/**
 * Fake /chat/completions 服务 — L3 能力信息生成用例的外部依赖替身（ADR-0005）。
 *
 * 返回固定的 chat completion：content 为一段 JSON 串（GeneratedAssetBasicInfo 形态，
 * 不含 name）。支持注入故障（429/5xx）与延迟，记录所有请求供断言。
 *
 * 仅 L3 测试使用；不 mock 被测对象（server 走真实 HTTP 调用它）。与 fake-embedding 同构。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export type FakeChatMode = "ok" | "fail-429" | "fail-500";

export interface FakeChatOptions {
  /** 默认返回的 chat content（GeneratedAssetBasicInfo JSON 串，不含 name）。 */
  content?: string;
  /** 故障模式，默认 "ok"。 */
  mode?: FakeChatMode;
  /** 单次请求延迟（ms）。 */
  delayMs?: number;
  /** 自定义响应内容生成器（按请求体动态返回，便于按资产名差异化）。 */
  responder?: (body: { model?: string; messages?: Array<{ role: string; content: string }> }) => string;
}

export interface CapturedChatRequest {
  model?: string;
  /** user 消息内容（生成 prompt）。 */
  userMessage?: string;
  at: number;
}

export interface FakeChatHandle {
  url: string;
  server: Server;
  requests: CapturedChatRequest[];
  setMode(mode: FakeChatMode): void;
  /** 运行时切换返回内容（覆盖 content/responder）。 */
  setContent(content: string): void;
  stop(): Promise<void>;
}

/** 默认返回：补全别名/标签/描述 + 一条 env 鉴权绑定。 */
export const DEFAULT_FAKE_CHAT_CONTENT = JSON.stringify({
  alias: "代码审查助手",
  tags: ["审查", "提交前检查", "代码质量"],
  description: "自动审查代码质量与规范，适合提交前检查。",
  auth: { bindings: [{ credentialName: "GITHUB_TOKEN", kind: "env", envKey: "GITHUB_TOKEN" }] },
});

export async function startFakeChat(opts: FakeChatOptions = {}): Promise<FakeChatHandle> {
  let mode: FakeChatMode = opts.mode ?? "ok";
  let content: string = opts.content ?? DEFAULT_FAKE_CHAT_CONTENT;
  const responder = opts.responder;
  const requests: CapturedChatRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      function emit() {
        let body: any;
        try { body = JSON.parse(chunks); } catch { res.writeHead(400).end(); return; }
        const userMsg = Array.isArray(body.messages)
          ? body.messages.find((m: any) => m.role === "user")
          : undefined;
        requests.push({
          model: body.model,
          userMessage: userMsg?.content,
          at: Date.now(),
        });
        if (mode !== "ok") {
          const status = mode === "fail-429" ? 429 : 500;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `fake ${mode}` } }));
          return;
        }
        const reply = responder ? responder(body) : content;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: reply } }],
          model: body.model ?? "fake-chat",
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }));
      }
      if (opts.delayMs && opts.delayMs > 0) setTimeout(emit);
      else emit();
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
    setContent: (c) => { content = c; },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
