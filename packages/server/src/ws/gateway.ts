import type { FastifyInstance } from "fastify";
import type { WebSocket as WsSocket } from "ws";
import { db } from "../db/index.js";
import { maybeGcRetiredWorkspace } from "../lib/workspace-gc.js";
import { reconcileInstalledAssets } from "../lib/asset-gc.js";
import { isTrustedBrowserOrigin } from "../lib/runtime-security.js";
import type {
  AgentCapabilities,
  LocalProjectState,
} from "@maolinc/cc-loom-shared";

interface ConnectedAgent {
  ws: WsSocket;
  userId: string;
  deviceId: string;
  connectedAt: string;
  /** CLI 在 auth 时自报的协议能力。当前要求 reconcileV2 === true。 */
  capabilities: AgentCapabilities;
}

const agents = new Map<string, ConnectedAgent>();
const webClients = new Set<WsSocket>();

// pong 写 DB 节流：每设备最多 60s 写一次 last_online_at
const lastOnlineWriteAt = new Map<string, number>();
const PONG_WRITE_INTERVAL_MS = 60_000;

/**
 * agent（重）连接成功时的回调钩子（由 index.ts 注入 compensateDeviceOnConnect）。
 * 用回调注入而非直接 import auto-sync，避免 gateway ↔ auto-sync 循环依赖。
 */
let onAgentConnect: ((deviceId: string) => void) | null = null;
export function setAgentConnectHandler(fn: ((deviceId: string) => void) | null): void {
  onAgentConnect = fn;
}

// ---- 通用 req/res 关联 ----
//
// server 通过 `requestFromAgent(deviceId, op, payload)` 向 agent 发起一次请求；
// agent 处理完用 `{ type: "res", payload: { requestId, success, data?, error? } }`
// 回送，server 按 requestId 取出 resolver。
//
// 跨设备：requestId 全局唯一即可，不区分 deviceId。每条请求一个监听槽，超时
// 自动 reject 并清理。

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  deviceId: string;
}

const pending = new Map<string, PendingRequest>();
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req_${Date.now().toString(36)}_${requestSeq.toString(36)}`;
}

// ---- 项目本地状态缓存 ----
//
// agent 推 `project:state` 时写入；REST GET /state 读出。无超时驱逐——内存里
// 项目数量级 << 100，最新状态以 agent 推送为准。server 重启后清空，第一次 GET
// /state 会触发一次主动 scan。

const projectStateCache = new Map<string, LocalProjectState>();

export function getCachedProjectState(projectId: string): LocalProjectState | null {
  return projectStateCache.get(projectId) ?? null;
}

export function getAgent(deviceId: string): ConnectedAgent | undefined {
  return agents.get(deviceId);
}

function send(ws: WsSocket, type: string, payload: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

/**
 * 向某设备发起一次同步请求，等待 agent `res` 应答。
 * 超时（默认 30s）自动 reject。设备不在线立即抛错。
 */
export function requestFromAgent<T = unknown>(
  deviceId: string,
  op: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<T> {
  const agent = agents.get(deviceId);
  if (!agent) return Promise.reject(new Error("Agent 未在线"));

  const requestId = nextRequestId();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Agent 响应超时 (op=${op})`));
    }, timeoutMs);
    pending.set(requestId, {
      resolve: resolve as (data: unknown) => void,
      reject,
      timer,
      deviceId,
    });
    send(agent.ws, "req", { requestId, op, ...payload });
  });
}

// 旧 install / install_result wire op 在 wire-protocol-unification 重构中已被 reconcile 完全取代。
// 「向 CLI 推一次落盘任务」改走 outbox-worker-v2 的 enqueueReconcile / enqueueReconcileAndWait。

export function broadcastToWebClients(type: string, payload: unknown): void {
  const data = JSON.stringify({ type, payload });
  for (const ws of webClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * agent 推送 LocalProjectState 时的副作用：
 *  1. 缓存
 *  2. drift 自动清空对齐：agent 端 lock 已清空（installedWorkspaceIds 为空）而服务端
 *     仍有显式订阅 → 删除全部显式订阅（ADR-0006；server 是安装关系的权威，只做
 *     「清空」方向的对齐，不从 agent 侧新增订阅）
 *  3. 广播到 web 客户端，让活动页签重新拉取 /state
 */
function ingestProjectState(state: LocalProjectState): void {
  projectStateCache.set(state.projectId, state);

  // agent 推送 state 说明 agent 在线且已绑定到该项目。
  // 更新 status = 'online' 覆盖可能的 stale offline：
  //   - rebindProjects 刚把 device_id 改为当前设备，但 auth handler 的
  //     UPDATE projects SET status='online' 在 rebind 之前跑，没覆盖到该项目
  //   - 服务器重启后 status 被清为 offline，agent 重连后首次推送时修正
  db.prepare("UPDATE projects SET status = 'online' WHERE id = ? AND status != 'unregistered'")
    .run(state.projectId);

  // drift 对齐仅在 agent 明确报告「lock 文件全缺失 → 已自动清 lock」（driftCleared）时
  // 触发。不能用 installedWorkspaceIds 为空作判据：新项目 / 安装途中（订阅行已建、
  // lock 未写）/ 仅单独添加能力的项目都合法地为空，误删会把进行中的订阅清掉。
  if (state.driftCleared) {
    const subs = db.prepare(
      "SELECT workspace_id FROM project_subscriptions WHERE project_id = ? AND workspace_id != ''",
    ).all(state.projectId) as { workspace_id: string }[];
    if (subs.length > 0) {
      db.prepare("DELETE FROM project_subscriptions WHERE project_id = ? AND workspace_id != ''")
        .run(state.projectId);
      db.prepare("DELETE FROM project_subscription_excludes WHERE project_id = ?")
        .run(state.projectId);
      // drift 自动清空 → 旧工作空间失去本项目引用，若已留存则尝试回收。
      for (const s of subs) maybeGcRetiredWorkspace(s.workspace_id);
    }
  }

  // 安装账本对账：以 agent 推送的真实安装能力集合为准，维护服务端 asset 引用计数，
  // 并对本次失去安装引用、已留存的 asset 触发 GC。capabilities 缺省（legacy/drift/无 lock）视为空集。
  reconcileInstalledAssets(state.projectId, (state.capabilities ?? []).map((c) => c.assetId));

  broadcastToWebClients("web:project:state_changed", { projectId: state.projectId });
}

/**
 * 累加 skill 调用次数到 assets.invocation_count（只增不减）。
 * - delta 取正整数，忽略非正与不存在的 asset；
 * - 上报的是增量，因此本地清零 / 重装不影响此处的全局累计；
 * - 计数变化后通知 web 刷新（市场卡片展示总数）。
 */
function ingestSkillUsage(items: { assetId: string; delta: number }[]): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const stmt = db.prepare("UPDATE assets SET invocation_count = invocation_count + ? WHERE id = ?");
  let changed = false;
  const tx = db.transaction((rows: { assetId: string; delta: number }[]) => {
    for (const { assetId, delta } of rows) {
      const d = Math.floor(Number(delta));
      if (!assetId || !Number.isFinite(d) || d <= 0) continue;
      const info = stmt.run(d, assetId);
      if (info.changes > 0) changed = true;
    }
  });
  try {
    tx(items);
  } catch {
    return;
  }
  if (changed) broadcastToWebClients("web:project:state_changed", {});
}

export function websocketGateway(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (!isTrustedBrowserOrigin(origin, request)) {
      socket.close(1008, "Untrusted Origin");
      return;
    }

    let deviceId: string | null = null;
    let userId: string | null = null;

    // 升级请求的 cookie 自动认证：web 客户端只需带浏览器 cookie 连过来即可，
    // 不需要再发 web_auth 消息（也保留 web_auth 作为兼容路径）。
    // agent 的 WS 客户端不带 cookie，会跳过这段。
    const cookieSessionId = (request as any).cookies?.loom_session as string | undefined;
    if (cookieSessionId) {
      const session = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(cookieSessionId) as
        | { user_id: string }
        | undefined;
      if (session) {
        userId = session.user_id;
        webClients.add(socket);
        send(socket, "web_auth_ok", {});
      }
    }

    // agent 存活追踪：记录最后一次收到 pong 的时间。
    // agent 每 25s 无条件发 pong + 收到 heartbeat 时也发 pong。
    // 若 90s 内无 pong（3 次 30s 心跳周期），判定连接已死，主动 terminate
    // 触发 close handler 清理 agents Map + DB 状态。
    let lastPongAt = Date.now();
    const PONG_TIMEOUT_MS = 90_000;

    const heartbeat = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        // 连接已死（半开 TCP / agent 进程卡住），强制终止以触发 close 清理
        socket.terminate();
        return;
      }
      socket.send(JSON.stringify({ type: "heartbeat", payload: {} }));
    }, 30000);

    socket.on("message", async (raw) => {
      let msg: { type: string; payload: any };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "auth": {
          const { token } = msg.payload;
          const cliToken = db.prepare("SELECT user_id FROM cli_tokens WHERE token = ?").get(token) as any;
          if (!cliToken) {
            send(socket, "error", { message: "无效的认证 Token" });
            socket.close();
            return;
          }
          // 协议能力校验:本次重构后 server 只支持 reconcile v2 wire 协议,
          // 旧 CLI(不上报 capabilities.reconcileV2 或为 false)直接拒连,避免
          // server 发出 reconcile op 但 CLI 不认识造成的协议错。
          const capabilities = (msg.payload?.capabilities ?? {}) as AgentCapabilities;
          if (capabilities.reconcileV2 !== true) {
            send(socket, "error", {
              message: "CLI 版本过旧:server 已升级到 reconcile v2 wire 协议,请升级 CLI 后重试",
            });
            socket.close();
            return;
          }
          // ADR-0006 硬门槛:多空间订阅协议(subscriptionsV3),旧 CLI 拒连。
          if (capabilities.subscriptionsV3 !== true) {
            send(socket, "error", {
              message: "CLI 版本过旧:server 已支持多空间订阅,请升级 loom CLI 后重试",
            });
            socket.close();
            return;
          }
          userId = cliToken.user_id;
          deviceId = msg.payload.deviceId;

          if (deviceId) {
            db.prepare("UPDATE devices SET status = 'online', last_online_at = ? WHERE id = ?").run(
              new Date().toISOString(), deviceId
            );

            // 同 deviceId 已有旧连接（半挂未 close / 客户端进程未退出就重连）：
            // 主动 terminate 旧 socket，让其 close handler 走完整清理流程。
            // 配合下方 close handler 的归属校验，旧 close 不会误删新 entry
            // 也不会把当前 device/projects 状态回滚为 offline。
            const prev = agents.get(deviceId);
            if (prev && prev.ws !== socket) {
              console.warn(`[ws] 接管旧连接 device=${deviceId}`);
              try { prev.ws.terminate(); } catch { /* ignore */ }
            }

            agents.set(deviceId, {
              ws: socket,
              userId: userId!,
              deviceId,
              connectedAt: new Date().toISOString(),
              capabilities,
            });

            // 把当前设备上"已注册"的项目刷为 online。注意排除 unregistered，
            // 否则 unregister 后 agent 任意一次重连都会把软删项目又复活成 online。
            db.prepare(
              "UPDATE projects SET status = 'online' WHERE device_id = ? AND status != 'unregistered'"
            ).run(deviceId);
          }

          send(socket, "auth_ok", { message: "已连接到 Loom" });
          // 重连补偿：把离线期间的 workspace/asset 编辑追平到该设备的 auto 项目。
          if (deviceId && onAgentConnect) {
            try { onAgentConnect(deviceId); } catch (e) {
              console.warn(`[ws] onAgentConnect 失败 device=${deviceId} err=${(e as Error)?.message ?? e}`);
            }
          }
          break;
        }

        case "web_auth": {
          const { sessionId } = msg.payload;
          const session = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sessionId) as any;
          if (!session) {
            send(socket, "error", { message: "无效的会话" });
            socket.close();
            return;
          }
          webClients.add(socket);
          send(socket, "web_auth_ok", {});
          break;
        }

        case "res": {
          const { requestId, success, data, error } = msg.payload ?? {};
          if (typeof requestId !== "string") break;
          const slot = pending.get(requestId);
          if (!slot) break;
          // 跨设备 requestId 不会冲突（前缀化），但兜底校验来源设备
          if (deviceId && slot.deviceId !== deviceId) break;
          clearTimeout(slot.timer);
          pending.delete(requestId);
          if (success) slot.resolve(data);
          else slot.reject(new Error(error || "Agent 处理失败"));
          break;
        }

        case "project:state": {
          // 仅接受来自已认证 agent 的推送；userId/deviceId 必须就位
          if (!deviceId || !userId) break;
          const state = msg.payload as LocalProjectState;
          if (!state || typeof state.projectId !== "string") break;
          // 校验 projectId 属于当前用户
          const row = db.prepare("SELECT user_id FROM projects WHERE id = ?").get(state.projectId) as
            | { user_id: string }
            | undefined;
          if (!row || row.user_id !== userId) break;
          ingestProjectState(state);
          break;
        }

        case "skill:usage": {
          // skill 调用次数增量上报（旁路统计）。校验项目归属后累加到市场计数。
          if (!deviceId || !userId) break;
          const payload = msg.payload as
            | { projectId?: string; items?: { assetId: string; delta: number }[] }
            | undefined;
          if (!payload || typeof payload.projectId !== "string") break;
          const owner = db.prepare("SELECT user_id FROM projects WHERE id = ?").get(payload.projectId) as
            | { user_id: string }
            | undefined;
          if (!owner || owner.user_id !== userId) break;
          ingestSkillUsage(payload.items ?? []);
          break;
        }

        case "pong": {
          lastPongAt = Date.now();
          if (deviceId) {
            const now = Date.now();
            const lastWrite = lastOnlineWriteAt.get(deviceId) ?? 0;
            if (now - lastWrite >= PONG_WRITE_INTERVAL_MS) {
              db.prepare("UPDATE devices SET last_online_at = ? WHERE id = ?").run(
                new Date(now).toISOString(), deviceId
              );
              lastOnlineWriteAt.set(deviceId, now);
            }
          }
          break;
        }
      }
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      if (deviceId) {
        // 归属校验：仅当本 socket 仍是 deviceId 的活跃连接才执行清理。
        // 半挂场景下新 socket 已 set 进 agents map 并跑过 compensate，
        // 旧 socket 的 close handler 若无条件 delete + 改 status + reject
        // pending，会把新连接的状态/请求一起抹掉（用户表现为"重连后什么
        // 都没下来"）。
        const current = agents.get(deviceId);
        if (current && current.ws !== socket) {
          // 已被新连接接管：仅清理本 socket 自有资源（heartbeat 已停），
          // 不动 agents map / DB 状态 / pending。
          console.warn(`[ws] 旧 socket close 已被接管，跳过清理 device=${deviceId}`);
          webClients.delete(socket);
          return;
        }

        agents.delete(deviceId);
        lastOnlineWriteAt.delete(deviceId);
        db.prepare("UPDATE devices SET status = 'offline', last_online_at = ? WHERE id = ?").run(
          new Date().toISOString(), deviceId
        );

        // 同样排除已注销项目，保持软删状态稳定
        db.prepare(
          "UPDATE projects SET status = 'offline' WHERE device_id = ? AND status != 'unregistered'"
        ).run(deviceId);

        // 清理这个 device 还在等待应答的 pending 请求，避免内存泄漏与僵尸 timer
        for (const [reqId, slot] of pending.entries()) {
          if (slot.deviceId === deviceId) {
            clearTimeout(slot.timer);
            slot.reject(new Error("Agent 已断开连接"));
            pending.delete(reqId);
          }
        }

        // 通知 web 客户端立即刷新：设备和项目状态已变为 offline，
        // 不必等 30s 轮询。
        broadcastToWebClients("web:project:state_changed", {});
      }
      webClients.delete(socket);
    });
  });
}
