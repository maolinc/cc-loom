/**
 * Skill 调用次数 —— 本地旁路统计的 Agent 侧聚合。
 *
 * 数据链路（全部在 ~/.loom 下，不进项目目录、不进 lock）：
 *   1. hook 脚本（skill-usage-tracker.cjs）在 PreToolUse(Skill) 时 append 一行
 *      到 `~/.loom/stats/<projectId>.events.log`（O_APPEND 原子，多进程安全，极快）。
 *   2. Agent 定时 / 推送前调 `flushSkillUsage()`：把事件日志按 skill 名聚合，
 *      经 lock 映射成 assetId，累加到本地计数（展示）+ 待上报队列（市场增量）。
 *   3. Agent authed 时把待上报队列作为「增量」发给 Server；发送成功后清队列。
 *
 * 关键不变量：
 *   - 本地计数 `local[assetId]`：随项目走，移除能力时清零（reinstall 从 0 起）。
 *   - 待上报 `pending[assetId]`：增量，移除能力**不清**（已发生的调用应送达市场）。
 *   - 上报的是增量，市场端只累加，因此本地清零/重装不影响市场总数。
 *
 * 性能：consume 用 rename + 读 + 删除处理临时文件，避免与 hook 追加竞争；
 * 单次只读一个项目的小日志，纯本地 IO，旁路不阻塞安装/扫描主链路。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import type { LockFile } from "@maolinc/cc-loom-shared";
import { STATS_DIR, skillEventsLog, skillStatsFile } from "./paths.js";
import { readJson, writeJsonAtomic } from "./atomic.js";

interface SkillStatsFile {
  /** 本地累计调用次数（展示用），key = assetId。移除能力时清零。 */
  local: Record<string, number>;
  /** 待上报市场的增量，key = assetId。上报成功后清。 */
  pending: Record<string, number>;
}

function emptyStats(): SkillStatsFile {
  return { local: {}, pending: {} };
}

function readStats(projectId: string): SkillStatsFile {
  const s = readJson<SkillStatsFile>(skillStatsFile(projectId));
  if (!s) return emptyStats();
  return { local: s.local ?? {}, pending: s.pending ?? {} };
}

function writeStats(projectId: string, stats: SkillStatsFile): void {
  mkdirSync(STATS_DIR, { recursive: true });
  writeJsonAtomic(skillStatsFile(projectId), stats);
}

/** 解析事件日志，按 skill 名聚合调用次数。 */
function parseEvents(raw: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let skill = "";
    try {
      const obj = JSON.parse(trimmed);
      skill = typeof obj?.skill === "string" ? obj.skill : "";
    } catch {
      // 容错：非 JSON 行直接当作 skill 名
      skill = trimmed;
    }
    skill = skill.trim().replace(/^\//, "");
    if (!skill) continue;
    counts.set(skill, (counts.get(skill) ?? 0) + 1);
  }
  return counts;
}

/** lock 中 skill 类型能力的 name → assetId 映射。 */
function skillNameToAssetId(lock: LockFile): Map<string, string> {
  const m = new Map<string, string>();
  for (const [assetId, entry] of Object.entries(lock.assets)) {
    if (entry.type === "skill" && entry.name) m.set(entry.name, assetId);
  }
  return m;
}

/**
 * 消费事件日志：把自上次以来的 skill 调用累加进 local + pending。
 * 通过 rename 抢占当前日志再处理，避免与 hook 的 append 竞争丢数据。
 * 返回是否产生了新的 pending（供调用方决定要不要上报）。
 */
export function consumeSkillEvents(projectId: string, lock: LockFile | null): boolean {
  const logPath = skillEventsLog(projectId);
  if (!existsSync(logPath)) return false;

  const processing = `${logPath}.${Date.now()}.processing`;
  try {
    renameSync(logPath, processing);
  } catch {
    return false; // 日志刚被清走或不可访问，下次再说
  }

  let raw = "";
  try {
    raw = readFileSync(processing, "utf8");
  } catch {
    raw = "";
  } finally {
    try { rmSync(processing, { force: true }); } catch { /* ignore */ }
  }

  const byName = parseEvents(raw);
  if (byName.size === 0) return false;

  // 没有 lock（已卸载）时无法映射 assetId，丢弃这批事件
  if (!lock) return false;
  const nameToId = skillNameToAssetId(lock);

  const stats = readStats(projectId);
  let changed = false;
  for (const [skillName, count] of byName) {
    const assetId = nameToId.get(skillName);
    if (!assetId) continue; // 该 skill 已被移除/未由 Loom 管理，丢弃
    stats.local[assetId] = (stats.local[assetId] ?? 0) + count;
    stats.pending[assetId] = (stats.pending[assetId] ?? 0) + count;
    changed = true;
  }
  if (changed) writeStats(projectId, stats);
  return changed;
}

/** 取当前待上报增量快照（assetId → delta）。 */
export function takePendingUsage(projectId: string): { assetId: string; delta: number }[] {
  const stats = readStats(projectId);
  return Object.entries(stats.pending)
    .filter(([, v]) => v > 0)
    .map(([assetId, delta]) => ({ assetId, delta }));
}

/**
 * 上报成功后，从 pending 中扣除已上报的量（而非整体清空），
 * 避免 take→report 期间新增的增量被误清。
 */
export function clearReportedUsage(
  projectId: string,
  reported: { assetId: string; delta: number }[],
): void {
  if (reported.length === 0) return;
  const stats = readStats(projectId);
  for (const { assetId, delta } of reported) {
    const cur = stats.pending[assetId] ?? 0;
    const next = cur - delta;
    if (next > 0) stats.pending[assetId] = next;
    else delete stats.pending[assetId];
  }
  writeStats(projectId, stats);
}

/** 读取本地累计计数（assetId → count），供 scanner 注入 capabilities 展示。 */
export function getLocalSkillCounts(projectId: string): Record<string, number> {
  return readStats(projectId).local;
}

/**
 * 移除某能力时，清掉它的本地计数（不动 pending —— 已发生的调用仍应送达市场）。
 * 满足「本地移除后重装相同技能则本地计数清 0，但不影响市场计数」。
 */
export function clearLocalSkillCount(projectId: string, assetId: string): void {
  const stats = readStats(projectId);
  if (stats.local[assetId] === undefined) return;
  delete stats.local[assetId];
  writeStats(projectId, stats);
}

/** hook 脚本侧也用得到：直接 append 一条事件（仅供测试/复用）。 */
export function appendSkillEvent(projectId: string, skill: string): void {
  mkdirSync(STATS_DIR, { recursive: true });
  appendFileSync(skillEventsLog(projectId), JSON.stringify({ skill, ts: Date.now() }) + "\n");
}

/**
 * 卸载项目时清空其全部 skill 统计（events 日志 + 本地计数 + 待上报队列）。
 * 调用前应先 flush 一次以把已发生的调用上报到市场。
 */
export function clearProjectSkillStats(projectId: string): void {
  for (const f of [skillEventsLog(projectId), skillStatsFile(projectId)]) {
    try {
      if (existsSync(f)) rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}
