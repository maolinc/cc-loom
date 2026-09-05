/**
 * L4 编排: 跨用户 auto 同步
 *
 * 角色:
 * - 用户 A (alice): 创建 public workspace, 含 1 个 skill
 * - 用户 B (bob): 安装 A 的 workspace (auto 策略)
 *
 * 流程:
 * 1. A 创建 skill + workspace (public)
 * 2. B 注册项目 + 启动 agent + 安装
 * 3. A 更新 workspace 成员 +1 skill
 * 4. B 的项目自动同步新 skill（auto 策略）
 *
 * 不变量: B 的磁盘最终出现 2 个 skill 文件
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
} from "@maolinc/cc-loom-testkit";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("L4 cross-user-sync: 跨用户 auto 同步", () => {
  let server: ServerHandle;
  let alice: ApiClient;
  let bob: ApiClient;
  let bobAgent: AgentHandle | null;
  let bobProject: string | null;

  beforeEach(() => {
    bobAgent = null;
    bobProject = null;
  });

  afterEach(async () => {
    if (bobAgent) await stopAgent(bobAgent);
    if (server) await stopServer(server);
    if (bobProject) cleanupProject(bobProject);
  });

  it("A 创建 workspace → B 安装 → A 加成员 → B 自动同步", async () => {
    server = await startServer();

    // ---- 角色 A: alice ----
    alice = new ApiClient(server.baseUrl);
    await alice.login("alice@sync.com");
    const aliceToken = await alice.getCliToken();

    const skillA = await alice.createAsset(assetBuilders.skill("shared-a", ["cursor"]));
    const skillB = await alice.createAsset(assetBuilders.skill("shared-b", ["cursor"]));
    const ws = await alice.createWorkspace(
      { name: "shared-ws", description: "cross-user", targetTools: ["cursor"], visibility: "public" },
      [skillA.id],
    );

    // ---- 角色 B: bob ----
    bob = new ApiClient(server.baseUrl);
    await bob.login("bob@sync.com");
    const bobToken = await bob.getCliToken();

    bobProject = makeProject("empty");
    bobAgent = await startAgent({
      endpoint: server.baseUrl,
      token: bobToken,
      projectRoot: bobProject,
      isOnline: async () => {
        const devices = await bob.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });

    // B 安装 A 的 public workspace
    await bob.installExecute({
      projectId: bobAgent.projectId,
      workspaceId: ws.id,
      targetTools: ["cursor"],
      policy: "auto",
    });

    // 断言: B 磁盘有 skillA, 没有 skillB
    expect(existsSync(join(bobProject, ".cursor/skills/shared-a/SKILL.md"))).toBe(true);
    expect(existsSync(join(bobProject, ".cursor/skills/shared-b/SKILL.md"))).toBe(false);

    // ---- A 更新 workspace: 加 skillB ----
    await alice.updateWorkspace(ws.id, { assetIds: [skillA.id, skillB.id] });

    // ---- 等待 B 自动同步 ----
    let synced = false;
    for (let i = 0; i < 40; i++) {
      if (existsSync(join(bobProject, ".cursor/skills/shared-b/SKILL.md"))) {
        synced = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(synced).toBe(true);

    // 最终不变量: B 磁盘有 2 个 skill
    expect(existsSync(join(bobProject, ".cursor/skills/shared-a/SKILL.md"))).toBe(true);
    expect(existsSync(join(bobProject, ".cursor/skills/shared-b/SKILL.md"))).toBe(true);
  }, 60000);
});
