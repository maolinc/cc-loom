/**
 * Pidfile 管理 —— `~/.loom/agent.pid` 用于 `loom stop` 找到正在跑的 `loom start`。
 *
 * 除了 pidfile，本模块也提供 best-effort 的进程识别与扫描：
 * - 校验 pidfile 指向的 pid 是否仍然真的是 loom Agent（防 PID 复用误杀）
 * - pidfile 缺失时，从进程表中找回 `loom start`（处理历史残留或异常退出）
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { AGENT_PID_PATH, ensureLoomDirs } from "./paths.js";
import { writeJsonAtomic, removeIfExists } from "./atomic.js";

export interface PidRecord {
  pid: number;
  startedAt: string;
}

export function writePidFile(pid: number = process.pid): void {
  ensureLoomDirs();
  writeJsonAtomic(AGENT_PID_PATH, { pid, startedAt: new Date().toISOString() } satisfies PidRecord);
}

export function readPidFile(): PidRecord | null {
  if (!existsSync(AGENT_PID_PATH)) return null;
  try {
    return JSON.parse(readFileSync(AGENT_PID_PATH, "utf-8")) as PidRecord;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  removeIfExists(AGENT_PID_PATH);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH = 不存在；EPERM = 存在但无权限发送（仍视为活）
    return err?.code === "EPERM";
  }
}

function normalizeCommand(command: string): string {
  // `\0` 是 /proc/<pid>/cmdline 的参数分隔符；`\` 在 Windows 路径里是分隔符，
  // 统一转 `/` 后下游的路径正则才能跨平台匹配（Windows 全局安装路径如
  // C:\Users\foo\AppData\Roaming\npm\node_modules\loom\dist\index.js）。
  return command.replace(/\0/g, " ").replace(/\\/g, "/").replace(/\s+/g, " ").trim();
}

/**
 * best-effort 识别某条命令行是否像 loom Agent。
 *
 * 只接受 `start`，拒绝 stop/status/login 等其它子命令，降低误杀概率。
 * 命令行已由 normalizeCommand 把反斜杠转成 `/`，故下面路径正则用 `/` 即可跨平台。
 */
export function isLikelyLoomAgentCommand(command: string): boolean {
  const normalized = normalizeCommand(command).toLowerCase();
  if (!normalized) return false;
  if (!/(?:^|\s)start(?:\s|$)/.test(normalized)) return false;

  return (
    /(?:^|\s|\/)loom(?:\s|$)/.test(normalized)
    || /packages\/cli\/src\/index\.ts(?:["'\s]|$)/.test(normalized)
    || /packages\/cli\/dist\/index\.js(?:["'\s]|$)/.test(normalized)
    // 全局安装的 dist 入口：覆盖 nvm 的 lib/node_modules 与 Windows npm 的
    // %APPDATA%\npm\node_modules 两种落点（normalizeCommand 已把 \ 转 /）。
    // 尾边界允许引号：Windows 命令行常以 "..." 包裹路径，index.js 后紧跟的是 "。
    || /node_modules\/loom\/dist\/index\.js(?:["'\s]|$)/.test(normalized)
  );
}

function readProcessCommandFromProc(pid: number): string | null {
  const path = `/proc/${pid}/cmdline`;
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const normalized = normalizeCommand(raw);
    return normalized || null;
  } catch {
    return null;
  }
}

function readProcessCommandFromPs(pid: number): string | null {
  try {
    // -ww = 无限列宽。macOS BSD ps 默认按列宽截断命令行（管道输出时 80/132 列），
    // loom 全局安装命令（nvm 路径 ~120 字符）会被截断 → isLikelyLoomAgentCommand
    // 认不出；Linux procps 的 -ww 同样表示不截断，跨平台安全。
    const out = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? normalizeCommand(out) : null;
  } catch {
    return null;
  }
}

/** Windows 没有 /proc 也没有 ps；用 PowerShell 的 Get-CimInstance 取进程命令行。 */
function runPowerShell(command: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readProcessCommandFromWin32(pid: number): string | null {
  try {
    const out = runPowerShell(
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
    ).trim();
    return out ? normalizeCommand(out) : null;
  } catch {
    return null;
  }
}

function readProcessCommand(pid: number): string | null {
  if (process.platform === "win32") return readProcessCommandFromWin32(pid);
  return readProcessCommandFromProc(pid) ?? readProcessCommandFromPs(pid);
}

export function isLikelyLoomAgentPid(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  const command = readProcessCommand(pid);
  if (!command) return false;
  return isLikelyLoomAgentCommand(command);
}

function listProcessesFromProc(): Array<{ pid: number; command: string }> {
  if (!existsSync("/proc")) return [];

  const rows: Array<{ pid: number; command: string }> = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    const command = readProcessCommandFromProc(pid);
    if (command) rows.push({ pid, command });
  }
  return rows;
}

function listProcessesFromPs(): Array<{ pid: number; command: string }> {
  try {
    // -ww 见 readProcessCommandFromPs：防 macOS BSD ps 截断长命令行。
    const out = execFileSync("ps", ["-ww", "-eo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: normalizeCommand(match[2] ?? "") };
      })
      .filter((row): row is { pid: number; command: string } => !!row && !!row.command);
  } catch {
    return [];
  }
}

/**
 * Windows 进程列表。一行一个 `<pid> <command>`，与 ps 输出同构，复用同一解析。
 * CommandLine 为 null 的系统进程输出空命令，被 filter 掉。
 */
function listProcessesFromWin32(): Array<{ pid: number; command: string }> {
  try {
    const out = runPowerShell(
      `Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }`,
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: normalizeCommand(match[2] ?? "") };
      })
      .filter((row): row is { pid: number; command: string } => !!row && !!row.command);
  } catch {
    return [];
  }
}

/** 列出当前机器上所有进程的 (pid, command)；按平台走 /proc → ps 或 PowerShell。 */
function listProcesses(): Array<{ pid: number; command: string }> {
  if (process.platform === "win32") return listProcessesFromWin32();
  const rows = listProcessesFromProc();
  return rows.length > 0 ? rows : listProcessesFromPs();
}

/** 列出当前机器上所有看起来像 loom Agent 的 pid。 */
export function findLikelyLoomAgentPids(excludePids: number[] = []): number[] {
  const excluded = new Set(excludePids);
  const source = listProcesses();

  return [...new Set(
    source
      .filter((row) => !excluded.has(row.pid))
      .filter((row) => isLikelyLoomAgentCommand(row.command))
      .map((row) => row.pid),
  )].sort((a, b) => a - b);
}
