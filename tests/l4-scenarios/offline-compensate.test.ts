/**
 * L4 编排: 离线补偿
 *
 * 角色:
 * - 用户 A (alice): 修改 asset 内容
 * - 用户 B (bob): 安装后离线，再上线
 *
 * 流程:
 * 1. A 创建 skill + workspace (public)
 * 2. B 安装 (auto)
 * 3. B agent 停止（离线）
 * 4. A 修改 skill 内容
 * 5. B agent 重启（上线）
 * 6. auto 补偿: B 收到更新后的内容
 *
 * 不变量: B 上线后磁盘文件内容与 A 修改后一致
 *
 * 注意: 产品文档 §9.2 — "当前保守不补偿离线期间的成员移除"，
 * 但 asset 内容变化会补偿。此测试验证内容补偿。
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
  assetBuilders,
  expectFileContains,
} from "@maolinc/cc-loom-testkit";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("L4 offline-compensate: 离线期间内容变更 → 上线补偿", () => {
  let server: ServerHandle;
  let alice: ApiClient;
  let bob: ApiClient;
  let bobAgent: AgentHandle | null;
  let bobProject: string | null;
  let bobToken: string;

  beforeEach(() => {
    bobAgent = null;
    bobProject = null;
  });

  afterEach(async () => {
    try { await runCli(["stop", "--force"], { timeout: 5000 }); } catch { /* ignore */ }
    if (server) await stopServer(server);
    if (bobProject) cleanupProject(bobProject);
  });

  it("B 离线 → A 改内容 → B 上线 → 内容已补偿", async () => {
    server = await startServer();

    // ---- A 创建 ----
    alice = new ApiClient(server.baseUrl);
    await alice.login("alice@offline.com");

    const skill = await alice.createAsset(assetBuilders.skill("compensate-skill", ["cursor"]));
    const ws = await alice.createWorkspace(
      { name: "ws-offline", description: "offline compensate", targetTools: ["cursor"], visibility: "public" },
      [skill.id],
    );

    // ---- B 安装 ----
    bob = new ApiClient(server.baseUrl);
    await bob.login("bob@offline.com");
    bobToken = await bob.getCliToken();

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

    await bob.installExecute({
      projectId: bobAgent.projectId,
      workspaceId: ws.id,
      targetTools: ["cursor"],
      policy: "auto",
    });

    // 验证初始内容
    expectFileContains(bobProject, ".cursor/skills/compensate-skill/SKILL.md", "Test skill");

    // ---- B 离线 ----
    await stopAgent(bobAgent);
    bobAgent = null;

    // ---- A 修改 skill 内容 ----
    await alice.updateAsset(skill.id, {
      files: [{ path: "SKILL.md", content: "# compensate-skill\n\nUPDATED CONTENT v2" }],
    });

    // ---- B 上线 ----
    await runCli(["start", "--force"], { timeout: 15000 });

    // 等待设备在线
    for (let i = 0; i < 40; i++) {
      const devices = await bob.listDevices();
      if (devices.some((d) => d.status === "online")) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // ---- 等待 auto 补偿推送新内容 ----
    let compensated = false;
    for (let i = 0; i < 40; i++) {
      const content = readFileSync(join(bobProject, ".cursor/skills/compensate-skill/SKILL.md"), "utf-8");
      if (content.includes("UPDATED CONTENT v2")) {
        compensated = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(compensated).toBe(true);
  }, 90000);
});
