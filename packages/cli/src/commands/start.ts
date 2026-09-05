/**
 * `loom start` —— 启动本地 Agent。
 *
 * 三种执行态（顶层根据 env 与 flag 分支，避免补丁式判断散落到下面）：
 *
 *   parent (默认)         不带 -f、且不在 daemon 子进程里。
 *                         做 config/pidfile 预检查，spawn 一个 detached 子进程
 *                         （env 带 LOOM_DAEMON_CHILD=1），等 pidfile 出现，
 *                         打印 pid 与日志路径后退出。
 *
 *   daemon-child          带 LOOM_DAEMON_CHILD=1。
 *                         无 TTY、stdio 已被父 spawn 时 ignore，靠
 *                         RotatingFileWriter 把所有事件写到
 *                         ~/.loom/logs/agent.log（按 5MB 切分，保留 5 份）。
 *
 *   foreground (-f)       用户显式想看 TUI，老的 Ink 流程，不变。
 *
 * pidfile / device 注册 / install 处理逻辑在 headless 与 foreground 之间共享，
 * 各自独立调用以便上下文互不干扰。
 */
import React from "react";
import { render } from "ink";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type { InstallResult, CliConfig, WsToolConfigApplyPayload } from "@maolinc/cc-loom-shared";
import { getValidConfig } from "../lib/config.js";
import { ensureDeviceRegistered } from "../lib/device-registration.js";
import { api } from "../lib/api.js";
import { fail } from "../lib/errors.js";
import {
  isLikelyLoomAgentPid,
  isPidAlive,
  readPidFile,
  removePidFile,
  writePidFile,
} from "../lib/pidfile.js";
import { findProjectByPath, listProjects, readProject, removeProject, writeProject } from "../lib/projects.js";
import { AgentClient, type AgentRequest } from "../ws/client.js";
import { StartApp } from "../ui/start-app.js";
import { isDaemonChild, spawnDaemon } from "../lib/daemon.js";
import { RotatingFileWriter } from "../lib/log-rotation.js";
import { LOGS_DIR, ensureLoomDirs } from "../lib/paths.js";
import { ProjectWatcher } from "../lib/watcher.js";
import { runBestEffortCleanupSteps } from "../lib/shutdown.js";
import { scanProjectState } from "../lib/scanner.js";
import {
  OP_INSTALL_UNINSTALL,
  OP_PROJECT_PURGE,
  OP_PROJECT_READ_FILE,
  OP_PROJECT_SCAN,
  OP_RECONCILE,
  OP_ENV_PUSH,
  OP_ENV_REVOKE,
  OP_TOOL_CONFIG_APPLY,
} from "../ws/messages.js";
import { readFileSafe, removeFileAndPruneEmptyDirs, removeIfExists, resolveSafe, UnsafePathError } from "../lib/safe-write.js";
import { lockedFiles, isLegacyLock, readLock, removeLock, writeLock } from "../lib/locks.js";
import { ensureTrackerScript } from "../lib/tracker-script.js";
import { applySkillTracker } from "../lib/skill-tracker.js";
import { clearProjectSkillStats, clearReportedUsage, consumeSkillEvents, takePendingUsage } from "../lib/skill-stats.js";
import { applyReconcilePlan, clearDisabledForProject } from "../lib/reconcile-runner.js";
import { pushEnvVar, revokeEnvVar } from "../lib/system-env.js";
import type { WsReconcileRequest } from "@maolinc/cc-loom-shared";
import { ok, info, kv, nextSteps, color } from "../lib/ui.js";
import { stopAgent } from "./stop.js";
import { applyToolConfig } from "../lib/tool-config.js";

interface StartOptions {
  /** 跳过 pidfile 检查，强制启动（仅故障恢复用）。 */
  force?: boolean;
  /** 显式前台运行（渲染 Ink TUI）。默认后台。 */
  foreground?: boolean;
}

const CLEANUP_STEP_TIMEOUT_MS = 1_000;
const LOG_FLUSH_WAIT_MS = 150;

function resolveExistingAgentPid(): number | null {
  const existing = readPidFile();
  if (!existing) return null;
  if (!isPidAlive(existing.pid)) {
    removePidFile();
    return null;
  }
  if (!isLikelyLoomAgentPid(existing.pid)) {
    removePidFile();
    return null;
  }
  return existing.pid;
}

export async function startCommand(options: StartOptions = {}): Promise<void> {
  if (isDaemonChild()) {
    await runHeadless(options);
    return;
  }
  if (options.foreground) {
    await runForeground(options);
    return;
  }
  await runParent(options);
}

// -------------- parent (默认): 派生 daemon 后退出 ---------------------------

async function runParent(options: StartOptions): Promise<void> {
  // 父进程做轻量预检查，让用户在 fork 之前就拿到清晰错误
  const config = getValidConfig();
  if (!config) {
    fail("尚未登录，请先执行: loom login --endpoint <url> --token <token>");
  }
  const existingPid = resolveExistingAgentPid();
  if (existingPid) {
    info(`检测到已有 Agent（pid=${existingPid}），正在停止…`);
    // --force 启动时对旧 Agent 用 SIGKILL 兜底：daemon 清理最多 4 步 × 1s + 150ms，
    // 可能超过 stop 的 3s 优雅等待；force 语义即"强制"，应保证停掉旧进程。
    if (!await stopAgent({ force: options.force ?? false })) {
      fail(`无法停止已有 Agent（pid=${existingPid}），请手动 loom stop --force 后重试`);
    }
    ok(`已停止旧 Agent`);
  }

  let pid: number;
  try {
    pid = await spawnDaemon();
  } catch (err: any) {
    fail(err?.message ?? String(err));
  }

  ok(`Agent 已在后台启动（pid=${color.cyan(String(pid))}）`);
  kv("日志", join(LOGS_DIR, "agent.log"));
  nextSteps([
    ["loom stop", "停止 Agent"],
    ["loom status", "查看状态"],
  ]);
}

// -------------- daemon-child (headless): 写日志文件,无 TUI -------------------

async function runHeadless(options: StartOptions): Promise<void> {
  ensureLoomDirs();
  ensureTrackerScript(); // 幂等写入 skill 调用统计 hook 脚本
  const log = new RotatingFileWriter({ filepath: join(LOGS_DIR, "agent.log") });
  const safeLogEvent = (level: "info" | "warn" | "error" | "success", text: string) => {
    try {
      log.write(`${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${text}`);
    } catch {
      /* 日志写失败不能反向阻断关闭链路 */
    }
  };

  let client: AgentClient | null = null;
  let mirror: MirrorWiring | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (signal: string, exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      safeLogEvent("info", `收到 ${signal}，停止 Agent`);
      await runBestEffortCleanupSteps(
        [
          { label: "mirror.cleanup", run: () => mirror?.cleanup() },
          { label: "client.stop", run: () => client?.stop() },
          { label: "removePidFile", run: () => removePidFile() },
          { label: "log.close", run: () => log.close() },
        ],
        {
          perStepTimeoutMs: CLEANUP_STEP_TIMEOUT_MS,
          onError: (label, err) => safeLogEvent("error", `${label} 失败：${err.message}`),
        },
      );
      await delay(LOG_FLUSH_WAIT_MS);
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };

  // 顶层异常兜底，确保任何错误都进日志，而不是被 stdio:ignore 吞掉后留下鬼进程
  process.on("uncaughtException", (err) => {
    safeLogEvent("error", `uncaughtException: ${err?.stack ?? err}`);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    safeLogEvent("error", `unhandledRejection: ${String(reason)}`);
    void shutdown("unhandledRejection", 1);
  });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("exit", () => {
    try { removePidFile(); } catch { /* ignore */ }
    try { log.close(); } catch { /* ignore */ }
  });

  const config = getValidConfig();
  if (!config) {
    safeLogEvent("error", "尚未登录，daemon 无法启动");
    try { log.close(); } catch { /* ignore */ }
    process.exit(1);
  }

  // pidfile：headless 早写晚清，让父进程能尽快确认；同时校验 pid 是否真的是 loom Agent。
  const existingPid = resolveExistingAgentPid();
  if (existingPid && existingPid !== process.pid) {
    safeLogEvent("error", `已有 Agent 在运行（pid=${existingPid}），daemon 拒绝启动`);
    try { log.close(); } catch { /* ignore */ }
    process.exit(1);
  }
  writePidFile();

  const liveConfig = await ensureDeviceRegistered(config, (lvl, msg) => safeLogEvent(lvl, msg));
  if (!liveConfig) {
    await runBestEffortCleanupSteps([
      { label: "removePidFile", run: () => removePidFile() },
      { label: "log.close", run: () => log.close() },
    ], {
      perStepTimeoutMs: CLEANUP_STEP_TIMEOUT_MS,
      onError: (label, err) => safeLogEvent("error", `${label} 失败：${err.message}`),
    });
    process.exit(1);
  }

  client = new AgentClient({ config: liveConfig });
  safeLogEvent("info", `Agent 启动 endpoint=${liveConfig.endpoint} device=${liveConfig.deviceId}`);

  mirror = wireProjectMirror(client, safeLogEvent);

  client.on("state", (s, detail) => {
    if (s === "authed") {
      safeLogEvent("success", "已认证，等待安装指令");
      // rebindProjects 必须在 onAuthed 之前完成：onAuthed → reconcile → pushState
      // 会向 server 推送 project:state，此时若 device_id 还没 rebind，
      // server 端 getAgent(stale_device_id) 返回 undefined → web 显示 "Agent 未在线"。
      void rebindProjects(liveConfig, safeLogEvent).finally(() => mirror?.onAuthed());
    } else if (s === "reconnecting" && detail) safeLogEvent("warn", `重连：${detail}`);
    else if (s === "stopped") safeLogEvent("error", "Agent 已停止");
    else safeLogEvent("info", `状态：${s}${detail ? `（${detail}）` : ""}`);
  });
  client.on("error", (msg) => safeLogEvent("error", msg));

  client.start();
  // headless 没有 Ink 的 waitUntilExit；让事件循环活着，靠 SIGTERM / fatal error 退出
  await new Promise<void>(() => { /* 永不 resolve */ });
}

// -------------- foreground: 老的 Ink TUI 流程（与重构前一致） ----------------

async function runForeground(options: StartOptions): Promise<void> {
  const config = getValidConfig();
  if (!config) {
    fail("尚未登录，请先执行: loom login --endpoint <url> --token <token>");
  }

  const existingPid = resolveExistingAgentPid();
  if (existingPid && existingPid !== process.pid) {
    info(`检测到已有 Agent（pid=${existingPid}），正在停止…`);
    if (!await stopAgent({ force: false })) {
      fail(`无法停止已有 Agent（pid=${existingPid}），请手动 loom stop --force 后重试`);
    }
    ok(`已停止旧 Agent`);
  }

  const liveConfig = await ensureDeviceRegistered(config, () => { /* foreground 不写日志文件 */ });
  if (!liveConfig) fail("设备注册失败");

  ensureTrackerScript(); // 幂等写入 skill 调用统计 hook 脚本
  writePidFile();
  const client = new AgentClient({ config: liveConfig! });

  // foreground 模式也启用镜像机制；StartApp 仅做 install 渲染，不参与 watcher 或 req 路由。
  const mirror = wireProjectMirror(client, () => { /* foreground 不写日志文件 */ });

  client.on("state", (s) => {
    if (s === "authed") {
      void rebindProjects(liveConfig!, () => {}).finally(() => mirror.onAuthed());
    }
  });

  const { unmount, waitUntilExit } = render(
    React.createElement(StartApp, { config: liveConfig!, client }),
    { exitOnCtrlC: true },
  );

  client.start();

  const cleanup = async () => {
    await runBestEffortCleanupSteps(
      [
        { label: "mirror.cleanup", run: () => mirror.cleanup() },
        { label: "client.stop", run: () => client.stop() },
        { label: "removePidFile", run: () => removePidFile() },
      ],
      { perStepTimeoutMs: CLEANUP_STEP_TIMEOUT_MS },
    );
  };
  process.once("SIGTERM", () => {
    void cleanup().finally(() => unmount());
  });
  process.once("exit", () => {
    try { removePidFile(); } catch { /* ignore */ }
  });

  try {
    await waitUntilExit();
  } finally {
    await cleanup();
  }
}

// -------------- 共享：设备注册 ------------------------------------
//
// 已抽至 ../lib/device-registration.js（含"服务端设备记录缺失时自动重建"
// 的自愈逻辑），headless 与 foreground 共用。

// -------------- 项目 rebind：认证后把本地项目绑定到当前设备 -----------------
//
// logout/login 导致 deviceId 丢失后 loom start 会创建新设备。已有项目在 DB
// 里仍绑在旧 deviceId 上，Web 端 getAgent(旧deviceId) 返回 undefined → 显示
// "Agent 未在线"。认证后立即 re-register 所有本地项目，register 端点会自动
// 把 device_id 更新为当前设备。
//
// 同时把本地 ~/.loom/projects/<id>.json 里的 deviceId / endpoint 也回写到
// 当前 config 的值——否则本地文件残留旧绑定，再次切换 endpoint 或观察 status
// 时会出现"本地说 deviceId=X，server 说 device_id=Y"的不一致（典型表现：
// CLI 收到 capability:* 请求时按本地 projectId 路由依然 OK，但运维查日志/
// 命令排查时极易被误导）。

async function rebindProjects(config: CliConfig, log: MirrorLog): Promise<void> {
  const projects = listProjects();
  for (const p of projects) {
    try {
      await api(config, "/api/projects/register", {
        method: "POST",
        body: JSON.stringify({
          deviceId: config.deviceId,
          projectName: p.projectName,
          normalizedPath: p.normalizedPath,
          detectedTargets: p.detectedTargets || [],
        }),
      });
      // register 成功才回写本地，避免中间状态：register 失败时本地仍指向旧
      // endpoint，便于人工补救。
      if (p.deviceId !== config.deviceId || p.endpoint !== config.endpoint) {
        writeProject({ ...p, deviceId: config.deviceId, endpoint: config.endpoint });
      }
    } catch (err: any) {
      log("warn", `rebind 项目 ${p.projectName} 失败：${err?.message ?? err}`);
    }
  }
}

// -------------- 项目镜像：watcher + req 分发 ---------------------------------
//
// headless 与 foreground 共用：每条 loom start 进程启动一个 ProjectWatcher，
// 监视本机已注册项目；fs 变更触发后扫描并推送 LocalProjectState；server 通过
// 通用 req/res 协议拉取扫描结果、单文件内容、或执行 uninstall。

interface MirrorWiring {
  /** 在 client 进入 authed 后调用：列出已注册项目、启动 watcher、推送初始状态。 */
  onAuthed: () => void;
  /** 进程退出前清理 watcher / interval。 */
  cleanup: () => void;
}

type MirrorLog = (level: "info" | "warn" | "error" | "success", text: string) => void;

function wireProjectMirror(client: AgentClient, log: MirrorLog): MirrorWiring {
  const watcher = new ProjectWatcher();
  let reconcileTimer: NodeJS.Timeout | null = null;
  let usageTimer: NodeJS.Timeout | null = null;

  /**
   * 消费 skill 调用事件日志 → 累加本地计数 + 待上报增量，并尝试上报 Server。
   * 旁路：任何失败都吞掉，不影响扫描/推送。返回本地计数是否发生变化。
   */
  const flushUsage = (projectId: string): boolean => {
    try {
      const lock = readLock(projectId);
      const changed = consumeSkillEvents(projectId, lock);
      const pending = takePendingUsage(projectId);
      if (pending.length > 0 && client.reportSkillUsage({ projectId, items: pending })) {
        clearReportedUsage(projectId, pending);
      }
      return changed;
    } catch {
      return false;
    }
  };

  const pushState = (projectId: string): void => {
    const p = readProject(projectId);
    if (!p) return;
    try {
      const state = scanProjectState(p);
      client.pushProjectState(state);
      if (state.driftCleared) {
        log("warn", `项目 ${p.projectName} 检测到本地缺失，已自动清空 lock`);
      }
    } catch (err: any) {
      log("error", `扫描 ${p.projectName} 失败：${err?.message ?? err}`);
    }
  };

  /**
   * 自愈补注入 skill 统计 hook：已安装好 skill 的项目（安装早于本功能、或 Agent
   * 升级前装的）在 Agent 扫描时补齐 tracker，无需用户重装。幂等收敛——稳定后
   * 不再写项目文件，因此不会触发 watcher 死循环。
   */
  const syncTracker = (projectId: string, projectRoot: string): void => {
    try {
      const lock = readLock(projectId);
      if (!lock || isLegacyLock(lock)) return;
      const before = JSON.stringify(lock);
      applySkillTracker(projectId, projectRoot, lock);
      if (JSON.stringify(lock) !== before) writeLock(projectId, lock);
    } catch {
      /* 旁路，失败忽略 */
    }
  };

  const startWatchingAndPush = (projectId: string): void => {
    const p = readProject(projectId);
    if (!p) {
      watcher.stop(projectId);
      return;
    }
    if (!watcher.watchedProjects().includes(projectId)) {
      watcher.start(projectId, p.normalizedPath);
    }
    syncTracker(projectId, p.normalizedPath); // 自愈补注入 skill 统计 hook
    flushUsage(projectId); // 推送前刷新 skill 调用计数，确保镜像里的计数较新
    pushState(projectId);
  };

  watcher.onChange((projectId) => {
    log("info", `检测到项目 ${projectId} 本地变更，重扫推送`);
    startWatchingAndPush(projectId);
  });
  watcher.onError((projectId, msg) => {
    log("warn", `watcher 错误 (${projectId}): ${msg}`);
  });

  const reconcile = (): void => {
    const local = listProjects().map((p) => p.id);
    const watching = new Set(watcher.watchedProjects());
    // 新注册项目：开始监视并推送初始状态
    for (const id of local) {
      if (!watching.has(id)) startWatchingAndPush(id);
    }
    // 已注销项目：停止监视
    for (const id of watching) {
      if (!local.includes(id)) watcher.stop(id);
    }
  };

  const dispatchRequest = (req: AgentRequest): void => {
    const respondError = (error: string): void =>
      client.sendResponse({ requestId: req.requestId, success: false, error });

    // reconcile op 在每个 projectId 上串行执行,避免快速点击 toggle 时
    // mcp.json / hooks.json 重算交叉写入。其它 op（scan / read / uninstall）
    // 互不依赖，保留原并行行为。
    if (req.op === OP_RECONCILE) {
      const pid = req.projectId as string | undefined;
      if (!pid) return respondError("缺少 projectId");
      enqueueCapabilityOp(pid, () => handleReconcileOp(req));
      return;
    }

    // env / tool-config 与项目无关（设备级），直接处理，不走 per-project 队列。
    if (req.op === OP_TOOL_CONFIG_APPLY) {
      const payload = req as unknown as WsToolConfigApplyPayload & { requestId: string; op: string };
      if (payload.tool !== "codex" && payload.tool !== "claudecode") return respondError("不支持的工具配置类型");
      if (!payload.config || typeof payload.secret !== "string" || !payload.secret) return respondError("配置或凭据缺失");
      try {
        const result = applyToolConfig(payload);
        client.sendResponse({ requestId: req.requestId, success: true, data: result });
        const safeProfileName = String(payload.profileName ?? "").replace(/[\r\n]/g, " ");
        log("success", `工具配置已下发：${safeProfileName}（${payload.tool}，${result.files.join("、")}）`);
      } catch (err: any) {
        respondError(`写入工具配置失败：${err?.message ?? err}`);
      }
      return;
    }

    if (req.op === OP_ENV_PUSH) {
      const key = req.key as string | undefined;
      const value = req.value as string | undefined;
      if (!key || typeof value !== "string") return respondError("缺少 key 或 value");
      try {
        const { rcPath } = pushEnvVar(key, value);
        client.sendResponse({ requestId: req.requestId, success: true, data: { key } });
        log("success", `环境变量已下发：${key}${rcPath ? ` → ${rcPath}` : ""}（新开 shell 生效；已运行终端需 source 或重启）`);
      } catch (err: any) {
        respondError(`写入环境变量失败：${err?.message ?? err}`);
      }
      return;
    }
    if (req.op === OP_ENV_REVOKE) {
      const key = req.key as string | undefined;
      if (!key) return respondError("缺少 key");
      try {
        revokeEnvVar(key);
        client.sendResponse({ requestId: req.requestId, success: true, data: { key } });
        log("info", `环境变量已回收：${key}`);
      } catch (err: any) {
        respondError(`移除环境变量失败：${err?.message ?? err}`);
      }
      return;
    }

    try {
      switch (req.op) {
        case OP_PROJECT_SCAN: {
          const projectId = req.projectId as string | undefined;
          if (!projectId) return respondError("缺少 projectId");
          const p = readProject(projectId);
          if (!p) return respondError(`本机未找到项目 ${projectId}`);
          // 顺便确保在监视列表里（server 上线后第一次 scan 时建立 watcher）
          if (!watcher.watchedProjects().includes(projectId)) {
            watcher.start(projectId, p.normalizedPath);
          }
          const state = scanProjectState(p);
          client.pushProjectState(state); // 同时刷缓存
          client.sendResponse({ requestId: req.requestId, success: true, data: state });
          return;
        }
        case OP_PROJECT_READ_FILE: {
          const projectId = req.projectId as string | undefined;
          const path = req.path as string | undefined;
          if (!projectId || !path) return respondError("缺少 projectId 或 path");
          const p = readProject(projectId);
          if (!p) return respondError(`本机未找到项目 ${projectId}`);
          let content: string | null;
          try {
            content = readFileSafe(p.normalizedPath, path);
          } catch (err) {
            if (err instanceof UnsafePathError) return respondError(err.message);
            throw err;
          }
          client.sendResponse({ requestId: req.requestId, success: true, data: { content } });
          return;
        }
        case OP_INSTALL_UNINSTALL: {
          const projectId = req.projectId as string | undefined;
          if (!projectId) return respondError("缺少 projectId");
          const p = readProject(projectId);
          if (!p) return respondError(`本机未找到项目 ${projectId}`);

          const lock = readLock(projectId);
          const files = lockedFiles(lock);
          // 卸载前先把已发生的 skill 调用上报市场，再清掉本地统计
          flushUsage(projectId);
          const errors: string[] = [];
          const filesRemoved: string[] = [];
          for (const rel of files) {
            try {
              removeFileAndPruneEmptyDirs(p.normalizedPath, rel);
              filesRemoved.push(rel);
            } catch (err) {
              const msg = err instanceof UnsafePathError ? err.message
                : err instanceof Error ? err.message : String(err);
              errors.push(`${rel}: ${msg}`);
            }
          }
          try {
            removeLock(projectId);
          } catch (err: any) {
            errors.push(`移除 lock 失败: ${err?.message ?? err}`);
          }
          // 一并清理隔离区：项目卸载后，旧的「关闭中」副本失去归属，没必要保留
          try {
            clearDisabledForProject(projectId);
          } catch (err: any) {
            errors.push(`清理隔离区失败: ${err?.message ?? err}`);
          }
          // 清空 skill 调用统计（本地计数清零，重装从 0 起）
          try {
            clearProjectSkillStats(projectId);
          } catch {
            /* 旁路统计，失败忽略 */
          }
          const result: InstallResult = {
            success: errors.length === 0,
            workspaceId: lock?.subscriptions?.find((s) => s.workspaceId)?.workspaceId ?? lock?.workspaceId ?? "",
            projectId,
            completedAt: new Date().toISOString(),
            filesWritten: filesRemoved, // 复用字段：表示本次操作触达的文件清单
            errors,
          };
          client.sendResponse({ requestId: req.requestId, success: true, data: result });
          // 立即重扫推送，让 server 缓存与 web UI 同步到"已卸载"
          startWatchingAndPush(projectId);
          if (result.success) {
            log("success", `项目 ${p.projectName} 已卸载（${filesRemoved.length} 个文件）`);
          } else {
            log("error", `项目 ${p.projectName} 卸载失败：${errors.join("; ")}`);
          }
          return;
        }
        case OP_PROJECT_PURGE: {
          // 抹掉该项目在 `~/.loom` 下的全部痕迹。与 uninstall 的区别：
          // uninstall 只清 lock 管理的厂商文件 + lock 自身，保留项目注册记录；
          // purge 连项目注册记录、隔离区、skill 统计一起清掉，使该 projectId
          // 在本地彻底不存在——避免注销后再次 register 出现新旧两条本地记录。
          const projectId = req.projectId as string | undefined;
          if (!projectId) return respondError("缺少 projectId");
          const p = readProject(projectId);
          // 停 watcher：项目记录即将删除，不再需要监听磁盘变化。
          watcher.stop(projectId);
          // 先 flush 一次 skill 调用统计，把已发生调用上报市场（只增不减），
          // 再清本地统计。flush 失败不阻塞 purge（旁路统计）。
          try { flushUsage(projectId); } catch { /* ignore */ }
          const errors: string[] = [];
          try { clearDisabledForProject(projectId); } catch (err: any) {
            errors.push(`清理隔离区失败: ${err?.message ?? err}`);
          }
          try { clearProjectSkillStats(projectId); } catch (err: any) {
            errors.push(`清理 skill 统计失败: ${err?.message ?? err}`);
          }
          try { removeLock(projectId); } catch (err: any) {
            errors.push(`移除 lock 失败: ${err?.message ?? err}`);
          }
          try { removeProject(projectId); } catch (err: any) {
            errors.push(`移除项目记录失败: ${err?.message ?? err}`);
          }
          if (errors.length > 0) {
            return respondError(errors.join("; "));
          }
          client.sendResponse({ requestId: req.requestId, success: true, data: { projectId } });
          log("success", `项目 ${p?.projectName ?? projectId} 已彻底清理（本地痕迹已抹除）`);
          return;
        }
        default:
          return respondError(`未知 op: ${req.op}`);
      }
    } catch (err: any) {
      respondError(`处理 ${req.op} 异常：${err?.message ?? err}`);
    }
  };

  // 每个 projectId 一条 promise 链。reconcile 入队后顺序执行;与 scan
  // 并行不冲突（scan 不动 lock，只读盘）。
  const capabilityQueues = new Map<string, Promise<void>>();
  const enqueueCapabilityOp = (projectId: string, fn: () => Promise<void>): void => {
    const prev = capabilityQueues.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn).catch((e) => {
      log("error", `capability op 队列异常 (${projectId}): ${e?.message ?? e}`);
    });
    capabilityQueues.set(projectId, next);
    // 链清理：当此次 op 完成时，如果它仍然是当前 head，移除引用避免内存泄漏
    next.finally(() => {
      if (capabilityQueues.get(projectId) === next) capabilityQueues.delete(projectId);
    });
  };

  // wire 协议 v2：单一 reconcile op 落地。复用 capability 队列保证 per-project 串行。
  const handleReconcileOp = async (req: AgentRequest): Promise<void> => {
    const respondError = (error: string): void =>
      client.sendResponse({ requestId: req.requestId, success: false, error });
    const projectId = req.projectId as string;
    const p = readProject(projectId);
    if (!p) return respondError(`本机未找到项目 ${projectId}`);
    try {
      // AgentRequest 把 op 之外的字段平铺，符合 WsReconcileRequest 字段（projectId /
      // workspaceId / syncPolicy / targetTools / plan）—— 直接断言可用。
      const rc = req as unknown as WsReconcileRequest & { requestId: string; op: string };
      const { response, errors } = applyReconcilePlan(rc, p.normalizedPath);
      client.sendResponse({ requestId: req.requestId, success: true, data: response });
      startWatchingAndPush(projectId);
      if (errors.length === 0) {
        log("success", `reconcile ok（${p.projectName}，写入 ${response.filesWritten.length} / 删除 ${response.filesRemoved.length}）`);
      } else {
        log("error", `reconcile 部分失败（${p.projectName}）：${errors.join("; ")}`);
      }
    } catch (err: any) {
      respondError(`处理 reconcile 异常：${err?.message ?? err}`);
    }
  };

  client.on("request", dispatchRequest);

  return {
    onAuthed: () => {
      reconcile();
      if (!reconcileTimer) {
        reconcileTimer = setInterval(reconcile, 30_000);
      }
      // skill 调用统计：定时消费事件日志、上报增量；有新计数则重推镜像供 UI 刷新。
      if (!usageTimer) {
        usageTimer = setInterval(() => {
          for (const id of watcher.watchedProjects()) {
            if (flushUsage(id)) pushState(id);
          }
        }, 15_000);
      }
    },
    cleanup: async () => {
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }
      if (usageTimer) {
        clearInterval(usageTimer);
        usageTimer = null;
      }
      await watcher.stopAll();
      client.off("request", dispatchRequest);
    },
  };
}
