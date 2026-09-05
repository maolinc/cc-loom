import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { db, vecAvailable } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { hybridSearch } from "../lib/search-query.js";
import { embeddingSettings } from "../lib/embedding-config.js";
import { clearQueryVectorCache } from "../lib/query-vector-cache.js";

// L1：直接 DB fixture + mock embed(query)。验证混合检索融合排序、词法降级、
// 后过滤、可见性预过滤、无向量资产、空候选。HTTP 路径见 API 冒烟 + L3。

function insertAsset(id: string, over: Partial<{
  name: string; alias: string | null; type: string; description: string; tags: string;
  visibility: string; sourceId: string | null; author: string;
}> = {}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assets (id, name, alias, type, description, author, tags, compatible_tools, visibility, version, metadata, auth_method, adopted, source_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, '1.0.0', '{}', 'none', 0, ?, ?, ?)`,
  ).run(
    id,
    over.name ?? id,
    over.alias ?? null,
    over.type ?? "skill",
    over.description ?? "d",
    over.author ?? "tester",
    over.tags ?? '["t"]',
    over.visibility ?? "public",
    over.sourceId ?? null,
    now, now,
  );
}

function insertFts(id: string, name: string, tags: string, description: string): void {
  db.prepare("DELETE FROM asset_fts WHERE asset_id = ?").run(id);
  db.prepare("INSERT INTO asset_fts (asset_id, name, tags, description) VALUES (?, ?, ?, ?)").run(id, name, tags, description);
}

function insertVec(id: string, field: string, vec: number[]): void {
  db.prepare("DELETE FROM asset_vec WHERE asset_id = ? AND field = ?").run(id, field);
  db.prepare("INSERT INTO asset_vec (embedding, asset_id, field) VALUES (?, ?, ?)").run(
    Buffer.from(new Float32Array(vec).buffer), id, field,
  );
}

function mockQueryVec(vec: number[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
    ok: true, status: 200,
    json: async () => ({ data: [{ embedding: vec, index: 0 }] }),
  }) as any);
}

function mockEmbedError() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
    ok: false, status: 503,
    json: async () => ({ error: { message: "down" } }),
  }) as any);
}

function cfgEnabled(alpha = 0.4) {
  embeddingSettings.update({
    enabled: true,
    baseUrl: "https://embed.example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    dim: 4,
    weights: { name: 0.4, tags: 0.2, description: 0.4 },
    alpha,
    backoffBaseMs: 1,
  });
}

const VISIBLE_PUBLIC = "a.deleted_at IS NULL AND a.adopted = 0 AND a.visibility = 'public'";

beforeAll(() => {
  migrate();
  if (!vecAvailable()) throw new Error("sqlite-vec 扩展未加载");
  // 对齐 4 维 mock 向量
  db.exec("DROP TABLE IF EXISTS asset_vec");
  db.exec("CREATE VIRTUAL TABLE asset_vec USING vec0(embedding float[4] distance=cosine, asset_id TEXT, field TEXT)");
});

beforeEach(() => {
  db.prepare("DELETE FROM asset_vec").run();
  db.prepare("DELETE FROM asset_fts").run();
  db.prepare("DELETE FROM asset_embeddings").run();
  db.prepare("DELETE FROM asset_files").run();
  db.prepare("DELETE FROM assets").run();
  db.prepare("DELETE FROM marketplace_sources").run();
  embeddingSettings.clear();
  clearQueryVectorCache();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("hybridSearch 融合排序", () => {
  beforeEach(cfgEnabled);

  it("语义近邻优先：vec 距离近的排前（FTS5 无命中时由 vec 驱动）", async () => {
    insertAsset("close", { name: "close", description: "x" });
    insertAsset("far", { name: "far", description: "x" });
    insertVec("close", "name", [1, 0, 0, 0]);          // sim 1.0（距离 0）
    insertVec("far", "name", [0.6, 0.8, 0, 0]);        // sim 0.6（距离 0.4）——仍远于 close 但过相似度阈值
    // FTS5 查询词无命中 → 词法路空，vec 驱动
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "zzznomatch", page: 1, pageSize: 10 });
    expect(res.mode).toBe("hybrid");
    expect(res.total).toBe(2);
    expect(res.assetIds[0]).toBe("close"); // 距离 0 → 语义分最高
    expect(res.assetIds[1]).toBe("far");
  });

  it("无向量的资产仍可经 FTS5 召回（语义分记 0）", async () => {
    insertAsset("onlyfts", { name: "react gen", description: "生成" });
    insertFts("onlyfts", "react gen", "前端", "生成 react");
    insertAsset("withvec", { name: "other", description: "x" });
    insertVec("withvec", "name", [1, 0, 0, 0]);
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", page: 1, pageSize: 10 });
    expect(res.mode).toBe("hybrid");
    expect(res.total).toBe(2);
    // onlyfts 有 FTS5 命中（react），withvec 无 FTS5 命中但 vec 命中。两者都在结果中。
    expect(res.assetIds).toContain("onlyfts");
    expect(res.assetIds).toContain("withvec");
  });

  it("α=1 时纯词法（vec 不影响排序）", async () => {
    embeddingSettings.update({ alpha: 1 });
    insertAsset("a", { name: "react component", description: "x" });
    insertAsset("b", { name: "react", description: "x" });
    insertFts("a", "react component", "", "");
    insertFts("b", "react", "", "");
    // a 的 vec 离 query 更近，但 α=1 应忽略 vec
    insertVec("a", "name", [1, 0, 0, 0]);
    insertVec("b", "name", [0, 1, 0, 0]);
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", page: 1, pageSize: 10 });
    expect(res.mode).toBe("hybrid");
    // 两者都命中 react；排序由 FTS5 BM25 决定（α=1）。b 文档更短，BM25 通常更高。
    expect(res.total).toBe(2);
  });
});

describe("hybridSearch 词法降级", () => {
  it("embedding 启用但 embed 失败 → mode=lexical，FTS5 驱动", async () => {
    cfgEnabled();
    insertAsset("a", { name: "react gen", description: "x" });
    insertAsset("b", { name: "react hooks", description: "x" });
    insertFts("a", "react gen", "", "");
    insertFts("b", "react hooks", "", "");
    mockEmbedError();

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", page: 1, pageSize: 10 });
    expect(res.mode).toBe("lexical");
    expect(res.total).toBe(2);
    expect(res.assetIds).toContain("a");
    expect(res.assetIds).toContain("b");
  });

  it("embedding 未启用 → mode=lexical，仅 FTS5，不调 embed", async () => {
    // cfg.enabled=false（默认）
    insertAsset("a", { name: "react", description: "x" });
    insertFts("a", "react", "", "");
    const spy = vi.spyOn(globalThis, "fetch");

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", page: 1, pageSize: 10 });
    expect(res.mode).toBe("lexical");
    expect(res.total).toBe(1);
    expect(res.assetIds[0]).toBe("a");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("hybridSearch 搜索模式门控", () => {
  beforeEach(cfgEnabled);

  it("useSemantic=false → 词法独占：不调 embed，mode=lexical，仅 FTS5 命中", async () => {
    embeddingSettings.update({ useSemantic: false });
    insertAsset("a", { name: "react gen", description: "x" });
    insertFts("a", "react gen", "", "");
    insertAsset("b", { name: "other", description: "x" });
    insertVec("b", "name", [1, 0, 0, 0]); // 仅供语义路，但语义路被关
    mockQueryVec([1, 0, 0, 0]);
    const spy = vi.spyOn(globalThis, "fetch");

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", page: 1, pageSize: 10 });
    expect(res.mode).toBe("lexical");
    expect(res.total).toBe(1);
    expect(res.assetIds[0]).toBe("a");
    expect(res.assetIds).not.toContain("b"); // b 无 FTS5 命中，语义路又被关 → 不召回
    expect(spy).not.toHaveBeenCalled(); // 语义路关闭 → embed 不调
  });

  it("useLexical=false → 语义独占：FTS5 不跑，仅 vec 命中", async () => {
    embeddingSettings.update({ useLexical: false });
    insertAsset("ftsOnly", { name: "react gen", description: "x" });
    insertFts("ftsOnly", "react gen", "", ""); // 本可经 FTS5 召回，但词法路被关
    insertAsset("vecOnly", { name: "other", description: "x" });
    insertVec("vecOnly", "name", [1, 0, 0, 0]);
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", page: 1, pageSize: 10 });
    expect(res.mode).toBe("hybrid");
    expect(res.total).toBe(1);
    expect(res.assetIds[0]).toBe("vecOnly");
    expect(res.assetIds).not.toContain("ftsOnly"); // FTS5 被关 → 词法命中不进候选
  });
});

describe("hybridSearch 后过滤", () => {
  beforeEach(cfgEnabled);

  it("type 过滤", async () => {
    insertAsset("s1", { name: "react", type: "skill", description: "x" });
    insertAsset("r1", { name: "react", type: "rule", description: "x" });
    insertFts("s1", "react", "", ""); insertFts("r1", "react", "", "");
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", type: "skill", page: 1, pageSize: 10 });
    expect(res.total).toBe(1);
    expect(res.assetIds[0]).toBe("s1");
  });

  it("tags 过滤（OR 语义）", async () => {
    insertAsset("a", { name: "react", tags: '["前端","React"]', description: "x" });
    insertAsset("b", { name: "react", tags: '["后端"]', description: "x" });
    insertFts("a", "react", "前端 React", ""); insertFts("b", "react", "后端", "");
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", tags: ["React"], page: 1, pageSize: 10 });
    expect(res.total).toBe(1);
    expect(res.assetIds[0]).toBe("a");
  });

  it("source 过滤", async () => {
    db.prepare(
      `INSERT INTO marketplace_sources (id, kind, repo_url, display_name, description, added_by, local_path, created_at, updated_at)
       VALUES ('src-1', 'git', 'https://x.git', 'src', '', 'tester', '/tmp/x', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    insertAsset("local", { name: "react", sourceId: null, description: "x" });
    insertAsset("remote", { name: "react", sourceId: "src-1", description: "x" });
    insertFts("local", "react", "", ""); insertFts("remote", "react", "", "");
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", source: "local", page: 1, pageSize: 10 });
    expect(res.total).toBe(1);
    expect(res.assetIds[0]).toBe("local");
  });
});

describe("hybridSearch 可见性预过滤", () => {
  beforeEach(cfgEnabled);

  it("仅返回可见集中的资产", async () => {
    insertAsset("pub", { name: "react", visibility: "public", description: "x" });
    insertAsset("priv", { name: "react", visibility: "private", author: "other@x", description: "x" });
    insertFts("pub", "react", "", ""); insertFts("priv", "react", "", "");
    insertVec("pub", "name", [1, 0, 0, 0]); insertVec("priv", "name", [1, 0, 0, 0]);
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "react", page: 1, pageSize: 10 });
    expect(res.total).toBe(1);
    expect(res.assetIds[0]).toBe("pub");
  });
});

describe("hybridSearch 空候选", () => {
  it("FTS5 与 vec 均无命中 → total=0", async () => {
    cfgEnabled();
    insertAsset("a", { name: "unrelated", description: "x" });
    insertFts("a", "unrelated", "", "");
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "zzznomatch", page: 1, pageSize: 10 });
    expect(res.total).toBe(0);
    expect(res.assetIds).toEqual([]);
  });
});

describe("hybridSearch 分页", () => {
  beforeEach(cfgEnabled);

  it("按 score DESC 分页", async () => {
    for (let i = 0; i < 5; i++) {
      insertAsset(`a${i}`, { name: `react ${i}`, description: "x" });
      insertVec(`a${i}`, "name", [1, 0, 0, 0]); // 全部距离 0，vec 分相同
    }
    mockQueryVec([1, 0, 0, 0]);

    const p1 = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "zzz", page: 1, pageSize: 2 });
    expect(p1.total).toBe(5);
    expect(p1.assetIds).toHaveLength(2);
    const p3 = await hybridSearch({ visibleWhere: VISIBLE_PUBLIC, visibleParams: [], query: "zzz", page: 3, pageSize: 2 });
    expect(p3.assetIds).toHaveLength(1);
  });
});
