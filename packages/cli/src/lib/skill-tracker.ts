/**
 * Skill 调用统计 hook 的注入 / 移除（CLI 侧，旁路）。
 *
 * 为什么在 CLI 侧做：tracker 命令需要本机绝对路径（~/.loom/hooks/...）与 projectId，
 * Server 构建安装计划时并不知道用户 home 目录，因此不能由 adapter 生成。
 *
 * 注入目标：每个支持 hook 的厂商各自的「唯一」hook 注册文件（与 adapter 一致）：
 *   - claudecode → .claude/settings.local.json （顶层 hooks 字段；tracker 命令含本机
 *     绝对路径 ~/.loom/hooks/...，是机器专属的，故写 gitignored 的 settings.local.json
 *     而非可提交的 settings.json，避免污染队友仓库。Claude Code 项目级 hook 只从
 *     settings.json / settings.local.json 顶层 hooks 字段加载——hooks/hooks.json 仅
 *     plugin 包内有效，独立项目不读取，详见 adapter/claudecode.ts。）
 *   - codex      → .codex/hooks.json          （{ hooks: {...} }）
 *   - codebuddy  → .codebuddy/settings.json   （{ ..., hooks: {...} }）
 *   - cursor 暂未接入：Cursor 的 preToolUse matcher 集合不含 "Skill"，
 *     tracker 旁路统计需另设匹配口径，作为后续 follow-up。
 *
 * 规则：某厂商上存在 ≥1 个 enabled 的 skill ⇒ 在该厂商 hook 注册文件的
 * PreToolUse / matcher=""（宽匹配，由 tracker 脚本自行判定 skill 调用）下，确保存在
 * 唯一一条指向 tracker 脚本的 command hook；否则移除该条（文件因此变空则删除）。
 *
 * 幂等：tracker hook 以「command 串包含脚本文件名」识别，重复执行不会重复注入
 *（不能直接用 mergeContent —— hooks-registry 合并是按 matcher 追加、不去重）。
 *
 * 与既有聚合的关系：若该文件同时由真实 hook 能力贡献，本模块只增删 tracker 那一条，
 * 不动其它条目；并用合成 id `__skill_tracker__` 在 lock.aggregates 登记，使
 * scanner 视其为 managed、卸载时被正确清理。
 *
 * 历史迁移：tracker 曾写到 `.claude/hooks/hooks.json`（Claude Code 不读该文件，故修正）。
 * `LEGACY_TRACKER_PATHS` 记录这些旧路径，applySkillTracker 每次运行时以 want=false
 * 退役它们——移除其中的 tracker 条目、清空则删文件、并清 lock.aggregates 对应登记，
 * 使已安装项目无需重装即可平滑迁移到新路径。
 */
import type { LockFile, TargetTool } from "@maolinc/cc-loom-shared";
import {
  readIfExists,
  removeFileAndPruneEmptyDirs,
  resolveSafe,
  writeFileAtomic,
} from "./safe-write.js";
import { SKILL_TRACKER_SCRIPT } from "./paths.js";

/** lock.aggregates 中标记「tracker 贡献了该文件」的合成 id。 */
export const SKILL_TRACKER_CONTRIB_ID = "__skill_tracker__";

const TRACKER_MARKER = "skill-usage-tracker";
/** 宽匹配：挂全部 PreToolUse，由 tracker 脚本自行判断是否为 skill 调用，
 *  以兼容不同工具（Claude Code 的 Skill、CodeBuddy 的 @Skills 等）各异的 tool_name。 */
const SKILL_MATCHER = "";

/** 支持 hook 的厂商及其唯一 hook 注册文件（相对项目根，POSIX）。cursor 暂未接入（见上）。 */
const TRACKER_REGISTRY: Partial<Record<TargetTool, string>> = {
  claudecode: ".claude/settings.local.json",
  codex: ".codex/hooks.json",
  codebuddy: ".codebuddy/settings.json",
};

/**
 * tracker 历史曾用的注册文件路径（在新路径启用时一并退役：移除 tracker 条目、清空则删文件、
 * 清 lock.aggregates 登记）。键为厂商，值为该厂商曾用过的旧路径列表。
 */
const LEGACY_TRACKER_PATHS: Partial<Record<TargetTool, string[]>> = {
  claudecode: [".claude/hooks/hooks.json"],
};

function trackerCommand(projectId: string): string {
  return `node "${SKILL_TRACKER_SCRIPT}" ${projectId}`;
}

/** 该厂商上是否存在 enabled 的 skill。 */
function vendorHasEnabledSkill(lock: LockFile, tool: TargetTool): boolean {
  for (const entry of Object.values(lock.assets)) {
    if (entry.type !== "skill") continue;
    if (entry.vendors?.[tool]?.enabled) return true;
  }
  return false;
}

type RegistryObj = Record<string, unknown>;

function parseObj(raw: string | null): RegistryObj {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as RegistryObj;
  } catch {
    /* ignore */
  }
  return {};
}

function isPlainObj(v: unknown): v is RegistryObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 命令串是否为 tracker（按脚本文件名识别）。 */
function isTrackerHook(h: unknown): boolean {
  return isPlainObj(h) && typeof h.command === "string" && h.command.includes(TRACKER_MARKER);
}

/**
 * 在 obj 上确保（或移除）tracker hook。返回是否修改了 obj。
 * obj 形如 { hooks: { PreToolUse: [ { matcher, hooks: [...] } ] } }。
 */
function mutateRegistry(obj: RegistryObj, want: boolean, projectId: string): boolean {
  const hooks = isPlainObj(obj.hooks) ? obj.hooks : undefined;

  // 先清理：移除所有 PreToolUse matcher 条目里残留的 tracker hook（含旧 matcher 形态，
  // 便于从 matcher="Skill" 平滑迁移到宽匹配）。
  let changed = false;
  if (hooks && Array.isArray(hooks.PreToolUse)) {
    const pre = hooks.PreToolUse as unknown[];
    for (let i = pre.length - 1; i >= 0; i--) {
      const e = pre[i];
      if (!isPlainObj(e)) continue;
      const list = Array.isArray(e.hooks) ? (e.hooks as unknown[]) : [];
      const kept = list.filter((h) => !isTrackerHook(h));
      if (kept.length !== list.length) {
        changed = true;
        if (kept.length === 0) pre.splice(i, 1);
        else e.hooks = kept;
      }
    }
  }

  if (want) {
    const root = (isPlainObj(obj.hooks) ? obj.hooks : (obj.hooks = {})) as RegistryObj;
    const pre = Array.isArray(root.PreToolUse)
      ? (root.PreToolUse as unknown[])
      : ((root.PreToolUse = []) as unknown[]);
    let entry = pre.find((e) => isPlainObj(e) && e.matcher === SKILL_MATCHER) as
      | RegistryObj
      | undefined;
    if (!entry) {
      entry = { matcher: SKILL_MATCHER, hooks: [] };
      pre.push(entry);
    }
    const list = Array.isArray(entry.hooks) ? (entry.hooks as unknown[]) : ((entry.hooks = []) as unknown[]);
    list.push({ type: "command", command: trackerCommand(projectId), timeout: 5 });
    return true;
  }

  // want=false：清理后收尾空结构
  if (hooks) {
    if (Array.isArray(hooks.PreToolUse) && (hooks.PreToolUse as unknown[]).length === 0) {
      delete hooks.PreToolUse;
    }
    if (Object.keys(hooks).length === 0) delete obj.hooks;
  }
  return changed;
}

/** obj 去掉 tracker 后是否还有「值得保留」的内容（其它 hook / settings 字段）。 */
function hasMeaningfulContent(obj: RegistryObj): boolean {
  for (const [k, v] of Object.entries(obj)) {
    if (k === "hooks") {
      if (isPlainObj(v) && Object.keys(v).length > 0) return true;
    } else {
      return true; // settings.json 的其它字段
    }
  }
  return false;
}

/** 把合成贡献 id 写入/移出 lock.aggregates[tool] 对应文件，保留真实贡献者。 */
function updateLockAggregate(lock: LockFile, tool: TargetTool, file: string, present: boolean): void {
  if (!lock.aggregates) lock.aggregates = {};
  const list = lock.aggregates[tool] ?? [];
  const idx = list.findIndex((a) => a.file === file);
  if (present) {
    const entry = idx === -1 ? undefined : list[idx];
    if (!entry) {
      list.push({ file, contributingAssetIds: [SKILL_TRACKER_CONTRIB_ID] });
    } else if (!entry.contributingAssetIds.includes(SKILL_TRACKER_CONTRIB_ID)) {
      entry.contributingAssetIds.push(SKILL_TRACKER_CONTRIB_ID);
    }
  } else if (idx !== -1) {
    const entry = list[idx];
    if (entry) {
      const rest = entry.contributingAssetIds.filter((id) => id !== SKILL_TRACKER_CONTRIB_ID);
      if (rest.length === 0) list.splice(idx, 1);
      else entry.contributingAssetIds = rest;
    }
  }
  if (list.length > 0) lock.aggregates[tool] = list;
  else delete lock.aggregates[tool];
}

/**
 * 按 lock 当前 skill 分布，同步各厂商的 tracker hook 与 lock.aggregates。
 * 会就地修改传入的 `lock`（由调用方负责 writeLock）。返回触达的文件清单。
 *
 * 除当前注册路径外，还对 `LEGACY_TRACKER_PATHS` 中的旧路径以 want=false 退役，
 * 使已安装项目无需重装即可从旧路径平滑迁移到新路径。
 */
export function applySkillTracker(
  projectId: string,
  projectRoot: string,
  lock: LockFile,
): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];

  /** 在单个注册文件上确保（want=true）或移除（want=false）tracker hook。 */
  const processFile = (tool: TargetTool, file: string, want: boolean): void => {
    let abs: string;
    try {
      abs = resolveSafe(projectRoot, file);
    } catch {
      return;
    }
    const existingRaw = readIfExists(abs);

    if (want) {
      const obj = parseObj(existingRaw);
      mutateRegistry(obj, true, projectId);
      const next = JSON.stringify(obj, null, 2);
      // 仅在内容确有变化时写盘：保证幂等，避免写盘→watcher→再扫描的死循环。
      if (existingRaw === null || existingRaw.trim() !== next.trim()) {
        writeFileAtomic(abs, next);
        written.push(file);
      }
      updateLockAggregate(lock, tool, file, true);
    } else {
      // 不需要 tracker：若文件不存在则只需保证 lock 没有遗留登记
      if (existingRaw === null) {
        updateLockAggregate(lock, tool, file, false);
        return;
      }
      const obj = parseObj(existingRaw);
      mutateRegistry(obj, false, projectId);
      if (hasMeaningfulContent(obj)) {
        const next = JSON.stringify(obj, null, 2);
        if (existingRaw.trim() !== next.trim()) {
          writeFileAtomic(abs, next);
          written.push(file);
        }
      } else {
        // 只剩 tracker（或本就空）→ 删除文件
        try {
          removeFileAndPruneEmptyDirs(projectRoot, file);
          removed.push(file);
        } catch {
          /* ignore */
        }
      }
      updateLockAggregate(lock, tool, file, false);
    }
  };

  for (const [toolStr, file] of Object.entries(TRACKER_REGISTRY)) {
    const tool = toolStr as TargetTool;
    if (!file) continue;
    const want = vendorHasEnabledSkill(lock, tool);
    processFile(tool, file, want);
    // 退役该厂商的历史 tracker 路径（与当前路径不同时，强制 want=false 清理）
    for (const legacy of LEGACY_TRACKER_PATHS[tool] ?? []) {
      if (legacy !== file) processFile(tool, legacy, false);
    }
  }

  return { written, removed };
}
