import type { FastifyInstance } from "fastify";
import {
  aiGenSettingsUpdateSchema,
  aiInfoRequeueSchema,
  type AiGenSettings,
} from "@maolinc/cc-loom-shared";
import { requireAdmin } from "../lib/auth.js";
import { aiGenSettings, aiGenPresetFor } from "../lib/ai-generation-config.js";
import {
  queueCounts,
  queueItems,
  assetInfoList,
  requeue,
  retryFailed,
  type AiInfoQueueStatusFilter,
} from "../lib/ai-info-queue.js";

/**
 * 能力信息生成设置与管理路由（ADR-0005，镜像 search-settings.ts）。
 *
 * - GET/PUT /api/settings/ai-gen：服务级生成配置（admin）。无 rebuild——补缺口模型下
 *   切 chat 模型不需重建（旧文本仍有效，新生成用新模型）。
 * - GET /api/settings/ai-gen/queue：队列计数汇总
 * - GET /api/settings/ai-gen/queue/items：分页列表（过滤已删除/adopted）
 * - GET /api/settings/ai-gen/assets：全部能力生成视图（LEFT JOIN，含未入队项）
 * - POST /api/settings/ai-gen/requeue：手动重新入队（重扫空缺）
 * - POST /api/settings/ai-gen/retry-failed：重试全部失败项
 *
 * 全部仅 admin 可访问（此功能仅管理员）。
 */
export function aiGenSettingsRoutes(app: FastifyInstance) {
  // ---- 配置读写 ----
  app.get("/api/settings/ai-gen", { preHandler: [requireAdmin] }, async (): Promise<{ success: true; data: AiGenSettings }> => {
    return { success: true, data: toSettings(aiGenSettings.get()) };
  });

  app.put("/api/settings/ai-gen", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = aiGenSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    const patch = parsed.data;
    const current = aiGenSettings.get();

    // 切换 provider 时自动带出对应预设默认值；显式传入的字段覆盖预设
    let toApply = patch;
    if (patch.provider && patch.provider !== current.provider) {
      toApply = { ...aiGenPresetFor(patch.provider), ...patch };
    }

    const updated = aiGenSettings.update(toApply);
    return { success: true, data: toSettings(updated) };
  });

  // ---- 队列管理 ----
  app.get("/api/settings/ai-gen/queue", { preHandler: [requireAdmin] }, async () => {
    return { success: true, data: queueCounts() };
  });

  app.get("/api/settings/ai-gen/queue/items", { preHandler: [requireAdmin] }, async (request, reply) => {
    const q = request.query as { status?: string; page?: string; pageSize?: string };
    const status = (q.status ?? "pending") as AiInfoQueueStatusFilter;
    if (!["pending", "processing", "ready", "failed", "all"].includes(status)) {
      return reply.status(400).send({ success: false, error: "无效的 status" });
    }
    const page = parseInt(q.page ?? "1", 10) || 1;
    const pageSize = parseInt(q.pageSize ?? "20", 10) || 20;
    return { success: true, data: queueItems(status, page, pageSize) };
  });

  // ---- 全部能力生成视图（name 搜索 + 处理时间排序；过滤已删除/adopted）----
  app.get("/api/settings/ai-gen/assets", { preHandler: [requireAdmin] }, async (request) => {
    const q = request.query as { q?: string; page?: string; pageSize?: string; order?: string };
    const page = parseInt(q.page ?? "1", 10) || 1;
    const pageSize = parseInt(q.pageSize ?? "20", 10) || 20;
    const order = q.order === "asc" ? "asc" : "desc";
    return { success: true, data: assetInfoList(page, pageSize, q.q?.trim() ?? "", order) };
  });

  app.post("/api/settings/ai-gen/requeue", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = aiInfoRequeueSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    const n = requeue(parsed.data);
    return { success: true, data: { requeued: n } };
  });

  app.post("/api/settings/ai-gen/retry-failed", { preHandler: [requireAdmin] }, async () => {
    const n = retryFailed();
    return { success: true, data: { retried: n } };
  });
}

/** 配置 → 对外 DTO（剥离明文 apiKey，换 apiKeyConfigured）。 */
function toSettings(cfg: ReturnType<typeof aiGenSettings.get>): AiGenSettings {
  const { apiKey: _omit, ...rest } = cfg;
  void _omit;
  return {
    ...rest,
    apiKeyConfigured: aiGenSettings.apiKeyConfigured(),
  };
}
