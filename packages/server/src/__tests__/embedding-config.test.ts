import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import {
  embeddingSettings,
  presetFor,
  DEFAULT_EMBEDDING_CONFIG,
  type EmbeddingProvider,
} from "../lib/embedding-config.js";
import { embeddingSettingsUpdateSchema } from "@maolinc/cc-loom-shared";
import { appSettings } from "../lib/app-settings.js";
import { migrate } from "../db/migrate.js";

// 这些用例直接读写真实（临时）DB 的 app_settings 表——L1 层验证配置可读写、
// provider 预设、加密往返。DB 隔离由 vitest.setup.ts 的 LOOM_DATA_DIR 保证。

beforeAll(() => {
  migrate();
});

beforeEach(() => {
  embeddingSettings.clear();
});

describe("embeddingSettings.get 默认值", () => {
  it("未配置时返回全部默认值且 apiKey 为空", () => {
    const cfg = embeddingSettings.get();
    expect(cfg.enabled).toBe(DEFAULT_EMBEDDING_CONFIG.enabled);
    expect(cfg.useLexical).toBe(true);
    expect(cfg.useSemantic).toBe(true);
    expect(cfg.provider).toBe("nvidia");
    expect(cfg.model).toBe("nvidia/nv-embed-v1");
    expect(cfg.dim).toBe(4096);
    expect(cfg.passageInputType).toBe("passage");
    expect(cfg.queryInputType).toBe("query");
    expect(cfg.extraBody).toEqual({ truncate: "NONE" });
    expect(cfg.weights).toEqual({ name: 0.4, tags: 0.2, description: 0.4 });
    expect(cfg.alpha).toBe(0.4);
    expect(cfg.batchSize).toBe(32);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.backoffBaseMs).toBe(5000);
    expect(cfg.apiKey).toBe("");
    expect(embeddingSettings.apiKeyConfigured()).toBe(false);
  });

  it("返回独立的对象副本，修改不影响后续读取", () => {
    const cfg = embeddingSettings.get();
    cfg.extraBody.foo = "bar";
    cfg.weights.name = 99;
    const cfg2 = embeddingSettings.get();
    expect(cfg2.extraBody).toEqual({ truncate: "NONE" });
    expect(cfg2.weights.name).toBe(0.4);
  });
});

describe("embeddingSettings.update 写读往返", () => {
  it("合并写入部分字段，其余保留默认", () => {
    embeddingSettings.update({ enabled: true, model: "bge-m3", dim: 1024 });
    const cfg = embeddingSettings.get();
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBe("bge-m3");
    expect(cfg.dim).toBe(1024);
    // 未改的保留默认
    expect(cfg.provider).toBe("nvidia");
    expect(cfg.passageInputType).toBe("passage");
  });

  it("weights/extraBody 整体替换", () => {
    embeddingSettings.update({
      weights: { name: 0.5, tags: 0.3, description: 0.2 },
      extraBody: { truncate: "END", foo: 1 },
    });
    const cfg = embeddingSettings.get();
    expect(cfg.weights).toEqual({ name: 0.5, tags: 0.3, description: 0.2 });
    expect(cfg.extraBody).toEqual({ truncate: "END", foo: 1 });
  });

  it("多次 update 累积合并", () => {
    embeddingSettings.update({ enabled: true, alpha: 0.6 });
    embeddingSettings.update({ batchSize: 64 });
    const cfg = embeddingSettings.get();
    expect(cfg.enabled).toBe(true);
    expect(cfg.alpha).toBe(0.6);
    expect(cfg.batchSize).toBe(64);
  });
});

describe("embeddingSettings apiKey 加密", () => {
  it("写入 apiKey 后落库为密文、读取还原明文", () => {
    embeddingSettings.update({ apiKey: "sk-test-123" });
    expect(embeddingSettings.apiKeyConfigured()).toBe(true);
    const cfg = embeddingSettings.get();
    expect(cfg.apiKey).toBe("sk-test-123");
    // 明文不应出现在配置 blob 里
    const blob = appSettings.get("search.embedding.config") ?? "";
    expect(blob).not.toContain("sk-test-123");
  });

  it("apiKey=undefined 保留既有 key", () => {
    embeddingSettings.update({ apiKey: "sk-keep", model: "x" });
    embeddingSettings.update({ enabled: true }); // 不传 apiKey
    const cfg = embeddingSettings.get();
    expect(cfg.apiKey).toBe("sk-keep");
    expect(cfg.model).toBe("x");
    expect(cfg.enabled).toBe(true);
  });

  it("apiKey 空串清除密钥", () => {
    embeddingSettings.update({ apiKey: "sk-clear-me" });
    expect(embeddingSettings.apiKeyConfigured()).toBe(true);
    embeddingSettings.update({ apiKey: "" });
    expect(embeddingSettings.apiKeyConfigured()).toBe(false);
    expect(embeddingSettings.get().apiKey).toBe("");
  });
});

describe("presetFor 提供商预设", () => {
  it("nvidia 预设带出 nv-embed-v1 + 4096 + input_type + truncate", () => {
    expect(presetFor("nvidia")).toEqual({
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "nvidia/nv-embed-v1",
      dim: 4096,
      passageInputType: "passage",
      queryInputType: "query",
      extraBody: { truncate: "NONE" },
    });
  });

  it("openai 预设带出 text-embedding-3-small + 1536 + 空 input_type + 空 extraBody", () => {
    expect(presetFor("openai")).toEqual({
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dim: 1536,
      passageInputType: "",
      queryInputType: "",
      extraBody: {},
    });
  });

  it("custom 预设为空（admin 全自配）", () => {
    expect(presetFor("custom")).toEqual({});
  });

  it("切换 provider 并应用预设后读取一致", () => {
    const provider: EmbeddingProvider = "openai";
    embeddingSettings.update({ provider, ...presetFor(provider) });
    const cfg = embeddingSettings.get();
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("text-embedding-3-small");
    expect(cfg.dim).toBe(1536);
    expect(cfg.passageInputType).toBe("");
    expect(cfg.queryInputType).toBe("");
    expect(cfg.extraBody).toEqual({});
  });
});

describe("默认配置不可变性", () => {
  it("DEFAULT_EMBEDDING_CONFIG.extraBody 不被 update 污染", () => {
    embeddingSettings.update({ extraBody: { polluted: true } });
    expect(DEFAULT_EMBEDDING_CONFIG.extraBody).toEqual({ truncate: "NONE" });
  });
});

describe("搜索模式校验", () => {
  it("schema 拒绝显式同传 useLexical=false + useSemantic=false", () => {
    const r = embeddingSettingsUpdateSchema.safeParse({
      useLexical: false,
      useSemantic: false,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.message).toContain("至少保留一种搜索模式");
    }
  });

  it("schema 接受只关一个（合并态校验由路由层负责）", () => {
    const r = embeddingSettingsUpdateSchema.safeParse({ useSemantic: false });
    expect(r.success).toBe(true);
  });
});
