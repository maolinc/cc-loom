import type { FastifyInstance } from "fastify";
import { requireAdmin, requireAuth } from "../lib/auth.js";
import { marketplaceService } from "../marketplace/service.js";
import { restartScheduler } from "../marketplace/scheduler.js";
import { aiSettingsUpdateSchema, settingsUpdateSchema } from "@maolinc/cc-loom-shared";
import { userAiSettings } from "../lib/user-ai-settings.js";

const DEFAULT_AI_MODEL = "gpt-4o-mini";

export function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings/ai", { preHandler: [requireAuth] }, async (request) => {
    const userId = request.user!.userId;
    const config = userAiSettings.get(userId);
    return {
      success: true,
      data: {
        baseUrl: config.baseUrl,
        model: config.model || DEFAULT_AI_MODEL,
        apiKeyConfigured: userAiSettings.apiKeyConfigured(userId),
      },
    };
  });

  app.put("/api/settings/ai", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = aiSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const userId = request.user!.userId;
    userAiSettings.upsert(userId, {
      baseUrl: parsed.data.baseUrl,
      model: parsed.data.model,
      apiKey: parsed.data.apiKey,
    });

    return {
      success: true,
      data: {
        baseUrl: parsed.data.baseUrl,
        model: parsed.data.model,
        apiKeyConfigured: userAiSettings.apiKeyConfigured(userId),
      },
    };
  });

  app.get("/api/settings/marketplace", { preHandler: [requireAdmin] }, async () => {
    return {
      success: true,
      data: { pollIntervalMinutes: marketplaceService.getPollIntervalMinutes() },
    };
  });

  app.put("/api/settings/marketplace", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = settingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    marketplaceService.setPollIntervalMinutes(parsed.data.pollIntervalMinutes);
    restartScheduler();
    return {
      success: true,
      data: { pollIntervalMinutes: marketplaceService.getPollIntervalMinutes() },
    };
  });
}
