import { appSettings } from "./app-settings.js";
import { encryptSecret, decryptSecret } from "./crypto.js";

/**
 * 服务级能力信息生成配置（ADR-0005）。
 *
 * 区别于每用户的 user_ai_settings：本配置供后台队列 worker 使用，全站共用、
 * admin 维护。marketplace 调度器触发的生成无用户上下文，必须走服务级。存 app_settings。
 *
 * 与 embedding-config 同构：非密钥字段合并为单条 JSON（键 `ai.generation.config`），
 * 密钥单独加密存（键 `ai.generation.api_key_cipher`，AES-256-GCM，明文不落 DB）。
 *
 * 与 embedding-config 的差异：chat 一资产一调用，无 batchSize；无 dim/weights/alpha/
 * inputType/extraBody 等向量专有字段。temperature 固定 0.4（生成质量参数，非调度旋钮）。
 */

export type AiGenProvider = "openai" | "custom";

export interface AiGenConfig {
  /** 总开关。关闭后 worker 停止消费、写入不再入队；队列与已生成结果保留。 */
  enabled: boolean;
  provider: AiGenProvider;
  baseUrl: string;
  /** 明文仅存内存；落库为 api_key_cipher 密文。 */
  apiKey: string;
  model: string;
  /** 打开后 worker 处理时无条件覆盖 alias/tags/description/auth.bindings（含新建首次），
   *  而非补缺口。用于「用更好模型/提示重算全部描述性字段」；关闭则只填空字段（补缺口，ADR-0005）。 */
  overwrite: boolean;
  /** 队列消费并发数；默认 1 规避接口限频。 */
  concurrency: number;
  /** 两次生成请求间的最小间隔（ms）；RPM 限频时设置。 */
  minIntervalMs: number;
  /** 单条队列项失败时的最大总尝试次数（worker 层；含首次，故 maxAttempts=3 → 共 3 次、2 次重试）。 */
  maxAttempts: number;
  /** 失败重试指数退避基数（next_attempt_at = now + base × 2^attempts）。 */
  backoffBaseMs: number;
}

const CONFIG_KEY = "ai.generation.config";
const API_KEY_CIPHER_KEY = "ai.generation.api_key_cipher";

export const DEFAULT_AI_GEN_CONFIG: AiGenConfig = {
  enabled: false,
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  overwrite: false,
  concurrency: 1,
  minIntervalMs: 0,
  maxAttempts: 3,
  backoffBaseMs: 5000,
};

/**
 * 提供商预设默认值。切换 provider 时设置页据此带出对应默认值，admin 可覆盖。
 * `custom` 无预设——完全由 admin 配置。
 */
export const AI_GEN_PROVIDER_PRESETS: Record<AiGenProvider, Partial<AiGenConfig>> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  custom: {},
};

/** 取某 provider 的预设默认值（供设置页切换时带出）。 */
export function aiGenPresetFor(provider: AiGenProvider): Partial<AiGenConfig> {
  return { ...AI_GEN_PROVIDER_PRESETS[provider] };
}

function mergeConfig(stored: Partial<AiGenConfig> | null): AiGenConfig {
  if (!stored) return { ...DEFAULT_AI_GEN_CONFIG };
  return {
    ...DEFAULT_AI_GEN_CONFIG,
    ...stored,
    apiKey: "", // apiKey 单独解密填充，不来自 blob
  };
}

export const aiGenSettings = {
  /** 读取服务级配置；未配置项用默认值补齐。 */
  get(): AiGenConfig {
    const raw = appSettings.get(CONFIG_KEY);
    let stored: Partial<AiGenConfig> | null = null;
    if (raw) {
      try { stored = JSON.parse(raw) as Partial<AiGenConfig>; } catch { stored = null; }
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
   */
  update(patch: Partial<AiGenConfig>): AiGenConfig {
    const current = this.get();
    const next: AiGenConfig = {
      ...current,
      ...patch,
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

  /** 清空全部配置（仅测试/重置用）。 */
  clear(): void {
    appSettings.set(CONFIG_KEY, "");
    appSettings.set(API_KEY_CIPHER_KEY, "");
  },
};

function safeDecrypt(cipher: string): string {
  try { return decryptSecret(cipher); } catch { return ""; }
}
