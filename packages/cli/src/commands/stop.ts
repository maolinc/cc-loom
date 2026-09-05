/**
 * `loom stop` —— 停止本机正在运行的 `loom start`。
 *
 * 流程：
 * 1. 优先读 pidfile；若 pidfile 缺失，则 best-effort 扫描进程表找回 Agent
 * 2. 若 pidfile 指向非 loom 进程，视为 stale 并清理（防 PID 复用误杀）
 * 3. 发现多个候选进程时全部停止（不再要求手动确认）
 * 4. SIGTERM；轮询最多 3s 等进程退出
 * 5. 仍未退出且 --force → SIGKILL；否则提示用户用 --force
 */
import { setTimeout as delay } from "node:timers/promises";
import {
  findLikelyLoomAgentPids,
  isLikelyLoomAgentPid,
  isPidAlive,
  readPidFile,
  removePidFile,
} from "../lib/pidfile.js";
import { fail } from "../lib/errors.js";
import { ok, info, warn, color } from "../lib/ui.js";

interface StopOptions {
  /** 超时仍未退出时强杀。 */
  force?: boolean;
}

interface StopTarget {
  pid: number;
  source: "pidfile" | "process-scan";
  stalePid?: number;
  staleReason?: "dead" | "mismatch";
}

const TERM_WAIT_MS = 3000;
const POLL_MS = 200;

/**
 * 解析所有需要处理的停止目标。
 *
 * - pidfile 存在且指向有效 loom Agent → 返回该单一目标
 * - pidfile 存在但 stale（进程已死 / 指向非 loom 进程）→ 清理 pidfile，
 *   回退到进程扫描；扫描结果全部返回
 * - pidfile 缺失 → 进程扫描结果全部返回
 *
 * 不再因"多个候选"而 fail，由调用方决定如何处理。
 */
function resolveStopTargets(): StopTarget[] {
  const pidfile = readPidFile();
  if (pidfile) {
    if (!isPidAlive(pidfile.pid)) {
      removePidFile();
      return [{ pid: pidfile.pid, source: "pidfile", stalePid: pidfile.pid, staleReason: "dead" }];
    }
    if (isLikelyLoomAgentPid(pidfile.pid)) {
      return [{ pid: pidfile.pid, source: "pidfile" }];
    }

    removePidFile();
    const scanned = findLikelyLoomAgentPids([process.pid, pidfile.pid]);
    if (scanned.length === 0) {
      return [{ pid: pidfile.pid, source: "pidfile", stalePid: pidfile.pid, staleReason: "mismatch" }];
    }
    return scanned.map((pid) => ({
      pid,
      source: "process-scan" as const,
      stalePid: pidfile.pid,
      staleReason: "mismatch" as const,
    }));
  }

  const scanned = findLikelyLoomAgentPids([process.pid]);
  return scanned.map((pid) => ({ pid, source: "process-scan" as const }));
}

async function stopResolvedTarget(target: StopTarget, options: StopOptions = {}): Promise<boolean> {
  if (target.staleReason === "dead") return false;
  if (target.staleReason === "mismatch" && target.source === "pidfile") return false;

  // 扫描后到发信号前进程可能已自行退出，视为已停止
  if (!isPidAlive(target.pid)) {
    removePidFile();
    return true;
  }

  try {
    process.kill(target.pid, "SIGTERM");
  } catch (err: any) {
    fail(`无法发送 SIGTERM 到 pid=${target.pid}: ${err?.message ?? err}`);
  }

  const deadline = Date.now() + TERM_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isPidAlive(target.pid)) {
      removePidFile();
      return true;
    }
    await delay(POLL_MS);
  }

  if (!options.force) {
    return false;
  }

  try {
    process.kill(target.pid, "SIGKILL");
  } catch (err: any) {
    fail(`SIGKILL 失败：${err?.message ?? err}`);
  }

  await delay(POLL_MS);
  removePidFile();
  return true;
}

export async function stopCommand(options: StopOptions = {}): Promise<void> {
  const targets = resolveStopTargets();
  if (targets.length === 0) {
    info("Agent 未在运行（无 pidfile，且未发现 loom start 进程）");
    return;
  }

  const first = targets[0]!;
  if (first.staleReason === "dead") {
    info(`Agent 已停止（pid=${first.stalePid} 不存在，已清理 pidfile）`);
    return;
  }
  if (first.staleReason === "mismatch" && first.source === "pidfile") {
    info(`pidfile 指向的 pid=${first.stalePid} 不是 loom Agent，已清理 stale pidfile`);
    return;
  }

  for (const target of targets) {
    if (target.staleReason === "mismatch" && target.source === "process-scan") {
      warn(`pidfile 指向的 pid=${target.stalePid} 不是 loom Agent，已回退到进程扫描定位 pid=${target.pid}`);
    } else if (target.source === "process-scan") {
      warn(`pidfile 缺失，已通过进程扫描定位 Agent（pid=${target.pid}）`);
    }
  }

  if (targets.length > 1) {
    warn(`发现 ${targets.length} 个 loom Agent 进程：${targets.map((t) => t.pid).join(", ")}，将全部停止`);
  }

  const results = await Promise.all(targets.map((t) => stopResolvedTarget(t, options)));
  const stopped = results.filter(Boolean).length;

  if (stopped === targets.length) {
    if (targets.length === 1) {
      ok(`已停止 Agent（pid=${color.cyan(String(targets[0]!.pid))}）`);
    } else {
      ok(`已停止 ${stopped} 个 Agent 进程：${targets.map((t) => t.pid).join(", ")}`);
    }
    return;
  }

  fail(
    `Agent 在 ${TERM_WAIT_MS}ms 内未退出。\n  再次执行 loom stop --force 强制终止。`,
  );
}

/**
 * 停止 Agent 的核心逻辑（供 login/logout 等其他命令复用）。
 *
 * 与 stopCommand 的差异：不打印"未运行"类提示，不 fail，静默处理。
 * 为避免副作用，仅在恰好一个可停止目标时才停止；多个候选时保持谨慎不动。
 * 返回是否实际停止了一个运行中的进程。
 */
export async function stopAgent(options: StopOptions = {}): Promise<boolean> {
  let targets: StopTarget[];
  try {
    targets = resolveStopTargets();
  } catch {
    return false;
  }
  if (targets.length === 0) return false;

  const first = targets[0]!;
  if (first.staleReason) return false;

  // 多个候选时保持谨慎，不自动停止（避免 login/logout 副作用误杀）
  if (targets.length > 1) return false;

  try {
    return await stopResolvedTarget(targets[0]!, options);
  } catch {
    return false;
  }
}
