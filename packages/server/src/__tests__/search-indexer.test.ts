import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { db, vecAvailable } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { enqueue, removeSearchIndex, tick, crashRecover } from "../lib/search-indexer.js";
import { embeddingSettings } from "../lib/embedding-config.js";

// L1：直接 DB fixture + mock embed。验证 enqueue 去重矩阵（§5.3）、worker
// processOne（成功/复检重排/失败退避/删除清理）、FTS5 同步写、removeSearchIndex。
// 集成级（真实 embedding API、HTTP 路径）属 L3（§9.2），见 docker testkit。

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
  status: string; attempts: number; content_hash: string | null;
  next_attempt_at: string | null; last_error: string | null;
  queued_at: string; embed_model: string | null; embed_dim: number;
} | undefined {
  return db.prepare("SELECT status, attempts, content_hash, next_attempt_at, last_error, queued_at, embed_model, embed_dim FROM asset_embeddings WHERE asset_id = ?").get(id) as any;
}

function vecRows(id: string): { field: string }[] {
  return db.prepare("SELECT field FROM asset_vec WHERE asset_id = ?").all(id) as { field: string }[];
}

function ftsRow(id: string): { name: string; tags: string; description: string } | undefined {
  return db.prepare("SELECT name, tags, description FROM asset_fts WHERE asset_id = ?").get(id) as any;
}

function cfgEnabled() {
  embeddingSettings.update({
    enabled: true,
    baseUrl: "https://embed.example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    dim: 4,
    backoffBaseMs: 1,
    maxAttempts: 3,
    concurrency: 4,
    batchSize: 32,
  });
}

/** mock fetch：按请求 input 数返回等长确定性向量；可选 sideEffect 在响应前执行。 */
function mockEmbedOk(sideEffect?: () => void) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: any, init: any) => {
    const body = JSON.parse((init as RequestInit).body as string) as { input: string[] };
    sideEffect?.();
    const n = body.input.length;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: Array.from({ length: n }, (_, i) => ({ embedding: [i, 0, 0, 0], index: i })) }),
    } as any;
  });
}

function mockEmbedError(status: number, message: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
    ok: false, status,
    json: async () => ({ error: { message } }),
  }) as any);
}

beforeAll(() => {
  migrate();
  if (!vecAvailable()) throw new Error("sqlite-vec 扩展未加载，无法跑 asset_vec 用例");
  // migrate 用默认 dim 4096 建 asset_vec；测试 mock 返回 4 维向量，按 dim=4 重建以对齐。
  db.exec("DROP TABLE IF EXISTS asset_vec");
  db.exec(
    "CREATE VIRTUAL TABLE asset_vec USING vec0(embedding float[4] distance=cosine, asset_id TEXT, field TEXT)",
  );
});

beforeEach(() => {
  db.prepare("DELETE FROM asset_vec").run();
  db.prepare("DELETE FROM asset_fts").run();
  db.prepare("DELETE FROM asset_embeddings").run();
  db.prepare("DELETE FROM asset_files").run();
  db.prepare("DELETE FROM assets").run();
  embeddingSettings.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 把 asset 处理到 ready（cfgEnabled + mockEmbedOk + tick）。 */
async function processToReady(id: string): Promise<void> {
  cfgEnabled();
  mockEmbedOk();
  enqueue(id, "new");
  await tick();
}

describe("enqueue 去重矩阵（§5.3）", () => {
  beforeEach(() => {
    insertAsset("a1", { name: "n", alias: null, type: "skill", description: "d", tags: '["t"]' });
    insertFile("a1", "SKILL.md", "---\ndescription: d\n---\nbody");
  });

  it("无行 + new → INSERT pending + 同步写 FTS5", () => {
    expect(enqueue("a1", "new")).toBe(true);
    const s = statusOf("a1");
    expect(s?.status).toBe("pending");
    expect(s?.attempts).toBe(0);
    expect(ftsRow("a1")).toBeDefined();
    expect(ftsRow("a1")!.name).toBe("n");
  });

  it("pending + new/auto → no-op（去重）", () => {
    enqueue("a1", "new");
    const q1 = statusOf("a1")!.queued_at;
    expect(enqueue("a1", "auto")).toBe(false);
    const s = statusOf("a1");
    expect(s?.status).toBe("pending");
    expect(s?.queued_at).toBe(q1);
  });

  it("ready + auto（hash 不变）→ no-op", async () => {
    await processToReady("a1");
    expect(statusOf("a1")?.status).toBe("ready");
    expect(enqueue("a1", "auto")).toBe(false);
    expect(statusOf("a1")?.status).toBe("ready");
  });

  it("ready + auto（hash 变）→ 重排 pending", async () => {
    await processToReady("a1");
    db.prepare("UPDATE assets SET name = ? WHERE id = ?").run("changed", "a1");
    expect(enqueue("a1", "auto")).toBe(true);
    expect(statusOf("a1")?.status).toBe("pending");
  });

  it("ready + manual → 强制重排（忽略 hash）", async () => {
    await processToReady("a1");
    expect(enqueue("a1", "manual")).toBe(true);
    expect(statusOf("a1")?.status).toBe("pending");
    expect(statusOf("a1")?.attempts).toBe(0);
  });

  it("failed + auto → 重排 pending, attempts=0", () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO asset_embeddings (asset_id, status, queued_at, attempts, embed_dim, content_hash, field_version, last_error, updated_at)
       VALUES (?, 'failed', ?, 3, 4, 'stale', 0, 'err', ?)`,
    ).run("a1", now, now);
    expect(enqueue("a1", "auto")).toBe(true);
    expect(statusOf("a1")?.status).toBe("pending");
    expect(statusOf("a1")?.attempts).toBe(0);
  });

  it("软删 asset + enqueue → 清理派生行、不建队列", () => {
    db.prepare("UPDATE assets SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), "a1");
    expect(enqueue("a1", "new")).toBe(false);
    expect(statusOf("a1")).toBeUndefined();
  });
});

describe("worker processOne", () => {
  beforeEach(cfgEnabled);

  it("成功：写 vec 行 + status=ready", async () => {
    insertAsset("b1", { name: "n", description: "d", tags: '["t"]' });
    insertFile("b1", "SKILL.md", "---\ndescription: d\n---\nbody");
    mockEmbedOk();
    enqueue("b1", "new");
    await tick();

    const s = statusOf("b1");
    expect(s?.status).toBe("ready");
    expect(s?.embed_model).toBe("test-model");
    expect(s?.embed_dim).toBe(4);
    expect(vecRows("b1").map(r => r.field).sort()).toEqual(["description", "name", "tags"]);
  });

  it("空字段不生成向量行（某字段为空）", async () => {
    insertAsset("b2", { name: "n", description: "", tags: "[]" });
    mockEmbedOk();
    enqueue("b2", "new");
    await tick();
    expect(statusOf("b2")?.status).toBe("ready");
    expect(vecRows("b2").map(r => r.field)).toEqual(["name"]);
  });

  it("写回复检：处理期间内容被编辑 → 重排 pending，丢弃旧向量", async () => {
    insertAsset("b3", { name: "n", description: "d1", tags: '["t"]' });
    insertFile("b3", "SKILL.md", "---\ndescription: d1\n---\nbody");
    mockEmbedOk(() => db.prepare("UPDATE assets SET name = ? WHERE id = ?").run("changed", "b3"));
    enqueue("b3", "new");
    await tick();

    expect(statusOf("b3")?.status).toBe("pending");
    expect(vecRows("b3").length).toBe(0);
  });

  it("失败：瞬时错误退避重试（attempts 递增，转 pending）", async () => {
    insertAsset("b4", { name: "n", description: "d" });
    mockEmbedError(429, "rate limited");
    enqueue("b4", "new");
    await tick();

    const s = statusOf("b4");
    expect(s?.status).toBe("pending");
    expect(s?.attempts).toBe(1);
    expect(s?.next_attempt_at).not.toBeNull();
    expect(s?.last_error).toContain("rate limited");
  });

  it("失败：达到 max_attempts → 转 failed", async () => {
    embeddingSettings.update({ maxAttempts: 1 });
    insertAsset("b5", { name: "n", description: "d" });
    mockEmbedError(503, "down");
    enqueue("b5", "new");
    await tick();
    const s = statusOf("b5");
    expect(s?.status).toBe("failed");
    expect(s?.attempts).toBe(1);
    expect(s?.last_error).toContain("down");
  });

  it("处理期间资产被软删 → 清理派生行", async () => {
    insertAsset("b6", { name: "n", description: "d" });
    mockEmbedOk(() => db.prepare("UPDATE assets SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), "b6"));
    enqueue("b6", "new");
    await tick();
    expect(statusOf("b6")).toBeUndefined();
    expect(vecRows("b6").length).toBe(0);
  });
});

describe("FTS5 同步写（ADR-0002）", () => {
  it("enqueue 即写 FTS5 行，内容为构造字段文本", () => {
    insertAsset("c1", { name: "react_gen", alias: "组件生成", description: "生成组件", tags: '["前端","React"]' });
    enqueue("c1", "new");
    const fts = ftsRow("c1");
    expect(fts!.name).toBe("react_gen 组件生成");
    expect(fts!.tags).toBe("前端 React");
    expect(fts!.description).toBe("生成组件");
  });

  it("再次 enqueue（hash 变）刷新 FTS5 到新内容", () => {
    insertAsset("c2", { name: "n", description: "d", tags: '["t"]' });
    enqueue("c2", "new");
    db.prepare("UPDATE assets SET name = ? WHERE id = ?").run("n2", "c2");
    enqueue("c2", "auto");
    expect(ftsRow("c2")!.name).toBe("n2");
  });
});

describe("并发控制（worker 池 + tick 重入保护）", () => {
  beforeEach(() => {
    cfgEnabled();
    embeddingSettings.update({ concurrency: 2, minIntervalMs: 0, maxAttempts: 3, backoffBaseMs: 1 });
  });

  /** 造一个有 name 字段、会真正调 embed 的资产并入队。 */
  function enqueueForVec(id: string): void {
    insertAsset(id, { name: id, description: "d" });
    insertFile(id, "SKILL.md", "---\ndescription: d\n---\nbody");
    enqueue(id, "new");
  }

  it("处理中数量不超过 concurrency：tick 重入不超额领取", async () => {
    for (let i = 0; i < 6; i++) enqueueForVec(`r${i}`);

    let maxProcessing = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: any, _init: any) => {
      const c = (db.prepare(
        "SELECT COUNT(*) AS c FROM asset_embeddings WHERE status = 'processing'",
      ).get() as { c: number }).c;
      maxProcessing = Math.max(maxProcessing, c);
      await new Promise((r) => setTimeout(r, 20)); // 让重入 tick 有机会领
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] }) } as any;
    });

    // 模拟 setInterval 重入：上一轮 tick 未结束时下一轮又触发
    await Promise.all([tick(), tick()]);

    expect(maxProcessing).toBeLessThanOrEqual(2);
  });

  it("真正并发：concurrency=2 时同时有 2 个 embed 调用在飞", async () => {
    for (let i = 0; i < 4; i++) enqueueForVec(`p${i}`);

    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url: any, _init: any) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [0, 0, 0, 0], index: 0 }] }) } as any;
    });

    await tick();

    expect(maxInFlight).toBe(2); // 真正 2 并发，而非串行 1
  });
});

describe("removeSearchIndex", () => {
  it("清理 vec/fts/embeddings 三处行", async () => {
    insertAsset("d1", { name: "n", description: "d" });
    insertFile("d1", "SKILL.md", "---\ndescription: d\n---\nbody");
    await processToReady("d1");
    expect(statusOf("d1")?.status).toBe("ready");
    expect(vecRows("d1").length).toBeGreaterThan(0);
    expect(ftsRow("d1")).toBeDefined();

    removeSearchIndex("d1");
    expect(statusOf("d1")).toBeUndefined();
    expect(vecRows("d1").length).toBe(0);
    expect(ftsRow("d1")).toBeUndefined();
  });
});

describe("crashRecover", () => {
  it("启动时把 processing → pending", () => {
    insertAsset("e1", { name: "n", description: "d" });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO asset_embeddings (asset_id, status, queued_at, attempts, embed_dim, content_hash, field_version, updated_at)
       VALUES (?, 'processing', ?, 0, 4, 'x', 0, ?)`,
    ).run("e1", now, now);
    crashRecover();
    expect(statusOf("e1")?.status).toBe("pending");
  });
});
