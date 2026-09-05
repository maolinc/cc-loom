import { embeddingSettings, type EmbeddingConfig } from "./embedding-config.js";

/**
 * OpenAI 兼容 /embeddings 端点封装（docs/sqlite-vec-search-design.md §4.2）。
 *
 * - 非对称 embedding：索引 mode="passage"（passageInputType）、查询 mode="query"
 *   （queryInputType）；对应 input_type 配置为空串时不发送该字段（兼容 OpenAI 原生）。
 * - 按 batchSize 切片批量请求；响应按 index 对齐输入顺序。
 * - 失败重试：网络错误 / 429 / 5xx 指数退避，最多 maxRetries 次（默认 2）。
 *   4xx（非 429）立即抛出（配置/鉴权错误重试无益）。
 * - 超时 30s（可配）。
 */

export type EmbedMode = "passage" | "query";

export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigError";
  }
}

export class EmbeddingApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingApiError";
  }
}

export interface EmbedOptions {
  /** 瞬时错误（网络/429/5xx）最大重试次数，默认 2（即最多 3 次尝试）。 */
  maxRetries?: number;
  /** 单次请求超时，默认 30000ms。 */
  timeoutMs?: number;
}

interface EmbeddingResponseData {
  embedding?: number[];
  index?: number;
}

interface EmbeddingApiResponse {
  data?: EmbeddingResponseData[];
  error?: { message?: string };
}

function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/embeddings") ? trimmed : `${trimmed}/embeddings`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * 调用 embedding 服务，返回与 texts 顺序对齐的向量数组。
 * 服务未配置（缺 baseUrl/apiKey）时抛 EmbeddingConfigError。
 */
export async function embed(
  texts: string[],
  mode: EmbedMode,
  opts?: EmbedOptions,
): Promise<number[][]> {
  const cfg = embeddingSettings.get();
  if (!cfg.baseUrl || !cfg.apiKey) {
    throw new EmbeddingConfigError("embedding 服务未配置 baseUrl/apiKey");
  }
  const maxRetries = opts?.maxRetries ?? 2;
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const batchSize = Math.max(1, cfg.batchSize);
  const inputType = mode === "passage" ? cfg.passageInputType : cfg.queryInputType;

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await embedBatch(batch, inputType, cfg, maxRetries, timeoutMs);
    results.push(...vectors);
  }
  return results;
}

async function embedBatch(
  batch: string[],
  inputType: string,
  cfg: EmbeddingConfig,
  maxRetries: number,
  timeoutMs: number,
): Promise<number[][]> {
  // extraBody 先铺底，核心字段后置以确保不被覆盖
  const body: Record<string, unknown> = {
    ...cfg.extraBody,
    input: batch,
    model: cfg.model,
    encoding_format: "float",
  };
  if (inputType) body.input_type = inputType;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(cfg.backoffBaseMs * 2 ** (attempt - 1));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(embeddingsUrl(cfg.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as EmbeddingApiResponse | null;

      if (!res.ok) {
        const msg = json?.error?.message ?? `HTTP ${res.status}`;
        if (isTransientStatus(res.status) && attempt < maxRetries) {
          lastError = new Error(msg);
          continue;
        }
        throw new EmbeddingApiError(`embedding 请求失败: ${msg}`);
      }
      return parseEmbeddings(json, batch.length);
    } catch (err) {
      // EmbeddingApiError（含非瞬时 4xx）直接抛出，不重试
      if (err instanceof EmbeddingApiError) throw err;
      if (attempt < maxRetries) {
        lastError = err;
        continue;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new EmbeddingApiError("embedding 请求超时");
      }
      throw new EmbeddingApiError(
        `embedding 请求失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  // 循环内每条路径都已 return 或 throw，到达此处说明重试耗尽
  throw new EmbeddingApiError(
    `embedding 请求多次失败: ${lastError instanceof Error ? lastError.message : "未知错误"}`,
  );
}

function parseEmbeddings(json: EmbeddingApiResponse | null, expected: number): number[][] {
  const data = json?.data;
  if (!Array.isArray(data)) {
    throw new EmbeddingApiError("embedding 响应缺少 data 数组");
  }
  const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = sorted.map((d) => d.embedding);
  if (vectors.length !== expected || vectors.some((v) => !Array.isArray(v))) {
    throw new EmbeddingApiError("embedding 响应向量数与输入不匹配");
  }
  return vectors as number[][];
}
