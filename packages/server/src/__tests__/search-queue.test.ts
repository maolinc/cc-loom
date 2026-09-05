import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { enqueue } from "../lib/search-indexer.js";
import { queueCounts, queueItems, requeue, retryFailed, assetIndexList } from "../lib/search-queue.js";
import { embeddingSettings } from "../lib/embedding-config.js";

// L1：直接 DB fixture 验证队列管理查询与操作（§5.7）。HTTP 路径见 API 冒烟 + L3。

function insertAsset(id: string, over: Partial<{
  name: string; type: string; description: string; tags: string; adopted: number;
}> = {}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assets (id, name, alias, type, description, author, tags, compatible_tools, visibility, version, metadata, auth_method, adopted, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'tester', ?, '[]', 'public', '1.0.0', '{}', 'none', ?, ?, ?)`,
  ).run(
    id,
    over.name ?? id,
    over.type ?? "skill",
    over.description ?? "d",
    over.tags ?? '["t"]',
    over.adopted ?? 0,
    now,
    now,
  );
}

function insertEmbRow(assetId: string, status: string, over: Partial<{
  attempts: number; last_error: string | null; processed_at: string | null; embed_model: string | null; queued_at: string;
}> = {}): void {
  const now = over.queued_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO asset_embeddings (asset_id, status, queued_at, attempts, next_attempt_at, last_error, embed_model, embed_dim, content_hash, field_version, processed_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 4, ?, 0, ?, ?)`,
  ).run(
    assetId, status, now,
    over.attempts ?? 0,
    over.last_error ?? null,
    over.embed_model ?? null,
    `hash-${assetId}`,
    over.processed_at ?? null,
    now,
  );
}

/** 写入一条 dim=4 的 vec 行（模拟已索引字段）。需 asset_vec 已按 dim=4 重建。 */
function insertVecRow(assetId: string, field: string): void {
  db.prepare("INSERT INTO asset_vec (embedding, asset_id, field) VALUES (?, ?, ?)").run(
    Buffer.from(new Float32Array(4).buffer), assetId, field,
  );
}

/** 重建 asset_vec 到 dim=4（对齐 insertEmbRow 的 embed_dim=4 + insertVecRow 的 4 维向量）。 */
function rebuildVec4(): void {
  db.exec("DROP TABLE IF EXISTS asset_vec");
  db.exec("CREATE VIRTUAL TABLE asset_vec USING vec0(embedding float[4] distance=cosine, asset_id TEXT, field TEXT)");
}

beforeAll(() => { migrate(); });

beforeEach(() => {
  db.prepare("DELETE FROM asset_vec").run();
  db.prepare("DELETE FROM asset_fts").run();
  db.prepare("DELETE FROM asset_embeddings").run();
  db.prepare("DELETE FROM asset_files").run();
  db.prepare("DELETE FROM assets").run();
  embeddingSettings.clear();
});

describe("queueCounts", () => {
  it("空队列全 0", () => {
    const c = queueCounts();
    expect(c).toEqual({ pending: 0, processing: 0, ready: 0, failed: 0, total: 0, assets: 0, rebuilding: false });
  });

  it("按 status 分组计数 + total", () => {
    insertAsset("a1"); insertAsset("a2"); insertAsset("a3");
    insertEmbRow("a1", "pending");
    insertEmbRow("a2", "ready", { processed_at: new Date().toISOString() });
    insertEmbRow("a3", "failed", { last_error: "err" });
    const c = queueCounts();
    expect(c).toEqual({ pending: 1, processing: 0, ready: 1, failed: 1, total: 3, assets: 3, rebuilding: false });
  });

  it("过滤 adopted 能力", () => {
    insertAsset("a1", { adopted: 0 });
    insertAsset("a2", { adopted: 1 });
    insertEmbRow("a1", "pending");
    insertEmbRow("a2", "pending");
    const c = queueCounts();
    expect(c.pending).toBe(1);
    expect(c.total).toBe(1);
    expect(c.assets).toBe(1);
  });

  it("assets 含未索引能力（无 embedding 行）", () => {
    insertAsset("idx", { name: "已索引" });
    insertAsset("unidx", { name: "未索引" });
    insertEmbRow("idx", "ready", { processed_at: new Date().toISOString() });
    const c = queueCounts();
    expect(c.assets).toBe(2);
    expect(c.total).toBe(1); // 仅 idx 有 embedding 行
  });
});

describe("queueItems", () => {
  it("按 status 过滤 + 分页", () => {
    for (let i = 0; i < 5; i++) {
      insertAsset(`p${i}`);
      insertEmbRow(`p${i}`, "pending");
    }
    const page1 = queueItems("pending", 1, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);
    const page3 = queueItems("pending", 3, 2);
    expect(page3.items).toHaveLength(1);
  });

  it("pending 按 queued_at ASC 排序", () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-01-02T00:00:00.000Z";
    insertAsset("late"); insertAsset("early");
    insertEmbRow("late", "pending", { queued_at: t2 });
    insertEmbRow("early", "pending", { queued_at: t1 });
    const list = queueItems("pending", 1, 10);
    expect(list.items[0]!.assetId).toBe("early");
    expect(list.items[1]!.assetId).toBe("late");
  });

  it("ready 按 processed_at DESC 排序", () => {
    insertAsset("r1"); insertAsset("r2");
    insertEmbRow("r1", "ready", { processed_at: "2026-01-01T00:00:00.000Z" });
    insertEmbRow("r2", "ready", { processed_at: "2026-01-02T00:00:00.000Z" });
    const list = queueItems("ready", 1, 10);
    expect(list.items[0]!.assetId).toBe("r2");
  });

  it("返回字段完整 + 过滤 adopted", () => {
    insertAsset("vis", { name: "可见", type: "skill", adopted: 0 });
    insertAsset("hid", { name: "adopted", adopted: 1 });
    insertEmbRow("vis", "failed", { attempts: 3, last_error: "boom" });
    insertEmbRow("hid", "failed", { attempts: 1, last_error: "x" });
    const list = queueItems("failed", 1, 10);
    expect(list.items).toHaveLength(1);
    const it = list.items[0]!;
    expect(it.assetId).toBe("vis");
    expect(it.name).toBe("可见");
    expect(it.type).toBe("skill");
    expect(it.attempts).toBe(3);
    expect(it.lastError).toBe("boom");
  });

  it("status=all 返回全部", () => {
    insertAsset("a1"); insertAsset("a2");
    insertEmbRow("a1", "pending");
    insertEmbRow("a2", "ready", { processed_at: new Date().toISOString() });
    const list = queueItems("all", 1, 10);
    expect(list.items).toHaveLength(2);
    expect(list.total).toBe(2);
  });
});

describe("requeue", () => {
  it("{all:true} 重新入队全部能力（ready/failed/未索引 → pending；pending/processing 跳过）", () => {
    insertAsset("r1"); insertAsset("f1"); insertAsset("u1"); insertAsset("p1");
    insertEmbRow("r1", "ready", { processed_at: new Date().toISOString() });
    insertEmbRow("f1", "failed", { attempts: 3, last_error: "err" });
    insertEmbRow("p1", "pending");
    // u1：无 embedding 行（未索引）
    const n = requeue({ all: true });
    // r1(ready)、f1(failed)→pending；u1(无行)→INSERT pending；p1(pending)→no-op
    expect(n).toBe(3);
    const c = queueCounts();
    expect(c.pending).toBe(4);
    expect(c.ready).toBe(0);
    expect(c.failed).toBe(0);
  });

  it("{assetIds} 指定重排（manual 强制，含 failed）", () => {
    insertAsset("f1"); insertAsset("r1");
    insertEmbRow("f1", "failed", { attempts: 3, last_error: "err" });
    insertEmbRow("r1", "ready", { processed_at: new Date().toISOString() });
    const n = requeue({ assetIds: ["f1", "r1"] });
    expect(n).toBe(2);
    const c = queueCounts();
    expect(c.pending).toBe(2);
    expect(c.failed).toBe(0);
    // manual 重置 attempts
    const f1 = db.prepare("SELECT attempts FROM asset_embeddings WHERE asset_id = ?").get("f1") as { attempts: number };
    expect(f1.attempts).toBe(0);
  });
});

describe("retryFailed", () => {
  it("把 failed → pending, attempts=0", () => {
    insertAsset("f1"); insertAsset("f2"); insertAsset("r1");
    insertEmbRow("f1", "failed", { attempts: 3, last_error: "err" });
    insertEmbRow("f2", "failed", { attempts: 2, last_error: "err2" });
    insertEmbRow("r1", "ready", { processed_at: new Date().toISOString() });
    const n = retryFailed();
    expect(n).toBe(2);
    const c = queueCounts();
    expect(c.pending).toBe(2);
    expect(c.failed).toBe(0);
    expect(c.ready).toBe(1);
  });

  it("无 failed 时返回 0", () => {
    insertAsset("r1");
    insertEmbRow("r1", "ready", { processed_at: new Date().toISOString() });
    expect(retryFailed()).toBe(0);
  });
});

describe("assetIndexList", () => {
  it("LEFT JOIN：无 embedding 行记 unindexed，与已索引项一同出现", () => {
    insertAsset("r1", { name: "已索引" });
    insertAsset("u1", { name: "未索引" });
    insertEmbRow("r1", "ready", { processed_at: "2026-01-02T00:00:00.000Z" });
    const list = assetIndexList(1, 20, "", "desc");
    expect(list.total).toBe(2);
    const u = list.items.find((i) => i.assetId === "u1")!;
    expect(u.status).toBe("unindexed");
    expect(u.processedAt).toBeNull();
    const r = list.items.find((i) => i.assetId === "r1")!;
    expect(r.status).toBe("ready");
    expect(r.processedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("过滤已软删与 adopted", () => {
    insertAsset("vis", { name: "可见" });
    insertAsset("del", { name: "已删" });
    insertAsset("ado", { name: "adopted", adopted: 1 });
    insertEmbRow("vis", "ready", { processed_at: "2026-01-01T00:00:00.000Z" });
    insertEmbRow("del", "ready", { processed_at: "2026-01-01T00:00:00.000Z" });
    db.prepare("UPDATE assets SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), "del");
    const list = assetIndexList(1, 20, "", "desc");
    expect(list.total).toBe(1);
    expect(list.items[0]!.assetId).toBe("vis");
  });

  it("按 processed_at DESC 排序，未成功过的排末尾", () => {
    insertAsset("recent"); insertAsset("old"); insertAsset("never");
    insertEmbRow("recent", "ready", { processed_at: "2026-03-01T00:00:00.000Z" });
    insertEmbRow("old", "ready", { processed_at: "2026-01-01T00:00:00.000Z" });
    // never：无 embedding 行
    const list = assetIndexList(1, 20, "", "desc");
    expect(list.items.map((i) => i.assetId)).toEqual(["recent", "old", "never"]);
  });

  it("order=asc：未成功过的排最前（NULLS FIRST）", () => {
    insertAsset("recent"); insertAsset("never");
    insertEmbRow("recent", "ready", { processed_at: "2026-03-01T00:00:00.000Z" });
    const list = assetIndexList(1, 20, "", "asc");
    expect(list.items[0]!.assetId).toBe("never");
    expect(list.items[1]!.assetId).toBe("recent");
  });

  it("q 按 name 子串过滤（含分页）", () => {
    for (let i = 0; i < 5; i++) {
      insertAsset(`sk${i}`, { name: `skill-${i}` });
      insertEmbRow(`sk${i}`, "ready", { processed_at: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    insertAsset("other", { name: "agent-x" });
    const list = assetIndexList(1, 2, "skill", "desc");
    expect(list.total).toBe(5);
    expect(list.items).toHaveLength(2);
    expect(list.items.every((i) => i.name.startsWith("skill-"))).toBe(true);
  });

  it("q 中的 % _ \\ 被转义为字面量", () => {
    insertAsset("lit", { name: "a%b_c" });
    insertAsset("norm", { name: "abc" });
    insertEmbRow("lit", "ready", { processed_at: "2026-01-01T00:00:00.000Z" });
    insertEmbRow("norm", "ready", { processed_at: "2026-01-01T00:00:00.000Z" });
    const list = assetIndexList(1, 20, "a%b_c", "desc");
    expect(list.total).toBe(1);
    expect(list.items[0]!.name).toBe("a%b_c");
  });

  it("status 映射各状态", () => {
    insertAsset("p1"); insertAsset("g1"); insertAsset("f1"); insertAsset("u1");
    insertEmbRow("p1", "pending");
    insertEmbRow("g1", "processing");
    insertEmbRow("f1", "failed", { last_error: "boom" });
    const list = assetIndexList(1, 20, "", "desc");
    const find = (id: string) => list.items.find((i) => i.assetId === id)!;
    expect(find("p1").status).toBe("pending");
    expect(find("g1").status).toBe("processing");
    expect(find("f1").status).toBe("failed");
    expect(find("f1").lastError).toBe("boom");
    expect(find("u1").status).toBe("unindexed");
  });

  it("pending 项保留 processedAt（requeue 后仍可见上次成功构建时间）", () => {
    insertAsset("r1");
    // 曾 ready（有 processed_at），后因 manual requeue 转 pending（processed_at 不被清）
    insertEmbRow("r1", "pending", { processed_at: "2026-02-01T00:00:00.000Z" });
    const list = assetIndexList(1, 20, "", "desc");
    const it = list.items.find((i) => i.assetId === "r1")!;
    expect(it.status).toBe("pending");
    expect(it.processedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("indexSizeBytes = vec 行数 × embed_dim × 4；totalSizeBytes 汇总全部可见能力", () => {
    rebuildVec4();
    insertAsset("a1", { name: "三字段" });
    insertAsset("a2", { name: "一字段" });
    insertEmbRow("a1", "ready", { processed_at: "2026-01-01T00:00:00.000Z" }); // embed_dim=4
    insertEmbRow("a2", "ready", { processed_at: "2026-01-02T00:00:00.000Z" });
    insertVecRow("a1", "name"); insertVecRow("a1", "tags"); insertVecRow("a1", "description");
    insertVecRow("a2", "name");
    const list = assetIndexList(1, 20, "", "desc");
    const a1 = list.items.find((i) => i.assetId === "a1")!;
    const a2 = list.items.find((i) => i.assetId === "a2")!;
    expect(a1.indexSizeBytes).toBe(3 * 4 * 4); // 3 字段 × dim4 × 4B
    expect(a2.indexSizeBytes).toBe(1 * 4 * 4);
    expect(list.totalSizeBytes).toBe(3 * 4 * 4 + 1 * 4 * 4);
  });

  it("indexSizeBytes=0 当未索引或无 vec 行", () => {
    rebuildVec4();
    insertAsset("u1", { name: "未索引" }); // 无 emb 行、无 vec 行
    insertAsset("e1", { name: "有emb无vec" });
    insertEmbRow("e1", "ready", { processed_at: "2026-01-01T00:00:00.000Z" }); // emb 行但无 vec 行
    const list = assetIndexList(1, 20, "", "desc");
    expect(list.items.find((i) => i.assetId === "u1")!.indexSizeBytes).toBe(0);
    expect(list.items.find((i) => i.assetId === "e1")!.indexSizeBytes).toBe(0);
    expect(list.totalSizeBytes).toBe(0);
  });
});
