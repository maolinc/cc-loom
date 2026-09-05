/**
 * L3 单独安装（type 2）— 验证 `/capabilities/add` 把市场 asset 作为项目级能力
 * 直接安装到 project_capabilities（无需 workspace、不 fan-out、不创建 implicit-workspace）。
 *
 * 不变量：
 *  - 无 workspace 项目：add 一个 skill → 文件落盘到厂商目录，能力在 capabilities 中可见。
 *  - 已装 workspace 项目：workspace 成员 + 单独 add 的能力并存于磁盘。
 *  - 不创建显式订阅（项目 subscriptions 中无 workspaceId 非空条目）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startServer,
  stopServer,
  type ServerHandle,
  startAgent,
  stopAgent,
  type AgentHandle,
  makeProject,
  cleanupProject,
  ApiClient,
  assetBuilders,
  expectFileExists,
} from "@maolinc/cc-loom-testkit";

describe("L3 single-asset install: /capabilities/add → project_capabilities", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  beforeEach(() => {
    agent = null;
    projectRoot = null;
  });

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  async function setup(): Promise<{ projectId: string; token: string }> {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("single@example.com");
    const token = await api.getCliToken();
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot,
      isOnline: async () => {
        const devices = await api.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });
    return { projectId: agent.projectId, token };
  }

  it("无 workspace 项目：add skill → 落盘 + 不创建 implicit workspace", async () => {
    const { projectId } = await setup();
    const skill = await api.createAsset(assetBuilders.skill("solo-skill", ["claudecode"]));

    const res = await api.addCapability(projectId, [skill.id]);
    expect(res.filesWritten.length).toBeGreaterThan(0);
    expectFileExists(projectRoot!, ".claude/skills/solo-skill/SKILL.md");

    // 项目仍无显式订阅（单独添加的能力归属隐式订阅）
    const proj = await api.getProject(projectId);
    expect(proj.subscriptions.every((s) => s.workspaceId === null)).toBe(true);
  });

  it("已装 workspace 项目：workspace 成员与单独 add 的能力并存", async () => {
    const { projectId } = await setup();
    const wsSkill = await api.createAsset(assetBuilders.skill("ws-skill", ["claudecode"]));
    const soloSkill = await api.createAsset(assetBuilders.skill("solo-skill", ["claudecode"]));
    const ws = await api.createWorkspace(
      { name: "ws", description: "ws", targetTools: ["claudecode"], visibility: "public" },
      [wsSkill.id],
    );

    // 先装 workspace
    const { result } = await api.installExecute({
      projectId, workspaceId: ws.id, targetTools: ["claudecode"], policy: "auto",
    });
    expect(result.success).toBe(true);
    expectFileExists(projectRoot!, ".claude/skills/ws-skill/SKILL.md");

    // 再单独 add 另一个 skill（走 project_capabilities，不进 workspace_assets）
    const res = await api.addCapability(projectId, [soloSkill.id]);
    expect(res.filesWritten.length).toBeGreaterThan(0);
    expectFileExists(projectRoot!, ".claude/skills/ws-skill/SKILL.md");
    expectFileExists(projectRoot!, ".claude/skills/solo-skill/SKILL.md");
  });
});
