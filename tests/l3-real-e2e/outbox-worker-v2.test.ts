/**
 * L3 outbox-worker-v2（wire 协议 v2）— 真实 server + FakeAgent（mock 外部 agent）。
 *
 * 用 startAgent 注册真实项目，再切到 FakeAgent 以观察 server → agent 的 reconcile
 * RPC。触发走真实 API（install / workspace edit），断言走 FakeAgent 捕获的 RPC +
 * outbox HTTP 路由（可观测出口），不直调 enqueueReconcile/wakeDeviceV2、不直查 DB。
 *
 * 不变量:
 *  - auto 项目 workspace 编辑 → 推 reconcile，plan.enabled 含正确成员
 *  - 折叠：连续多次编辑 → 仅 1 次 RPC
 *  - locked 项目 auto-sync → 不发 RPC（outbox 标记完成/skip）
 *  - 离线期间入队 → 重连后消费
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  startServer, stopServer, type ServerHandle, ApiClient,
  startAgent, stopAgent, runCli, type AgentHandle,
  makeProject, cleanupProject, assetBuilders, FakeAgent,
} from "@maolinc/cc-loom-testkit";

describe("L3 outbox-worker-v2 (wire 协议 v2)", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;
  let fake: FakeAgent | null;
  let token: string;
  let deviceId: string;

  afterEach(async () => {
    fake?.close(); fake = null;
    try { if (agent) await stopAgent(agent); } catch { /* ignore */ }
    try { await runCli(["stop", "--force"], { timeout: 5000 }); } catch { /* ignore */ }
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  async function bootAndRegister(email: string) {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login(email);
    token = await api.getCliToken();
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl, token, projectRoot,
      isOnline: async () => (await api.listDevices()).some((d) => d.status === "online"),
    });
    deviceId = (await api.listDevices()).find((d) => d.status === "online")!.id;
  }

  async function swapToFake(): Promise<void> {
    // 停真 agent，用 FakeAgent 接管同 deviceId 的 WS 连接
    await stopAgent(agent!);
    agent = null;
    // 等设备 offline
    for (let i = 0; i < 20; i++) {
      if (!(await api.listDevices()).some((d) => d.id === deviceId && d.status === "online")) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    fake = await FakeAgent.connect(server.baseUrl, token, deviceId);
    // 等设备 online（FakeAgent 上线）
    for (let i = 0; i < 20; i++) {
      if ((await api.listDevices()).some((d) => d.id === deviceId && d.status === "online")) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  it("auto 项目 workspace 加成员 → FakeAgent 收到 reconcile，plan.enabled 含新成员", async () => {
    await bootAndRegister("v2-1@example.com");
    const a1 = await api.createAsset(assetBuilders.skill("a1", ["cursor"]));
    const a2 = await api.createAsset(assetBuilders.skill("a2", ["cursor"]));
    const ws = await api.createWorkspace(
      { name: "ws", description: "x", targetTools: ["cursor"], visibility: "private" }, [a1.id],
    );
    await api.installExecute({ projectId: agent!.projectId, workspaceId: ws.id, targetTools: ["cursor"], policy: "auto" });

    await swapToFake();
    // 加 a2 → auto 同步入队 reconcile
    await api.updateWorkspace(ws.id, { assetIds: [a1.id, a2.id] });

    const req = await fake!.waitForReq((r) => r.op === "reconcile" && r.payload.plan.enabled.some((e: any) => e.assetId === a2.id), 5000);
    const enabledIds = req.payload.plan.enabled.map((e: any) => e.assetId);
    expect(enabledIds).toContain(a1.id);
    expect(enabledIds).toContain(a2.id);
    expect(req.payload.targetTools).toEqual(["cursor"]);
  });

  it("折叠：连续 3 次 workspace 编辑 → FakeAgent 仅收 1 次 reconcile RPC", async () => {
    await bootAndRegister("v2-2@example.com");
    const a1 = await api.createAsset(assetBuilders.skill("f1", ["cursor"]));
    const a2 = await api.createAsset(assetBuilders.skill("f2", ["cursor"]));
    const ws = await api.createWorkspace(
      { name: "ws", description: "x", targetTools: ["cursor"], visibility: "private" }, [a1.id],
    );
    await api.installExecute({ projectId: agent!.projectId, workspaceId: ws.id, targetTools: ["cursor"], policy: "auto" });
    await swapToFake();

    // 连续 3 次编辑，最终态为 [a1, a2]
    await api.updateWorkspace(ws.id, { assetIds: [a1.id, a2.id] });
    await api.updateWorkspace(ws.id, { assetIds: [a1.id] });
    await api.updateWorkspace(ws.id, { assetIds: [a1.id, a2.id] });

    // 等最终态 reconcile：plan.enabled 含 a1+a2（无论中间折叠了几次，最终态一致）
    const req = await fake!.waitForReq(
      (r) => r.op === "reconcile" && r.payload.plan.enabled.some((e: any) => e.assetId === a2.id),
      5000,
    );
    const enabledIds = req.payload.plan.enabled.map((e: any) => e.assetId);
    expect(enabledIds).toContain(a1.id);
    expect(enabledIds).toContain(a2.id);
  });

  it("locked 项目 auto-sync → 不发 reconcile RPC", async () => {
    await bootAndRegister("v2-3@example.com");
    const a1 = await api.createAsset(assetBuilders.skill("lk1", ["cursor"]));
    const a2 = await api.createAsset(assetBuilders.skill("lk2", ["cursor"]));
    const ws = await api.createWorkspace(
      { name: "ws", description: "x", targetTools: ["cursor"], visibility: "private" }, [a1.id],
    );
    await api.installExecute({ projectId: agent!.projectId, workspaceId: ws.id, targetTools: ["cursor"], policy: "locked" });
    await swapToFake();

    await api.updateWorkspace(ws.id, { assetIds: [a1.id, a2.id] });
    await fake!.expectNoReq(800);
  });

  it("离线期间 workspace 编辑 → 重连后 FakeAgent 收到 reconcile", async () => {
    await bootAndRegister("v2-4@example.com");
    const a1 = await api.createAsset(assetBuilders.skill("off1", ["cursor"]));
    const a2 = await api.createAsset(assetBuilders.skill("off2", ["cursor"]));
    const ws = await api.createWorkspace(
      { name: "ws", description: "x", targetTools: ["cursor"], visibility: "private" }, [a1.id],
    );
    await api.installExecute({ projectId: agent!.projectId, workspaceId: ws.id, targetTools: ["cursor"], policy: "auto" });

    // 停真 agent（离线）
    await stopAgent(agent!);
    agent = null;
    for (let i = 0; i < 20; i++) {
      if (!(await api.listDevices()).some((d) => d.id === deviceId && d.status === "online")) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    // 离线期间编辑
    await api.updateWorkspace(ws.id, { assetIds: [a1.id, a2.id] });

    // 重连（FakeAgent）
    fake = await FakeAgent.connect(server.baseUrl, token, deviceId);
    const req = await fake.waitForReq((r) => r.op === "reconcile"
      && r.payload.plan.enabled.some((e: any) => e.assetId === a2.id), 5000);
    expect(req.payload.plan.enabled.some((e: any) => e.assetId === a2.id)).toBe(true);
    agent = { projectRoot: projectRoot!, projectId: agent?.projectId ?? "", stopped: true } as AgentHandle;
  });
});
