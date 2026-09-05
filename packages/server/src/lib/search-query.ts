import { db, vecAvailable } from "../db/index.js";
import { embed } from "./embedding.js";
import { embeddingSettings } from "./embedding-config.js";
import { isRebuilding } from "./search-indexer.js";
import { getQueryVector, setQueryVector } from "./query-vector-cache.js";

/**
 * 混合检索（docs/sqlite-vec-search-design.md §2.4 / §6）。
 *
 * 流程：可见性预过滤（子查询）→ ① FTS5 BM25 词法 top100（useLexical）+ ② 每字段一条 KNN 语义 top100（useSemantic）
 * → min-max 归一化 → α 融合 → type/tags/source 后过滤 → score_final DESC 分页。
 *
 * 模式：cfg.useLexical 控制是否跑 FTS5；cfg.useSemantic 控制是否跑 vec（另需 enabled+扩展+凭据）。
 * 两者至少一个为 true（路由层保证）。两者都开 → α 融合；仅开一个 → 该路独占排序（α 不影响排序）。
 * 降级：语义路不可用 / embed(query) 失败 → 仅 FTS5 词法（mode='lexical'）。候选为空时由调用方回退 LIKE。
 *
 * 分数方向统一为「越高越相关」：FTS5 用 -bm25（bm25 更负=更相关），vec 用 Σ w×(1-distance)。
 */

export interface HybridSearchParams {
  /** 可见性 WHERE 片段（deleted_at IS NULL / adopted=0 / visibility 条件，不含 query/type/tags/source）。 */
  visibleWhere: string;
  visibleParams: unknown[];
  query: string;
  type?: string;
  tags?: string[];
  source?: string;
  page: number;
  pageSize: number;
}

export interface HybridResult {
  /** 当前页 asset_id（按 score_final DESC）。 */
  assetIds: string[];
  total: number;
  mode: "hybrid" | "lexical";
}

const KNN_K = 100;
const FTS_LIMIT = 100;

export async function hybridSearch(p: HybridSearchParams): Promise<HybridResult> {
  const cfg = embeddingSettings.get();
  const visibleSub = `SELECT a.id FROM assets a WHERE ${p.visibleWhere}`;

  // ① FTS5 词法路（BM25，取 -bm25 使越高越相关）——仅当搜索模式启用词法时跑
  const ftsScores = new Map<string, number>();
  const matchExpr = buildFtsMatch(p.query);
  if (cfg.useLexical && matchExpr) {
    try {
      const rows = db.prepare(
        `SELECT asset_id, bm25(asset_fts) AS score FROM asset_fts
         WHERE asset_fts MATCH ? AND asset_id IN (${visibleSub})
         ORDER BY bm25(asset_fts) ASC LIMIT ${FTS_LIMIT}`,
      ).all(matchExpr, ...p.visibleParams) as { asset_id: string; score: number }[];
      for (const r of rows) ftsScores.set(r.asset_id, -r.score);
    } catch {
      // FTS5 语法/分词异常 → 词法路空，语义路或回退兜底
    }
  }

  // ② 语义路：每字段一条 KNN（重建中跳过——asset_vec 已清空，降级词法省 embed 调用）
  // 仅当搜索模式启用语义、且向量可用（enabled + 扩展 + 凭据）时跑
  const vecScores = new Map<string, number>();
  let mode: "hybrid" | "lexical" = "lexical";
  const canVec = !isRebuilding() && cfg.enabled && !!cfg.baseUrl && !!cfg.apiKey && vecAvailable();
  if (cfg.useSemantic && canVec) {
    try {
      // 查询向量走缓存（query-vector-cache）：同一搜索词 60s 内复用，免重复打 embedding 接口。
      const now = Date.now();
      let qVec = getQueryVector(p.query, now);
      if (!qVec) {
        const vectors = await embed([p.query], "query", { maxRetries: 1 });
        qVec = vectors[0]!;
        setQueryVector(p.query, qVec, now);
      }
      const qBuf = Buffer.from(new Float32Array(qVec).buffer);
      const weights = cfg.weights;
      // 相似度阈值（§6）：cosine similarity = 1 - distance。低于阈值的弱语义匹配
      // 不纳入候选——否则宽泛词（如「生成设计图像」）会经 KNN top-k 召回几乎全目录。
      // 调高 simThreshold → 召回更聚焦；调低 → 更宽；0 = 不过滤。
      const simThreshold = cfg.simThreshold;
      for (const field of ["name", "tags", "description"] as const) {
        const w = weights[field];
        const rows = db.prepare(
          `SELECT asset_id, distance FROM asset_vec
           WHERE embedding MATCH ? AND k = ${KNN_K} AND field = ?
             AND asset_id IN (${visibleSub})
           ORDER BY distance`,
        ).all(qBuf, field, ...p.visibleParams) as { asset_id: string; distance: number }[];
        for (const r of rows) {
          const sim = 1 - r.distance;
          if (sim < simThreshold) continue; // 丢弃弱匹配（不进候选、不计分）
          vecScores.set(r.asset_id, (vecScores.get(r.asset_id) ?? 0) + w * sim);
        }
      }
      mode = "hybrid";
    } catch {
      // embed 失败 / vec 查询异常 → 词法降级
    }
  }

  const candidateIds = new Set<string>([...ftsScores.keys(), ...vecScores.keys()]);
  if (candidateIds.size === 0) return { assetIds: [], total: 0, mode };

  // 归一化 + α 融合
  const ftsNorm = minMaxNorm(ftsScores);
  const vecNorm = minMaxNorm(vecScores);
  const alpha = cfg.alpha;
  const finalScore = new Map<string, number>();
  for (const id of candidateIds) {
    finalScore.set(
      id,
      alpha * (ftsNorm.get(id) ?? 0) + (1 - alpha) * (vecNorm.get(id) ?? 0),
    );
  }

  // 后过滤 type/tags/source（可见性已在预过滤完成）
  const ids = [...candidateIds];
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, type, tags, source_id FROM assets WHERE id IN (${ph})`,
  ).all(...ids) as { id: string; type: string; tags: string; source_id: string | null }[];

  const filtered = rows.filter((r) => matchesFilters(r, p));
  filtered.sort((a, b) => (finalScore.get(b.id) ?? 0) - (finalScore.get(a.id) ?? 0));

  const total = filtered.length;
  const start = (p.page - 1) * p.pageSize;
  const pageIds = filtered.slice(start, start + p.pageSize).map((r) => r.id);
  return { assetIds: pageIds, total, mode };
}

/** min-max 归一化到 [0,1]（越高越相关）。全等时给 1（都视作最佳）。 */
function minMaxNorm(scores: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (scores.size === 0) return out;
  const vals = [...scores.values()];
  let min = Infinity, max = -Infinity;
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; }
  if (max === min) {
    for (const k of scores.keys()) out.set(k, 1);
    return out;
  }
  const range = max - min;
  for (const [k, v] of scores) out.set(k, (v - min) / range);
  return out;
}

/** FTS5 MATCH 表达式：每个空白分词作为 phrase，OR 连接（任意命中即可）。 */
function buildFtsMatch(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

function matchesFilters(
  r: { type: string; tags: string; source_id: string | null },
  p: HybridSearchParams,
): boolean {
  if (p.type && r.type !== p.type) return false;
  if (p.source) {
    if (p.source === "local") {
      if (r.source_id !== null) return false;
    } else if (r.source_id !== p.source) {
      return false;
    }
  }
  if (p.tags && p.tags.length > 0) {
    let assetTags: string[] = [];
    try { assetTags = JSON.parse(r.tags) as string[]; } catch { /* 留空 */ }
    if (!p.tags.some((t) => assetTags.includes(t))) return false;
  }
  return true;
}
