import type { FastifyInstance } from "fastify";
import {
  assetBasicInfoGenerateSchema,
  type ValidatedAssetBasicInfoGenerate,
} from "@maolinc/cc-loom-shared";
import { requireAuth } from "../lib/auth.js";
import { userAiSettings } from "../lib/user-ai-settings.js";
import { generateAssetInfo, AssetInfoGenError } from "../lib/ai-info-generation.js";

const DEFAULT_MODEL = "gpt-4o-mini";

function getAiConfig(userId: string) {
  const config = userAiSettings.get(userId);
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model || DEFAULT_MODEL,
  };
}

export function aiRoutes(app: FastifyInstance) {
  // 编辑页「AI 生成」按钮：每用户配置、同步返回候选回填表单（不写库）。
  // 不生成 name（落盘身份，由作者自填）。生成核心与后台队列 worker 共用
  // ai-info-generation.ts，保证两处 prompt/解析一致。
  app.post("/api/ai/asset-basic-info", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = assetBasicInfoGenerateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const input = parsed.data;
    const hasContext = Boolean(
      input.name.trim()
      || input.alias.trim()
      || input.description.trim()
      || input.tags.length > 0
      || input.files.some((f) => f.path.trim() || f.content.trim()),
    );
    if (!hasContext) {
      return reply.status(400).send({ success: false, error: "请先上传文件或填写一些内容，再使用 AI 生成" });
    }

    const config = getAiConfig(request.user!.userId);
    if (!config.baseUrl || !config.apiKey) {
      return reply.status(400).send({ success: false, error: "请先在设置页配置 AI Base URL 和 API Key" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const generated = await generateAssetInfo(toGenInput(input), config, { signal: controller.signal });
      return { success: true, data: generated };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return reply.status(502).send({ success: false, error: "AI 服务响应超时，请稍后重试" });
      }
      const message = err instanceof AssetInfoGenError
        ? err.message
        : "AI 服务请求失败，请检查配置后重试";
      return reply.status(502).send({ success: false, error: message });
    } finally {
      clearTimeout(timeout);
    }
  });
}

function toGenInput(input: ValidatedAssetBasicInfoGenerate) {
  return {
    type: input.type,
    name: input.name,
    alias: input.alias,
    description: input.description,
    tags: input.tags,
    metadata: input.metadata,
    files: input.files,
  };
}
