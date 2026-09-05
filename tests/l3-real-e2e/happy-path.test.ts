/**
 * L3 真实链路 happy-path — 验证完整用户旅程:
 * (分层缓存验证: 此注释变更不应触发 pnpm install 重跑)
 * login → 创建 skill → 组 capabilitySet → 注册项目 → 启动 agent → 安装 → 落盘 → lock
 *
 * 不变量: 安装后磁盘文件与预期一致，lock 记录正确的 capabilitySetId 和 policy。
 * 真实性: server 和 agent 都是真实进程，通过 HTTP + WebSocket 通信。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startServer,
  stopServer,
  type ServerHandle,
} from "@maolinc/cc-loom-testkit";
import {
  startAgent,
  stopAgent,
  type AgentHandle,
} from "@maolinc/cc-loom-testkit";
import { makeProject, cleanupProject } from "@maolinc/cc-loom-testkit";
import { ApiClient } from "@maolinc/cc-loom-testkit";
import { assetBuilders } from "@maolinc/cc-loom-testkit";
import { expectFileExists, expectFileSet, expectLock } from "@maolinc/cc-loom-testkit";

describe("L3 happy-path: 全链路", () => {
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

  it("登录→创建skill→组capabilitySet→注册项目→安装→落盘", async () => {
    // 1. 启动真实 server
    server = await startServer();
    api = new ApiClient(server.baseUrl);

    // 2. Web 登录 + 获取 CLI token
    await api.login("alice@example.com");
    const token = await api.getCliToken();

    // 3. 创建 skill asset
    const skill = await api.createAsset(assetBuilders.skill("scout", ["cursor"]));
    expect(skill.id).toBeDefined();

    // 4. 创建 capabilitySet 并添加 skill 成员
    const ws = await api.createCapabilitySet(
      {
        name: "test-ws",
        description: "happy path capabilitySet",
        targetTools: ["cursor"],
        visibility: "public",
      },
      [skill.id],
    );
    expect(ws.assets).toHaveLength(1);

    // 5. 创建项目沙箱（空目录）
    projectRoot = makeProject("empty");

    // 6. 启动真实 agent: login → start → register → 等待在线
    agent = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot,
      // agent 连接后设备变 online，但项目状态要等 30s reconcile 才变 online。
      // 只要设备在线，安装就能送达 agent。检查设备状态更可靠。
      isOnline: async () => {
        try {
          const devices = await api.listDevices();
          return devices.some((d) => d.status === "online");
        } catch {
          return false;
        }
      },
    });

    // 7. 生成安装计划
    const plan = await api.installPlan({
      projectId: agent.projectId,
      capabilitySetId: ws.id,
      targetTools: ["cursor"],
      policy: "auto",
    });
    expect(plan.diff.length).toBeGreaterThan(0);
    expect(plan.conflicts).toEqual([]);

    // 8. 执行安装
    const { result } = await api.installExecute({
      projectId: agent.projectId,
      capabilitySetId: ws.id,
      targetTools: ["cursor"],
      policy: "auto",
    });
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);

    // 9. 断言磁盘落盘: .cursor/skills/scout/SKILL.md
    expectFileExists(projectRoot, ".cursor/skills/scout/SKILL.md");
    expectFileSet(projectRoot, [".cursor/skills/scout/SKILL.md"]);

    // 10. 断言 lock: capabilitySetId + policy 正确
    expectLock(agent.projectId, { capabilitySetId: ws.id, policy: "auto" });
  });
});
