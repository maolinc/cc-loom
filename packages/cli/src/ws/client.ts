/**
 * Agent 端 WebSocket 客户端：
 * - 单实例 ws + 心跳 interval + 重连 timer
 * - 指数退避重连：1s / 2s / 4s / 8s / 16s / 30s 封顶
 * - `stop()` 后绝不再重连，并清空所有 timer 与监听器（杜绝旧版递归 startCommand 的泄漏）
 *
 * 不在这里处理 reconcile op —— `loom start` 命令层订阅 `request` 事件,
 * 调 reconcile-runner,再用 `sendResponse()` 回传。这样 client 与 IO 解耦、便于
 * 在测试或不同 UI 中复用。
 */
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type {
  CliConfig,
  LocalProjectState,
  SkillUsageReport,
} from "@maolinc/cc-loom-shared";
import {
  MSG_ACK,
  MSG_AUTH,
  MSG_AUTH_OK,
  MSG_ERROR,
  MSG_HEARTBEAT,
  MSG_PONG,
  MSG_PROJECT_STATE,
  MSG_REQ,
  MSG_RES,
  MSG_SKILL_USAGE,
} from "./messages.js";

export type AgentState =
  | "idle"
  | "connecting"
  | "authed"
  | "reconnecting"
  | "stopped";

/**
 * server → agent 通用请求。`payload` 字段中带 `requestId` + `op`，agent 处理完调
 * `sendResponse` 回传同 `requestId`。具体 op 由上层（start.ts）路由。
 */
export interface AgentRequest {
  requestId: string;
  op: string;
  /** 各 op 自己的字段，原样透传给上层处理器 */
  [key: string]: unknown;
}

export interface AgentResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentEvents {
  state: (state: AgentState, detail?: string) => void;
  /** server → agent 请求（带 requestId）；上层处理后必须调 sendResponse */
  request: (req: AgentRequest) => void;
  error: (message: string) => void;
  message: (type: string, payload: unknown) => void;
}

const HEARTBEAT_MS = 25_000; // 比 server 30s 短，确保 server 端不会先超时
const BACKOFF_STEPS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export interface AgentClientOptions {
  config: CliConfig;
  /** 是否在 close/error 后重连。默认 true。 */
  autoReconnect?: boolean;
}

export declare interface AgentClient {
  on<E extends keyof AgentEvents>(event: E, listener: AgentEvents[E]): this;
  emit<E extends keyof AgentEvents>(event: E, ...args: Parameters<AgentEvents[E]>): boolean;
}

export class AgentClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private state: AgentState = "idle";
  private stopped = false;
  private readonly autoReconnect: boolean;

  constructor(private readonly opts: AgentClientOptions) {
    super();
    this.autoReconnect = opts.autoReconnect !== false;
  }

  getState(): AgentState {
    return this.state;
  }

  start(): void {
    if (this.stopped) return;
    this.connect();
  }

  /** 优雅关闭：不再重连，清理所有 timer + ws + listener。幂等。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.setState("stopped");
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "client stop");
        else this.ws.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  /** 通用请求响应：上层处理完 `request` 事件后调一次此方法回送。 */
  sendResponse(response: AgentResponse): void {
    this.send(MSG_RES, response);
  }

  /** agent 主动向 server 推送项目本地状态（fs.watch / 启动 / install 完成等触发）。 */
  pushProjectState(state: LocalProjectState): void {
    this.send(MSG_PROJECT_STATE, state);
  }

  /** agent 主动上报 skill 调用次数增量（旁路统计）。仅在已认证时发送。 */
  reportSkillUsage(report: SkillUsageReport): boolean {
    if (this.state !== "authed") return false;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.send(MSG_SKILL_USAGE, report);
    return true;
  }

  // ---------------- internal ----------------

  private connect(): void {
    if (this.stopped) return;
    this.clearTimers();

    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");

    const wsUrl = this.opts.config.endpoint.replace(/^http/, "ws").replace(/\/+$/, "") + "/ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err: any) {
      this.emit("error", `WebSocket 创建失败: ${err?.message || err}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.send(MSG_AUTH, {
        token: this.opts.config.token,
        deviceId: this.opts.config.deviceId,
        // 自报支持 reconcile v2 wire 协议 + 多能力集订阅（ADR-0006）；
        // server 当前实现要求这两个字段均为 true 才放行。
        capabilities: { reconcileV2: true, subscriptionsV3: true, toolConfigProfiles: true },
      });
      this.startHeartbeat();
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: { type: string; payload: any } | null = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg) return;
      this.emit("message", msg.type, msg.payload);

      switch (msg.type) {
        case MSG_AUTH_OK:
          this.attempt = 0;
          this.setState("authed");
          break;
        case MSG_HEARTBEAT:
          this.send(MSG_PONG, {});
          break;
        case MSG_REQ: {
          const req = msg.payload as AgentRequest;
          // 基本字段缺失就直接报错回复，不走业务层
          if (!req || typeof req.requestId !== "string" || typeof req.op !== "string") {
            this.send(MSG_RES, {
              requestId: req?.requestId ?? "",
              success: false,
              error: "请求格式错误：requestId 或 op 缺失",
            } satisfies AgentResponse);
            break;
          }
          this.emit("request", req);
          break;
        }
        case MSG_ERROR:
          this.emit("error", msg.payload?.message ?? "服务端错误");
          break;
        case MSG_ACK:
          // 不需要处理
          break;
      }
    });

    ws.on("close", (code) => {
      if (this.stopped) return;
      this.clearHeartbeat();
      this.ws = null;
      this.emit("error", `连接关闭 (${code})`);
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      if (this.stopped) return;
      this.emit("error", `连接错误: ${err.message}`);
      // 'error' 之后通常会跟 'close'，重连让 close handler 处理
    });
  }

  private send(type: string, payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type, payload }));
    } catch {
      // 忽略：下一次心跳/重连会发现
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send(MSG_PONG, {});
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.stopped) {
      this.setState("stopped");
      return;
    }
    const delay = BACKOFF_STEPS[Math.min(this.attempt, BACKOFF_STEPS.length - 1)] ?? 30_000;
    this.attempt += 1;
    this.setState("reconnecting", `${Math.round(delay / 1000)}s 后重试 (#${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private setState(state: AgentState, detail?: string): void {
    this.state = state;
    this.emit("state", state, detail);
  }
}
