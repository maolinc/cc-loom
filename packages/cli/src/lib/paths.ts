/**
 * `~/.loom` 子路径与目录初始化。
 * 全 CLI 内 `~/.loom` 路径的唯一来源，避免各处拼接出错。
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, rmSync } from "node:fs";

/**
 * Loom 本地数据目录。优先读 LOOM_HOME 环境变量（测试隔离用，指向容器内
 * 隔离路径）；未设置时回退到 ~/.loom（生产行为不变）。
 */
export const LOOM_DIR = process.env.LOOM_HOME ?? join(homedir(), ".loom");
export const CONFIG_PATH = join(LOOM_DIR, "config.json");
export const PROJECTS_DIR = join(LOOM_DIR, "projects");
export const LOCKS_DIR = join(LOOM_DIR, "locks");
export const LOGS_DIR = join(LOOM_DIR, "logs");
/**
 * 已关闭能力的隔离区。capabilities toggle 把厂商目录里的文件移到
 * `~/.loom/disabled/<projectId>/<tool>/<rel>`，开关再开时移回。
 *
 * 不放在 `<project>/.loom/disabled` 是为了：
 *   1) 不放宽 safe-write.ts 的厂商目录白名单；
 *   2) 避免 IDE 索引器仍能读取「关闭」状态的内容。
 */
export const DISABLED_DIR = join(LOOM_DIR, "disabled");
export const AGENT_PID_PATH = join(LOOM_DIR, "agent.pid");

/** Loom 内置 hook 脚本目录（如 skill 调用统计脚本）。所有项目共用。 */
export const HOOKS_DIR = join(LOOM_DIR, "hooks");
/** skill 调用统计的本地数据目录（旁路，不进 lock，不入项目目录）。 */
export const STATS_DIR = join(LOOM_DIR, "stats");
/** skill 调用统计脚本的绝对路径（由 daemon 启动时幂等写入）。 */
export const SKILL_TRACKER_SCRIPT = join(HOOKS_DIR, "skill-usage-tracker.cjs");

export function projectFile(projectId: string): string {
  return join(PROJECTS_DIR, `${projectId}.json`);
}

export function lockFile(projectId: string): string {
  return join(LOCKS_DIR, `${projectId}.json`);
}

/** hook 脚本 append 的事件日志（每行一条 skill 调用记录）。 */
export function skillEventsLog(projectId: string): string {
  return join(STATS_DIR, `${projectId}.events.log`);
}

/** Agent 聚合后的本地计数 + 待上报队列。 */
export function skillStatsFile(projectId: string): string {
  return join(STATS_DIR, `${projectId}.json`);
}

/** 单文件在隔离区中的绝对路径。`rel` 为相对项目根的 POSIX 路径。 */
export function disabledPath(projectId: string, rel: string): string {
  return join(DISABLED_DIR, projectId, rel);
}

/** 项目级隔离区根目录（用于整项目卸载/移除时清理）。 */
export function disabledProjectRoot(projectId: string): string {
  return join(DISABLED_DIR, projectId);
}

/**
 * 同 rel 文件在 vendor 目录与隔离区同时存在是非法状态：
 *   - toggle off 后再走 install/capability:add 重写 vendor（installer.applyEntry /
 *     addCapabilities）的路径上，老代码只 writeFileAtomic 到 vendor，不动隔离区——
 *     于是隔离区残留旧副本，占空间且后续 toggle off 时会被覆盖。
 *
 * 所有 "把 Loom 管理的文件写入 vendor" 的入口在写完后调用本函数，确保不变量。
 * 不存在则 no-op；删除失败 (权限/竞态) best-effort 忽略。
 */
export function clearDisabledCopy(projectId: string, rel: string): void {
  const p = disabledPath(projectId, rel);
  if (!existsSync(p)) return;
  try {
    rmSync(p, { force: true });
  } catch {
    /* best-effort */
  }
}

/** 在写入任何 `~/.loom` 子文件前调用，确保目录存在。多次调用幂等。 */
export function ensureLoomDirs(): void {
  for (const d of [LOOM_DIR, PROJECTS_DIR, LOCKS_DIR, LOGS_DIR, HOOKS_DIR, STATS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}
