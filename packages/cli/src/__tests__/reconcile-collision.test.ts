/**
 * 诊断：安装能力与本地已存在文件 / 同名能力的碰撞行为。
 *
 * 验证当前实现的真实行为（非断言理想行为），用于回答「会发生什么」。
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

const PROJECT_ID = "p-collision-diag";

function makeReq(plan: ReconcilePlan, opts: Partial<WsReconcileRequest> = {}): WsReconcileRequest {
  return {
    requestId: "req-coll",
    projectId: PROJECT_ID,
    subscriptions: opts.subscriptions ?? [{ workspaceId: "ws-coll", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
    targetTools: opts.targetTools ?? ["cursor"],
    plan,
  };
}

describe("诊断：能力安装碰撞行为", () => {
  let projectRoot: string;

  beforeEach(() => {
    ensureLoomDirs();
    projectRoot = mkdtempSync(join(tmpdir(), "loom-coll-"));
    writeProject({
      id: PROJECT_ID, deviceId: "d", userId: "u", projectName: "coll",
      normalizedPath: projectRoot, registeredAt: new Date().toISOString(),
      detectedTargets: [], defaultTargets: [], subscriptions: [],
      status: "online", endpoint: "http://localhost:0",
    });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    try { removeLock(PROJECT_ID); } catch { /* ignore */ }
    try { removeProject(PROJECT_ID); } catch { /* ignore */ }
    rmSync(disabledProjectRoot(PROJECT_ID), { recursive: true, force: true });
  });

  // 场景 A：用户已有同名 skill 文件（非 Loom 管理），Loom 装入同名 skill。
  it("A. 目标路径已有用户文件 → 被静默覆写（无警告/无备份）", () => {
    mkdirSync(join(projectRoot, ".cursor/skills/my-skill"), { recursive: true });
    const userContent = "# 用户自己写的 skill，重要内容\n";
    writeFileSync(join(projectRoot, ".cursor/skills/my-skill/SKILL.md"), userContent);

    const { errors } = applyReconcilePlan(makeReq({
      enabled: [{
        assetId: "a1", name: "my-skill", type: "skill", version: "1",
        vendors: [{ tool: "cursor", enabled: true,
          files: [{ path: ".cursor/skills/my-skill/SKILL.md", content: "# Loom 的 skill\n" }] }],
      }],
      disabled: [], removed: [], aggregates: [],
    }), projectRoot);

    // 当前行为：直接覆写，无错误、无警告
    expect(errors).toEqual([]);
    const after = readFileSync(join(projectRoot, ".cursor/skills/my-skill/SKILL.md"), "utf-8");
    expect(after).toBe("# Loom 的 skill\n");
    expect(after).not.toBe(userContent); // 用户内容丢失，无备份
    // 装入后文件归 Loom 管理（lock 登记）
    expect(readLock(PROJECT_ID)!.assets["a1"]).toBeDefined();
  });

  // 场景 B：两个同名 asset（不同来源，如 workspace + project_capability）落到同一路径。
  it("B. 两个同名能力同路径 → 后写者覆盖，无冲突报错（顺序依赖）", () => {
    const { errors } = applyReconcilePlan(makeReq({
      enabled: [
        { assetId: "a1", name: "dup", type: "skill", version: "1",
          vendors: [{ tool: "cursor", enabled: true,
            files: [{ path: ".cursor/skills/dup/SKILL.md", content: "from-a1" }] }] },
        { assetId: "a2", name: "dup", type: "skill", version: "1",
          vendors: [{ tool: "cursor", enabled: true,
            files: [{ path: ".cursor/skills/dup/SKILL.md", content: "from-a2" }] }] },
      ],
      disabled: [], removed: [], aggregates: [],
    }), projectRoot);

    // 当前行为：无冲突检测，两个 asset 都进 lock，后写者（a2）覆盖前者
    expect(errors).toEqual([]);
    const after = readFileSync(join(projectRoot, ".cursor/skills/dup/SKILL.md"), "utf-8");
    expect(after).toBe("from-a2");
    const lock = readLock(PROJECT_ID)!;
    expect(lock.assets["a1"]).toBeDefined();
    expect(lock.assets["a2"]).toBeDefined();
    // 两个 asset 的 lock vendor.files 都指向同一路径——对账时无法区分谁拥有该文件
    expect(lock.assets["a1"]!.vendors!.cursor!.files).toEqual([".cursor/skills/dup/SKILL.md"]);
    expect(lock.assets["a2"]!.vendors!.cursor!.files).toEqual([".cursor/skills/dup/SKILL.md"]);
  });

  // 场景 C：聚合文件（mcp）已有用户 foreign server，Loom 装入同名 owned server。
  it("C. mcp 聚合：同名 owned server 覆盖用户同名 server，foreign 保留", () => {
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    writeFileSync(join(projectRoot, ".cursor/mcp.json"), JSON.stringify({
      mcpServers: {
        same: { command: "user-own" },           // 与 Loom owned 同名
        other: { command: "user-foreign" },      // foreign，应保留
      },
    }, null, 2));

    applyReconcilePlan(makeReq({
      enabled: [], disabled: [], removed: [],
      aggregates: [{ tool: "cursor", type: "mcp", path: ".cursor/mcp.json",
        entries: [{ key: "same", value: { command: "loom-owned" } }], ownedKeys: ["same"],
        contributingAssetIds: ["mcp-same"] }],
    }), projectRoot);

    const after = JSON.parse(readFileSync(join(projectRoot, ".cursor/mcp.json"), "utf-8"));
    // owned 同名 server 被覆盖（用户内容丢失，但这是同名 server 的预期行为）
    expect(after.mcpServers.same).toEqual({ command: "loom-owned" });
    // foreign 不同名 server 保留
    expect(after.mcpServers.other).toEqual({ command: "user-foreign" });
  });
});
