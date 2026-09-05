import { db } from "../db/index.js";
import { enqueue, isRebuilding } from "./search-indexer.js";
import type {
  AssetType,
  AssetIndexStatus,
  SearchAssetIndexItem,
  SearchAssetIndexList,
  SearchQueueCounts,
  SearchQueueItem,
  SearchQueueList,
  SearchRequeueInput,
} from "@maolinc/cc-loom-shared";

/**
 * 语义搜索队列管理查询与操作（docs/sqlite-vec-search-design.md §5.7）。
 *
 * 列表与计数均过滤已软删（asset_embeddings 行已在软删时由 removeSearchIndex 清理，
 * 此处再过滤 deleted_at IS NULL 作兜底）与 adopted 能力（不进市场、不展示）。
 * 所有操作仅 admin 可调（路由层 requireAdmin）。
 */

const VISIBLE_CLAUSE = "a.deleted_at IS NULL AND a.adopted = 0";

/** 队列状态计数汇总（§5.7 GET /queue）。 */
export function queueCounts(): SearchQueueCounts {
  const rows = db.prepare(
    `SELECT e.status AS status, COUNT(*) AS c
     FROM asset_embeddings e
     JOIN assets a ON a.id = e.asset_id
     WHERE ${VISIBLE_CLAUSE}
     GROUP BY e.status`,
  ).all() as { status: string; c: number }[];
  const assets = (db.prepare(
    `SELECT COUNT(*) AS c FROM assets a WHERE ${VISIBLE_CLAUSE}`,
  ).get() as { c: number }).c;
  const counts: SearchQueueCounts = {
    pending: 0, processing: 0, ready: 0, failed: 0, total: 0, assets,
    rebuilding: isRebuilding(),
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

export type QueueStatusFilter = "pending" | "processing" | "ready" | "failed" | "all";

/**
 * 队列分页列表（§5.7 GET /queue/items）。JOIN assets 过滤已删除/adopted，
 * 按 tab 语义排序：pending/processing→queued_at ASC、ready→processed_at DESC、failed→updated_at DESC。
 */
export function queueItems(
  status: QueueStatusFilter,
  page: number,
  pageSize: number,
): SearchQueueList {
  const p = Math.max(1, page);
  const ps = Math.max(1, Math.min(pageSize, 200));
  const offset = (p - 1) * ps;

  const statusClause = status !== "all" ? `AND e.status = ${sqlLit(status)}` : "";
  const orderBy = status !== "all" && STATUS_ORDER[status]
    ? STATUS_ORDER[status]!
    : "e.queued_at ASC";

  const total = (db.prepare(
    `SELECT COUNT(*) AS c FROM asset_embeddings e JOIN assets a ON a.id = e.asset_id
     WHERE ${VISIBLE_CLAUSE} ${statusClause}`,
  ).get() as { c: number }).c;

  const rows = db.prepare(
    `SELECT e.asset_id, a.name, a.type, e.queued_at, e.attempts, e.last_error,
            e.processed_at, e.embed_model
     FROM asset_embeddings e
     JOIN assets a ON a.id = e.asset_id
     WHERE ${VISIBLE_CLAUSE} ${statusClause}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?`,
  ).all(ps, offset) as {
    asset_id: string; name: string; type: AssetType;
    queued_at: string; attempts: number; last_error: string | null;
    processed_at: string | null; embed_model: string | null;
  }[];

  const items: SearchQueueItem[] = rows.map((r) => ({
    assetId: r.asset_id,
    name: r.name,
    type: r.type,
    queuedAt: r.queued_at,
    attempts: r.attempts,
    lastError: r.last_error,
    processedAt: r.processed_at,
    embedModel: r.embed_model,
  }));

  return { items, page: p, pageSize: ps, total };
}

/**
 * 手动重新入队（刷新模式，同模型，§5.7 POST /requeue）。
 * - {all: true}：全部可见能力重新入队（不论当前状态）。enqueue 内部对 pending/processing
 *   去重 no-op，故实际重排 ready/failed/未索引项；processing 不打断。
 * - {assetIds: [...]}：指定能力重新入队（不论当前状态，manual 强制重排）
 * 返回实际入队条数。
 */
export function requeue(input: SearchRequeueInput): number {
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
    if (enqueue(id, "manual")) n++;
  }
  return n;
}

/** 重试全部失败项（§5.7 POST /retry-failed）。返回重置条数。 */
export function retryFailed(): number {
  const now = new Date().toISOString();
  const info = db.prepare(
    `UPDATE asset_embeddings
     SET status = 'pending', attempts = 0, next_attempt_at = NULL, queued_at = ?, updated_at = ?
     WHERE status = 'failed'
       AND asset_id IN (SELECT id FROM assets WHERE deleted_at IS NULL AND adopted = 0)`,
  ).run(now, now);
  return info.changes;
}

/**
 * 全部能力的索引视图（§5.7 GET /assets）。
 * LEFT JOIN assets → asset_embeddings：无 embedding 行记 unindexed（即尚未构建）。
 * 过滤已软删/adopted；按 name 子串搜索（LIKE，转义 % _ \）；按 processed_at
 * （最近一次成功构建时间）排序，未成功过的排末尾（DESC NULLS LAST / ASC NULLS FIRST）。
 * 逐能力「重新构建」复用 requeue({assetIds:[id]}) —— manual 强制重排，对未索引项也生效。
 * indexSizeBytes = 该能力在 asset_vec 的行数（字段数）× embed_dim × 4（float32 向量存储）。
 */
export function assetIndexList(
  page: number,
  pageSize: number,
  q: string,
  order: "asc" | "desc",
): SearchAssetIndexList {
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
     LEFT JOIN asset_embeddings e ON e.asset_id = a.id
     WHERE ${VISIBLE_CLAUSE} ${nameClause}`,
  ).get(...nameParams) as { c: number } | undefined)?.c ?? 0;

  const rows = db.prepare(
    `SELECT a.id, a.name, a.type, e.status, e.processed_at, e.embed_model, e.last_error, e.embed_dim
     FROM assets a
     LEFT JOIN asset_embeddings e ON e.asset_id = a.id
     WHERE ${VISIBLE_CLAUSE} ${nameClause}
     ORDER BY ${orderBy}, a.name ASC
     LIMIT ? OFFSET ?`,
  ).all(...nameParams, ps, offset) as {
    id: string; name: string; type: AssetType;
    status: string | null; processed_at: string | null;
    embed_model: string | null; last_error: string | null; embed_dim: number | null;
  }[];

  // 每能力 vec 行数（字段数）；asset_vec 不存在（降级）时为空 map
  const vecCounts = new Map<string, number>();
  try {
    const vrows = db.prepare(
      "SELECT asset_id, COUNT(*) AS n FROM asset_vec GROUP BY asset_id",
    ).all() as { asset_id: string; n: number }[];
    for (const r of vrows) vecCounts.set(r.asset_id, r.n);
  } catch { /* asset_vec 未建（扩展降级） */ }

  const items: SearchAssetIndexItem[] = rows.map((r) => {
    const dim = r.embed_dim ?? 0;
    const cnt = vecCounts.get(r.id) ?? 0;
    return {
      assetId: r.id,
      name: r.name,
      type: r.type,
      status: (r.status ?? "unindexed") as AssetIndexStatus,
      processedAt: r.processed_at,
      embedModel: r.embed_model,
      lastError: r.last_error,
      indexSizeBytes: dim > 0 && cnt > 0 ? cnt * dim * 4 : 0,
    };
  });

  // 全部可见能力的向量索引汇总大小
  let totalSizeBytes = 0;
  try {
    const row = db.prepare(
      `SELECT SUM(v.cnt * COALESCE(e.embed_dim, 0) * 4) AS s
       FROM (SELECT asset_id, COUNT(*) AS cnt FROM asset_vec GROUP BY asset_id) v
       JOIN asset_embeddings e ON e.asset_id = v.asset_id
       JOIN assets a ON a.id = v.asset_id
       WHERE ${VISIBLE_CLAUSE}`,
    ).get() as { s: number | null } | undefined;
    totalSizeBytes = row?.s ?? 0;
  } catch { /* asset_vec 未建 */ }

  return { items, page: p, pageSize: ps, total, totalSizeBytes };
}

/** SQL 字符串字面量（status 取值受枚举约束，安全）。 */
function sqlLit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
