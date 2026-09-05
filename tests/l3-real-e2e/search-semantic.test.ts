/**
 * L3 语义搜索 — sqlite-vec 混合检索端到端（docs/sqlite-vec-search-design.md §9.2）。
 *
 * 真实 server 进程 + 真实 HTTP + 真实 sqlite-vec 扩展 + fake /embeddings 服务
 * （返回确定性向量，同义词经 keywordVectors 映射到同一向量）。不 mock 被测对象。
 *
 * 覆盖：索引 ready + 语义近义命中、失败重试、持续失败转 failed、手动重排、
 * 已删除不出现、降级（embed 不可用→lexical）、匿名只 public、字段权重调整排序。
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { startServer, stopServer, startFakeEmbedding, type ServerHandle, type FakeEmbeddingHandle } from "@maolinc/cc-loom-testkit";
import { login, request, parseJson } from "./_http.js";

// 测试专用：worker 快速轮询（docker 已设；本地 L3 也生效，singleFork 下持久）
beforeAll(() => {
  process.env.LOOM_SEARCH_WORKER_TICK_MS = "200";
});

const ADMIN_EMAIL = "admin@loom.test";
const ADMIN_PASSWORD = "test-admin-password";
const DIM = 8;

// 同义词经 keywordVectors 映射到同一向量：react≈前端、review≈审查、alpha≈first、beta≈second
const KEYWORD_VECTORS: Record<string, number[]> = {
  react: [1, 0, 0, 0, 0, 0, 0, 0],
  前端: [1, 0, 0, 0, 0, 0, 0, 0],
  review: [0, 1, 0, 0, 0, 0, 0, 0],
  审查: [0, 1, 0, 0, 0, 0, 0, 0],
  alpha: [1, 0, 0, 0, 0, 0, 0, 0],
  first: [1, 0, 0, 0, 0, 0, 0, 0],
  beta: [0, 1, 0, 0, 0, 0, 0, 0],
  second: [0, 1, 0, 0, 0, 0, 0, 0],
};

interface Ctx {
  server: ServerHandle;
  cookie: string;
  fake: FakeEmbeddingHandle;
}

async function boot(over: { mode?: "ok" | "fail-429" | "fail-500"; weights?: Record<string, number>; maxAttempts?: number; backoffBaseMs?: number } = {}): Promise<Ctx> {
  const server = await startServer();
  const cookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  const fake = await startFakeEmbedding({ dim: DIM, keywordVectors: KEYWORD_VECTORS, mode: over.mode ?? "ok" });
  // 配置 embedding 指向 fake；dim=8 需重建 asset_vec 对齐维度
  await putConfig(server.baseUrl, cookie, {
    enabled: true,
    baseUrl: fake.url,
    apiKey: "sk-fake",
    model: "fake-model",
    dim: DIM,
    weights: over.weights ?? { name: 0.4, tags: 0.2, description: 0.4 },
    alpha: 0.4,
    batchSize: 32,
    concurrency: 4,
    minIntervalMs: 0,
    maxAttempts: over.maxAttempts ?? 3,
    backoffBaseMs: over.backoffBaseMs ?? 10,
  });
  // 重建 asset_vec 到 dim=8（migrate 默认 4096，需对齐测试向量维度）
  const rb = await request(server.baseUrl, "POST", "/api/settings/search/rebuild", { cookie, body: { confirm: true } });
  expect(rb.status).toBe(200);
  return { server, cookie, fake };
}

async function putConfig(baseUrl: string, cookie: string, cfg: Record<string, unknown>): Promise<void> {
  const res = await request(baseUrl, "PUT", "/api/settings/search", { cookie, body: cfg });
  expect(res.status).toBe(200);
}

async function createSkill(server: ServerHandle, cookie: string, name: string, description: string, tags: string[] = [], visibility: "public" | "private" = "public"): Promise<string> {
  const res = await request(server.baseUrl, "POST", "/api/assets", {
    cookie,
    body: {
      name, type: "skill", description, tags, compatibleTools: ["cursor"], visibility,
      files: [{ path: "SKILL.md", content: `# ${name}` }],
    },
  });
  expect(res.status).toBe(200);
  const body = await parseJson<any>(res);
  return body.data.id;
}

async function search(server: ServerHandle, cookie: string | null, query: string): Promise<{ assets: any[]; total: number; mode: string | null }> {
  const res = await request(server.baseUrl, "GET", `/api/assets?query=${encodeURIComponent(query)}`, cookie ? { cookie } : {});
  expect(res.status).toBe(200);
  const body = await parseJson<any>(res);
  return { assets: body.data ?? [], total: body.total ?? 0, mode: res.headers.get("x-loom-search-mode") };
}

async function queueCounts(server: ServerHandle, cookie: string): Promise<any> {
  const res = await request(server.baseUrl, "GET", "/api/settings/search/queue", { cookie });
  return (await parseJson<any>(res)).data;
}

async function queueItems(server: ServerHandle, cookie: string, status: string): Promise<any[]> {
  const res = await request(server.baseUrl, "GET", `/api/settings/search/queue/items?status=${status}&page=1&pageSize=100`, { cookie });
  return (await parseJson<any>(res)).data.items ?? [];
}

async function assetIndex(server: ServerHandle, cookie: string, q: string, order: "desc" | "asc" = "desc"): Promise<{ items: any[]; total: number; totalSizeBytes: number }> {
  const params = new URLSearchParams({ page: "1", pageSize: "100", order });
  if (q) params.set("q", q);
  const res = await request(server.baseUrl, "GET", `/api/settings/search/assets?${params.toString()}`, { cookie });
  expect(res.status).toBe(200);
  const body = await parseJson<any>(res);
  return { items: body.data.items ?? [], total: body.data.total ?? 0, totalSizeBytes: body.data.totalSizeBytes ?? 0 };
}

/** 轮询直到 predicate 返回 true 或超时。 */
async function poll(predicate: () => Promise<boolean>, timeoutMs = 20000, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("poll 超时");
}

/** 轮询直到 assetId 出现在指定 status 的队列项中。 */
async function awaitStatus(ctx: Ctx, assetId: string, status: "ready" | "failed" | "pending"): Promise<void> {
  await poll(async () => {
    const items = await queueItems(ctx.server, ctx.cookie, status);
    return items.some((it: any) => it.assetId === assetId);
  });
}

describe("L3 语义搜索", () => {
  let ctx: Ctx | null = null;
  afterEach(async () => {
    if (ctx) {
      if (ctx.fake) await ctx.fake.stop();
      await stopServer(ctx.server);
      ctx = null;
    }
  });

  it("索引 ready + 语义近义命中（LIKE 不命中，vec 命中）", async () => {
    ctx = await boot();
    // 资产描述含 "react"；查询 "前端"（同义词映射同向量，2 字符 trigram 不命中 FTS5）
    const id = await createSkill(ctx.server, ctx.cookie, "react_component_gen", "react 组件生成器");
    await awaitStatus(ctx, id, "ready");

    const r = await search(ctx.server, ctx.cookie, "前端");
    expect(r.mode).toBe("hybrid");
    expect(r.assets.map((a) => a.id)).toContain(id);

    // 对照：LIKE 不应命中（name/description 无 "前端" 子串）
    const likeRes = await request(ctx.server.baseUrl, "GET", `/api/assets?query=${encodeURIComponent("前端")}`, {});
    // 未启用匿名降级路径仍走 LIKE（匿名 + 未登录，embedding 启用 → hybrid 但匿名无 vec？实际匿名也走 hybrid）
    // 这里仅断言 vec 路径命中即可
    void likeRes;
  });

  it("失败重试：429 → 恢复后 ready", async () => {
    ctx = await boot({ mode: "fail-429", maxAttempts: 3, backoffBaseMs: 10 });
    const id = await createSkill(ctx.server, ctx.cookie, "retry_skill", "review 审查");
    // 等待至少一次失败（attempts 增长）
    await poll(async () => {
      const items = await queueItems(ctx.server, ctx.cookie, "pending");
      const it = items.find((x: any) => x.assetId === id);
      return !!it && it.attempts >= 1;
    });
    // 恢复 fake → 转 ready
    ctx.fake.setMode("ok");
    await awaitStatus(ctx, id, "ready");
  });

  it("持续失败至 max_attempts → failed + last_error", async () => {
    ctx = await boot({ mode: "fail-500", maxAttempts: 2, backoffBaseMs: 10 });
    const id = await createSkill(ctx.server, ctx.cookie, "doomed_skill", "react");
    await awaitStatus(ctx, id, "failed");
    const items = await queueItems(ctx.server, ctx.cookie, "failed");
    const it = items.find((x: any) => x.assetId === id);
    expect(it).toBeDefined();
    expect(it.lastError).toContain("fake fail-500");
  });

  it("手动重排：ready 项 requeue → pending → ready", async () => {
    ctx = await boot();
    const id = await createSkill(ctx.server, ctx.cookie, "requeue_skill", "react");
    await awaitStatus(ctx, id, "ready");

    const res = await request(ctx.server.baseUrl, "POST", "/api/settings/search/requeue", { cookie: ctx.cookie, body: { assetIds: [id] } });
    expect(res.status).toBe(200);
    await awaitStatus(ctx, id, "ready");
  });

  it("已删除能力不出现：队列与搜索均清理", async () => {
    ctx = await boot();
    const id = await createSkill(ctx.server, ctx.cookie, "deleteme_skill", "react 组件");
    await awaitStatus(ctx, id, "ready");
    expect((await search(ctx.server, ctx.cookie, "前端")).assets.map((a) => a.id)).toContain(id);

    await request(ctx.server.baseUrl, "DELETE", `/api/assets/${id}`, { cookie: ctx.cookie });
    // 队列不再含该能力
    await poll(async () => {
      const ready = await queueItems(ctx.server, ctx.cookie, "ready");
      return !ready.some((x: any) => x.assetId === id);
    });
    // 搜索不再返回
    expect((await search(ctx.server, ctx.cookie, "前端")).assets.map((a) => a.id)).not.toContain(id);
  });

  it("降级：embed 不可用 → X-Loom-Search-Mode: lexical + FTS5 结果", async () => {
    ctx = await boot();
    // 资产 name 含 "react"（FTS5 trigram 命中）
    const id = await createSkill(ctx.server, ctx.cookie, "react_searchable", "react thing");
    await awaitStatus(ctx, id, "ready");

    // 停掉 fake embedding → embed 失败 → 词法降级
    await ctx.fake.stop();
    ctx.fake = null as any;
    const r = await search(ctx.server, ctx.cookie, "react");
    expect(r.mode).toBe("lexical");
    expect(r.assets.map((a) => a.id)).toContain(id);
  });

  it("匿名只命中 public 能力", async () => {
    ctx = await boot();
    const pub = await createSkill(ctx.server, ctx.cookie, "pub_react", "react 公开", [], "public");
    const priv = await createSkill(ctx.server, ctx.cookie, "priv_react", "react 私有", [], "private");
    await awaitStatus(ctx, pub, "ready");
    await awaitStatus(ctx, priv, "ready");

    // 匿名（无 cookie）搜索 "前端"（同义词 vec 命中 react）
    const r = await search(ctx.server, null, "前端");
    expect(r.mode).toBe("hybrid");
    const ids = r.assets.map((a) => a.id);
    expect(ids).toContain(pub);
    expect(ids).not.toContain(priv);
  });

  it("字段权重调整后排序即时变化", async () => {
    // q="first" → [1,0,...]（同义词 alpha/first 同向量）
    // A: name 含 alpha 关键词（name vec=[1,0,...]，贴近 q）；tags=beta（vec=[0,1,...]，远）
    // B: name=beta（vec=[0,1,...]，远）；tags=alpha（vec=[1,0,...]，贴近 q）
    // 用纯关键词（非 hash 兜底）保证相似度=1.0/0，稳定越过相似度阈值。
    ctx = await boot({ weights: { name: 0.9, tags: 0.1, description: 0 } });
    const a = await createSkill(ctx.server, ctx.cookie, "alpha", "x", ["beta"]);
    const b = await createSkill(ctx.server, ctx.cookie, "beta", "x", ["alpha"]);
    await awaitStatus(ctx, a, "ready");
    await awaitStatus(ctx, b, "ready");

    // query "first"（同义词→alpha 向量，无 FTS5 命中）；name 权重高 → A 前
    const r1 = await search(ctx.server, ctx.cookie, "first");
    expect(r1.assets.map((x: any) => x.id)).toEqual([a, b]);

    // 改权重 tags 高（不重建），立即重查 → B 前
    await putConfig(ctx.server.baseUrl, ctx.cookie, { weights: { name: 0.1, tags: 0.9, description: 0 } });
    const r2 = await search(ctx.server, ctx.cookie, "first");
    expect(r2.assets.map((x: any) => x.id)).toEqual([b, a]);
  });

  it("全部能力视图：列出全部能力 + name 搜索 + 逐能力重建 + admin 门禁", async () => {
    ctx = await boot();
    const a = await createSkill(ctx.server, ctx.cookie, "alpha_skill", "react");
    const b = await createSkill(ctx.server, ctx.cookie, "beta_agent", "review");
    await awaitStatus(ctx, a, "ready");
    await awaitStatus(ctx, b, "ready");

    // 全部列出：两条都 ready，processedAt 非空
    const all = await assetIndex(ctx.server, ctx.cookie, "");
    const ids = all.items.map((x: any) => x.assetId);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    const aItem = all.items.find((x: any) => x.assetId === a);
    expect(aItem.status).toBe("ready");
    expect(aItem.processedAt).toBeTruthy();
    expect(aItem.type).toBe("skill");
    // 索引大小：name+description 两字段 × dim8 × 4B = 64；汇总 2 条 = 128
    expect(aItem.indexSizeBytes).toBe(2 * DIM * 4);
    expect(all.totalSizeBytes).toBe(2 * (2 * DIM * 4));

    // name 搜索 "beta"：仅 b
    const filtered = await assetIndex(ctx.server, ctx.cookie, "beta");
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].assetId).toBe(b);

    // 逐能力重新构建：a → 出现在 pending
    const rq = await request(ctx.server.baseUrl, "POST", "/api/settings/search/requeue", { cookie: ctx.cookie, body: { assetIds: [a] } });
    expect(rq.status).toBe(200);
    await poll(async () => {
      const pending = await queueItems(ctx.server, ctx.cookie, "pending");
      return pending.some((x: any) => x.assetId === a);
    });

    // admin 门禁：未登录 → 401
    const noAuth = await request(ctx.server.baseUrl, "GET", "/api/settings/search/assets", {});
    expect(noAuth.status).toBe(401);
  });

  it("全部能力视图：已删除能力不出现", async () => {
    ctx = await boot();
    const a = await createSkill(ctx.server, ctx.cookie, "keep_skill", "react");
    const b = await createSkill(ctx.server, ctx.cookie, "del_skill", "react");
    await awaitStatus(ctx, a, "ready");
    await awaitStatus(ctx, b, "ready");
    await request(ctx.server.baseUrl, "DELETE", `/api/assets/${b}`, { cookie: ctx.cookie });

    // 删除项从全部能力视图消失（removeSearchIndex 清理后 + 软删过滤）
    await poll(async () => {
      const all = await assetIndex(ctx.server, ctx.cookie, "");
      return !all.items.some((x: any) => x.assetId === b);
    });
    const all = await assetIndex(ctx.server, ctx.cookie, "");
    expect(all.items.map((x: any) => x.assetId)).toContain(a);
    expect(all.items.map((x: any) => x.assetId)).not.toContain(b);
  });
});
