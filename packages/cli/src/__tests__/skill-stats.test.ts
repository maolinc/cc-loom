/**
 * Skill 调用统计旁路逻辑回归保护：
 *   A. skill-tracker：按 lock 的 skill 分布幂等注入 / 移除统计 hook，
 *      与既有 hook 内容共存、只增删 tracker 自身那一条。
 *   B. skill-stats：事件消费 → 本地计数 + 待上报增量；移除清本地不动 pending。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LockFile } from "@maolinc/cc-loom-shared";
import { applySkillTracker } from "../lib/skill-tracker.js";
import {
  appendSkillEvent,
  clearLocalSkillCount,
  clearProjectSkillStats,
  consumeSkillEvents,
  getLocalSkillCounts,
  takePendingUsage,
  clearReportedUsage,
} from "../lib/skill-stats.js";
import { ensureLoomDirs } from "../lib/paths.js";

const PROJECT_ID = "p-skill-stats-test";

function lockWithSkill(enabled: boolean): LockFile {
  return {
    subscriptions: [{ capabilitySetId: "w1", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
    version: "1",
    assets: {
      "asset-1": {
        version: "1",
        name: "my-skill",
        type: "skill",
        files: [".claude/skills/my-skill/SKILL.md"],
        vendors: { claudecode: { enabled, files: [".claude/skills/my-skill/SKILL.md"] } },
      },
    },
  };
}

function readJson(abs: string): any {
  return JSON.parse(readFileSync(abs, "utf8"));
}

describe("skill-tracker", () => {
  let root: string;

  beforeEach(() => {
    ensureLoomDirs();
    root = mkdtempSync(join(tmpdir(), "loom-tracker-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearProjectSkillStats(PROJECT_ID);
  });

  it("有 enabled skill 时向 .claude/settings.local.json 注入 tracker，且幂等", () => {
    const lock = lockWithSkill(true);
    const r1 = applySkillTracker(PROJECT_ID, root, lock);
    const file = join(root, ".claude/settings.local.json");
    expect(existsSync(file)).toBe(true);
    expect(r1.written).toContain(".claude/settings.local.json");

    const pre = readJson(file).hooks.PreToolUse;
    const skillEntry = pre.find((e: any) => e.matcher === "");
    expect(skillEntry).toBeTruthy();
    const trackers = skillEntry.hooks.filter((h: any) => h.command.includes("skill-usage-tracker"));
    expect(trackers).toHaveLength(1);

    // 再跑一次：不应重复注入
    applySkillTracker(PROJECT_ID, root, lock);
    const after = readJson(file).hooks.PreToolUse.find((e: any) => e.matcher === "");
    expect(after.hooks.filter((h: any) => h.command.includes("skill-usage-tracker"))).toHaveLength(1);

    // lock.aggregates 登记了 tracker 合成贡献
    expect(lock.aggregates?.claudecode?.some((a) => a.file === ".claude/settings.local.json")).toBe(true);
  });

  it("无 enabled skill 时移除 tracker；文件仅含 tracker 则删除", () => {
    const lockOn = lockWithSkill(true);
    applySkillTracker(PROJECT_ID, root, lockOn);
    const file = join(root, ".claude/settings.local.json");
    expect(existsSync(file)).toBe(true);

    const lockOff = lockWithSkill(false);
    const r = applySkillTracker(PROJECT_ID, root, lockOff);
    expect(existsSync(file)).toBe(false);
    expect(r.removed).toContain(".claude/settings.local.json");
    expect(lockOff.aggregates?.claudecode?.some((a) => a.file === ".claude/settings.local.json")).toBeFalsy();
  });

  it("与既有真实 hook 共存：移除 tracker 不影响其它 hook，文件保留", () => {
    const file = join(root, ".claude/settings.local.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        permissions: { allow: ["Bash(*)"] },
        hooks: {
          PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    );

    // 注入 tracker（有 skill）
    applySkillTracker(PROJECT_ID, root, lockWithSkill(true));
    let obj = readJson(file);
    expect(obj.hooks.PreToolUse.find((e: any) => e.matcher === "")).toBeTruthy();
    expect(obj.hooks.PostToolUse).toBeTruthy();
    expect(obj.permissions.allow).toContain("Bash(*)"); // 用户 settings 字段保留

    // 移除 tracker（无 skill）→ 文件保留，PostToolUse/permissions 仍在，PreToolUse 清掉
    applySkillTracker(PROJECT_ID, root, lockWithSkill(false));
    expect(existsSync(file)).toBe(true);
    obj = readJson(file);
    expect(obj.permissions.allow).toContain("Bash(*)");
    expect(obj.hooks.PostToolUse[0].hooks[0].command).toBe("echo hi");
    expect(obj.hooks.PreToolUse).toBeUndefined();
  });

  it("迁移：历史 .claude/hooks/hooks.json 上的 tracker 被退役（删文件 + 清 lock 登记）", () => {
    // 模拟旧版本遗留：tracker 写在 .claude/hooks/hooks.json，lock 登记也指向旧路径
    const legacyFile = join(root, ".claude/hooks/hooks.json");
    mkdirSync(dirname(legacyFile), { recursive: true });
    const oldTrackerCmd = `node "/root/.loom/hooks/skill-usage-tracker.cjs" ${PROJECT_ID}`;
    writeFileSync(legacyFile, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: oldTrackerCmd, timeout: 5 }] }] },
    }, null, 2));
    const lock = lockWithSkill(true);
    lock.aggregates = { claudecode: [{ file: ".claude/hooks/hooks.json", contributingAssetIds: ["__skill_tracker__"] }] };

    applySkillTracker(PROJECT_ID, root, lock);

    // 新路径已注入
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(true);
    // 旧路径文件被删除（只剩 tracker → 清空 → 删）
    expect(existsSync(legacyFile)).toBe(false);
    // lock 登记：新路径在、旧路径不在
    expect(lock.aggregates?.claudecode?.some((a) => a.file === ".claude/settings.local.json")).toBe(true);
    expect(lock.aggregates?.claudecode?.some((a) => a.file === ".claude/hooks/hooks.json")).toBe(false);
  });
});

describe("skill-stats", () => {
  beforeEach(() => {
    ensureLoomDirs();
    clearProjectSkillStats(PROJECT_ID);
  });
  afterEach(() => {
    clearProjectSkillStats(PROJECT_ID);
  });

  it("消费事件 → 本地计数 + 待上报增量（按 assetId 聚合）", () => {
    appendSkillEvent(PROJECT_ID, "my-skill");
    appendSkillEvent(PROJECT_ID, "my-skill");
    appendSkillEvent(PROJECT_ID, "/my-skill"); // 前导斜杠归一

    const changed = consumeSkillEvents(PROJECT_ID, lockWithSkill(true));
    expect(changed).toBe(true);
    expect(getLocalSkillCounts(PROJECT_ID)["asset-1"]).toBe(3);

    const pending = takePendingUsage(PROJECT_ID);
    expect(pending).toEqual([{ assetId: "asset-1", delta: 3 }]);
  });

  it("未映射到 lock 的 skill 事件被丢弃（已移除/非 Loom 管理）", () => {
    appendSkillEvent(PROJECT_ID, "ghost-skill");
    consumeSkillEvents(PROJECT_ID, lockWithSkill(true));
    expect(getLocalSkillCounts(PROJECT_ID)["asset-1"]).toBeUndefined();
    expect(takePendingUsage(PROJECT_ID)).toEqual([]);
  });

  it("clearReportedUsage 扣减 pending；clearLocalSkillCount 清本地但不动 pending", () => {
    appendSkillEvent(PROJECT_ID, "my-skill");
    consumeSkillEvents(PROJECT_ID, lockWithSkill(true));

    clearReportedUsage(PROJECT_ID, [{ assetId: "asset-1", delta: 1 }]);
    expect(takePendingUsage(PROJECT_ID)).toEqual([]); // 已上报清空

    // 再产生一次调用并消费，pending 重新累计
    appendSkillEvent(PROJECT_ID, "my-skill");
    consumeSkillEvents(PROJECT_ID, lockWithSkill(true));
    expect(getLocalSkillCounts(PROJECT_ID)["asset-1"]).toBe(2);
    expect(takePendingUsage(PROJECT_ID)).toEqual([{ assetId: "asset-1", delta: 1 }]);

    // 移除能力：本地清零，但 pending（未上报的那 1 次）保留
    clearLocalSkillCount(PROJECT_ID, "asset-1");
    expect(getLocalSkillCounts(PROJECT_ID)["asset-1"]).toBeUndefined();
    expect(takePendingUsage(PROJECT_ID)).toEqual([{ assetId: "asset-1", delta: 1 }]);
  });
});
