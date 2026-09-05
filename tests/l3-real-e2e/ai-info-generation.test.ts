/**
 * L3 能力信息生成队列 — 端到端（ADR-0005，镜像 search-semantic.test.ts）。
 *
 * 真实 server 进程 + 真实 HTTP + fake /chat/completions 服务（返回固定
 * GeneratedAssetBasicInfo JSON，不含 name）。不 mock 被测对象。
 *
 * 覆盖：补缺口（空 alias/tags 被填）、已满字段不覆盖、失败重试、持续失败转 failed、
 * 编辑清空字段触发重填、已删除能力队列清理、全部能力视图+待补字段标注+admin 门禁、
 * 跨系统（ai-info 补空 alias → 向量重算 → 语义搜索经同义词命中）。
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import {
  startServer, stopServer, startFakeChat, startFakeEmbedding,
  type ServerHandle, type FakeChatHandle, type FakeEmbeddingHandle,
} from "@maolinc/cc-loom-testkit";
import { login, request, parseJson } from "./_http.js";

// 测试专用：worker 快速轮询（docker 已设；本地 L3 也生效，singleFork 下持久）
beforeAll(() => {
  process.env.LOOM_AI_INFO_WORKER_TICK_MS = "200";
  process.env.LOOM_SEARCH_WORKER_TICK_MS = "200";
});

const ADMIN_EMAIL = "admin@loom.test";
const ADMIN_PASSWORD = "test-admin-password";
const DIM = 8;

// 跨系统用同义词向量：前端/alpha/first → [1,0,...]，react → [1,0,...]（同义词）
const KEYWORD_VECTORS: Record<string, number[]> = {
  前端: [1, 0, 0, 0, 0, 0, 0, 0],
  alpha: [1, 0, 0, 0, 0, 0, 0, 0],
  first: [1, 0, 0, 0, 0, 0, 0, 0],
  react: [1, 0, 0, 0, 0, 0, 0, 0],
};

/** 跨系统用：AI 返回含多个关键词的 alias（向量强化，规避 hash 噪声）。 */
const CROSS_AI_CONTENT = JSON.stringify({
  alias: "前端 alpha first",
  tags: ["跨系统"],
  description: "跨系统触发验证用。",
});

interface Ctx {
  server: ServerHandle;
  cookie: string;
  fake: FakeChatHandle;
  emb?: FakeEmbeddingHandle;
}

/** 仅启动 ai-info（不含 embedding）。 */
async function bootAi(over: { mode?: "ok" | "fail-429" | "fail-500"; content?: string; maxAttempts?: number; backoffBaseMs?: number; overwrite?: boolean } = {}): Promise<Ctx> {
  const server = await startServer();
  const cookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  const fake = await startFakeChat({ mode: over.mode ?? "ok", content: over.content });
  await putAiConfig(server.baseUrl, cookie, {
    enabled: true,
    provider: "custom",
    baseUrl: fake.url,
    apiKey: "sk-fake",
    model: "fake-chat",
    overwrite: over.overwrite ?? false,
    concurrency: 4,
    minIntervalMs: 0,
    maxAttempts: over.maxAttempts ?? 3,
    backoffBaseMs: over.backoffBaseMs ?? 10,
  });
  return { server, cookie, fake };
}

/** 启动 ai-info + embedding（跨系统用例）。 */
async function bootBoth(): Promise<Ctx> {
  const server = await startServer();
  const cookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  const fake = await startFakeChat({ content: CROSS_AI_CONTENT });
  const emb = await startFakeEmbedding({ dim: DIM, keywordVectors: KEYWORD_VECTORS });
  // 先配 embedding 并重建 asset_vec 到 dim=8
  await request(server.baseUrl, "PUT", "/api/settings/search", {
    cookie,
    body: { enabled: true, useLexical: true, useSemantic: true, baseUrl: emb.url, apiKey: "sk-fake", model: "fake-emb", dim: DIM, weights: { name: 0.4, tags: 0.2, description: 0.4 }, alpha: 0.4, simThreshold: 0.3, batchSize: 32, concurrency: 4, minIntervalMs: 0, maxAttempts: 3, backoffBaseMs: 10 },
  });
  const rb = await request(server.baseUrl, "POST", "/api/settings/search/rebuild", { cookie, body: { confirm: true } });
  expect(rb.status).toBe(200);
  // ai-gen 暂不启用——先让资产按「无 alias」建好向量，再启用 ai-gen 触发重算
  return { server, cookie, fake, emb };
}

async function putAiConfig(baseUrl: string, cookie: string, cfg: Record<string, unknown>): Promise<void> {
  const res = await request(baseUrl, "PUT", "/api/settings/ai-gen", { cookie, body: cfg });
  expect(res.status).toBe(200);
}

async function createSkill(server: ServerHandle, cookie: string, over: { name: string; description?: string; tags?: string[]; alias?: string; visibility?: "public" | "private" }): Promise<string> {
  const res = await request(server.baseUrl, "POST", "/api/assets", {
    cookie,
    body: {
      name: over.name, type: "skill",
      description: over.description ?? "默认描述",
      tags: over.tags ?? [],
      ...(over.alias !== undefined ? { alias: over.alias } : {}),
      compatibleTools: ["cursor"],
      visibility: over.visibility ?? "public",
      files: [{ path: "SKILL.md", content: `# ${over.name}` }],
    },
  });
  expect(res.status).toBe(200);
  const body = await parseJson<any>(res);
  return body.data.id;
}

async function getAsset(server: ServerHandle, cookie: string, id: string): Promise<any> {
  const res = await request(server.baseUrl, "GET", `/api/assets/${id}`, { cookie });
  expect(res.status).toBe(200);
  return (await parseJson<any>(res)).data;
}

async function queueCounts(server: ServerHandle, cookie: string): Promise<any> {
  const res = await request(server.baseUrl, "GET", "/api/settings/ai-gen/queue", { cookie });
  return (await parseJson<any>(res)).data;
}

async function queueItems(server: ServerHandle, cookie: string, status: string): Promise<any[]> {
  const res = await request(server.baseUrl, "GET", `/api/settings/ai-gen/queue/items?status=${status}&page=1&pageSize=100`, { cookie });
  return (await parseJson<any>(res)).data.items ?? [];
}

async function assetInfoList(server: ServerHandle, cookie: string, q: string): Promise<{ items: any[]; total: number }> {
  const params = new URLSearchParams({ page: "1", pageSize: "100", order: "desc" });
  if (q) params.set("q", q);
  const res = await request(server.baseUrl, "GET", `/api/settings/ai-gen/assets?${params.toString()}`, { cookie });
  expect(res.status).toBe(200);
  const body = await parseJson<any>(res);
  return { items: body.data.items ?? [], total: body.data.total ?? 0 };
}

async function search(server: ServerHandle, cookie: string | null, query: string): Promise<any[]> {
  const res = await request(server.baseUrl, "GET", `/api/assets?query=${encodeURIComponent(query)}`, cookie ? { cookie } : {});
  expect(res.status).toBe(200);
  const body = await parseJson<any>(res);
  return body.data ?? [];
}

/** 取某能力在语义搜索侧的 processed_at（用于判定向量是否重算过）。 */
async function searchProcessedAt(server: ServerHandle, cookie: string, id: string): Promise<string | null> {
  const res = await request(server.baseUrl, "GET", `/api/settings/search/assets?page=1&pageSize=100&order=desc`, { cookie });
  const body = await parseJson<any>(res);
  const it = (body.data.items ?? []).find((x: any) => x.assetId === id);
  return it?.processedAt ?? null;
}

async function poll(predicate: () => Promise<boolean>, timeoutMs = 20000, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("poll 超时");
}

async function awaitStatus(ctx: Ctx, assetId: string, status: "ready" | "failed" | "pending"): Promise<void> {
  await poll(async () => {
    const items = await queueItems(ctx.server, ctx.cookie, status);
    return items.some((it: any) => it.assetId === assetId);
  });
}

describe("L3 能力信息生成队列", () => {
  let ctx: Ctx | null = null;
  afterEach(async () => {
    if (ctx) {
      if (ctx.emb) await ctx.emb.stop();
      if (ctx.fake) await ctx.fake.stop();
      await stopServer(ctx.server);
      ctx = null;
    }
  });

  it("补缺口：空 alias/tags 被填，已有 description 不动 + auth 首次补全", async () => {
    ctx = await bootAi();
    const id = await createSkill(ctx.server, ctx.cookie, { name: "gap_skill", description: "保留的描述", tags: [] });
    await awaitStatus(ctx, id, "ready");

    const a = await getAsset(ctx.server, ctx.cookie, id);
    expect(a.alias).toBe("代码审查助手"); // AI 补
    expect(a.tags).toEqual(["审查", "提交前检查", "代码质量"]); // AI 补
    expect(a.description).toBe("保留的描述"); // 已有，不动
    // auth 首次补全：一条 env 绑定
    expect(a.auth?.bindings ?? []).toHaveLength(1);
    expect(a.auth.bindings[0]).toMatchObject({ credentialName: "GITHUB_TOKEN", kind: "env" });
  });

  it("已满字段不被覆盖（gap-fill 核心不变量）", async () => {
    ctx = await bootAi();
    const id = await createSkill(ctx.server, ctx.cookie, {
      name: "full_skill", alias: "已有别名", description: "已有描述", tags: ["已有"],
    });
    await awaitStatus(ctx, id, "ready");
    const a = await getAsset(ctx.server, ctx.cookie, id);
    expect(a.alias).toBe("已有别名");
    expect(a.tags).toEqual(["已有"]);
    expect(a.description).toBe("已有描述");
  });

  it("失败重试：429 → 恢复后 ready", async () => {
    ctx = await bootAi({ mode: "fail-429", maxAttempts: 3, backoffBaseMs: 10 });
    const id = await createSkill(ctx.server, ctx.cookie, { name: "retry_skill", description: "d" });
    await poll(async () => {
      const items = await queueItems(ctx.server, ctx.cookie, "pending");
      const it = items.find((x: any) => x.assetId === id);
      return !!it && it.attempts >= 1;
    });
    ctx.fake.setMode("ok");
    await awaitStatus(ctx, id, "ready");
  });

  it("持续失败至 max_attempts → failed + last_error", async () => {
    ctx = await bootAi({ mode: "fail-500", maxAttempts: 2, backoffBaseMs: 10 });
    const id = await createSkill(ctx.server, ctx.cookie, { name: "doomed_skill", description: "d" });
    await awaitStatus(ctx, id, "failed");
    const items = await queueItems(ctx.server, ctx.cookie, "failed");
    const it = items.find((x: any) => x.assetId === id);
    expect(it).toBeDefined();
    expect(it.lastError).toContain("fake fail-500");
  });

  it("编辑清空字段 → 触发重填（auto 入队）", async () => {
    ctx = await bootAi();
    const id = await createSkill(ctx.server, ctx.cookie, { name: "edit_skill", alias: "原名", description: "d", tags: ["t"] });
    await awaitStatus(ctx, id, "ready");
    // 清空 alias → PUT 触发 enqueueAiInfo('auto')，文本缺口 → 重排 → 重填
    const res = await request(ctx.server.baseUrl, "PUT", `/api/assets/${id}`, {
      cookie: ctx.cookie, body: { alias: "" },
    });
    expect(res.status).toBe(200);
    await awaitStatus(ctx, id, "ready");
    const a = await getAsset(ctx.server, ctx.cookie, id);
    expect(a.alias).toBe("代码审查助手"); // 被重填
  });

  it("已删除能力队列清理：不出现于队列与全部能力视图", async () => {
    ctx = await bootAi();
    const id = await createSkill(ctx.server, ctx.cookie, { name: "del_skill", description: "d" });
    await awaitStatus(ctx, id, "ready");
    await request(ctx.server.baseUrl, "DELETE", `/api/assets/${id}`, { cookie: ctx.cookie });
    await poll(async () => {
      const ready = await queueItems(ctx.server, ctx.cookie, "ready");
      return !ready.some((x: any) => x.assetId === id);
    });
    const all = await assetInfoList(ctx.server, ctx.cookie, "");
    expect(all.items.map((x: any) => x.assetId)).not.toContain(id);
  });

  it("全部能力视图：列出全部 + 待补字段标注 + admin 门禁", async () => {
    ctx = await bootAi();
    const a = await createSkill(ctx.server, ctx.cookie, { name: "alpha_skill", description: "d", tags: [] }); // alias 空、tags 空
    const b = await createSkill(ctx.server, ctx.cookie, { name: "beta_skill", alias: "已有", description: "d", tags: ["t"] });
    await awaitStatus(ctx, a, "ready");
    await awaitStatus(ctx, b, "ready");

    const all = await assetInfoList(ctx.server, ctx.cookie, "");
    const ids = all.items.map((x: any) => x.assetId);
    expect(ids).toContain(a);
    expect(ids).toContain(b);

    // a 处理后 alias/tags 已被补 → 不再标记待补；b 各字段已满
    const aItem = all.items.find((x: any) => x.assetId === a);
    expect(aItem.status).toBe("ready");
    expect(aItem.aliasEmpty).toBe(false);
    expect(aItem.tagsEmpty).toBe(false);

    // name 搜索 "beta"：仅 b
    const filtered = await assetInfoList(ctx.server, ctx.cookie, "beta");
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].assetId).toBe(b);

    // admin 门禁：未登录 → 401
    const noAuth = await request(ctx.server.baseUrl, "GET", "/api/settings/ai-gen/assets", {});
    expect(noAuth.status).toBe(401);
  });

  it("overwrite 开关：覆盖已有文本字段 + 重建 auth（含首次）", async () => {
    const OVER_CONTENT = JSON.stringify({
      alias: "AI 别名", tags: ["AI 标签"], description: "AI 描述",
      auth: { bindings: [{ credentialName: "GITHUB_TOKEN", kind: "env", envKey: "GITHUB_TOKEN" }] },
    });
    ctx = await bootAi({ content: OVER_CONTENT, overwrite: true });
    // 创建时各字段已满 + 一条人工 env 绑定 ORIGINAL_TOKEN
    const res = await request(ctx.server.baseUrl, "POST", "/api/assets", {
      cookie: ctx.cookie,
      body: {
        name: "ow_skill", type: "skill", alias: "原名", description: "原描述", tags: ["原标签"],
        compatibleTools: ["cursor"], visibility: "public",
        auth: { bindings: [{ credentialName: "ORIGINAL_TOKEN", kind: "env", envKey: "ORIGINAL_TOKEN" }] },
        files: [{ path: "SKILL.md", content: "# ow" }],
      },
    });
    expect(res.status).toBe(200);
    const id = (await parseJson<any>(res)).data.id;
    await awaitStatus(ctx, id, "ready");

    const a = await getAsset(ctx.server, ctx.cookie, id);
    expect(a.alias).toBe("AI 别名"); // 覆盖了「原名」
    expect(a.tags).toEqual(["AI 标签"]); // 覆盖了「原标签」
    expect(a.description).toBe("AI 描述"); // 覆盖了「原描述」
    // auth 重建：ORIGINAL_TOKEN 被删，GITHUB_TOKEN 写入
    const credNames = (a.auth?.bindings ?? []).map((b: any) => b.credentialName);
    expect(credNames).toEqual(["GITHUB_TOKEN"]);
    expect(credNames).not.toContain("ORIGINAL_TOKEN");
  });

  it("跨系统：ai-info 补空 alias → 触发向量重算（processedAt 推进 + 同义词命中）", async () => {
    ctx = await bootBoth();
    // 资产 name/desc/tags 均无关键词；alias 空。先建好「无 alias」向量
    const id = await createSkill(ctx.server, ctx.cookie, { name: "a", description: "x", tags: ["t"] });
    // 等待 search 首次 ready（ai-gen 未启用，alias 仍空）
    await poll(async () => (await searchProcessedAt(ctx.server, ctx.cookie, id)) !== null);
    const t1 = await searchProcessedAt(ctx.server, ctx.cookie, id);
    expect(t1).not.toBeNull();

    // 启用 ai-gen → worker 补 alias="前端 alpha first"（三关键词同向量）
    await putAiConfig(ctx.server.baseUrl, ctx.cookie, {
      enabled: true, provider: "custom", baseUrl: ctx.fake.url, apiKey: "sk-fake", model: "fake-chat",
      concurrency: 4, minIntervalMs: 0, maxAttempts: 3, backoffBaseMs: 10,
    });
    // 等待 ai-info 补全 alias
    await poll(async () => (await getAsset(ctx.server, ctx.cookie, id)).alias === "前端 alpha first");
    // 关键不变量：ai-info 写了 alias（向量输入）→ enqueueSearchIndex('auto') →
    // content_hash 变 → search 重排 → 重算，processedAt 推进到晚于首次
    await poll(async () => {
      const t2 = await searchProcessedAt(ctx.server, ctx.cookie, id);
      return t2 !== null && t2 > t1!;
    });

    // 重算后向量纳入 AI 补的 alias（前端）→ 搜索其同义词 react 应命中该资产
    const after = await search(ctx.server, ctx.cookie, "react");
    expect(after.map((x: any) => x.id)).toContain(id);
  });
});
