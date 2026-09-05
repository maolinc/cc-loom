import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { db } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { enqueue, removeAiInfoIndex, tick, crashRecover } from "../lib/ai-info-indexer.js";
import { aiGenSettings } from "../lib/ai-generation-config.js";

// L1：直接 DB fixture + mock chat completions。验证补缺口 enqueue 矩阵、worker
// processOne（补空字段/首次 auth/无缺口 no-op/失败退避/删除清理/向量触发）、
// removeAiInfoIndex、crashRecover。真实 HTTP 路径与 marketplace 入队属 L3（docker testkit）。

function insertAsset(id: string, over: Partial<{
  name: string; alias: string | null; type: string; description: string; tags: string; deletedAt: string | null;
}> = {}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assets (id, name, alias, type, description, author, tags, compatible_tools, visibility, version, metadata, auth_method, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'tester', ?, '[]', 'public', '1.0.0', '{}', 'none', ?, ?)`,
  ).run(
    id,
    over.name ?? "code_review",
    over.alias ?? null,
    over.type ?? "skill",
    over.description ?? "审查代码",
    over.tags ?? '["review"]',
    now,
    now,
  );
}

function insertFile(assetId: string, path: string, content: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO asset_files (id, asset_id, path, content, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(`${assetId}-${path}`, assetId, path, content, content.length, now, now);
}

function statusOf(id: string): {
  status: string; attempts: number; next_attempt_at: string | null;
  last_error: string | null; queued_at: string; gen_model: string | null; processed_at: string | null;
} | undefined {
  return db.prepare(
    "SELECT status, attempts, next_attempt_at, last_error, queued_at, gen_model, processed_at FROM asset_ai_info WHERE asset_id = ?",
  ).get(id) as any;
}

function assetFields(id: string): { alias: string | null; description: string; tags: string } {
  return db.prepare("SELECT alias, description, tags FROM assets WHERE id = ?").get(id) as any;
}

function bindingCount(id: string): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM asset_auth_bindings WHERE asset_id = ?").get(id) as { c: number }).c;
}

/** 向量触发副作用：enqueueSearchIndex 写 asset_embeddings pending 行（无论 embedding 是否启用）。 */
function vecPending(id: string): boolean {
  const r = db.prepare("SELECT status FROM asset_embeddings WHERE asset_id = ?").get(id) as { status: string } | undefined;
  return r?.status === "pending";
}

function cfgEnabled() {
  aiGenSettings.update({
    enabled: true,
    baseUrl: "https://chat.example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    backoffBaseMs: 1,
    maxAttempts: 3,
    concurrency: 4,
    minIntervalMs: 0,
  });
}

/** mock fetch：返回 chat completions，content 为给定 JSON 串。 */
function mockChatOk(content: string, sideEffect?: () => void) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    sideEffect?.();
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    } as any;
  });
}

function mockChatError(status: number, message: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
    ok: false, status,
    json: async () => ({ error: { message } }),
  }) as any);
}

/** AI 返回的典型结果（含 auth 绑定）。 */
const AI_CONTENT = JSON.stringify({
  alias: "代码审查",
  tags: ["审查", "提交前检查"],
  description: "自动审查代码质量与规范。",
  auth: { bindings: [{ credentialName: "GITHUB_TOKEN", kind: "env", envKey: "GITHUB_TOKEN" }] },
});

beforeAll(() => { migrate(); });

beforeEach(() => {
  db.prepare("DELETE FROM asset_ai_info").run();
  db.prepare("DELETE FROM asset_auth_bindings").run();
  db.prepare("DELETE FROM asset_embeddings").run();
  db.prepare("DELETE FROM asset_fts").run();
  db.prepare("DELETE FROM asset_files").run();
  db.prepare("DELETE FROM assets").run();
  aiGenSettings.clear();
});

afterEach(() => { vi.restoreAllMocks(); });

/** 把 asset 处理到 ready（cfgEnabled + mockChatOk + enqueue new + tick）。 */
async function processToReady(id: string, content: string = AI_CONTENT): Promise<void> {
  cfgEnabled();
  mockChatOk(content);
  enqueue(id, "new");
  await tick();
}

describe("enqueue 补缺口矩阵", () => {
  beforeEach(() => {
    insertAsset("a1", { name: "n", alias: null, description: "d", tags: '["t"]' });
    insertFile("a1", "SKILL.md", "body");
  });

  it("无行 + new → INSERT pending", () => {
    expect(enqueue("a1", "new")).toBe(true);
    expect(statusOf("a1")?.status).toBe("pending");
    expect(statusOf("a1")?.attempts).toBe(0);
  });

  it("pending + auto → no-op（去重）", () => {
    enqueue("a1", "new");
    const q1 = statusOf("a1")!.queued_at;
    expect(enqueue("a1", "auto")).toBe(false);
    expect(statusOf("a1")?.status).toBe("pending");
    expect(statusOf("a1")?.queued_at).toBe(q1);
  });

  it("ready + auto（无文本缺口）→ no-op", async () => {
    await processToReady("a1");
    expect(statusOf("a1")?.status).toBe("ready");
    expect(enqueue("a1", "auto")).toBe(false);
    expect(statusOf("a1")?.status).toBe("ready");
  });

  it("ready + auto（清空 description 产生文本缺口）→ 重排 pending", async () => {
    await processToReady("a1");
    db.prepare("UPDATE assets SET description = '' WHERE id = ?").run("a1");
    expect(enqueue("a1", "auto")).toBe(true);
    expect(statusOf("a1")?.status).toBe("pending");
  });

  it("ready + manual → 强制重排（忽略缺口）", async () => {
    await processToReady("a1");
    expect(enqueue("a1", "manual")).toBe(true);
    expect(statusOf("a1")?.status).toBe("pending");
    expect(statusOf("a1")?.attempts).toBe(0);
  });

  it("failed + auto（首次：processed_at NULL）→ 重排 pending, attempts=0", () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO asset_ai_info (asset_id, status, queued_at, attempts, updated_at)
       VALUES (?, 'failed', ?, 3, ?)`,
    ).run("a1", now, now);
    expect(enqueue("a1", "auto")).toBe(true);
    expect(statusOf("a1")?.status).toBe("pending");
    expect(statusOf("a1")?.attempts).toBe(0);
  });

  it("failed + auto（非首次且无缺口）→ 收口 ready", () => {
    const now = new Date().toISOString();
    // a1 默认 alias=null（有缺口）；置非空使其无文本缺口，方能验证「非首次+无缺口」收口
    db.prepare("UPDATE assets SET alias = ? WHERE id = ?").run("已有别名", "a1");
    // processed_at 非空 = 曾成功过；a1 各字段均满 → 无缺口 → 收口 ready
    db.prepare(
      `INSERT INTO asset_ai_info (asset_id, status, queued_at, attempts, processed_at, updated_at)
       VALUES (?, 'failed', ?, 2, ?, ?)`,
    ).run("a1", now, now, now);
    expect(enqueue("a1", "auto")).toBe(false);
    expect(statusOf("a1")?.status).toBe("ready");
  });

  it("软删 asset + enqueue → 清理队列行、不入队", () => {
    enqueue("a1", "new");
    db.prepare("UPDATE assets SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), "a1");
    expect(enqueue("a1", "new")).toBe(false);
    expect(statusOf("a1")).toBeUndefined();
  });
});

describe("worker processOne（补缺口）", () => {
  beforeEach(cfgEnabled);

  it("成功：补空字段 alias/tags/description + status=ready + 触发向量重算", async () => {
    insertAsset("b1", { name: "n", alias: null, description: "", tags: "[]" });
    insertFile("b1", "SKILL.md", "body");
    mockChatOk(AI_CONTENT);
    enqueue("b1", "new");
    await tick();

    expect(statusOf("b1")?.status).toBe("ready");
    expect(statusOf("b1")?.gen_model).toBe("test-model");
    const f = assetFields("b1");
    expect(f.alias).toBe("代码审查");
    expect(f.description).toBe("自动审查代码质量与规范。");
    expect(JSON.parse(f.tags)).toEqual(["审查", "提交前检查"]);
    // 写了文本字段 → 触发向量重算（asset_embeddings 出现 pending 行）
    expect(vecPending("b1")).toBe(true);
  });

  it("全字段已满 + 非首次 → 不调 AI，直接 ready", async () => {
    insertAsset("b2", { name: "n", alias: "已有别名", description: "已有描述", tags: '["t"]' });
    insertFile("b2", "SKILL.md", "body");
    await processToReady("b2"); // 首次处理（auth 评估）
    // 重新入队后：全满 + 非首次 → 不应调 AI
    const spy = mockChatOk(AI_CONTENT);
    enqueue("b2", "manual");
    await tick();
    expect(spy).not.toHaveBeenCalled();
    expect(statusOf("b2")?.status).toBe("ready");
  });

  it("全字段已满 + 首次 → 调 AI 评估 auth 并补全绑定", async () => {
    insertAsset("b3", { name: "n", alias: "已有别名", description: "已有描述", tags: '["t"]' });
    insertFile("b3", "SKILL.md", "body");
    expect(bindingCount("b3")).toBe(0);
    mockChatOk(AI_CONTENT);
    enqueue("b3", "new");
    await tick();
    expect(statusOf("b3")?.status).toBe("ready");
    expect(bindingCount("b3")).toBe(1);
    // 文本字段未被覆盖（已有值，条件 UPDATE 不命中）
    expect(assetFields("b3").alias).toBe("已有别名");
    expect(vecPending("b3")).toBe(false); // 没写文本字段，不触发向量
  });

  it("auth 仅首次补全：再次处理不重复加绑定", async () => {
    insertAsset("b4", { name: "n", alias: null, description: "", tags: "[]" });
    insertFile("b4", "SKILL.md", "body");
    await processToReady("b4");
    expect(bindingCount("b4")).toBe(1);
    // 清空 description 产生文本缺口 → 重排；但 auth 非首次 → 不再写绑定
    db.prepare("UPDATE assets SET description = '' WHERE id = ?").run("b4");
    mockChatOk(AI_CONTENT);
    enqueue("b4", "auto");
    await tick();
    expect(bindingCount("b4")).toBe(1); // 未翻倍
    expect(assetFields("b4").description).toBe("自动审查代码质量与规范。");
  });

  it("条件写回：处理期间用户填入字段 → 不覆盖", async () => {
    insertAsset("b5", { name: "n", alias: null, description: "", tags: "[]" });
    insertFile("b5", "SKILL.md", "body");
    // AI 返回期间用户填了 alias → 条件 UPDATE 不命中，alias 保留用户值
    mockChatOk(AI_CONTENT, () => {
      db.prepare("UPDATE assets SET alias = ? WHERE id = ?").run("用户手填", "b5");
    });
    enqueue("b5", "new");
    await tick();
    expect(assetFields("b5").alias).toBe("用户手填");
    expect(statusOf("b5")?.status).toBe("ready");
  });

  it("失败：瞬时错误退避重试（attempts 递增，转 pending）", async () => {
    insertAsset("b6", { name: "n", alias: null, description: "", tags: "[]" });
    mockChatError(429, "rate limited");
    enqueue("b6", "new");
    await tick();
    const s = statusOf("b6");
    expect(s?.status).toBe("pending");
    expect(s?.attempts).toBe(1);
    expect(s?.next_attempt_at).not.toBeNull();
    expect(s?.last_error).toContain("rate limited");
  });

  it("失败：达到 max_attempts → 转 failed", async () => {
    aiGenSettings.update({ maxAttempts: 1 });
    insertAsset("b7", { name: "n", alias: null, description: "", tags: "[]" });
    mockChatError(503, "down");
    enqueue("b7", "new");
    await tick();
    const s = statusOf("b7");
    expect(s?.status).toBe("failed");
    expect(s?.attempts).toBe(1);
    expect(s?.last_error).toContain("down");
  });

  it("处理期间资产被软删 → 清理队列行", async () => {
    insertAsset("b8", { name: "n", alias: null, description: "", tags: "[]" });
    mockChatOk(AI_CONTENT, () => {
      db.prepare("UPDATE assets SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), "b8");
    });
    enqueue("b8", "new");
    await tick();
    expect(statusOf("b8")).toBeUndefined();
  });
});

describe("overwrite 模式（全覆盖，含 auth+含首次）", () => {
  // AI 返回含 auth 绑定
  const WITH_AUTH = JSON.stringify({
    alias: "AI 别名", tags: ["AI 标签"], description: "AI 描述",
    auth: { bindings: [{ credentialName: "GITHUB_TOKEN", kind: "env", envKey: "GITHUB_TOKEN" }] },
  });
  // AI 返回无需鉴权（auth.bindings 为空）
  const NO_AUTH = JSON.stringify({
    alias: "AI 别名", tags: ["AI 标签"], description: "AI 描述",
    auth: { bindings: [] },
  });

  beforeEach(() => {
    cfgEnabled();
    aiGenSettings.update({ overwrite: true });
  });

  it("覆盖已有文本字段（不限于空）", async () => {
    insertAsset("o1", { name: "n", alias: "原别名", description: "原描述", tags: '["原标签"]' });
    insertFile("o1", "SKILL.md", "body");
    mockChatOk(WITH_AUTH);
    enqueue("o1", "new");
    await tick();
    expect(statusOf("o1")?.status).toBe("ready");
    const f = assetFields("o1");
    expect(f.alias).toBe("AI 别名");
    expect(f.description).toBe("AI 描述");
    expect(JSON.parse(f.tags)).toEqual(["AI 标签"]);
  });

  it("auth 全覆盖：删旧按 AI 重建", async () => {
    insertAsset("o2", { name: "n", alias: "x", description: "d", tags: '["t"]' });
    insertFile("o2", "SKILL.md", "body");
    // 预置一条人工 auth 绑定，overwrite 应删之并按 AI 重建
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO asset_auth_bindings (id, asset_id, ordinal, credential_name, kind, env_key, created_at) VALUES ('h1', ?, 0, 'HUMAN_TOKEN', 'env', 'HUMAN_TOKEN', ?)`,
    ).run("o2", now);
    expect(bindingCount("o2")).toBe(1);

    mockChatOk(WITH_AUTH);
    enqueue("o2", "new");
    await tick();
    expect(bindingCount("o2")).toBe(1); // 旧 HUMAN_TOKEN 被删，AI 的 GITHUB_TOKEN 写入
    const b = db.prepare("SELECT credential_name FROM asset_auth_bindings WHERE asset_id = ?").get("o2") as { credential_name: string };
    expect(b.credential_name).toBe("GITHUB_TOKEN");
  });

  it("AI 判定无需鉴权 → overwrite 清空已有绑定", async () => {
    insertAsset("o3", { name: "n", alias: "x", description: "d", tags: '["t"]' });
    insertFile("o3", "SKILL.md", "body");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO asset_auth_bindings (id, asset_id, ordinal, credential_name, kind, env_key, created_at) VALUES ('h2', ?, 0, 'HUMAN_TOKEN', 'env', 'HUMAN_TOKEN', ?)`,
    ).run("o3", now);
    mockChatOk(NO_AUTH);
    enqueue("o3", "new");
    await tick();
    expect(bindingCount("o3")).toBe(0); // 人工绑定被清空
  });

  it("manual 重新入队已处理能力 → 重新调 AI 并覆盖", async () => {
    insertAsset("o4", { name: "n", alias: "v1", description: "d1", tags: '["t1"]' });
    insertFile("o4", "SKILL.md", "body");
    mockChatOk(WITH_AUTH);
    enqueue("o4", "new");
    await tick();
    expect(assetFields("o4").alias).toBe("AI 别名");
    // 再次 manual 入队 → 仍调 AI（needGenerate=true 因 overwrite）
    const spy = mockChatOk(NO_AUTH);
    enqueue("o4", "manual");
    await tick();
    expect(spy).toHaveBeenCalled();
    expect(bindingCount("o4")).toBe(0); // 第二次 AI 判定无需鉴权 → 清空
  });

  it("overwrite=off 时 manual 重新入队已满能力 → 不调 AI（回归保护）", async () => {
    aiGenSettings.update({ overwrite: false });
    insertAsset("o5", { name: "n", alias: "满", description: "满", tags: '["t"]' });
    insertFile("o5", "SKILL.md", "body");
    await processToReady("o5", WITH_AUTH);
    const spy = mockChatOk(NO_AUTH);
    enqueue("o5", "manual");
    await tick();
    expect(spy).not.toHaveBeenCalled();
    expect(assetFields("o5").alias).toBe("满"); // 未被覆盖
  });
});

describe("并发控制（worker 池 + tick 重入保护）", () => {
  beforeEach(() => {
    cfgEnabled();
    aiGenSettings.update({ concurrency: 2, minIntervalMs: 0, maxAttempts: 3, backoffBaseMs: 1 });
  });

  /** 造一个有文本缺口、会真正调 AI 的资产并入队。 */
  function enqueueGap(id: string): void {
    insertAsset(id, { name: id, alias: null, description: "", tags: "[]" });
    insertFile(id, "SKILL.md", "body");
    enqueue(id, "new");
  }

  it("处理中数量不超过 concurrency：tick 重入不超额领取", async () => {
    for (let i = 0; i < 6; i++) enqueueGap(`r${i}`);

    let maxProcessing = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const c = (db.prepare(
        "SELECT COUNT(*) AS c FROM asset_ai_info WHERE status = 'processing'",
      ).get() as { c: number }).c;
      maxProcessing = Math.max(maxProcessing, c);
      await new Promise((r) => setTimeout(r, 20)); // 让重入 tick 有机会领
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: AI_CONTENT } }] }) } as any;
    });

    // 模拟 setInterval 重入：上一轮 tick 未结束时下一轮又触发
    await Promise.all([tick(), tick()]);

    expect(maxProcessing).toBeLessThanOrEqual(2);
  });

  it("真正并发：concurrency=2 时同时有 2 个 AI 调用在飞", async () => {
    for (let i = 0; i < 4; i++) enqueueGap(`p${i}`);

    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: AI_CONTENT } }] }) } as any;
    });

    await tick();

    expect(maxInFlight).toBe(2); // 真正 2 并发，而非串行 1
  });
});

describe("调度参数：minInterval 全局间隔 / maxAttempts / backoff", () => {
  beforeEach(() => {
    cfgEnabled();
    aiGenSettings.update({ concurrency: 3, minIntervalMs: 0, maxAttempts: 3, backoffBaseMs: 1 });
  });

  it("minIntervalMs：跨 worker 全局串行化请求起点（任意两次起点间隔 ≥ minIntervalMs）", async () => {
    aiGenSettings.update({ concurrency: 3, minIntervalMs: 60 });
    for (let i = 0; i < 3; i++) {
      insertAsset(`m${i}`, { name: `m${i}`, alias: null, description: "", tags: "[]" });
      insertFile(`m${i}`, "SKILL.md", "body");
      enqueue(`m${i}`, "new");
    }
    const starts: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      starts.push(Date.now());
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: AI_CONTENT } }] }) } as any;
    });
    await tick();
    starts.sort((a, b) => a - b);
    // 3 个并发 worker 若无全局 gate 会同时发起（间隔≈0）；gate 保证起点依次错开 ≥60ms。
    // setTimeout 不提前触发→实测间隔≥60ms，阈值 40ms 留测量抖动余量。
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(40);
    }
  });

  it("maxAttempts=3：持续失败恰好尝试 3 次后转 failed（attempts=3）", async () => {
    aiGenSettings.update({ concurrency: 1, maxAttempts: 3, backoffBaseMs: 1, minIntervalMs: 0 });
    insertAsset("x1", { name: "x1", alias: null, description: "", tags: "[]" });
    insertFile("x1", "SKILL.md", "body");
    mockChatError(503, "down");
    enqueue("x1", "new");

    await tick();                                   // 第 1 次：attempts 0→1，pending
    expect(statusOf("x1")?.status).toBe("pending");
    expect(statusOf("x1")?.attempts).toBe(1);
    await new Promise((r) => setTimeout(r, 5));      // 等 2ms 退避过去
    await tick();                                   // 第 2 次：attempts 1→2，pending
    expect(statusOf("x1")?.attempts).toBe(2);
    expect(statusOf("x1")?.status).toBe("pending");
    await new Promise((r) => setTimeout(r, 5));      // 等 4ms 退避过去
    await tick();                                   // 第 3 次：attempts 2→3，3<3 不成立→failed
    expect(statusOf("x1")?.status).toBe("failed");
    expect(statusOf("x1")?.attempts).toBe(3);
  });

  it("backoff：首次重试 next_attempt_at ≈ now + base×2^1（指数退避基数按 2^attempts）", async () => {
    aiGenSettings.update({ concurrency: 1, maxAttempts: 3, backoffBaseMs: 100, minIntervalMs: 0 });
    insertAsset("x2", { name: "x2", alias: null, description: "", tags: "[]" });
    insertFile("x2", "SKILL.md", "body");
    mockChatError(503, "down");
    enqueue("x2", "new");

    const before = Date.now();
    await tick();                                   // 第 1 次失败：attempts=1，next = now+100×2^1 = +200ms
    const s = statusOf("x2");
    expect(s?.status).toBe("pending");
    expect(s?.attempts).toBe(1);
    const nextAt = new Date(s!.next_attempt_at!).getTime();
    const delta = nextAt - before;
    // 期望 ~200ms；容忍定时器/调度抖动，落 in [150, 400]
    expect(delta).toBeGreaterThanOrEqual(150);
    expect(delta).toBeLessThanOrEqual(400);
  });
});

describe("removeAiInfoIndex", () => {
  it("清理 asset_ai_info 行", async () => {
    insertAsset("d1", { name: "n", alias: null, description: "", tags: "[]" });
    insertFile("d1", "SKILL.md", "body");
    await processToReady("d1");
    expect(statusOf("d1")?.status).toBe("ready");
    removeAiInfoIndex("d1");
    expect(statusOf("d1")).toBeUndefined();
  });
});

describe("crashRecover", () => {
  it("启动时把 processing → pending", () => {
    insertAsset("e1", { name: "n", alias: null, description: "", tags: "[]" });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO asset_ai_info (asset_id, status, queued_at, attempts, updated_at)
       VALUES (?, 'processing', ?, 0, ?)`,
    ).run("e1", now, now);
    crashRecover();
    expect(statusOf("e1")?.status).toBe("pending");
  });
});
