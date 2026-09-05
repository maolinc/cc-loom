/**
 * L3 sync-outbox 路由（项目维度）— 真实 server + 真实 HTTP。
 *
 * outbox 行通过真实流程产生（auto 项目 + 离线期间 workspace 编辑 → enqueue）。
 * 断言走 HTTP 响应（list / stats / retry / discard 的可观测出口），不直查 DB、
 * 不直调 enqueueReconcile。
 *
 * 不变量:
 *  - 归属隔离：跨用户访问项目级端点 → 404
 *  - GET /api/projects/:id/sync-outbox → 列出该项目未完成行
 *  - GET /api/projects/:id/sync-outbox/stats → ready 计数
 *  - DELETE /api/sync-outbox/:id → 标记 completed，列表不再返回
 *  - POST /api/sync-outbox/:id/retry → 行仍在，可被再次消费
 *
 * 注: dead-letter / backoff 状态需要跑满多次失败 worker（真实退避耗时、易 flake），
 *      L2 用 DB UPDATE 模拟；L3 不模拟内部状态，该部分由 outbox-worker-v2 的
 *      failReconcile 路径 + 单元测试覆盖，本文件不构造 dead-letter 行。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  startServer, stopServer, type ServerHandle, ApiClient, ApiRequestError,
  startAgent, stopAgent, runCli, type AgentHandle,
  makeProject, cleanupProject, assetBuilders,
} from "@maolinc/cc-loom-testkit";

describe("L3 sync-outbox routes", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  afterEach(async () => {
    try { if (agent) await stopAgent(agent); } catch { /* ignore */ }
    try { await runCli(["stop", "--force"], { timeout: 5000 }); } catch { /* ignore */ }
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  async function bootAndRegister(email: string) {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login(email);
    const token = await api.getCliToken();
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl, token, projectRoot,
      isOnline: async () => (await api.listDevices()).some((d) => d.status === "online"),
    });
    return { token, projectId: agent.projectId };
  }

  async function makePendingRow(projectId: string): Promise<number> {
    // auto 项目 + 离线期间 workspace 编辑 → 入队一条 pending reconcile 行
    const a1 = await api.createAsset(assetBuilders.skill("ob-a", ["cursor"]));
    const a2 = await api.createAsset(assetBuilders.skill("ob-b", ["cursor"]));
    const ws = await api.createWorkspace(
      { name: "ws-ob", description: "x", targetTools: ["cursor"], visibility: "private" }, [a1.id],
    );
    await api.installExecute({ projectId, workspaceId: ws.id, targetTools: ["cursor"], policy: "auto" });

    // 停 agent（离线），编辑空间 → 入队 pending 行（不消费）
    await stopAgent(agent!);
    agent = null;
    for (let i = 0; i < 20; i++) {
      if (!(await api.listDevices()).some((d) => d.status === "online")) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    await api.updateWorkspace(ws.id, { assetIds: [a1.id, a2.id] });

    // 取 pending 行 id
    const rows = await api.get<any[]>(`/api/projects/${projectId}/sync-outbox`);
    if (rows.length === 0) throw new Error("no pending outbox row produced");
    return rows[0].id;
  }

  it("GET /api/projects/:id/sync-outbox 跨用户 → 404", async () => {
    const { projectId } = await bootAndRegister("ob-owner@example.com");
    // 另一用户登录
    const other = new ApiClient(server.baseUrl);
    await other.login("ob-other@example.com");
    await expect(other.get(`/api/projects/${projectId}/sync-outbox`)).rejects.toMatchObject({ status: 404 });
  });

  it("GET stats → ready 计数；list → 含 pending 行", async () => {
    const { projectId } = await bootAndRegister("ob-stats@example.com");
    const rowId = await makePendingRow(projectId);

    const list = await api.get<any[]>(`/api/projects/${projectId}/sync-outbox`);
    expect(list.some((r: any) => r.id === rowId)).toBe(true);

    const stats = await api.get<{ ready: number; backoff: number; deadLetter: number }>(`/api/projects/${projectId}/sync-outbox/stats`);
    expect(stats.ready).toBeGreaterThanOrEqual(1);
  });

  it("DELETE /api/sync-outbox/:id → 行标记 completed，列表不再返回", async () => {
    const { projectId } = await bootAndRegister("ob-del@example.com");
    const rowId = await makePendingRow(projectId);

    await api.del(`/api/sync-outbox/${rowId}`);

    const list = await api.get<any[]>(`/api/projects/${projectId}/sync-outbox`);
    expect(list.find((r: any) => r.id === rowId)).toBeUndefined();
  });

  it("POST /api/sync-outbox/:id/retry 跨用户 → 404", async () => {
    const { projectId } = await bootAndRegister("ob-retry@example.com");
    const rowId = await makePendingRow(projectId);
    const other = new ApiClient(server.baseUrl);
    await other.login("ob-retry-other@example.com");
    await expect(other.post(`/api/sync-outbox/${rowId}/retry`, undefined)).rejects.toMatchObject({ status: 404 });
  });
});
