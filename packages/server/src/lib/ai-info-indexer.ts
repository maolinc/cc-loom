import { db } from "../db/index.js";
import { aiGenSettings, type AiGenConfig } from "./ai-generation-config.js";
import { generateAssetInfo, type AssetInfoGenInput } from "./ai-info-generation.js";
import { enqueue as enqueueSearchIndex } from "./search-indexer.js";
import type { AssetAuthBinding, AssetType } from "@maolinc/cc-loom-shared";

/**
 * 能力信息生成队列 worker（ADR-0005，镜像 search-indexer.ts 骨架）。
 *
 * 写入语义 = 补缺口（gap-fill）：
 *  - worker 只填当前为空的 alias/tags/description；已有字段永不重算。
 *  - auth.bindings 仅在「首次处理」（processed_at IS NULL）时按 AI 结果补全；
 *    首次处理后 auth 视为已评估——后续内容编辑不重评 auth（避免「无需鉴权」被
 *    反复当作空缺重填，也尊重用户清空绑定 = 不要鉴权的意图）。陈旧由手动重新入队兜底。
 *  - 写任一文本字段后触发向量重算（enqueueSearchIndex 'auto'）：alias/tags/description
 *    是向量输入，不触发会让向量停在「字段为空时的旧内容」。auth 写入不触发（不在 content_hash）。
 *
 * 入队去重（pending/processing = no-op）；启动崩溃恢复 processing→pending；
 * 失败指数退避，超 max_attempts 转 failed。派生表可 DROP 重建。
 */

export type AiInfoEnqueueMode = "new" | "auto" | "manual";

/** worker 轮询间隔。测试环境可通过 LOOM_AI_INFO_WORKER_TICK_MS 调小以加速消费。 */
const WORKER_TICK_MS = Number(process.env.LOOM_AI_INFO_WORKER_TICK_MS) || 5_000;

let timer: NodeJS.Timeout | null = null;
/** tick 重入保护：setInterval 在上一轮未结束时再触发→跳过，避免多轮并发领取导致
 *  处理中数量超过 concurrency（worker 池已在内部保证 ≤ concurrency，此锁防的是
 *  「上一轮还在跑、下一轮又领一批」的跨轮叠加）。 */
let ticking = false;

// ============ 清理 ============

/** 物理清理某 asset 的生成队列行（派生数据，软删/硬删时调）。 */
export function removeAiInfoIndex(assetId: string): void {
  db.prepare("DELETE FROM asset_ai_info WHERE asset_id = ?").run(assetId);
}

// ============ 资产读取 ============

interface AssetGenData {
  deletedAt: string | null;
  input: AssetInfoGenInput;
}

/** 读取资产 + 文件，构造生成输入。软删/不存在返回 null。 */
function loadAssetForGen(assetId: string): AssetGenData | null {
  const asset = db.prepare(
    `SELECT name, type, alias, description, tags, metadata, deleted_at FROM assets WHERE id = ?`,
  ).get(assetId) as {
    name: string; type: string; alias: string | null; description: string;
    tags: string; metadata: string; deleted_at: string | null;
  } | undefined;
  if (!asset) return null;

  let tags: string[] = [];
  try { tags = JSON.parse(asset.tags) as string[]; } catch { tags = []; }
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(asset.metadata) as Record<string, unknown>; } catch { metadata = {}; }

  const fileRows = db.prepare(
    `SELECT path, content, encoding FROM asset_files WHERE asset_id = ? ORDER BY path`,
  ).all(assetId) as { path: string; content: string; encoding: string | null }[];
  // 仅喂文本文件（跳过 base64 二进制——喂给 AI 无意义）。
  const files = fileRows
    .filter((f) => !f.encoding)
    .map((f) => ({ path: f.path, content: f.content }));

  return {
    deletedAt: asset.deleted_at,
    input: {
      type: asset.type as AssetInfoGenInput["type"],
      name: asset.name,
      alias: asset.alias ?? "",
      description: asset.description ?? "",
      tags,
      metadata,
      files,
    },
  };
}

/** 当前是否有文本字段为空（alias/tags/description）——enqueue 的重算信号（不含 auth）。 */
function hasTextGap(assetId: string): boolean {
  const row = db.prepare(
    `SELECT alias, description, tags FROM assets WHERE id = ?`,
  ).get(assetId) as { alias: string | null; description: string; tags: string | null } | undefined;
  if (!row) return false;
  const aliasEmpty = !row.alias || row.alias.trim() === "";
  const descEmpty = !row.description || row.description.trim() === "";
  let tagsEmpty = true;
  try {
    const arr = JSON.parse(row.tags ?? "[]") as unknown[];
    tagsEmpty = !Array.isArray(arr) || arr.length === 0;
  } catch { tagsEmpty = true; }
  return aliasEmpty || descEmpty || tagsEmpty;
}

// ============ 入队（去重）============

/**
 * 入队生成任务（镜像 search-indexer enqueue 矩阵，gap-fill 语义）。
 * - new/auto：无行→INSERT pending；pending/processing→no-op；ready/failed→
 *   首次（processed_at IS NULL）或有文本缺口才 pending，否则 no-op（failed→ready 收口）。
 * - manual：ready/failed→强制 pending（重扫）。
 * 返回是否产生/重排了 pending。
 */
export function enqueue(assetId: string, mode: AiInfoEnqueueMode): boolean {
  const exists = db.prepare("SELECT deleted_at FROM assets WHERE id = ?").get(assetId) as { deleted_at: string | null } | undefined;
  if (!exists || exists.deleted_at) {
    removeAiInfoIndex(assetId);
    return false;
  }

  const now = new Date().toISOString();
  const row = db.prepare(
    "SELECT status, processed_at FROM asset_ai_info WHERE asset_id = ?",
  ).get(assetId) as { status: string; processed_at: string | null } | undefined;

  if (!row) {
    db.prepare(
      `INSERT INTO asset_ai_info (asset_id, status, queued_at, attempts, updated_at)
       VALUES (?, 'pending', ?, 0, ?)`,
    ).run(assetId, now, now);
    return true;
  }

  if (row.status === "pending" || row.status === "processing") {
    return false; // 去重 no-op
  }

  // ready 或 failed
  if (mode === "manual") {
    db.prepare(
      `UPDATE asset_ai_info SET status = 'pending', queued_at = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
       WHERE asset_id = ?`,
    ).run(now, now, assetId);
    return true;
  }

  // auto / new
  const isFirstTime = row.processed_at === null;
  const need = isFirstTime || hasTextGap(assetId);
  if (need) {
    db.prepare(
      `UPDATE asset_ai_info SET status = 'pending', queued_at = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
       WHERE asset_id = ?`,
    ).run(now, now, assetId);
    return true;
  }
  // 无缺口且非首次：failed→ready 收口（曾经失败，现在缺口已被用户填上）
  if (row.status === "failed") {
    db.prepare(
      `UPDATE asset_ai_info SET status = 'ready', last_error = NULL, next_attempt_at = NULL, updated_at = ?
       WHERE asset_id = ?`,
    ).run(now, assetId);
  }
  return false;
}

// ============ worker ============

/** 启动崩溃恢复：把 processing 拉回 pending。 */
export function crashRecover(): void {
  db.prepare(
    `UPDATE asset_ai_info SET status = 'pending', updated_at = ? WHERE status = 'processing'`,
  ).run(new Date().toISOString());
}

interface QueuedItem { asset_id: string; attempts: number; }

/** 原子领取单个 pending → processing（worker 池每 worker 一次领一个）。单进程下事务即可
 *  保证不重复领取（JS 单线程 + better-sqlite3 同步事务，两 worker 的事务串行不交错）。 */
function claimOnePending(): QueuedItem | null {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const row = db.prepare(
      `SELECT asset_id, attempts FROM asset_ai_info
       WHERE status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY queued_at ASC
       LIMIT 1`,
    ).get(now) as QueuedItem | undefined;
    if (!row) return null;
    db.prepare(
      `UPDATE asset_ai_info SET status = 'processing', updated_at = ? WHERE asset_id = ?`,
    ).run(now, row.asset_id);
    return row;
  });
  return tx();
}

/** 写入一条 auth 绑定（复用 asset_auth_bindings 表）。 */
function insertAuthBinding(
  assetId: string, ordinal: number, b: AssetAuthBinding, now: string,
): void {
  const id = (
    db.prepare("SELECT lower(hex(randomblob(16))) AS h").get() as { h: string }
  ).h;
  db.prepare(
    `INSERT INTO asset_auth_bindings (id, asset_id, ordinal, credential_name, kind, env_key, path, auth_page_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, assetId, ordinal, b.credentialName, b.kind, b.envKey ?? null, b.path ?? null, b.authPageUrl ?? null, now);
}

/**
 * 处理单个 processing asset。
 * - overwrite=off（默认，补缺口 ADR-0005）：只填空字段，已有不动；auth 仅首次补全。
 * - overwrite=on（全覆盖）：无条件覆盖 alias/tags/description；auth 删旧按 AI 结果重建。
 * 读当前内容→判定是否需调 AI→写回→ready；写文本字段后触发向量重算。
 * 失败退避重试/转 failed。
 */
export async function processOne(assetId: string, cfg: AiGenConfig): Promise<void> {
  const data = loadAssetForGen(assetId);
  if (!data || data.deletedAt) {
    removeAiInfoIndex(assetId);
    return;
  }

  const row = db.prepare(
    "SELECT attempts, processed_at FROM asset_ai_info WHERE asset_id = ?",
  ).get(assetId) as { attempts: number; processed_at: string | null } | undefined;
  const attempts = row?.attempts ?? 0;
  const isFirstTime = row?.processed_at === null;

  const aliasEmpty = !data.input.alias || data.input.alias.trim() === "";
  const descEmpty = !data.input.description || data.input.description.trim() === "";
  const tagsEmpty = data.input.tags.length === 0;
  const authCount = (db.prepare(
    "SELECT COUNT(*) AS c FROM asset_auth_bindings WHERE asset_id = ?",
  ).get(assetId) as { c: number }).c;
  const authEmpty = authCount === 0;

  // overwrite：每次处理都调 AI 且无条件覆盖；否则只在有缺口/首次 auth 时才调 AI
  const needGenerate = cfg.overwrite
    || (aliasEmpty || descEmpty || tagsEmpty)
    || (isFirstTime && authEmpty);

  const now = new Date().toISOString();
  if (!needGenerate) {
    // 无缺口且非首次：直接 ready，不调 AI
    db.prepare(
      `UPDATE asset_ai_info
       SET status = 'ready', gen_model = ?, processed_at = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
       WHERE asset_id = ?`,
    ).run(cfg.model, now, now, assetId);
    return;
  }

  try {
    const generated = await generateAssetInfo(data.input, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model });

    // 写回前复检：AI 调用期间资产被软删/删除 → 丢弃结果，清理队列行（镜像 search-indexer 决策 K）
    const after = loadAssetForGen(assetId);
    if (!after || after.deletedAt) {
      removeAiInfoIndex(assetId);
      return;
    }

    let wroteText = false;
    const now2 = new Date().toISOString();
    const tx = db.transaction(() => {
      if (cfg.overwrite) {
        // 全覆盖：无条件写文本三件套（AI 保证非空）
        if (generated.alias) {
          db.prepare("UPDATE assets SET alias = ?, updated_at = ? WHERE id = ?").run(generated.alias, now2, assetId);
          wroteText = true;
        }
        if (generated.tags.length > 0) {
          db.prepare("UPDATE assets SET tags = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(generated.tags), now2, assetId);
          wroteText = true;
        }
        if (generated.description) {
          db.prepare("UPDATE assets SET description = ?, updated_at = ? WHERE id = ?").run(generated.description, now2, assetId);
          wroteText = true;
        }
        // auth 全覆盖：删旧绑定，按 AI 结果重建（AI 判定无需鉴权 → 绑定清空）
        db.prepare("DELETE FROM asset_auth_bindings WHERE asset_id = ?").run(assetId);
        if (generated.auth?.bindings?.length) {
          generated.auth.bindings.forEach((b, i) => insertAuthBinding(assetId, i, b, now2));
        }
      } else {
        // 补缺口：仅写仍空字段（条件 UPDATE，防 worker 处理中用户并发填入）
        if (aliasEmpty && generated.alias) {
          const r = db.prepare(
            `UPDATE assets SET alias = ?, updated_at = ? WHERE id = ? AND (alias IS NULL OR alias = '')`,
          ).run(generated.alias, now2, assetId);
          if (r.changes > 0) wroteText = true;
        }
        if (tagsEmpty && generated.tags.length > 0) {
          const r = db.prepare(
            `UPDATE assets SET tags = ?, updated_at = ? WHERE id = ? AND (tags IS NULL OR tags = '[]')`,
          ).run(JSON.stringify(generated.tags), now2, assetId);
          if (r.changes > 0) wroteText = true;
        }
        if (descEmpty && generated.description) {
          const r = db.prepare(
            `UPDATE assets SET description = ?, updated_at = ? WHERE id = ? AND (description = '')`,
          ).run(generated.description, now2, assetId);
          if (r.changes > 0) wroteText = true;
        }
        // auth.bindings 仅首次处理时补全（已评估后不重写）
        if (isFirstTime && authEmpty && generated.auth?.bindings?.length) {
          const curCount = (db.prepare(
            "SELECT COUNT(*) AS c FROM asset_auth_bindings WHERE asset_id = ?",
          ).get(assetId) as { c: number }).c;
          if (curCount === 0) {
            generated.auth.bindings.forEach((b, i) => insertAuthBinding(assetId, i, b, now2));
          }
        }
      }
      db.prepare(
        `UPDATE asset_ai_info
         SET status = 'ready', gen_model = ?, processed_at = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
         WHERE asset_id = ?`,
      ).run(cfg.model, now2, now2, assetId);
    });
    tx();

    // 写了文本字段 → 触发向量重算（alias/tags/description 是向量输入；auth 不在 content_hash，
    // 但 content_hash 去重保证 auth-only 变化不会无意义重算）
    if (wroteText) {
      try { enqueueSearchIndex(assetId, "auto"); } catch { /* 向量化可能未启用，忽略 */ }
    }
  } catch (err) {
    handleFailure(assetId, attempts, err, cfg);
  }
}

function handleFailure(
  assetId: string,
  attemptsBefore: number,
  err: unknown,
  cfg: AiGenConfig,
): void {
  const attempts = attemptsBefore + 1;
  const message = err instanceof Error ? err.message : String(err);
  const now = new Date().toISOString();
  if (attempts < cfg.maxAttempts) {
    const nextAttempt = new Date(Date.now() + cfg.backoffBaseMs * 2 ** attempts).toISOString();
    db.prepare(
      `UPDATE asset_ai_info
       SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE asset_id = ?`,
    ).run(attempts, nextAttempt, message, now, assetId);
  } else {
    db.prepare(
      `UPDATE asset_ai_info
       SET status = 'failed', attempts = ?, next_attempt_at = NULL, last_error = ?, updated_at = ?
       WHERE asset_id = ?`,
    ).run(attempts, message, now, assetId);
  }
}

/**
 * 一轮 worker 消费：并发=concurrency 个 worker 并行，每个领一个→处理→领下一个，
 * 直到无 pending。处理中数量恒 ≤ concurrency。返回处理条数。
 *
 * 重入保护：上一轮 tick 未结束时 setInterval 又触发→直接跳过（避免跨轮叠加领取）。
 * 全局最小间隔 gate：minIntervalMs > 0 时跨 worker 串行化「请求起点」，保证任意两次
 * AI 请求起点间隔 ≥ minIntervalMs（RPM 限频）。占位在同步段完成（JS 单线程→原子）。
 */
export async function tick(): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  try {
    const cfg = aiGenSettings.get();
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) return 0;

    const n = Math.max(1, cfg.concurrency);
    let nextAllowedStart = 0;
    const gate = (): Promise<void> => {
      if (cfg.minIntervalMs <= 0) return Promise.resolve();
      const now = Date.now();
      const wait = Math.max(0, nextAllowedStart - now);
      // 同步占位下一个允许起点（读改写无 await → 事件循环上原子，两 worker 不会抢同一槽）
      nextAllowedStart = Math.max(now, nextAllowedStart) + cfg.minIntervalMs;
      return wait > 0 ? sleep(wait) : Promise.resolve();
    };

    const workers = Array.from({ length: n }, () => runWorker(cfg, gate));
    const counts = await Promise.all(workers);
    return counts.reduce((a, b) => a + b, 0);
  } finally {
    ticking = false;
  }
}

/** 单个 worker 循环：领一个→（间隔 gate）→处理→领下一个，直到队列空。 */
async function runWorker(cfg: AiGenConfig, gate: () => Promise<void>): Promise<number> {
  let processed = 0;
  for (;;) {
    const item = claimOnePending();
    if (!item) return processed;
    await gate();
    await processOne(item.asset_id, cfg);
    processed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 启动后台生成 worker（仅生产入口调用，与 startSearchIndexer 同模式）。
 * 崩溃恢复后按 WORKER_TICK_MS 轮询；未配置/未启用时 tick 空转。
 */
export function startAiInfoIndexer(): void {
  if (timer) return;
  crashRecover();
  timer = setInterval(() => { void tick(); }, WORKER_TICK_MS);
}

export function stopAiInfoIndexer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
