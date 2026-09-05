/**
 * 诊断用例：能力安装/卸载是否动到不该动的文件内容。
 *
 * 聚焦「聚合文件（mcp.json / hooks.json / settings.json）中非 Loom 管理的
 * foreign 内容，在工具从 effectiveTools 中消失时是否被整文件删除」。
 *
 * 设计意图：merge-preserving 语义承诺「整文件重算不抹用户手写配置」，
 * 但 orphan 清理对「旧 lock 记录、但本次 plan 不再涉及的聚合文件」直接
 * removeFileAndPruneEmptyDirs —— 当某厂商从 effectiveTools 退出时，该厂商
 * 的聚合文件不会被任何 adapter.mergeAggregate 处理（无 adapter），落入
 * orphan 清理被整文件删除，foreign 内容随之丢失。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReconcilePlan, WsReconcileRequest } from "@maolinc/cc-loom-shared";
import { applyReconcilePlan } from "../lib/reconcile-runner.js";
import { readLock, removeLock } from "../lib/locks.js";
import { writeProject, removeProject } from "../lib/projects.js";
import { disabledProjectRoot, ensureLoomDirs } from "../lib/paths.js";

const PROJECT_ID = "p-rec-diag";

function makeReq(plan: ReconcilePlan, opts: Partial<WsReconcileRequest> = {}): WsReconcileRequest {
  return {
    requestId: "req-diag",
    projectId: PROJECT_ID,
    subscriptions: opts.subscriptions ?? [{ capabilitySetId: "ws-diag", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
    targetTools: opts.targetTools ?? ["cursor"],
    plan,
  };
}

describe("诊断：工具退出 effectiveTools 时聚合文件 foreign 内容", () => {
  let projectRoot: string;

  beforeEach(() => {
    ensureLoomDirs();
    projectRoot = mkdtempSync(join(tmpdir(), "loom-diag-"));
    writeProject({
      id: PROJECT_ID,
      deviceId: "d",
      userId: "u",
      projectName: "diag",
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

  // 回归：cursor 退出 effectiveTools 时，server 仍为 dropped 厂商 emit 清理聚合
  // （entries 空、ownedKeys=该厂商受管 key），CLI mergeAggregate 据此清 owned、留 foreign。
  // 即便 plan 漏 emit（边缘），orphan 阶段也因 oldAggregateFiles 护栏不整文件删。
  it("cursor 装了 mcp（含 foreign），切到 claudecode 后清 owned、留 foreign", () => {
    // 1) 预置用户手写 foreign server
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".cursor/mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "foreign" } } }, null, 2),
    );
    // 2) 装入 Loom 管理的 owned server "x"（cursor 仍在 effectiveTools）
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [],
      aggregates: [{ tool: "cursor", type: "mcp", path: ".cursor/mcp.json",
        entries: [{ key: "x", value: { command: "npx-x" } }], ownedKeys: ["x"],
        contributingAssetIds: ["mcp-x"] }],
    }), projectRoot);
    let parsed = JSON.parse(readFileSync(join(projectRoot, ".cursor/mcp.json"), "utf-8"));
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["other", "x"]);
    // lock 登记了 .cursor/mcp.json
    expect(readLock(PROJECT_ID)!.aggregates?.cursor?.[0]?.file).toBe(".cursor/mcp.json");

    // 3) 切换：cursor 不再属于 effectiveTools。server（方案 C）仍 emit cursor 清理聚合：
    //    entries=[] ownedKeys=["x"] contributingAssetIds=[]（无 enabled 贡献）。
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [],
      aggregates: [{ tool: "cursor", type: "mcp", path: ".cursor/mcp.json",
        entries: [], ownedKeys: ["x"], contributingAssetIds: [] }],
    }, { targetTools: ["claudecode"] }), projectRoot);

    // 期望：owned "x" 被清，foreign "other" 保留
    const after = JSON.parse(readFileSync(join(projectRoot, ".cursor/mcp.json"), "utf-8"));
    expect(Object.keys(after.mcpServers)).toEqual(["other"]);
    expect(after.mcpServers.other).toEqual({ command: "foreign" });
    // 无 enabled 贡献 → lock 不再登记该聚合（文件因 foreign 保留，但非 Loom 拥有）
    expect(readLock(PROJECT_ID)!.aggregates).toBeUndefined();
  });

  // 护栏：即便 server 漏 emit cursor 清理聚合（plan.aggregates 不含 .cursor/mcp.json），
  // orphan 阶段也绝不整文件删 oldLock 登记过的聚合文件——foreign 原样保留。
  it("plan 漏 emit dropped 厂商聚合时，orphan 护栏仍保留 foreign（不整文件删）", () => {
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".cursor/mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "foreign" } } }, null, 2),
    );
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [],
      aggregates: [{ tool: "cursor", type: "mcp", path: ".cursor/mcp.json",
        entries: [{ key: "x", value: { command: "npx-x" } }], ownedKeys: ["x"],
        contributingAssetIds: ["mcp-x"] }],
    }), projectRoot);

    // plan 完全不含 cursor 聚合（模拟 server 边缘漏 emit）
    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [], aggregates: [],
    }, { targetTools: ["claudecode"] }), projectRoot);

    // foreign 仍保留（owned "x" 残留是可接受的孤儿，不算用户内容丢失）
    const after = JSON.parse(readFileSync(join(projectRoot, ".cursor/mcp.json"), "utf-8"));
    expect(after.mcpServers?.other).toEqual({ command: "foreign" });
  });

  // 次要 bug 回归：聚合文件为 JSONC（含注释）时，CLI 不覆写、报错、不登记 lock。
  it("聚合文件含注释（JSONC）→ 不覆写、errors 含提示、文件原样保留", () => {
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    const jsonc = `{\n  // 我的注释\n  "mcpServers": { "other": { "command": "foreign" } }\n}`;
    writeFileSync(join(projectRoot, ".cursor/mcp.json"), jsonc);

    const { errors } = applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [],
      aggregates: [{ tool: "cursor", type: "mcp", path: ".cursor/mcp.json",
        entries: [{ key: "x", value: { command: "npx-x" } }], ownedKeys: ["x"],
        contributingAssetIds: ["mcp-x"] }],
    }), projectRoot);

    expect(errors.some((e) => e.includes(".cursor/mcp.json") && e.includes("有效 JSON"))).toBe(true);
    // 文件原样保留（注释 + foreign 都在）
    expect(readFileSync(join(projectRoot, ".cursor/mcp.json"), "utf-8")).toBe(jsonc);
    // 解析失败的聚合不登记 lock
    expect(readLock(PROJECT_ID)!.aggregates).toBeUndefined();
  });
});
