import { db } from "../db/index.js";
import { encryptSecret, decryptSecret } from "./crypto.js";

/**
 * 每用户一份的 AI 生成配置（设置页 → AI 基础信息生成）。
 *
 * 与全局 app_settings 对称，但按 user_id 隔离：每个用户配置自己的 AI Base URL /
 * 模型 / API Key，互不影响。API Key 用 AES-256-GCM 加密存储（复用 env_vars 的
 * master.key），明文永不落 DB。
 */
export interface UserAiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const userAiSettings = {
  /** 读取某用户的 AI 配置；未配置时返回空串（model 默认值由调用方决定）。 */
  get(userId: string): UserAiConfig {
    const row = db
      .prepare("SELECT base_url, model, api_key_cipher FROM user_ai_settings WHERE user_id = ?")
      .get(userId) as { base_url: string; model: string; api_key_cipher: string } | undefined;
    if (!row) return { baseUrl: "", model: "", apiKey: "" };
    return {
      baseUrl: row.base_url ?? "",
      model: row.model ?? "",
      apiKey: row.api_key_cipher ? decryptSecret(row.api_key_cipher) : "",
    };
  },

  /** API Key 是否已配置（不解密，仅判断密文是否存在）。 */
  apiKeyConfigured(userId: string): boolean {
    const row = db
      .prepare("SELECT api_key_cipher FROM user_ai_settings WHERE user_id = ?")
      .get(userId) as { api_key_cipher: string } | undefined;
    return Boolean(row?.api_key_cipher);
  },

  /**
   * 写入某用户的 AI 配置。
   * apiKey 为 undefined 时保留既有 Key（允许只改 baseUrl/model）；为空串则清除。
   */
  upsert(userId: string, data: { baseUrl: string; model: string; apiKey?: string }): void {
    const apiKey =
      data.apiKey !== undefined ? data.apiKey : this.get(userId).apiKey;
    const apiKeyCipher = apiKey ? encryptSecret(apiKey) : "";
    db.prepare(`
      INSERT INTO user_ai_settings (user_id, base_url, model, api_key_cipher, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        base_url = excluded.base_url,
        model = excluded.model,
        api_key_cipher = excluded.api_key_cipher,
        updated_at = excluded.updated_at
    `).run(userId, data.baseUrl, data.model, apiKeyCipher, new Date().toISOString());
  },
};
