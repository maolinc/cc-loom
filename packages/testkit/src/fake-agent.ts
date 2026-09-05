/**
 * FakeAgent — 真实 WS 客户端模拟本地 agent（mock 外部依赖，非被测对象）。
 *
 * 连接到真实 server 的 /ws，用于需要观察 server → agent RPC（如 op=reconcile）
 * 或精确控制在线/离线时机的 L3 用例。自动应答，并捕获所有 req 供断言。
 * server 端的 worker / WS / DB 全是真的。用 Node 22 全局 WebSocket，无额外依赖。
 */
export interface CapturedReq {
  op: string;
  payload: any;
}

export interface FakeAgentOptions {
  reconcileV2?: boolean;
  /** 若为 true，对 reconcile op 应答失败，驱动 outbox attempts → dead-letter。 */
  failReconcile?: boolean;
}

export class FakeAgent {
  private ws: WebSocket;
  readonly reqs: CapturedReq[] = [];
  private waiters: { pred: (r: CapturedReq) => boolean; resolve: (r: CapturedReq) => void; timer: NodeJS.Timeout }[] = [];
  private closed = false;
  private failReconcile: boolean;

  private constructor(ws: WebSocket, failReconcile: boolean) {
    this.ws = ws;
    this.failReconcile = failReconcile;
  }

  static async connect(baseUrl: string, token: string, deviceId: string, options?: FakeAgentOptions): Promise<FakeAgent> {
    const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    const agent = new FakeAgent(ws, options?.failReconcile ?? false);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("FakeAgent auth timeout")), 5000);
      const onOpen = () => {
        const capabilities = options?.reconcileV2 !== false
          ? { reconcileV2: true, subscriptionsV3: true }
          : undefined;
        ws.send(JSON.stringify({ type: "auth", payload: { token, deviceId, capabilities } }));
      };
      const onMessage = (ev: MessageEvent) => {
        let msg: any;
        try { msg = JSON.parse(ev.data as string); } catch { return; }
        if (msg.type === "auth_ok") { clearTimeout(timer); resolve(); return; }
        if (msg.type === "error") { clearTimeout(timer); reject(new Error(msg.payload?.message ?? "auth error")); return; }
        agent.handle(msg);
      };
      const onError = () => { clearTimeout(timer); reject(new Error("FakeAgent WS error")); };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("error", onError);
    });
    return agent;
  }

  private handle(msg: any): void {
    if (msg.type !== "req") return;
    const { requestId, op, ...payload } = msg.payload ?? {};
    const captured: CapturedReq = { op, payload };
    this.reqs.push(captured);
    let resPayload: any;
    if (op === "reconcile") {
      if (this.failReconcile) {
        resPayload = { requestId, success: false, error: "fake-agent failure" };
      } else {
        resPayload = { requestId, success: true, data: { filesWritten: [], filesRemoved: [], lockWorkspaceId: payload.workspaceId ?? null } };
      }
    } else {
      resPayload = { requestId, success: true, data: { success: true, workspaceId: "", projectId: payload.projectId ?? "", completedAt: new Date().toISOString(), filesWritten: [], errors: [] } };
    }
    this.ws.send(JSON.stringify({ type: "res", payload: resPayload }));
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i]!.pred(captured)) {
        clearTimeout(this.waiters[i]!.timer);
        this.waiters[i]!.resolve(captured);
        this.waiters.splice(i, 1);
      }
    }
  }

  /** 等待匹配某谓词的 req（默认 2s 超时）。 */
  waitForReq(pred: (r: CapturedReq) => boolean, timeoutMs = 2000): Promise<CapturedReq> {
    const existing = this.reqs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for matching req")), timeoutMs);
      this.waiters.push({ pred, resolve: (r) => { clearTimeout(timer); resolve(r); }, timer });
    });
  }

  /** 在 ms 内未收到任何 req 则通过（负向断言）。 */
  async expectNoReq(ms = 300): Promise<void> {
    const before = this.reqs.length;
    await new Promise((r) => setTimeout(r, ms));
    if (this.reqs.length !== before) {
      throw new Error(`expected no req but got ${this.reqs.length - before}: ${JSON.stringify(this.reqs.slice(before))}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
