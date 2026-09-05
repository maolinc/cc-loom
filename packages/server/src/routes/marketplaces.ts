import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../lib/auth.js";
import { marketplaceService } from "../marketplace/service.js";
import { broadcastToWebClients } from "../ws/gateway.js";
import { marketplaceCreateSchema, marketplaceDeleteQuerySchema, marketplaceUpdateSchema } from "@maolinc/cc-loom-shared";

export function marketplaceRoutes(app: FastifyInstance) {
  app.get("/api/marketplaces", { preHandler: [requireAdmin] }, async () => {
    return { success: true, data: marketplaceService.list() };
  });

  app.post("/api/marketplaces", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = marketplaceCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    const result = await marketplaceService.add({
      repoUrl: parsed.data.repoUrl,
      ref: parsed.data.ref ?? null,
      addedBy: request.user!.email,
      assetTypes: parsed.data.assetTypes,
    });
    if (result.kind === "conflict") {
      return reply.status(409).send({
        success: false, error: `该来源已存在`, existingSourceId: result.existing.id,
      });
    }
    if (result.kind === "invalid") {
      return reply.status(400).send({ success: false, error: result.error });
    }
    broadcastToWebClients("marketplace:source:added", { sourceId: result.source.id });
    return { success: true, data: marketplaceService.get(result.source.id) };
  });

  app.delete("/api/marketplaces/:id", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = marketplaceDeleteQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "查询参数不正确" });
    }
    const id = (request.params as any).id;
    const source = marketplaceService.get(id);
    if (!source) {
      return reply.status(404).send({ success: false, error: "来源不存在" });
    }
    await marketplaceService.remove(id, { keepAssets: parsed.data.keepAssets });
    broadcastToWebClients("marketplace:source:removed", { sourceId: id });
    return { success: true };
  });

  app.post("/api/marketplaces/:id/refresh", { preHandler: [requireAdmin] }, async (request, reply) => {
    const id = (request.params as any).id;
    if (!marketplaceService.get(id)) {
      return reply.status(404).send({ success: false, error: "来源不存在" });
    }
    broadcastToWebClients("marketplace:sync:started", { sourceId: id });
    const result = await marketplaceService.refresh(id);
    broadcastToWebClients(
      result.status === "success" ? "marketplace:sync:completed" : "marketplace:sync:failed",
      { sourceId: id, error: result.error },
    );
    return { success: true, data: result };
  });

  app.get("/api/marketplaces/:id/logs", { preHandler: [requireAdmin] }, async (request, reply) => {
    const id = (request.params as any).id;
    if (!marketplaceService.get(id)) {
      return reply.status(404).send({ success: false, error: "来源不存在" });
    }
    return { success: true, data: marketplaceService.logs(id, 50) };
  });

  // 启用/暂停一个数据源：暂停后调度遍历跳过该源（sourceQueries.listEnabled 过滤）。
  app.patch("/api/marketplaces/:id", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = marketplaceUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    const id = (request.params as any).id;
    const existing = marketplaceService.get(id);
    if (!existing) {
      return reply.status(404).send({ success: false, error: "来源不存在" });
    }
    marketplaceService.setEnabled(id, parsed.data.enabled);
    broadcastToWebClients("marketplace:source:updated", { sourceId: id });
    return { success: true, data: marketplaceService.get(id) };
  });
}
