import { db, vecAvailable } from "../db/index.js";
import { embed } from "./embedding.js";
import { embeddingSettings, type EmbeddingConfig } from "./embedding-config.js";
import { appSettings } from "./app-settings.js";
import {
  buildFieldTexts,
  computeContentHash,
  loadAssetIndexData,
  type FieldTexts,
} from "./search-field-text.js";

/**
 * 语义搜索索引器（docs/sqlite-vec-search-design.md §5）。
 *
 * 持久化队列（asset_embeddings，status 驱动）+ 慢消费 worker。
 * - enqueue：去重（§5.3 矩阵），FTS5 行入队时同步写（ADR-0002）。
 * - worker：领 pending → embed → 写 asset_vec → ready；写回复检 content_hash；
 *   失败指数退避重试，超 max_attempts 转 failed。
 * - 启动崩溃恢复：processing → pending（复用 sync_outbox 模式）。
 * - removeSearchIndex：软删/硬删时物理清理派生索引行。
 *
 * 派生数据可重建；asset_vec/asset_fts 手动维护生命周期，asset_embeddings 带 CASCADE。
 */

export type EnqueueMode = "new" | "auto" | "manual";

const FIELD_VERSION = 0;
/** worker 轮询间隔。测试环境可通过 LOOM_SEARCH_WORKER_TICK_MS 调小以加速消费。 */
const WORKER_TICK_MS = Number(process.env.LOOM_SEARCH_WORKER_TICK_MS) || 5_000;
/** 重建中标记（app_settings 键）：置 1 时 search-query 跳过 vec 路降级词法，前端显示「重建中」。 */
const REBUILD_FLAG_KEY = "search.rebuild.active";

let timer: NodeJS.Timeout | null = null;
/** tick 重入保护：setInterval 在上一轮未结束时再触发→跳过，避免多轮并发领取导致
 *  处理中数量超过 concurrency（worker 池已在内部保证 ≤ concurrency，此锁防的是
 *  「上一轮还在跑、下一轮又领一批」的跨轮叠加）。 */
let ticking = false;

// ============ FTS5 / vec 行维护 ============

function writeFtsRow(assetId: string, texts: FieldTexts): void {
  db.prepare("DELETE FROM asset_fts WHERE asset_id = ?").run(assetId);
  db.prepare(
    "INSERT INTO asset_fts (asset_id, name, tags, description) VALUES (?, ?, ?, ?)",
  ).run(assetId, texts.name, texts.tags, texts.description);
}

/** 物理清理某 asset 的全部派生索引行（vec/fts/embeddings）。 */
export function removeSearchIndex(assetId: string): void {
  try { db.prepare("DELETE FROM asset_vec WHERE asset_id = ?").run(assetId); } catch { /* vec 表可能未建（扩展降级） */ }
  try { db.prepare("DELETE FROM asset_fts WHERE asset_id = ?").run(assetId); } catch { /* 表不存在 */ }
  db.prepare("DELETE FROM asset_embeddings WHERE asset_id = ?").run(assetId);
}

// ============ 入队（去重）============

/**
 * 入队索引任务（§5.3 矩阵）。
 * - new/auto：无行→INSERT pending；pending/processing→no-op；ready→hash 变才 pending；failed→pending
 * - manual：ready/failed→强制 pending（忽略 hash）
 * FTS5 行始终同步写/刷新（ADR-0002）。返回是否产生/重排了 pending。
 */
export function enqueue(assetId: string, mode: EnqueueMode): boolean {
  const data = loadAssetIndexData(assetId);
  if (!data) return false;
  if (data.deletedAt) {
    // 软删资产不索引；清理可能残留的派生行
    removeSearchIndex(assetId);
    return false;
  }
  const texts = buildFieldTexts(data);
  const hash = computeContentHash(texts);
  const now = new Date().toISOString();

  // FTS5 同步写（文本构造本就是算 hash 要做的事）
  writeFtsRow(assetId, texts);

  const row = db.prepare(
    "SELECT status, content_hash FROM asset_embeddings WHERE asset_id = ?",
  ).get(assetId) as { status: string; content_hash: string } | undefined;

  const dim = embeddingSettings.get().dim;

  if (!row) {
    db.prepare(
      `INSERT INTO asset_embeddings
        (asset_id, status, queued_at, attempts, embed_dim, content_hash, field_version, updated_at)
       VALUES (?, 'pending', ?, 0, ?, ?, ?, ?)`,
    ).run(assetId, now, dim, hash, FIELD_VERSION, now);
    return true;
  }

  if (row.status === "pending" || row.status === "processing") {
    return false; // 去重 no-op
  }

  // ready 或 failed
  const force = mode === "manual";
  if (force || row.content_hash !== hash) {
    db.prepare(
      `UPDATE asset_embeddings
       SET status = 'pending', queued_at = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
       WHERE asset_id = ?`,
    ).run(now, now, assetId);
    return true;
  }
  return false; // hash 未变，无需重算
}

// ============ 重建（§5.6 模式 B）============

/** 当前是否处于重建中（model/dim 变更后、向量重算期间）。 */
export function isRebuilding(): boolean {
  return appSettings.get(REBUILD_FLAG_KEY) === "1";
}

/**
 * 重建向量索引（§5.6 模式 B，模型/维度变更后）：
 * - DROP + 按当前配置 dim 重建 asset_vec（保证维度对齐）
 * - 全量可见 asset 入队（manual 语义：status=pending, attempts=0）
 * - 置重建标记：期间 search-query 跳过 vec 路降级词法，前端显示进度
 * worker 消费完所有 pending 后自动清除标记（tick 收尾）。
 * 返回入队条数。
 */
export function rebuildIndex(): { queued: number } {
  if (!vecAvailable()) {
    throw new Error("sqlite-vec 扩展不可用，无法重建向量索引");
  }
  const cfg = embeddingSettings.get();
  const dim = cfg.dim > 0 ? cfg.dim : 4096;

  // 清空 asset_vec（DROP + 按新 dim 重建；维度不变也 DROP，逻辑统一且保证对齐）
  db.exec("DROP TABLE IF EXISTS asset_vec");
  db.exec(
    `CREATE VIRTUAL TABLE asset_vec USING vec0(
      embedding float[${dim}] distance=cosine,
      asset_id  TEXT,
      field     TEXT
    )`,
  );

  // 全量入队：所有非软删、非 adopted 能力置 pending（manual 语义）
  const now = new Date().toISOString();
  const ids = db.prepare(
    `SELECT a.id FROM assets a WHERE a.deleted_at IS NULL AND a.adopted = 0`,
  ).all() as { id: string }[];
  const upsert = db.prepare(
    `INSERT INTO asset_embeddings (asset_id, status, queued_at, attempts, embed_dim, content_hash, field_version, updated_at)
     VALUES (?, 'pending', ?, 0, ?, '', ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET
       status = 'pending', queued_at = excluded.queued_at, attempts = 0,
       next_attempt_at = NULL, embed_dim = excluded.embed_dim, updated_at = excluded.updated_at`,
  );
  for (const r of ids) upsert.run(r.id, now, dim, FIELD_VERSION, now);

  appSettings.set(REBUILD_FLAG_KEY, "1");
  return { queued: ids.length };
}

/** worker tick 收尾：重建标记下若 pending+processing 全清，则清除标记。 */
function maybeClearRebuildFlag(): void {
  if (appSettings.get(REBUILD_FLAG_KEY) !== "1") return;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM asset_embeddings WHERE status IN ('pending', 'processing')`,
  ).get() as { c: number };
  if (row.c === 0) appSettings.set(REBUILD_FLAG_KEY, "");
}

// ============ worker ============

/** 启动崩溃恢复：把 processing 拉回 pending（§5.5 / 决策 K）。 */
export function crashRecover(): void {
  db.prepare(
    `UPDATE asset_embeddings SET status = 'pending', updated_at = ?
     WHERE status = 'processing'`,
  ).run(new Date().toISOString());
}

interface QueuedItem {
  asset_id: string;
  attempts: number;
}

/**
 * 原子领取单个 pending → processing（worker 池每 worker 一次领一个）。单进程下事务即可
 * 保证不重复领取（JS 单线程 + better-sqlite3 同步事务，两 worker 的事务串行不交错）。
 *
 * `skipThisTick`：本轮已处理过的 asset_id 集合。processOne 的「内容复检」分支会把内容被
 * 编辑的项重排回 pending（next_attempt_at=NULL，立即可领）；若不跳过，draining worker
 * 会在本轮立即重新领取并重算，与原「重排→留待下一轮」语义相悖（亦可能在持续编辑时
 * 热循环）。失败重排带未来 next_attempt_at，本就不会被立即领取，skip 对其无影响。
 */
function claimOnePending(skipThisTick?: Set<string>): QueuedItem | null {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    let row: QueuedItem | undefined;
    if (skipThisTick && skipThisTick.size > 0) {
      const ids = [...skipThisTick];
      const ph = ids.map(() => "?").join(",");
      row = db.prepare(
        `SELECT asset_id, attempts FROM asset_embeddings
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND asset_id NOT IN (${ph})
         ORDER BY queued_at ASC
         LIMIT 1`,
      ).get(now, ...ids) as QueuedItem | undefined;
    } else {
      row = db.prepare(
        `SELECT asset_id, attempts FROM asset_embeddings
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY queued_at ASC
         LIMIT 1`,
      ).get(now) as QueuedItem | undefined;
    }
    if (!row) return null;
    db.prepare(
      `UPDATE asset_embeddings SET status = 'processing', updated_at = ? WHERE asset_id = ?`,
    ).run(now, row.asset_id);
    return row;
  });
  return tx();
}

function toBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/**
 * 处理单个 processing asset（§5.5 步骤 4）。
 * 读当前内容→embed→写回前复检 content_hash→写 vec + ready；失败退避重试/转 failed。
 */
export async function processOne(assetId: string, cfg: EmbeddingConfig): Promise<void> {
  const data = loadAssetIndexData(assetId);
  if (!data || data.deletedAt) {
    // 资产已删除/不存在：清理派生行
    removeSearchIndex(assetId);
    return;
  }

  const texts = buildFieldTexts(data);
  const hCur = computeContentHash(texts);
  const fields = ([
    ["name", texts.name],
    ["tags", texts.tags],
    ["description", texts.description],
  ] as Array<[string, string]>).filter(([, v]) => v.length > 0);

  const row = db.prepare(
    "SELECT attempts FROM asset_embeddings WHERE asset_id = ?",
  ).get(assetId) as { attempts: number } | undefined;
  const attempts = row?.attempts ?? 0;

  try {
    if (fields.length === 0) {
      // 无可向量化字段：直接标记 ready，清空 vec 行
      const now = new Date().toISOString();
      db.prepare("DELETE FROM asset_vec WHERE asset_id = ?").run(assetId);
      db.prepare(
        `UPDATE asset_embeddings
         SET status = 'ready', embed_model = ?, embed_dim = ?, content_hash = ?,
             processed_at = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
         WHERE asset_id = ?`,
      ).run(cfg.model, cfg.dim, hCur, now, now, assetId);
      return;
    }

    const vectors = await embed(fields.map((f) => f[1]), "passage", { maxRetries: 2 });

    // 写回前无条件复检（决策 K）：处理期间被编辑则重排，丢弃本次结果
    const dataNow = loadAssetIndexData(assetId);
    if (!dataNow || dataNow.deletedAt) {
      removeSearchIndex(assetId);
      return;
    }
    const hNow = computeContentHash(buildFieldTexts(dataNow));
    if (hNow !== hCur) {
      db.prepare(
        `UPDATE asset_embeddings SET status = 'pending', updated_at = ? WHERE asset_id = ?`,
      ).run(new Date().toISOString(), assetId);
      return;
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM asset_vec WHERE asset_id = ?").run(assetId);
      const ins = db.prepare(
        "INSERT INTO asset_vec (embedding, asset_id, field) VALUES (?, ?, ?)",
      );
      for (let i = 0; i < fields.length; i++) {
        ins.run(toBuffer(vectors[i]!), assetId, fields[i]![0]);
      }
      db.prepare(
        `UPDATE asset_embeddings
         SET status = 'ready', embed_model = ?, embed_dim = ?, content_hash = ?,
             processed_at = ?, attempts = 0, next_attempt_at = NULL, updated_at = ?
         WHERE asset_id = ?`,
      ).run(cfg.model, cfg.dim, hCur, now, now, assetId);
    });
    tx();
  } catch (err) {
    handleFailure(assetId, attempts, err, cfg);
  }
}

function handleFailure(
  assetId: string,
  attemptsBefore: number,
  err: unknown,
  cfg: EmbeddingConfig,
): void {
  const attempts = attemptsBefore + 1;
  const message = err instanceof Error ? err.message : String(err);
  const now = new Date().toISOString();
  if (attempts < cfg.maxAttempts) {
    const nextAttempt = new Date(Date.now() + cfg.backoffBaseMs * 2 ** attempts).toISOString();
    db.prepare(
      `UPDATE asset_embeddings
       SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE asset_id = ?`,
    ).run(attempts, nextAttempt, message, now, assetId);
  } else {
    db.prepare(
      `UPDATE asset_embeddings
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
 * embedding 请求起点间隔 ≥ minIntervalMs（RPM 限频）。占位在同步段完成（JS 单线程→原子）。
 */
export async function tick(): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  try {
    const cfg = embeddingSettings.get();
    if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey || !vecAvailable()) return 0;

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

    // 本轮已处理集合：防止 draining worker 在同一轮内重新领取「复检重排」回 pending 的项
    const skipThisTick = new Set<string>();
    const workers = Array.from({ length: n }, () => runWorker(cfg, gate, skipThisTick));
    const counts = await Promise.all(workers);
    maybeClearRebuildFlag();
    return counts.reduce((a, b) => a + b, 0);
  } finally {
    ticking = false;
  }
}

/** 单个 worker 循环：领一个→（间隔 gate）→处理→领下一个，直到队列空。 */
async function runWorker(cfg: EmbeddingConfig, gate: () => Promise<void>, skipThisTick: Set<string>): Promise<number> {
  let processed = 0;
  for (;;) {
    const item = claimOnePending(skipThisTick);
    if (!item) return processed;
    skipThisTick.add(item.asset_id); // 标记本轮已处理，避免复检重排后本轮重复领取
    await gate();
    await processOne(item.asset_id, cfg);
    processed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 启动后台索引 worker（仅生产入口调用，与 startScheduler 同模式）。
 * 崩溃恢复后按 WORKER_TICK_MS 轮询；embedding 未配置/降级时 tick 空转。
 */
export function startSearchIndexer(): void {
  if (timer) return;
  crashRecover();
  timer = setInterval(() => { void tick(); }, WORKER_TICK_MS);
}

export function stopSearchIndexer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
