import type { FastifyInstance } from "fastify";
import {
  embeddingSettingsUpdateSchema,
  searchRequeueSchema,
  type EmbeddingSettings,
} from "@maolinc/cc-loom-shared";
import { requireAdmin } from "../lib/auth.js";
import { db, vecAvailable } from "../db/index.js";
import { embeddingSettings, presetFor } from "../lib/embedding-config.js";
import { rebuildIndex } from "../lib/search-indexer.js";
import {
  queueCounts,
  queueItems,
  assetIndexList,
  requeue,
  retryFailed,
  type QueueStatusFilter,
} from "../lib/search-queue.js";

/**
 * 语义搜索设置与管理路由（docs/sqlite-vec-search-design.md §4.1 / §5.7 / §7）。
 *
 * - GET/PUT /api/settings/search：服务级 embedding 配置（admin）。PUT 检测 model/dim
 *   变化自动触发重建（§5.6 模式 B）。
 * - GET /api/settings/search/queue：队列计数汇总（含 rebuilding 标记）
 * - GET /api/settings/search/queue/items：分页列表（过滤已删除/adopted）
 * - GET /api/settings/search/assets：全部能力索引视图（LEFT JOIN，含未索引项；name 搜索 + 构建时间排序）
 * - POST /api/settings/search/requeue：手动重新入队（刷新模式；逐能力「重新构建」复用此端点）
 * - POST /api/settings/search/retry-failed：重试全部失败项
 * - POST /api/settings/search/rebuild：重建向量索引（清空 vec + 全量入队，二次确认）
 *
 * 全部仅 admin 可访问。
 */
const rebuildConfirmSchema = { safeParse: (body: unknown) => {
  const ok = typeof body === "object" && body !== null && (body as any).confirm === true;
  return ok ? { success: true as const, data: {} } : { success: false as const, error: "需传 confirm: true 以确认重建（期间搜索词法降级）" };
} };

export function searchSettingsRoutes(app: FastifyInstance) {
  // ---- 配置读写 ----
  app.get("/api/settings/search", { preHandler: [requireAdmin] }, async (): Promise<{ success: true; data: EmbeddingSettings }> => {
    return { success: true, data: toSettings(embeddingSettings.get()) };
  });

  app.put("/api/settings/search", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = embeddingSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    const patch = parsed.data;
    const current = embeddingSettings.get();

    // 切换 provider 时自动带出对应预设默认值（§4.1）；显式传入的字段覆盖预设
    let toApply = patch;
    if (patch.provider && patch.provider !== current.provider) {
      toApply = { ...presetFor(patch.provider), ...patch };
    }

    // 搜索模式互斥关闭保护：词法/语义至少保留一种。schema refine 只能拦「同一次显式同传 false」，
    // 这里拦合并态——本次关掉一个、另一个本就关——避免落库成「两路全关」的不可搜索配置。
    const merged = { ...current, ...toApply };
    if (!merged.useLexical && !merged.useSemantic) {
      return reply.status(400).send({ success: false, error: "词法与语义不能同时关闭，至少保留一种搜索模式" });
    }

    const updated = embeddingSettings.update(toApply);

    // 模型/维度变化检测（§5.6 模式 B）：已有 ready 行且 model/dim 与新配置不一致 → 重建
    // model 不变则走刷新模式（不在此触发），由 requeue 端点或 content_hash 变化驱动。
    let rebuilt = false;
    if (vecAvailable()) {
      const readyRow = db.prepare(
        "SELECT embed_model, embed_dim FROM asset_embeddings WHERE status = 'ready' LIMIT 1",
      ).get() as { embed_model: string | null; embed_dim: number } | undefined;
      if (readyRow && (readyRow.embed_model !== updated.model || readyRow.embed_dim !== updated.dim)) {
        rebuildIndex();
        rebuilt = true;
      }
    }

    return { success: true, data: toSettings(updated), rebuilt };
  });

  // ---- 队列管理 ----
  app.get("/api/settings/search/queue", { preHandler: [requireAdmin] }, async () => {
    return { success: true, data: queueCounts() };
  });

  app.get("/api/settings/search/queue/items", { preHandler: [requireAdmin] }, async (request, reply) => {
    const q = request.query as { status?: string; page?: string; pageSize?: string };
    const status = (q.status ?? "pending") as QueueStatusFilter;
    if (!["pending", "processing", "ready", "failed", "all"].includes(status)) {
      return reply.status(400).send({ success: false, error: "无效的 status" });
    }
    const page = parseInt(q.page ?? "1", 10) || 1;
    const pageSize = parseInt(q.pageSize ?? "20", 10) || 20;
    return { success: true, data: queueItems(status, page, pageSize) };
  });

  // ---- 全部能力索引视图（name 搜索 + 构建时间排序；过滤已删除/adopted）----
  app.get("/api/settings/search/assets", { preHandler: [requireAdmin] }, async (request) => {
    const q = request.query as { q?: string; page?: string; pageSize?: string; order?: string };
    const page = parseInt(q.page ?? "1", 10) || 1;
    const pageSize = parseInt(q.pageSize ?? "20", 10) || 20;
    const order = q.order === "asc" ? "asc" : "desc";
    return { success: true, data: assetIndexList(page, pageSize, q.q?.trim() ?? "", order) };
  });

  app.post("/api/settings/search/requeue", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = searchRequeueSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    const n = requeue(parsed.data);
    return { success: true, data: { requeued: n } };
  });

  app.post("/api/settings/search/retry-failed", { preHandler: [requireAdmin] }, async () => {
    const n = retryFailed();
    return { success: true, data: { retried: n } };
  });

  // ---- 重建（§5.6 模式 B / §5.7）----
  app.post("/api/settings/search/rebuild", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = rebuildConfirmSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "需传 confirm: true 以确认重建（期间搜索词法降级）" });
    }
    if (!vecAvailable()) {
      return reply.status(409).send({ success: false, error: "sqlite-vec 扩展不可用，无法重建" });
    }
    const result = rebuildIndex();
    return { success: true, data: { ...result, mode: "rebuild" } };
  });
}

/** 配置 → 对外 DTO（剥离明文 apiKey，换 apiKeyConfigured）。 */
function toSettings(cfg: ReturnType<typeof embeddingSettings.get>): EmbeddingSettings {
  const { apiKey: _omit, ...rest } = cfg;
  void _omit;
  return {
    ...rest,
    apiKeyConfigured: embeddingSettings.apiKeyConfigured(),
  };
}
