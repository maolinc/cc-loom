/**
 * Fake /embeddings 服务 — L3 语义搜索用例的外部依赖替身。
 *
 * 返回确定性向量：按 token 匹配 keywordVectors 求和（同义词可映射到同一向量），
 * 未命中的文本用确定性 hash 兜底（避免零向量）。支持注入故障（429/5xx）与延迟，
 * 记录所有请求供断言（input / input_type / 时间戳）。
 *
 * 仅 L3 测试使用；不 mock 被测对象（server 走真实 HTTP 调用它）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";

export type FakeEmbeddingMode = "ok" | "fail-429" | "fail-500";

export interface FakeEmbeddingOptions {
  /** 向量维度，默认 8。需与 server 端配置 dim 一致。 */
  dim?: number;
  /** token → 向量映射（同义词测试：不同词映射同向量）。命中的 token 求和。 */
  keywordVectors?: Record<string, number[]>;
  /** 故障模式，默认 "ok"。 */
  mode?: FakeEmbeddingMode;
  /** 单次请求延迟（ms），用于限频/超时测试。 */
  delayMs?: number;
}

export interface CapturedEmbeddingRequest {
  input: string[];
  inputType?: string;
  model?: string;
  at: number;
}

export interface FakeEmbeddingHandle {
  url: string;
  server: Server;
  requests: CapturedEmbeddingRequest[];
  setMode(mode: FakeEmbeddingMode): void;
  stop(): Promise<void>;
}

export async function startFakeEmbedding(
  opts: FakeEmbeddingOptions = {},
): Promise<FakeEmbeddingHandle> {
  const dim = opts.dim ?? 8;
  const keywordVectors = opts.keywordVectors ?? {};
  let mode: FakeEmbeddingMode = opts.mode ?? "ok";
  const requests: CapturedEmbeddingRequest[] = [];

  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/embeddings")) {
      res.writeHead(404).end();
      return;
    }
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      if (opts.delayMs && opts.delayMs > 0) {
        setTimeout(emit, opts.delayMs);
      } else {
        emit();
      }
      function emit() {
        let body: any;
        try { body = JSON.parse(chunks); } catch { res.writeHead(400).end(); return; }
        const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
        requests.push({
          input,
          inputType: body.input_type,
          model: body.model,
          at: Date.now(),
        });
        if (mode !== "ok") {
          const status = mode === "fail-429" ? 429 : 500;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `fake ${mode}` } }));
          return;
        }
        const data = input.map((text, i) => ({ embedding: vectorFor(text, dim, keywordVectors), index: i }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data, model: body.model ?? "fake", usage: { prompt_tokens: 0, total_tokens: 0 } }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    server,
    requests,
    setMode: (m) => { mode = m; },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** token 匹配 keywordVectors 求和；无命中则 hash 兜底（非零，确定性）。 */
function vectorFor(text: string, dim: number, keywordVectors: Record<string, number[]>): number[] {
  const tokens = text.toLowerCase().split(/[\s,，。、/]+/).filter(Boolean);
  const sum = new Array(dim).fill(0);
  let hit = false;
  for (const tok of tokens) {
    const v = keywordVectors[tok];
    if (v) {
      for (let i = 0; i < dim && i < v.length; i++) sum[i] += v[i]!;
      hit = true;
    }
  }
  if (!hit) {
    // hash 兜底：文本 hash → dim 维非零向量
    const h = createHash("sha256").update(text).digest();
    for (let i = 0; i < dim; i++) sum[i] = (h[i % h.length]! / 255) * 2 - 1;
  }
  // 确保非零向量（cosine 需要非零）
  if (sum.every((v) => v === 0)) sum[0] = 1;
  return sum;
}
