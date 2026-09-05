/**
 * `loom start` 的 daemon 化辅助。
 *
 * 父进程调用 `spawnDaemon()`：
 *   1. 用 `child_process.spawn` 起一个 detached 子进程，stdio 全 ignore（子进程
 *      自己管日志文件 + 滚动；父进程不可能 detach 后还代理 stdio）。
 *   2. `child.unref()` 让父进程可以立刻退出。
 *   3. 通过 env `LOOM_DAEMON_CHILD=1` 让子进程识别自己处于 headless 模式。
 *   4. 轮询 pidfile，至多 5s。pidfile 出现即认为启动成功（子进程在 headless
 *      模式下会优先写 pidfile，再做 device 注册等可能失败的事）。
 *
 * 进入子进程的入口仍是 `loom start` 本身（同样的 argv），但 env 变量分支让
 * `startCommand` 走 headless 流程而不是再 fork 一次。
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readPidFile } from "./pidfile.js";

export const DAEMON_CHILD_ENV = "LOOM_DAEMON_CHILD";

export function isDaemonChild(): boolean {
  return process.env[DAEMON_CHILD_ENV] === "1";
}

const PIDFILE_WAIT_MS = 5_000;
const PIDFILE_POLL_MS = 100;

/** 返回子进程 pid。pidfile 5s 内未出现则抛错。 */
export async function spawnDaemon(extraArgs: string[] = []): Promise<number> {
  const argv0 = process.execPath; // node 的绝对路径
  const script = process.argv[1]; // 当前 cli 入口（dist/index.js 或 tsx 的源文件）
  if (!script) throw new Error("无法定位 CLI 入口脚本（process.argv[1] 为空）");

  const child = spawn(argv0, [script, "start", ...extraArgs], {
    detached: true,
    // Windows 上 detached 子进程默认会分配一个新控制台 → 弹出黑窗。windowsHide
    // 让其以无窗口方式启动；Linux/macOS 上该选项被忽略。
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore"] as const,
    env: { ...process.env, [DAEMON_CHILD_ENV]: "1" },
  });
  child.unref();

  const deadline = Date.now() + PIDFILE_WAIT_MS;
  while (Date.now() < deadline) {
    const p = readPidFile();
    if (p && p.pid === child.pid) return p.pid;
    if (p) return p.pid; // 容忍极端竞态：写入的 pid 与 spawn 返回的 pid 不一致时仍接受
    await delay(PIDFILE_POLL_MS);
  }
  throw new Error(
    `Agent 在 ${PIDFILE_WAIT_MS}ms 内未写出 pidfile。查看 ~/.loom/logs/agent.log 排错。`,
  );
}
