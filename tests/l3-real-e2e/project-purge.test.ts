/**
 * L3 项目删除（purge / unregister）真实链路 —— 验证「一句话抹掉项目全部痕迹」
 * 在真实 server + agent + WS + 磁盘 下的端到端行为。
 *
 * 不变量：
 *  - loom unregister：本机 ~/.loom 痕迹全清 + 服务端项目行硬删
 *  - Web purge（agent 在线）：本机痕迹全清 + 服务端项目行硬删（depth=deep）
 *  - Web purge（agent 离线）：服务端软删 + 本地痕迹保留；agent 重连后自愈
 *    （补发 project:purge 抹本地痕迹 + 硬删服务端行）
 *
 * 真实性：server / agent 均为真实进程，通过 HTTP + WebSocket 通信，磁盘真实读写。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startServer,
  stopServer,
  type ServerHandle,
  startAgent,
  stopAgent,
  runCli,
  type AgentHandle,
  makeProject,
  cleanupProject,
  ApiClient,
  ApiRequestError,
  assetBuilders,
  expectFileExists,
  expectNoProjectTraces,
} from "@maolinc/cc-loom-testkit";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LOOM_HOME } from "@maolinc/cc-loom-testkit";

describe("L3 project-purge: 删除项目抹掉全部痕迹", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  beforeEach(() => {
    agent = null;
    projectRoot = null;
  });

  afterEach(async () => {
    try { await runCli(["stop", "--force"], { timeout: 5000 }); } catch { /* ignore */ }
    if (agent) { agent.stopped = true; }
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  async function bootagent(token: string): Promise<void> {
    agent = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot: projectRoot!,
      isOnline: async () => {
        const devices = await api.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });
  }

  /** 等待设备重新在线（agent 重启后用）。 */
  async function waitForDeviceOnline(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const devices = await api.listDevices();
      if (devices.some((d) => d.status === "online")) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`设备上线超时 (${timeoutMs}ms)`);
  }

  it("loom unregister：本机痕迹全清 + 服务端硬删", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("unreg@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(assetBuilders.skill("unreg-skill", ["cursor"]));
    const ws = await api.createWorkspace(
      { name: "ws-unreg", description: "unregister test", targetTools: ["cursor"], visibility: "public" },
      [skill.id],
    );

    projectRoot = makeProject("empty");
    await bootagent(token);
    const projectId = agent!.projectId;

    await api.installExecute({
      projectId, workspaceId: ws.id, targetTools: ["cursor"], policy: "locked",
    });
    expectFileExists(projectRoot, ".cursor/skills/unreg-skill/SKILL.md");
    // 确认本地痕迹存在（projects/locks）
    expect(existsSync(join(LOOM_HOME, "projects", `${projectId}.json`))).toBe(true);

    // 执行 loom unregister（在项目目录下）
    await runCli(["unregister"], { cwd: projectRoot, timeout: 15000 });

    // 本机 ~/.loom 痕迹全清
    expectNoProjectTraces(projectId);
    // 服务端项目行硬删（getProject → 404）
    await expect(api.getProject(projectId)).rejects.toMatchObject({ status: 404 });
  });

  it("Web purge（agent 在线）：depth=deep，本机痕迹全清 + 服务端硬删", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("purge-online@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(assetBuilders.skill("purge-online-skill", ["cursor"]));
    const ws = await api.createWorkspace(
      { name: "ws-purge-online", description: "purge online", targetTools: ["cursor"], visibility: "public" },
      [skill.id],
    );

    projectRoot = makeProject("empty");
    await bootagent(token);
    const projectId = agent!.projectId;

    await api.installExecute({
      projectId, workspaceId: ws.id, targetTools: ["cursor"], policy: "locked",
    });
    expectFileExists(projectRoot, ".cursor/skills/purge-online-skill/SKILL.md");

    const result = await api.purgeProject(projectId);
    expect(result.depth).toBe("deep");

    expectNoProjectTraces(projectId);
    await expect(api.getProject(projectId)).rejects.toMatchObject({ status: 404 });
  });

  it("Web purge（agent 离线）→ 浅度清理；agent 重连后自愈（抹本地 + 硬删服务端）", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("purge-offline@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(assetBuilders.skill("purge-offline-skill", ["cursor"]));
    const ws = await api.createWorkspace(
      { name: "ws-purge-offline", description: "purge offline", targetTools: ["cursor"], visibility: "public" },
      [skill.id],
    );

    projectRoot = makeProject("empty");
    await bootagent(token);
    const projectId = agent!.projectId;

    await api.installExecute({
      projectId, workspaceId: ws.id, targetTools: ["cursor"], policy: "locked",
    });
    expectFileExists(projectRoot, ".cursor/skills/purge-offline-skill/SKILL.md");

    // 停 agent → 项目离线
    await stopAgent(agent!);
    agent = null;

    // Web purge：离线 → shallow，服务端软删，本地痕迹保留
    const result = await api.purgeProject(projectId);
    expect(result.depth).toBe("shallow");
    // 服务端项目行仍在（软删，status=unregistered）
    const softDeleted = await api.getProject(projectId);
    expect(softDeleted.status).toBe("unregistered");
    // 本地痕迹仍在
    expect(existsSync(join(LOOM_HOME, "projects", `${projectId}.json`))).toBe(true);
    expect(existsSync(join(LOOM_HOME, "locks", `${projectId}.json`))).toBe(true);

    // 重启 agent → 重连自愈：compensateDeviceOnConnect 补发 project:purge + 硬删服务端行
    await runCli(["start", "--force"], { timeout: 15000 });
    await waitForDeviceOnline(20000);

    // 轮询等待自愈完成（本地痕迹清 + 服务端行硬删）
    let tracesGone = false;
    let serverGone = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (!tracesGone && !existsSync(join(LOOM_HOME, "projects", `${projectId}.json`))) {
        tracesGone = true;
      }
      if (tracesGone && !serverGone) {
        try {
          await api.getProject(projectId);
        } catch (e) {
          if (e instanceof ApiRequestError && e.status === 404) {
            serverGone = true;
          }
        }
      }
      if (tracesGone && serverGone) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(tracesGone).toBe(true);
    expect(serverGone).toBe(true);
    expectNoProjectTraces(projectId);
  });
});
