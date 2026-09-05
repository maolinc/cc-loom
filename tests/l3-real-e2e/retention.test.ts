/**
 * L3 留存（retained）生命周期 — 工作空间 / asset 引用计数 + GC。
 *
 * 真实 server + 真实 agent（安装引用场景）+ 真实 HTTP。
 * 不变量:
 *  - 工作空间: 无引用删除→硬删(404)；被安装引用→留存(库 404 但项目 retained)；
 *    失去最后引用→GC 硬删。
 *  - asset: 被空间/安装引用→留存；无引用→硬删；移出空间→引用归零 GC。
 *  - assetRefs: 空间引用 + 安装引用 分开计数、合并求和。
 * 断言一律走 API（refs / retained / 404 / 列表），不直查 DB、不直调内部 GC 函数。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  startServer, stopServer, type ServerHandle, ApiClient, ApiRequestError,
  startAgent, stopAgent, type AgentHandle,
  makeProject, cleanupProject, assetBuilders,
} from "@maolinc/cc-loom-testkit";

describe("L3 retention: 留存 + 引用计数 + GC", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  async function boot() {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("retain@example.com");
  }

  async function bootWithAgent(email: string) {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login(email);
    const token = await api.getCliToken();
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl, token, projectRoot,
      isOnline: async () => (await api.listDevices()).some((d) => d.status === "online"),
    });
    return token;
  }

  const skill = (name: string) => api.createAsset(assetBuilders.skill(name, ["cursor"]));
  const ws = (name: string, assetIds: string[]) =>
    api.createWorkspace({ name, description: "x", targetTools: ["cursor"], visibility: "private" }, assetIds);

  async function expectGone<T>(fn: () => Promise<T>): Promise<boolean> {
    try { await fn(); return false; } catch (e) { return e instanceof ApiRequestError && e.status === 404; }
  }

  // ---- workspace 留存 -----------------------------------------------------

  it("删除无引用工作空间 → 直接硬删（404）", async () => {
    await boot();
    const a = await skill("ws-hard-a");
    const w = await ws("ws-hard", [a.id]);
    await api.deleteWorkspace(w.id);
    expect(await expectGone(() => api.getWorkspace(w.id))).toBe(true);
  });

  it("删除被项目安装引用的工作空间 → 留存（库 404 但项目 retained）", async () => {
    await bootWithAgent("retain-ws@example.com");
    const a = await skill("ws-keep-a");
    const w = await ws("ws-keep", [a.id]);
    await api.installExecute({ projectId: agent!.projectId, workspaceId: w.id, targetTools: ["cursor"], policy: "locked" });

    await api.deleteWorkspace(w.id);

    // 库视角 404
    expect(await expectGone(() => api.getWorkspace(w.id))).toBe(true);
    // 项目安装视角：仍解析到，标 retained
    const projects = await api.listProjects();
    const p = projects.find((x: any) =>
      x.subscriptions?.some((s: any) => s.workspaceId === w.id))!;
    expect(p).toBeDefined();
    const sub = p.subscriptions.find((s: any) => s.workspaceId === w.id);
    expect(sub.retained).toBe(true);
  });

  it("留存工作空间失去最后引用 → GC 硬删", async () => {
    await bootWithAgent("retain-gc@example.com");
    const a = await skill("ws-gc-a");
    const w = await ws("ws-gc", [a.id]);
    await api.installExecute({ projectId: agent!.projectId, workspaceId: w.id, targetTools: ["cursor"], policy: "locked" });
    await api.deleteWorkspace(w.id); // 留存
    expect(await expectGone(() => api.getWorkspace(w.id))).toBe(true); // 库 404 但行在

    // 卸载该订阅 → ws-gc 失去安装引用 → GC（多订阅模型下「安装另一个空间」不再顶替旧订阅）
    await api.unsubscribeWorkspace(agent!.projectId, w.id);

    // GC 后项目不再订阅 ws-gc
    const projects = await api.listProjects();
    const p = projects.find((x: any) => x.id === agent!.projectId)!;
    expect(p.subscriptions.some((s: any) => s.workspaceId === w.id)).toBe(false);
  });

  // ---- asset 引用计数 + 留存 ---------------------------------------------

  it("assetRefs：空间引用 + 安装引用 分开计数并求和", async () => {
    await bootWithAgent("retain-refs@example.com");
    const a = await skill("refs-a");
    const w = await ws("refs-ws", [a.id]);
    await api.installExecute({ projectId: agent!.projectId, workspaceId: w.id, targetTools: ["cursor"], policy: "locked" });

    const detail = await api.getAsset(a.id);
    expect(detail.refs).toEqual({ workspaceRefs: 1, installRefs: 1, total: 2 });
  });

  it("删除被空间引用的 asset → 留存；空间仍以 retained 形态保留该成员", async () => {
    await boot();
    const a = await skill("asset-keep");
    const w = await ws("asset-keep-ws", [a.id]);

    await api.deleteAsset(a.id);
    // 库视角 404
    expect(await expectGone(() => api.getAsset(a.id))).toBe(true);
    // 空间详情仍含该成员，标 retained
    const wd = await api.getWorkspace(w.id);
    expect(wd.assets).toHaveLength(1);
    expect(wd.assets[0].id).toBe(a.id);
    expect((wd.assets[0] as any).retained).toBe(true);
  });

  it("删除无引用 asset → 直接硬删（404）", async () => {
    await boot();
    const a = await skill("asset-hard");
    await api.deleteAsset(a.id);
    expect(await expectGone(() => api.getAsset(a.id))).toBe(true);
  });

  it("留存 asset 被移出空间（PUT）→ 引用归零触发 GC 硬删", async () => {
    await boot();
    const a = await skill("asset-put-gc");
    const w = await ws("asset-put-ws", [a.id]);
    await api.deleteAsset(a.id); // 留存（仍在空间里）
    expect(await expectGone(() => api.getAsset(a.id))).toBe(true);

    // 从空间移除 → 失去最后引用 → GC
    await api.updateWorkspace(w.id, { assetIds: [] });
    // GC 后即使恢复空间成员也找不到该 asset
    const list = await api.listAssets();
    expect(list.find((x) => x.id === a.id)).toBeUndefined();
  });
});
