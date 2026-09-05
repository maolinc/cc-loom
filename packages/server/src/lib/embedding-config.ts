import { appSettings } from "./app-settings.js";
import { encryptSecret, decryptSecret } from "./crypto.js";

/**
 * 服务级 Embedding 配置（docs/sqlite-vec-search-design.md §4.1）。
 *
 * 区别于每用户的 user_ai_settings：embedding 是服务端后台任务、需对匿名请求
 * 生效，故为全站共用的服务级配置，admin 维护。存 app_settings 表。
 *
 * 存储取舍：设计文档列了 ~15 个 `search.embedding.*` 键，但 admin 总是整体编辑
 * 一份配置、无需按键部分更新。故非密钥字段合并为单条 JSON（键 `search.embedding.config`），
 * 密钥单独加密存（键 `search.embedding.api_key_cipher`，AES-256-GCM，明文不落 DB）。
 * 单条 JSON 读写原子、测试简单，语义与逐键等价。
 */

export type EmbeddingProvider = "nvidia" | "openai" | "custom";

export interface EmbeddingWeights {
  name: number;
  tags: number;
  description: number;
}

export interface EmbeddingConfig {
  /** 向量存储/索引总开关。关闭后 worker 停止消费、写入不入队；不再决定搜索走哪条路（由 useLexical/useSemantic 决定）。 */
  enabled: boolean;
  /** 搜索模式：启用词法路（FTS5 BM25）。与 useSemantic 至少一个为 true。 */
  useLexical: boolean;
  /** 搜索模式：启用语义路（vec KNN，需 enabled 且向量可用）。与 useLexical 至少一个为 true。 */
  useSemantic: boolean;
  /** 提供商预设：决定默认值与特有字段（input_type / truncate）。 */
  provider: EmbeddingProvider;
  baseUrl: string;
  /** 明文仅存在于内存；落库为 api_key_cipher 密文。 */
  apiKey: string;
  model: string;
  /** 向量维度，建 vec0 表/校验用。 */
  dim: number;
  /** 索引时的 input_type 值；空串=不发该字段（兼容 OpenAI 原生）。 */
  passageInputType: string;
  /** 查询时的 input_type 值；空串=不发该字段。 */
  queryInputType: string;
  /** 透传的 provider 特有请求体字段（如 NVIDIA 的 truncate）。 */
  extraBody: Record<string, unknown>;
  weights: EmbeddingWeights;
  /** 词法/语义融合比 α。 */
  alpha: number;
  /** 语义相似度阈值（cosine similarity = 1 - distance）：vec KNN 仅纳入 ≥ 此值者，丢弃弱匹配。
   *  调高 → 召回更少更聚焦；调低 → 召回更宽。0 = 不过滤。默认 0.3。 */
  simThreshold: number;
  batchSize: number;
  /** 队列消费并发数；默认 1 规避接口限频。 */
  concurrency: number;
  /** 两次 embedding 请求间的最小间隔（ms）；RPM 限频时设置。 */
  minIntervalMs: number;
  /** 单条队列项失败时的最大总尝试次数（worker 层；含首次，故 maxAttempts=3 → 共 3 次、2 次重试）。 */
  maxAttempts: number;
  /** 失败重试指数退避基数（next_attempt_at = now + base × 2^attempts）。 */
  backoffBaseMs: number;
}

const CONFIG_KEY = "search.embedding.config";
const API_KEY_CIPHER_KEY = "search.embedding.api_key_cipher";

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: false,
  useLexical: true,
  useSemantic: true,
  provider: "nvidia",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  apiKey: "",
  model: "nvidia/nv-embed-v1",
  dim: 4096,
  passageInputType: "passage",
  queryInputType: "query",
  extraBody: { truncate: "NONE" },
  weights: { name: 0.4, tags: 0.2, description: 0.4 },
  alpha: 0.4,
  simThreshold: 0.3,
  batchSize: 32,
  concurrency: 1,
  minIntervalMs: 0,
  maxAttempts: 3,
  backoffBaseMs: 5000,
};

/**
 * 提供商预设默认值（§4.1 提供商预设语义）。
 * 切换 provider 时设置页据此带出对应默认值，admin 可再覆盖。
 * `custom` 无预设——完全由 admin 配置。
 */
export const PROVIDER_PRESETS: Record<EmbeddingProvider, Partial<EmbeddingConfig>> = {
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nv-embed-v1",
    dim: 4096,
    passageInputType: "passage",
    queryInputType: "query",
    extraBody: { truncate: "NONE" },
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dim: 1536,
    // OpenAI 原生模型不使用 input_type
    passageInputType: "",
    queryInputType: "",
    extraBody: {},
  },
  custom: {},
};

/** 取某 provider 的预设默认值（供设置页切换时带出）。 */
export function presetFor(provider: EmbeddingProvider): Partial<EmbeddingConfig> {
  return { ...PROVIDER_PRESETS[provider] };
}

function mergeConfig(stored: Partial<EmbeddingConfig> | null): EmbeddingConfig {
  if (!stored) {
    return {
      ...DEFAULT_EMBEDDING_CONFIG,
      extraBody: { ...DEFAULT_EMBEDDING_CONFIG.extraBody },
      weights: { ...DEFAULT_EMBEDDING_CONFIG.weights },
    };
  }
  // 顶层缺字段用默认补；extraBody/weights 显式提供时（含空对象）原样使用，
  // 不与默认深合并——否则 openai 的空 extraBody 会被 nvidia 默认 {truncate} 污染。
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...stored,
    extraBody: stored.extraBody ? { ...stored.extraBody } : { ...DEFAULT_EMBEDDING_CONFIG.extraBody },
    weights: stored.weights ? { ...stored.weights } : { ...DEFAULT_EMBEDDING_CONFIG.weights },
    apiKey: "", // apiKey 单独解密填充，不来自 blob
  };
}

export const embeddingSettings = {
  /** 读取服务级配置；未配置项用默认值补齐。 */
  get(): EmbeddingConfig {
    const raw = appSettings.get(CONFIG_KEY);
    let stored: Partial<EmbeddingConfig> | null = null;
    if (raw) {
      try { stored = JSON.parse(raw) as Partial<EmbeddingConfig>; } catch { stored = null; }
    }
    const cfg = mergeConfig(stored);
    const cipher = appSettings.get(API_KEY_CIPHER_KEY);
    cfg.apiKey = cipher ? safeDecrypt(cipher) : "";
    return cfg;
  },

  /** API Key 是否已配置（不解密，仅判断密文存在）。 */
  apiKeyConfigured(): boolean {
    return Boolean(appSettings.get(API_KEY_CIPHER_KEY));
  },

  /**
   * 合并写入配置。
   * apiKey：undefined=保留既有；空串=清除；非空=加密落库。
   * weights/extraBody 提供时整体替换。
   */
  update(patch: Partial<EmbeddingConfig>): EmbeddingConfig {
    const current = this.get();
    const next: EmbeddingConfig = {
      ...current,
      ...patch,
      extraBody: patch.extraBody ? { ...patch.extraBody } : current.extraBody,
      weights: patch.weights ? { ...patch.weights } : current.weights,
      apiKey: current.apiKey, // 不把明文 apiKey 写进 blob
    };

    // 落库非密钥字段（剔除 apiKey）
    const { apiKey: _omit, ...persist } = next;
    void _omit;
    appSettings.set(CONFIG_KEY, JSON.stringify(persist));

    // 处理 apiKey
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === "") {
        appSettings.set(API_KEY_CIPHER_KEY, "");
      } else {
        appSettings.set(API_KEY_CIPHER_KEY, encryptSecret(patch.apiKey));
        next.apiKey = patch.apiKey;
      }
    }
    return next;
  },

  /** 清空全部 embedding 配置（仅测试/重置用）。 */
  clear(): void {
    appSettings.set(CONFIG_KEY, "");
    appSettings.set(API_KEY_CIPHER_KEY, "");
  },
};

function safeDecrypt(cipher: string): string {
  try { return decryptSecret(cipher); } catch { return ""; }
}
