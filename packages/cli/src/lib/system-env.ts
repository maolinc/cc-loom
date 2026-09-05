/**
 * 跨 OS 系统环境变量读写。
 *
 * 下发：把 `export KEY=VALUE` 写入用户当前 shell 的 rc 文件（按 SHELL 环境变量
 *   判定，bash→~/.bashrc / zsh→~/.zshrc；macOS 无 SHELL 时默认 zsh，其它默认 bash），
 *   或 Windows 用 `setx` 持久化到用户注册表。同时设置 agent 自身 process.env，
 *   让其派生子进程立即读到。
 * 回收：从所有候选 rc 文件移除 Loom 管理的该 KEY 行（shell 切换后旧文件残留也清）
 *   / Windows 删除用户环境变量。
 *
 * 已知限制：系统级 env 无法热注入到已运行进程。下发后只有「新开的 shell / 从该
 * shell 启动的 IDE」与 agent 自身子进程能立即读到；正在运行的 shell/IDE 需重启
 * 或 `source ~/.<shell>rc` 才能读到。
 *
 * 幂等：重复下发同 key 会替换原值而非追加。Loom 写入的行用标记注释块包裹，
 * 回收时只动标记块内的行，绝不碰用户手写配置。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const MARK_BEGIN = "# >>> loom-managed env >>>";
const MARK_END = "# <<< loom-managed env <<<";

function isWindows(): boolean {
  return platform() === "win32";
}

/**
 * 用户当前交互 shell 对应的 rc 文件（主文件）。以 `SHELL` 环境变量为准——它是
 * 用户登录 shell（/etc/passwd 设置），反映其终端实际 source 的 rc 文件。绝不用
 * 「.zshrc 是否存在」来猜：bash 用户机器上常残留 .zshrc，按文件存在会写错地方。
 */
function primaryRcPath(): string | null {
  if (isWindows()) return null;
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return join(homedir(), ".zshrc");
  if (shell.includes("bash")) return join(homedir(), ".bashrc");
  // 无 SHELL：macOS 默认 zsh，其余默认 bash
  return platform() === "darwin" ? join(homedir(), ".zshrc") : join(homedir(), ".bashrc");
}

/** 所有需要清理的候选 rc 文件（shell 切换后旧文件可能残留 Loom 写入的行）。 */
function candidateRcPaths(): string[] {
  if (isWindows()) return [];
  return [join(homedir(), ".zshrc"), join(homedir(), ".bashrc")].filter((p) => existsSync(p));
}

/** 读取 rc 文件全部内容；不存在返回空串。 */
function readRc(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * 在 rc 内容中把 Loom 标记块整体替换为给定的行集合。
 * - lines 为空数组 → 删除整个标记块（含标记注释）。
 * - 不存在标记块 → 在文件末尾追加新块。
 * 返回新内容。绝不修改标记块以外的任何行。
 */
function replaceManagedBlock(content: string, lines: string[]): string {
  const beginIdx = content.indexOf(MARK_BEGIN);
  const endIdx = content.indexOf(MARK_END);
  let before: string;
  let after: string;
  if (beginIdx >= 0 && endIdx > beginIdx) {
    before = content.slice(0, beginIdx);
    after = content.slice(endIdx + MARK_END.length);
    before = before.replace(/\n{2,}$/, "\n");
  } else {
    before = content;
    if (before.length > 0 && !before.endsWith("\n")) before += "\n";
    after = "";
  }

  if (lines.length === 0) {
    return (before + after).replace(/\n{3,}/g, "\n\n");
  }
  const block = [MARK_BEGIN, ...lines, MARK_END, ""].join("\n");
  return before + (before.endsWith("\n") ? "" : "\n") + block + after;
}

/** 把单个 KEY 的 export 行（单引号包裹 value，避免 shell 解释）。 */
function exportLine(key: string, value: string): string {
  const escaped = value.replace(/'/g, `'\\''`);
  return `export ${key}='${escaped}'`;
}

/** 从 rc 内容的 Loom 标记块内抽取所有 export 行（不含标记注释）。 */
function extractManagedExports(content: string): string[] {
  const beginIdx = content.indexOf(MARK_BEGIN);
  const endIdx = content.indexOf(MARK_END);
  if (beginIdx < 0 || endIdx <= beginIdx) return [];
  const block = content.slice(beginIdx + MARK_BEGIN.length, endIdx);
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("export "));
}

export interface PushResult {
  /** 实际写入的 rc 文件路径（Windows 为 null）。 */
  rcPath: string | null;
}

/**
 * 推入一个环境变量：写入主 rc 文件 + agent 自身 process.env。
 * 同时清理其它候选 rc 文件中同 key 的残留（shell 切换场景）。
 */
export function pushEnvVar(key: string, value: string): PushResult {
  process.env[key] = value;

  if (isWindows()) {
    if (value.length <= 1024) {
      try {
        execFileSync("setx", [key, value], { stdio: "ignore", shell: true });
      } catch {
        /* setx 失败不阻断，当前进程已设值 */
      }
    }
    return { rcPath: null };
  }

  const primary = primaryRcPath();
  if (primary) {
    const content = readRc(primary);
    const existing = extractManagedExports(content).filter((l) => !l.startsWith(`export ${key}=`));
    existing.push(exportLine(key, value));
    ensureDirFor(primary);
    writeFileSync(primary, replaceManagedBlock(content, existing), { encoding: "utf8" });
  }
  // 清理其它候选 rc 文件中同 key 的残留（不在主文件，避免 shell 切换后旧值遗留）
  for (const other of candidateRcPaths()) {
    if (other === primary) continue;
    const content = readRc(other);
    if (!content.includes(MARK_BEGIN)) continue;
    const remaining = extractManagedExports(content).filter((l) => !l.startsWith(`export ${key}=`));
    writeFileSync(other, replaceManagedBlock(content, remaining), { encoding: "utf8" });
  }
  return { rcPath: primary };
}

/** 从所有候选 rc 文件 + agent process.env 移除一个环境变量。 */
export function revokeEnvVar(key: string): void {
  delete process.env[key];

  if (isWindows()) {
    try {
      execFileSync("reg", ["delete", "HKCU\\Environment", "/v", key, "/f"], { stdio: "ignore", shell: true });
    } catch {
      /* 项不存在视为成功 */
    }
    return;
  }

  for (const rc of candidateRcPaths()) {
    const content = readRc(rc);
    if (!content.includes(MARK_BEGIN)) continue;
    const remaining = extractManagedExports(content).filter((l) => !l.startsWith(`export ${key}=`));
    writeFileSync(rc, replaceManagedBlock(content, remaining), { encoding: "utf8" });
  }
}

function ensureDirFor(file: string): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
