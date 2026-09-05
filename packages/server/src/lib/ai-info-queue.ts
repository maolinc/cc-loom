import { db } from "../db/index.js";
import { enqueue, type AiInfoEnqueueMode } from "./ai-info-indexer.js";
import type {
  AssetType,
  AiInfoQueueCounts,
  AiInfoQueueItem,
  AiInfoQueueList,
  AiInfoAssetIndexItem,
  AiInfoAssetIndexList,
  AiInfoRequeueInput,
} from "@maolinc/cc-loom-shared";

/**
 * 能力信息生成队列管理查询与操作（ADR-0005，镜像 search-queue.ts）。
 *
 * 列表与计数均过滤已软删与 adopted 能力（不进市场、不展示）。
 * 全部操作仅 admin 可调（路由层 requireAdmin）。
 */

const VISIBLE_CLAUSE = "a.deleted_at IS NULL AND a.adopted = 0";

/** 队列状态计数汇总。 */
export function queueCounts(): AiInfoQueueCounts {
  const rows = db.prepare(
    `SELECT e.status AS status, COUNT(*) AS c
     FROM asset_ai_info e
     JOIN assets a ON a.id = e.asset_id
     WHERE ${VISIBLE_CLAUSE}
     GROUP BY e.status`,
  ).all() as { status: string; c: number }[];
  const assets = (db.prepare(
    `SELECT COUNT(*) AS c FROM assets a WHERE ${VISIBLE_CLAUSE}`,
  ).get() as { c: number }).c;
  const counts: AiInfoQueueCounts = {
    pending: 0, processing: 0, ready: 0, failed: 0, total: 0, assets,
  };
  for (const r of rows) {
    if (r.status in { pending: 1, processing: 1, ready: 1, failed: 1 }) (counts as any)[r.status] = r.c;
    counts.total += r.c;
  }
  return counts;
}

const STATUS_ORDER: Record<string, string> = {
  pending: "e.queued_at ASC",
  processing: "e.queued_at ASC",
  ready: "e.processed_at DESC",
  failed: "e.updated_at DESC",
};

export type AiInfoQueueStatusFilter = "pending" | "processing" | "ready" | "failed" | "all";

/** 队列分页列表，按 tab 语义排序。 */
export function queueItems(
  status: AiInfoQueueStatusFilter,
  page: number,
  pageSize: number,
): AiInfoQueueList {
  const p = Math.max(1, page);
  const ps = Math.max(1, Math.min(pageSize, 200));
  const offset = (p - 1) * ps;

  const statusClause = status !== "all" ? `AND e.status = ${sqlLit(status)}` : "";
  const orderBy = status !== "all" && STATUS_ORDER[status]
    ? STATUS_ORDER[status]!
    : "e.queued_at ASC";

  const total = (db.prepare(
    `SELECT COUNT(*) AS c FROM asset_ai_info e JOIN assets a ON a.id = e.asset_id
     WHERE ${VISIBLE_CLAUSE} ${statusClause}`,
  ).get() as { c: number }).c;

  const rows = db.prepare(
    `SELECT e.asset_id, a.name, a.type, e.queued_at, e.attempts, e.last_error,
            e.processed_at, e.gen_model
     FROM asset_ai_info e
     JOIN assets a ON a.id = e.asset_id
     WHERE ${VISIBLE_CLAUSE} ${statusClause}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
  ).all(ps, offset) as {
    asset_id: string; name: string; type: AssetType;
    queued_at: string; attempts: number; last_error: string | null;
    processed_at: string | null; gen_model: string | null;
  }[];

  const items: AiInfoQueueItem[] = rows.map((r) => ({
    assetId: r.asset_id,
    name: r.name,
    type: r.type,
    queuedAt: r.queued_at,
    attempts: r.attempts,
    lastError: r.last_error,
    processedAt: r.processed_at,
    genModel: r.gen_model,
  }));

  return { items, page: p, pageSize: ps, total };
}

/**
 * 手动重新入队（manual 强制重扫）。{all:true} 全部可见能力；{assetIds:[...]} 指定。
 * 返回实际入队条数。
 */
export function requeue(input: AiInfoRequeueInput): number {
  let ids: string[];
  if (input.all) {
    ids = (db.prepare(
      `SELECT a.id FROM assets a WHERE ${VISIBLE_CLAUSE}`,
    ).all() as { id: string }[]).map((r) => r.id);
  } else {
    ids = input.assetIds ?? [];
  }
  let n = 0;
  for (const id of ids) {
    if (enqueue(id, "manual" as AiInfoEnqueueMode)) n++;
  }
  return n;
}

/** 重试全部失败项。返回重置条数。 */
export function retryFailed(): number {
  const now = new Date().toISOString();
  const info = db.prepare(
    `UPDATE asset_ai_info
     SET status = 'pending', attempts = 0, next_attempt_at = NULL, queued_at = ?, updated_at = ?
     WHERE status = 'failed'
       AND asset_id IN (SELECT id FROM assets WHERE deleted_at IS NULL AND adopted = 0)`,
  ).run(now, now);
  return info.changes;
}

/**
 * 全部能力的生成状态视图（LEFT JOIN asset_ai_info，含未入队项）。
 * 逐能力标注各字段是否为空（worker 会补的缺口）。过滤已软删/adopted；
 * 按 name 子串搜索；按 processed_at 排序（未成功过的排末尾）。
 */
export function assetInfoList(
  page: number,
  pageSize: number,
  q: string,
  order: "asc" | "desc",
): AiInfoAssetIndexList {
  const p = Math.max(1, page);
  const ps = Math.max(1, Math.min(pageSize, 200));
  const offset = (p - 1) * ps;

  const nameClause = q ? `AND a.name LIKE ? ESCAPE '\\'` : "";
  const likeParam = q
    ? `%${q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`
    : null;
  const nameParams = q ? [likeParam] : [];
  const orderBy =
    order === "asc"
      ? "e.processed_at ASC NULLS FIRST"
      : "e.processed_at DESC NULLS LAST";

  const total = (db.prepare(
    `SELECT COUNT(*) AS c FROM assets a
     LEFT JOIN asset_ai_info e ON e.asset_id = a.id
     WHERE ${VISIBLE_CLAUSE} ${nameClause}`,
  ).get(...nameParams) as { c: number } | undefined)?.c ?? 0;

  const rows = db.prepare(
    `SELECT a.id, a.name, a.type, a.alias, a.description, a.tags,
            e.status, e.processed_at, e.gen_model, e.last_error
     FROM assets a
     LEFT JOIN asset_ai_info e ON e.asset_id = a.id
     WHERE ${VISIBLE_CLAUSE} ${nameClause}
     ORDER BY ${orderBy}, a.name ASC
     LIMIT ? OFFSET ?`,
  ).all(...nameParams, ps, offset) as {
    id: string; name: string; type: AssetType;
    alias: string | null; description: string; tags: string | null;
    status: string | null; processed_at: string | null;
    gen_model: string | null; last_error: string | null;
  }[];

  // auth 绑定数（批量查一次）
  const authCounts = new Map<string, number>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => "?").join(",");
    const ac = db.prepare(
      `SELECT asset_id, COUNT(*) AS n FROM asset_auth_bindings WHERE asset_id IN (${ph}) GROUP BY asset_id`,
    ).all(...ids) as { asset_id: string; n: number }[];
    for (const r of ac) authCounts.set(r.asset_id, r.n);
  }

  const items: AiInfoAssetIndexItem[] = rows.map((r) => {
    let tagsEmpty = true;
    try {
      const arr = JSON.parse(r.tags ?? "[]") as unknown[];
      tagsEmpty = !Array.isArray(arr) || arr.length === 0;
    } catch { tagsEmpty = true; }
    return {
      assetId: r.id,
      name: r.name,
      type: r.type,
      status: (r.status ?? "unindexed") as AiInfoAssetIndexItem["status"],
      processedAt: r.processed_at,
      genModel: r.gen_model,
      lastError: r.last_error,
      aliasEmpty: !r.alias || r.alias.trim() === "",
      tagsEmpty,
      descriptionEmpty: !r.description || r.description.trim() === "",
      authEmpty: (authCounts.get(r.id) ?? 0) === 0,
    };
  });

  return { items, page: p, pageSize: ps, total };
}

/** SQL 字符串字面量（status 取值受枚举约束，安全）。 */
function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
