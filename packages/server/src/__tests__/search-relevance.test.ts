import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { db, vecAvailable } from "../db/index.js";
import { migrate } from "../db/migrate.js";
import { hybridSearch } from "../lib/search-query.js";
import { embeddingSettings } from "../lib/embedding-config.js";
import { clearQueryVectorCache } from "../lib/query-vector-cache.js";

// §12 Step 7 verify：① 中文 trigram 用例 ② 改权重后排序即时变化（无需重建）。
// 权重/α 在 hybridSearch 内每次现读 embeddingSettings.get()（结构保证即时生效）。

function insertAsset(id: string, over: Partial<{ name: string; description: string; tags: string; visibility: string }> = {}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO assets (id, name, alias, type, description, author, tags, compatible_tools, visibility, version, metadata, auth_method, adopted, created_at, updated_at)
     VALUES (?, ?, NULL, 'skill', ?, 'tester', ?, '[]', ?, '1.0.0', '{}', 'none', 0, ?, ?)`,
  ).run(id, over.name ?? id, over.description ?? "d", over.tags ?? '["t"]', over.visibility ?? "public", now, now);
}

function insertFts(id: string, name: string, tags: string, description: string): void {
  db.prepare("INSERT INTO asset_fts (asset_id, name, tags, description) VALUES (?, ?, ?, ?)").run(id, name, tags, description);
}

function insertVec(id: string, field: string, vec: number[]): void {
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

function cfg(weights: { name: number; tags: number; description: number }, alpha = 0.1) {
  embeddingSettings.update({
    enabled: true, baseUrl: "https://embed.example.com/v1", apiKey: "sk-test",
    model: "test-model", dim: 4, weights, alpha, backoffBaseMs: 1,
  });
}

const VISIBLE = "a.deleted_at IS NULL AND a.adopted = 0 AND a.visibility = 'public'";

beforeAll(() => {
  migrate();
  if (!vecAvailable()) throw new Error("sqlite-vec 扩展未加载");
  db.exec("DROP TABLE IF EXISTS asset_vec");
  db.exec("CREATE VIRTUAL TABLE asset_vec USING vec0(embedding float[4] distance=cosine, asset_id TEXT, field TEXT)");
});

beforeEach(() => {
  db.prepare("DELETE FROM asset_vec").run();
  db.prepare("DELETE FROM asset_fts").run();
  db.prepare("DELETE FROM asset_embeddings").run();
  db.prepare("DELETE FROM asset_files").run();
  db.prepare("DELETE FROM assets").run();
  embeddingSettings.clear();
  clearQueryVectorCache();
});

afterEach(() => { vi.restoreAllMocks(); });

describe("§12 Step 7 ① 中文 trigram 用例", () => {
  beforeEach(() => cfg({ name: 0.4, tags: 0.2, description: 0.4 }));

  it("3+ 字符中文子串命中（审查清单）", async () => {
    insertAsset("a", { name: "code_review_checklist", description: "代码审查清单" });
    insertFts("a", "code_review_checklist", "审查", "代码审查清单用于审查");
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "审查清单", page: 1, pageSize: 10 });
    expect(res.total).toBe(1);
    expect(res.assetIds[0]).toBe("a");
  });

  it("中文跨字段命中（name 含中文）", async () => {
    insertAsset("a", { name: "代码审查", description: "x" });
    insertFts("a", "代码审查", "", "x");
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "代码审查", page: 1, pageSize: 10 });
    expect(res.total).toBe(1);
    expect(res.assetIds[0]).toBe("a");
  });

  it("2 字符查询不命中 trigram（最小 3-gram）", async () => {
    insertAsset("a", { name: "代码审查", description: "x" });
    insertFts("a", "代码审查", "", "x");
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "审查", page: 1, pageSize: 10 });
    // 2 字符不命中 trigram，且 query "审查" 与 mock vec 无语义近邻 → 空候选
    expect(res.total).toBe(0);
  });

  it("中英混合查询：英文 token + 中文子串均能召回", async () => {
    insertAsset("en", { name: "react component", description: "组件生成" });
    insertAsset("cn", { name: "组件生成器", description: "react" });
    insertFts("en", "react component", "", "组件生成");
    insertFts("cn", "组件生成器", "", "react");
    mockQueryVec([1, 0, 0, 0]);

    const res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "react 组件生成", page: 1, pageSize: 10 });
    // "react" OR "组件生成" → 两资产均命中其一
    expect(res.total).toBe(2);
    expect(new Set(res.assetIds)).toEqual(new Set(["en", "cn"]));
  });
});

describe("§12 Step 7 ② 改权重后排序即时变化（无需重建）", () => {
  // q = [1,0,0,0]
  // A: name vec 贴近 q（dist 0），tags vec 远（dist 1）
  // B: name vec 远（dist 1），tags vec 贴近 q（dist 0）
  // weights name 高 → A 前；weights tags 高 → B 前。无 FTS 命中（query=zzz），vec 驱动。
  const A = "A_nameclose";
  const B = "B_tagsclose";

  beforeEach(() => {
    insertAsset(A, { name: A, description: "x" });
    insertAsset(B, { name: B, description: "x" });
    insertVec(A, "name", [1, 0, 0, 0]); // dist 0 to q
    insertVec(A, "tags", [0, 1, 0, 0]); // dist 1
    insertVec(B, "name", [0, 1, 0, 0]); // dist 1
    insertVec(B, "tags", [1, 0, 0, 0]); // dist 0 to q
    mockQueryVec([1, 0, 0, 0]);
  });

  it("权重 name 高 → A 排前", async () => {
    cfg({ name: 0.9, tags: 0.1, description: 0 });
    const res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "zzz", page: 1, pageSize: 10 });
    expect(res.total).toBe(2);
    expect(res.assetIds[0]).toBe(A);
    expect(res.assetIds[1]).toBe(B);
  });

  it("权重 tags 高 → B 排前（仅改配置，不重建）", async () => {
    // 先按 name 高排（A 前）
    cfg({ name: 0.9, tags: 0.1, description: 0 });
    let res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "zzz", page: 1, pageSize: 10 });
    expect(res.assetIds[0]).toBe(A);

    // 改权重为 tags 高，不触碰 vec 行、不 rebuild，立即重查
    cfg({ name: 0.1, tags: 0.9, description: 0 });
    res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "zzz", page: 1, pageSize: 10 });
    expect(res.assetIds[0]).toBe(B);
    expect(res.assetIds[1]).toBe(A);
  });
});

describe("相似度阈值 simThreshold（§6）", () => {
  // q = [1,0,0,0]；strong name vec=[1,0,0,0]（sim 1.0）；weak name vec=[0.6,0.8,0,0]（sim 0.6）
  beforeEach(() => {
    insertAsset("strong", { name: "strong", description: "x" });
    insertAsset("weak", { name: "weak", description: "x" });
    insertVec("strong", "name", [1, 0, 0, 0]);
    insertVec("weak", "name", [0.6, 0.8, 0, 0]);
    mockQueryVec([1, 0, 0, 0]);
    cfg({ name: 1, tags: 0, description: 0 });
  });

  it("低于阈值的弱匹配不召回（避免宽泛词召回全目录）", async () => {
    embeddingSettings.update({ simThreshold: 0.7 }); // weak sim 0.6 < 0.7
    const res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "zzz", page: 1, pageSize: 10 });
    expect(res.assetIds).toEqual(["strong"]);
    expect(res.total).toBe(1);
  });

  it("simThreshold=0 不过滤，弱匹配也召回", async () => {
    embeddingSettings.update({ simThreshold: 0 });
    const res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "zzz", page: 1, pageSize: 10 });
    expect(new Set(res.assetIds)).toEqual(new Set(["strong", "weak"]));
    // strong sim 1.0 > weak sim 0.6 → strong 排前
    expect(res.assetIds[0]).toBe("strong");
  });

  it("阈值介于两者之间：仅召回高于阈值者", async () => {
    embeddingSettings.update({ simThreshold: 0.8 });
    const res = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "zzz", page: 1, pageSize: 10 });
    expect(res.assetIds).toEqual(["strong"]);
    embeddingSettings.update({ simThreshold: 0.5 });
    const res2 = await hybridSearch({ visibleWhere: VISIBLE, visibleParams: [], query: "zzz", page: 1, pageSize: 10 });
    expect(new Set(res2.assetIds)).toEqual(new Set(["strong", "weak"]));
  });
});
