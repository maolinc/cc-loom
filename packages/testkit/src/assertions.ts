/**
 * 磁盘 / lock 断言原语。
 *
 * 所有断言失败抛 AssertionError（vitest 的 expect 接力），消息带上下文。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { LockFile, SyncPolicy } from "@maolinc/cc-loom-shared";
import { LOOM_HOME } from "./env.js";

/** 断言项目目录下某文件存在。 */
export function expectFileExists(projectRoot: string, relPath: string): void {
  const full = join(projectRoot, relPath);
  if (!existsSync(full)) {
    throw new Error(`期望文件存在但未找到: ${relPath} (root=${projectRoot})`);
  }
}

/** 断言项目目录下某文件不存在。 */
export function expectFileNotExists(projectRoot: string, relPath: string): void {
  const full = join(projectRoot, relPath);
  if (existsSync(full)) {
    throw new Error(`期望文件不存在但找到了: ${relPath} (root=${projectRoot})`);
  }
}

/** 断言文件内容包含某子串。 */
export function expectFileContains(projectRoot: string, relPath: string, substr: string): void {
  expectFileExists(projectRoot, relPath);
  const content = readFileSync(join(projectRoot, relPath), "utf-8");
  if (!content.includes(substr)) {
    throw new Error(`文件 ${relPath} 内容不包含 "${substr}"\n实际内容:\n${content}`);
  }
}

/** 断言文件内容完全等于给定字符串。 */
export function expectFileContent(projectRoot: string, relPath: string, expected: string): void {
  expectFileExists(projectRoot, relPath);
  const content = readFileSync(join(projectRoot, relPath), "utf-8");
  if (content !== expected) {
    throw new Error(`文件 ${relPath} 内容不匹配\n期望:\n${expected}\n实际:\n${content}`);
  }
}

/**
 * 递归列出项目目录下所有文件（相对路径），用于快照对比。
 * 排除 node_modules 和 .git。
 */
export function listFiles(root: string, prefix = ""): string[] {
  const out: string[] = [];
  const dir = prefix ? join(root, prefix) : root;
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(root, rel);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(root, rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * 断言项目目录的文件集合**恰好**等于 expected 列表（不多不少）。
 * 这比逐个 expectFileExists 更严格——能发现意外多出的文件。
 */
export function expectFileSet(projectRoot: string, expected: string[]): void {
  const actual = listFiles(projectRoot);
  const expectedSorted = [...expected].sort();
  const missing = expectedSorted.filter((f) => !actual.includes(f));
  const extra = actual.filter((f) => !expectedSorted.includes(f));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `文件集合不匹配 (root=${projectRoot})\n` +
      (missing.length ? `缺失: ${missing.join(", ")}\n` : "") +
      (extra.length ? `多余: ${extra.join(", ")}` : ""),
    );
  }
}

// ---- Lock 断言 ----

/** 读取项目的 lock 文件。不存在返回 null。 */
export function readLock(projectId: string): LockFile | null {
  const lockPath = join(LOOM_HOME, "locks", `${projectId}.json`);
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, "utf-8")) as LockFile;
}

/** 断言 lock 存在且包含指定订阅（capabilitySetId）/策略匹配（ADR-0006：lock 记录订阅数组）。 */
export function expectLock(
  projectId: string,
  expected: { capabilitySetId?: string; policy?: SyncPolicy },
): void {
  const lock = readLock(projectId);
  if (!lock) {
    throw new Error(`期望 lock 存在但未找到 (projectId=${projectId})`);
  }
  if (expected.capabilitySetId !== undefined) {
    const sub = lock.subscriptions?.find((s) => s.capabilitySetId === expected.capabilitySetId);
    if (!sub) {
      throw new Error(
        `lock 中未找到订阅 ${expected.capabilitySetId}, 实际订阅: ${JSON.stringify(lock.subscriptions)}`,
      );
    }
    if (expected.policy !== undefined && sub.syncPolicy !== expected.policy) {
      throw new Error(`订阅 ${expected.capabilitySetId} policy 不匹配: 期望 ${expected.policy}, 实际 ${sub.syncPolicy}`);
    }
  }
}

/** 断言 lock 不存在（已清除）。 */
export function expectNoLock(projectId: string): void {
  const lock = readLock(projectId);
  if (lock) {
    throw new Error(`期望 lock 不存在但找到了 (projectId=${projectId}): ${JSON.stringify(lock).slice(0, 200)}`);
  }
}

/** 断言 lock 中某 asset 在某 tool 上的 enabled 状态。 */
export function expectLockVendorState(
  projectId: string,
  assetId: string,
  tool: string,
  enabled: boolean,
): void {
  const lock = readLock(projectId);
  if (!lock) throw new Error(`lock 不存在 (projectId=${projectId})`);
  const entry = lock.assets[assetId];
  if (!entry) throw new Error(`lock.assets[${assetId}] 不存在`);
  const vendor = entry.vendors?.[tool as keyof typeof entry.vendors];
  if (!vendor) throw new Error(`lock.assets[${assetId}].vendors[${tool}] 不存在`);
  if (vendor.enabled !== enabled) {
    throw new Error(`lock.assets[${assetId}].vendors[${tool}].enabled 不匹配: 期望 ${enabled}, 实际 ${vendor.enabled}`);
  }
}

/**
 * 断言该项目在 `~/.loom` 下的全部痕迹已抹除：
 * projects/<id>.json、locks/<id>.json、disabled/<id>/、stats/<id>.events.log、stats/<id>.json。
 * 用于 purge / unregister 的 L3 验证。
 */
export function expectNoProjectTraces(projectId: string): void {
  const paths = [
    join(LOOM_HOME, "projects", `${projectId}.json`),
    join(LOOM_HOME, "locks", `${projectId}.json`),
    join(LOOM_HOME, "disabled", projectId),
    join(LOOM_HOME, "stats", `${projectId}.events.log`),
    join(LOOM_HOME, "stats", `${projectId}.json`),
  ];
  const leftover = paths.filter((p) => existsSync(p));
  if (leftover.length > 0) {
    throw new Error(`期望无项目痕迹但找到 (projectId=${projectId}): ${leftover.join(", ")}`);
  }
}
