import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  aiGenSettings,
  aiGenPresetFor,
  DEFAULT_AI_GEN_CONFIG,
} from "../lib/ai-generation-config.js";
import { aiGenSettingsUpdateSchema } from "@maolinc/cc-loom-shared";
import { appSettings } from "../lib/app-settings.js";
import { migrate } from "../db/migrate.js";

// L1：直接读写真实（临时）DB 的 app_settings 表——验证服务级配置可读写、
// provider 预设、加密往返。DB 隔离由 vitest.setup.ts 的 LOOM_DATA_DIR 保证。

beforeAll(() => { migrate(); });
beforeEach(() => { aiGenSettings.clear(); });

describe("aiGenSettings 默认值", () => {
  it("未配置时返回全部默认值且 apiKey 为空", () => {
    const cfg = aiGenSettings.get();
    expect(cfg.enabled).toBe(DEFAULT_AI_GEN_CONFIG.enabled);
    expect(cfg.provider).toBe("openai");
    expect(cfg.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.concurrency).toBe(1);
    expect(cfg.minIntervalMs).toBe(0);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.backoffBaseMs).toBe(5000);
    expect(cfg.apiKey).toBe("");
  });
});

describe("aiGenSettings.update / get 往返", () => {
  it("update 写入非密钥字段 + 加密 apiKey，get 还原明文", () => {
    aiGenSettings.update({
      enabled: true,
      baseUrl: "https://x/v1",
      model: "m",
      apiKey: "sk-secret",
      concurrency: 2,
    });
    const cfg = aiGenSettings.get();
    expect(cfg.enabled).toBe(true);
    expect(cfg.baseUrl).toBe("https://x/v1");
    expect(cfg.model).toBe("m");
    expect(cfg.concurrency).toBe(2);
    expect(cfg.apiKey).toBe("sk-secret");
    // 明文不落库（blob 与 cipher 均不含明文）
    expect(appSettings.get("ai.generation.config") ?? "").not.toContain("sk-secret");
  });

  it("apiKey undefined=保留既有；空串=清除", () => {
    aiGenSettings.update({ apiKey: "sk-1" });
    aiGenSettings.update({ concurrency: 3 }); // 不带 apiKey
    expect(aiGenSettings.get().apiKey).toBe("sk-1");
    aiGenSettings.update({ apiKey: "" }); // 清除
    expect(aiGenSettings.get().apiKey).toBe("");
    expect(aiGenSettings.apiKeyConfigured()).toBe(false);
  });

  it("apiKeyConfigured 仅判断密文存在", () => {
    expect(aiGenSettings.apiKeyConfigured()).toBe(false);
    aiGenSettings.update({ apiKey: "sk-2" });
    expect(aiGenSettings.apiKeyConfigured()).toBe(true);
  });
});

describe("provider 预设", () => {
  it("openai 预设带出默认 baseUrl/model；custom 为空", () => {
    expect(aiGenPresetFor("openai").baseUrl).toBe("https://api.openai.com/v1");
    expect(aiGenPresetFor("openai").model).toBe("gpt-4o-mini");
    expect(aiGenPresetFor("custom")).toEqual({});
  });
});

describe("aiGenSettingsUpdateSchema", () => {
  it("拒绝未知字段（strict）", () => {
    const r = aiGenSettingsUpdateSchema.safeParse({ batchSize: 5 });
    expect(r.success).toBe(false);
  });
  it("provider 只接受 openai | custom", () => {
    expect(aiGenSettingsUpdateSchema.safeParse({ provider: "nvidia" }).success).toBe(false);
    expect(aiGenSettingsUpdateSchema.safeParse({ provider: "custom" }).success).toBe(true);
  });
});
