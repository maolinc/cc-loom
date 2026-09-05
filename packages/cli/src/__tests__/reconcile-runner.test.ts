/**
 * wire 协议 v2 的 `applyReconcilePlan` 单测。
 *
 * 覆盖关键路径（不变量优先于 API 表面）：
 *   1. 单 skill 落盘 → vendor 文件 + lockFormat="2" + lock.assets[id].vendors[tool].files
 *   2. disabled 桶单 asset → vendor 目录无文件，隔离区有文件
 *   3. toggle off 跨调用：先 enabled 后 disabled → 文件搬到隔离区，vendor 目录清空
 *   4. toggle on：先 disabled 后 enabled → 文件回 vendor，隔离区清空
 *   5. orphan 清理：上次 lock 有 a/b 两文件，本次 plan 只含 a → b 被清掉
 *   6. removed assets：plan.removed 含某 id → 该 id 在隔离区的旧副本被清
 *   7. aggregates 写入 / 清空：mcp.json content / mcp.json content=null → 删除
 *   8. v1 lock 迁移：lockFormat 缺失 + vendors[t].enabled=false 集合 → migrationDisabled
 *   9. 空 plan + workspaceId=null：vendor & 隔离区 & aggregate 全清
 *  10. 路径安全：plan 携带越界 path 被 errors 捕获，不写盘也不致命
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LockFile, ReconcilePlan, WsReconcileRequest } from "@maolinc/cc-loom-shared";
import { applyReconcilePlan } from "../lib/reconcile-runner.js";
import { readLock, writeLock, removeLock } from "../lib/locks.js";
import { writeProject, removeProject } from "../lib/projects.js";
import { disabledPath, disabledProjectRoot, ensureLoomDirs } from "../lib/paths.js";

const PROJECT_ID = "p-rec-test";

function makeReq(plan: ReconcilePlan, opts: Partial<WsReconcileRequest> = {}): WsReconcileRequest {
  return {
    requestId: "req-1",
    projectId: PROJECT_ID,
    // 显式区分"未传"和"传空数组"：`??` 把 undefined 当默认值。
    subscriptions: opts.subscriptions ?? [{ workspaceId: "ws-rec", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
    targetTools: opts.targetTools ?? ["cursor"],
    plan,
  };
}

function emptyPlan(): ReconcilePlan {
  return { enabled: [], disabled: [], removed: [], aggregates: [] };
}

describe("applyReconcilePlan", () => {
  let projectRoot: string;

  beforeEach(() => {
    ensureLoomDirs();
    projectRoot = mkdtempSync(join(tmpdir(), "loom-rec-test-"));
    writeProject({
      id: PROJECT_ID,
      deviceId: "d",
      userId: "u",
      projectName: "rec-test",
      normalizedPath: projectRoot,
      registeredAt: new Date().toISOString(),
      detectedTargets: [],
      defaultTargets: [],
      subscriptions: [],
      status: "online",
      endpoint: "http://localhost:0",
    });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    try { removeLock(PROJECT_ID); } catch { /* ignore */ }
    try { removeProject(PROJECT_ID); } catch { /* ignore */ }
    rmSync(disabledProjectRoot(PROJECT_ID), { recursive: true, force: true });
  });

  it("单 skill 落盘：vendor 文件出现，lockFormat=2，migrationDisabled 缺失", () => {
    const req = makeReq({
      enabled: [{
        assetId: "a1", name: "a1", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: true, files: [{ path: ".cursor/skills/a1.md", content: "hello" }] }],
      }],
      disabled: [], removed: [], aggregates: [],
    });
    const { response, errors } = applyReconcilePlan(req, projectRoot);
    expect(errors).toEqual([]);
    expect(response.filesWritten).toContain(".cursor/skills/a1.md");
    expect(readFileSync(join(projectRoot, ".cursor/skills/a1.md"), "utf-8")).toBe("hello");
    expect(response.migrationDisabled).toBeUndefined();
    const lock = readLock(PROJECT_ID)!;
    expect(lock.lockFormat).toBe("3");
    expect(lock.subscriptions.map((s) => s.workspaceId)).toEqual(["ws-rec"]);
    expect(lock.assets["a1"]!.vendors!.cursor!.enabled).toBe(true);
    expect(lock.assets["a1"]!.vendors!.cursor!.files).toEqual([".cursor/skills/a1.md"]);
  });

  it("disabled 桶 asset：vendor 目录无文件，隔离区有文件", () => {
    const req = makeReq({
      enabled: [], disabled: [{
        assetId: "a1", name: "a1", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: false, files: [{ path: ".cursor/skills/a1.md", content: "off" }] }],
      }], removed: [], aggregates: [],
    });
    const { errors } = applyReconcilePlan(req, projectRoot);
    expect(errors).toEqual([]);
    expect(existsSync(join(projectRoot, ".cursor/skills/a1.md"))).toBe(false);
    expect(readFileSync(disabledPath(PROJECT_ID, ".cursor/skills/a1.md"), "utf-8")).toBe("off");
  });

  it("toggle off：先 enabled 后 disabled → 文件从 vendor 搬到隔离区", () => {
    // 1st apply: enabled
    applyReconcilePlan(makeReq({
      enabled: [{
        assetId: "a1", name: "a1", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: true, files: [{ path: ".cursor/skills/a1.md", content: "v1" }] }],
      }], disabled: [], removed: [], aggregates: [],
    }), projectRoot);
    expect(existsSync(join(projectRoot, ".cursor/skills/a1.md"))).toBe(true);

    // 2nd apply: disabled
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [{
        assetId: "a1", name: "a1", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: false, files: [{ path: ".cursor/skills/a1.md", content: "v1" }] }],
      }], removed: [], aggregates: [],
    }), projectRoot);
    expect(existsSync(join(projectRoot, ".cursor/skills/a1.md"))).toBe(false);
    expect(readFileSync(disabledPath(PROJECT_ID, ".cursor/skills/a1.md"), "utf-8")).toBe("v1");
  });

  it("toggle on：先 disabled 后 enabled → 文件回 vendor 目录，隔离区清空", () => {
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [{
        assetId: "a1", name: "a1", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: false, files: [{ path: ".cursor/skills/a1.md", content: "v1" }] }],
      }], removed: [], aggregates: [],
    }), projectRoot);
    expect(existsSync(disabledPath(PROJECT_ID, ".cursor/skills/a1.md"))).toBe(true);

    applyReconcilePlan(makeReq({
      enabled: [{
        assetId: "a1", name: "a1", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: true, files: [{ path: ".cursor/skills/a1.md", content: "v1" }] }],
      }], disabled: [], removed: [], aggregates: [],
    }), projectRoot);
    expect(readFileSync(join(projectRoot, ".cursor/skills/a1.md"), "utf-8")).toBe("v1");
    expect(existsSync(disabledPath(PROJECT_ID, ".cursor/skills/a1.md"))).toBe(false);
  });

  it("orphan：上次 plan 含 a/b，本次只含 a → b 被清", () => {
    applyReconcilePlan(makeReq({
      enabled: [
        { assetId: "a", name: "a", type: "skill", version: "1",
          vendors: [{ tool: "cursor", enabled: true, files: [{ path: ".cursor/skills/a.md", content: "a" }] }] },
        { assetId: "b", name: "b", type: "skill", version: "1",
          vendors: [{ tool: "cursor", enabled: true, files: [{ path: ".cursor/skills/b.md", content: "b" }] }] },
      ], disabled: [], removed: [], aggregates: [],
    }), projectRoot);
    expect(existsSync(join(projectRoot, ".cursor/skills/b.md"))).toBe(true);

    applyReconcilePlan(makeReq({
      enabled: [
        { assetId: "a", name: "a", type: "skill", version: "1",
          vendors: [{ tool: "cursor", enabled: true, files: [{ path: ".cursor/skills/a.md", content: "a" }] }] },
      ], disabled: [], removed: [
        { assetId: "b", name: "b", type: "skill", version: "1",
          vendors: [{ tool: "cursor", enabled: false, files: [{ path: ".cursor/skills/b.md", content: "b" }] }] },
      ], aggregates: [],
    }), projectRoot);
    expect(existsSync(join(projectRoot, ".cursor/skills/a.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".cursor/skills/b.md"))).toBe(false);
    const lock = readLock(PROJECT_ID)!;
    expect(lock.assets["b"]).toBeUndefined();
  });

  it("removed asset 的隔离区副本被清", () => {
    // 先 disabled 一下，让隔离区有文件
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [
        { assetId: "stale", name: "stale", type: "skill", version: "1",
          vendors: [{ tool: "cursor", enabled: false, files: [{ path: ".cursor/skills/stale.md", content: "x" }] }] },
      ], removed: [], aggregates: [],
    }), projectRoot);
    expect(existsSync(disabledPath(PROJECT_ID, ".cursor/skills/stale.md"))).toBe(true);

    // 再发一次 plan，这次 removed 含 stale（plan 自带 files，即使不在 lock 也能删 + 清隔离区）
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [
        { assetId: "stale", name: "stale", type: "skill", version: "1",
          vendors: [{ tool: "cursor", enabled: false, files: [{ path: ".cursor/skills/stale.md", content: "x" }] }] },
      ], aggregates: [],
    }), projectRoot);
    expect(existsSync(disabledPath(PROJECT_ID, ".cursor/skills/stale.md"))).toBe(false);
  });

  it("removed asset 不在 lock 也能按 plan files 删除（外部能力 adopt 后直接 remove）", () => {
    // 预置磁盘文件（模拟外部能力，从未进 lock）
    mkdirSync(join(projectRoot, ".cursor/skills"), { recursive: true });
    writeFileSync(join(projectRoot, ".cursor/skills/ext.md"), "ext");
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [
        { assetId: "ext", name: "ext", type: "skill", version: "1",
          vendors: [{ tool: "cursor", enabled: false, files: [{ path: ".cursor/skills/ext.md", content: "ext" }] }] },
      ], aggregates: [],
    }), projectRoot);
    expect(existsSync(join(projectRoot, ".cursor/skills/ext.md"))).toBe(false);
  });

  it("aggregate merge-preserving：写 owned、清 owned、保留 foreign", () => {
    // 预置：磁盘上已有用户手写的 foreign server "other"
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".cursor/mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "foreign" } } }, null, 2),
    );

    // 写 owned "x"：merge 后应同时含 owned x 与 foreign other
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [],
      aggregates: [{ tool: "cursor", type: "mcp", path: ".cursor/mcp.json",
        entries: [{ key: "x", value: { command: "npx-x" } }], ownedKeys: ["x"],
        contributingAssetIds: ["mcp-x"] }],
    }), projectRoot);
    let parsed = JSON.parse(readFileSync(join(projectRoot, ".cursor/mcp.json"), "utf-8"));
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["other", "x"]);
    let lock = readLock(PROJECT_ID)!;
    expect(lock.aggregates?.cursor?.[0]?.file).toBe(".cursor/mcp.json");

    // 清 owned "x"（entries 空、ownedKeys 仍含 x）：x 删除，foreign other 保留
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [],
      aggregates: [{ tool: "cursor", type: "mcp", path: ".cursor/mcp.json",
        entries: [], ownedKeys: ["x"], contributingAssetIds: [] }],
    }), projectRoot);
    parsed = JSON.parse(readFileSync(join(projectRoot, ".cursor/mcp.json"), "utf-8"));
    expect(Object.keys(parsed.mcpServers)).toEqual(["other"]);
    lock = readLock(PROJECT_ID)!;
    // 无 enabled 贡献 → 不登记（文件因 foreign 保留，但非 Loom 拥有）
    expect(lock.aggregates).toBeUndefined();

    // 连 foreign 也清掉（用户手动删）后，再发空 plan：文件不存在，merged=null，无报错
    rmSync(join(projectRoot, ".cursor/mcp.json"), { force: true });
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [],
      aggregates: [{ tool: "cursor", type: "mcp", path: ".cursor/mcp.json",
        entries: [], ownedKeys: [], contributingAssetIds: [] }],
    }), projectRoot);
    expect(existsSync(join(projectRoot, ".cursor/mcp.json"))).toBe(false);
  });

  it("mcp aggregate 持久化 serverKeys（wrapped 资产 name ≠ server key）", () => {
    // 复现：资产名 tapd_mcp，内层 server key tapd_mcp_http。reconcile plan 的 entries
    // 带 assetId（与 server 端 mcpServerEntriesAll 一致）。buildV2Lock 必须把真实
    // server key → assetId 写进 lock.aggregates，否则 scanner 无法把磁盘 server 归到
    // 受管资产，能力视图出现两行（见 scanner.test wrapped MCP 用例）。
    mkdirSync(join(projectRoot, ".claude"), { recursive: true });
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [],
      aggregates: [{
        tool: "claudecode", type: "mcp", path: ".mcp.json",
        entries: [{ key: "tapd_mcp_http", value: { type: "http", url: "x" }, assetId: "asset-tapd" }],
        ownedKeys: ["tapd_mcp_http"],
        contributingAssetIds: ["asset-tapd"],
      }],
    }), projectRoot);
    const lock = readLock(PROJECT_ID)!;
    const agg = lock.aggregates?.claudecode?.[0];
    expect(agg?.file).toBe(".mcp.json");
    expect(agg?.serverKeys).toEqual({ tapd_mcp_http: "asset-tapd" });
  });

  it("v1 lock 迁移：响应携带 migrationDisabled，server 据此回填", () => {
    const cursorSkill = ".cursor/skills/legacy.md";
    mkdirSync(join(projectRoot, ".cursor/skills"), { recursive: true });
    writeFileSync(join(projectRoot, cursorSkill), "legacy");
    // 写一个 v1 per-asset lock（无 lockFormat），其中 cursor vendor 被关闭
    const v1lock: LockFile = {
      subscriptions: [{ workspaceId: "ws-rec", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }], version: "1",
      assets: {
        legacyAsset: {
          version: "1", name: "legacy", type: "skill",
          files: [cursorSkill],
          vendors: { cursor: { enabled: false, files: [cursorSkill] } },
        },
      },
    };
    writeLock(PROJECT_ID, v1lock);

    const req = makeReq({
      enabled: [{
        assetId: "legacyAsset", name: "legacy", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: false, files: [{ path: cursorSkill, content: "legacy" }] }],
      }], disabled: [], removed: [], aggregates: [],
    });
    const { response } = applyReconcilePlan(req, projectRoot);
    expect(response.migrationDisabled).toBeDefined();
    expect(response.migrationDisabled).toEqual([{ assetId: "legacyAsset", tool: "cursor" }]);
    // 新 lock 是 v2
    expect(readLock(PROJECT_ID)!.lockFormat).toBe("3");
  });

  it("legacy lock (__plan__): 不产 migrationDisabled", () => {
    writeLock(PROJECT_ID, {
      subscriptions: [{ workspaceId: "ws-rec", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }], version: "1",
      assets: { __plan__: { version: "1", files: [".cursor/skills/x.md"] } },
    });
    const req = makeReq({ enabled: [], disabled: [], removed: [], aggregates: [] });
    const { response } = applyReconcilePlan(req, projectRoot);
    expect(response.migrationDisabled).toBeUndefined();
  });

  it("空 plan + 无订阅：lock subscriptions 为空，隔离区清空", () => {
    // 先种点东西
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [{ assetId: "x", name: "x", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: false, files: [{ path: ".cursor/skills/x.md", content: "x" }] }] }],
      removed: [], aggregates: [],
    }), projectRoot);
    expect(existsSync(disabledPath(PROJECT_ID, ".cursor/skills/x.md"))).toBe(true);

    // 清空
    applyReconcilePlan(makeReq(emptyPlan(), { subscriptions: [] }), projectRoot);
    const lock = readLock(PROJECT_ID)!;
    expect(lock.subscriptions).toEqual([]);
    expect(Object.keys(lock.assets)).toEqual([]);
    expect(existsSync(disabledProjectRoot(PROJECT_ID))).toBe(false);
  });

  it("不安全路径：errors 收集但不抛", () => {
    const req = makeReq({
      enabled: [{ assetId: "bad", name: "bad", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: true, files: [{ path: "../escape.txt", content: "nope" }] }] }],
      disabled: [], removed: [], aggregates: [],
    });
    const { errors, response } = applyReconcilePlan(req, projectRoot);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("../escape.txt");
    expect(response.filesWritten).not.toContain("../escape.txt");
    expect(existsSync(join(projectRoot, "..", "escape.txt"))).toBe(false);
  });
});
