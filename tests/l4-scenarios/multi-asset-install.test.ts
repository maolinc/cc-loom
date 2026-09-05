/**
 * L4 编排: 多项目多工具安装编排
 *
 * 角色:
 * - 用户 A: 创建含 4 类 asset 的 capabilitySet (cursor + claudecode)
 * - 项目 1: 安装到 cursor
 * - 项目 2: 安装到 claudecode
 *
 * 流程:
 * 1. A 创建 4 个 asset (skill, rule, mcp, command) + capabilitySet
 * 2. 项目 1 安装到 cursor → 断言 cursor 目录
 * 3. 项目 2 安装到 claudecode → 断言 claude 目录 + 根 .mcp.json
 *
 * 不变量: 两个项目各自落盘正确，互不干扰
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

describe("L4 multi-asset-install: 多项目多工具编排", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent1: AgentHandle | null;
  let agent2: AgentHandle | null;
  let proj1: string | null;
  let proj2: string | null;

  beforeEach(() => {
    agent1 = null;
    agent2 = null;
    proj1 = null;
    proj2 = null;
  });

  afterEach(async () => {
    if (agent1) await stopAgent(agent1);
    if (agent2) await stopAgent(agent2);
    if (server) await stopServer(server);
    if (proj1) cleanupProject(proj1);
    if (proj2) cleanupProject(proj2);
  });

  it("同一 capabilitySet 分别装到两个项目的 cursor 和 claudecode", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("multi@example.com");
    const token = await api.getCliToken();

    // 创建 4 类 asset，全部兼容 cursor + claudecode
    const skill = await api.createAsset(assetBuilders.skill("multi-skill", ["cursor", "claudecode"]));
    const rule = await api.createAsset(assetBuilders.rule("multi-rule", ["**/*.ts"], ["cursor", "claudecode"]));
    const mcp = await api.createAsset(assetBuilders.mcp("multi-mcp", "npx serve", ["cursor", "claudecode"]));
    const cmd = await api.createAsset(assetBuilders.command("multi-cmd", "/build", ["cursor", "claudecode"]));

    const ws = await api.createCapabilitySet(
      { name: "ws-multi", description: "multi asset", targetTools: ["cursor", "claudecode"], visibility: "public" },
      [skill.id, rule.id, mcp.id, cmd.id],
    );

    // ---- 项目 1: cursor ----
    proj1 = makeProject("empty");
    agent1 = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot: proj1,
      isOnline: async () => {
        const devices = await api.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });

    await api.installExecute({
      projectId: agent1.projectId,
      capabilitySetId: ws.id,
      targetTools: ["cursor"],
      policy: "locked",
    });

    // cursor 落盘
    expectFileExists(proj1, ".cursor/skills/multi-skill/SKILL.md");
    expectFileExists(proj1, ".cursor/rules/multi-rule.md");
    expectFileExists(proj1, ".cursor/mcp.json");
    expectFileExists(proj1, ".cursor/commands/multi-cmd.md");

    // ---- 项目 2: claudecode ----
    proj2 = makeProject("empty");
    agent2 = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot: proj2,
      isOnline: async () => {
        const devices = await api.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });

    await api.installExecute({
      projectId: agent2.projectId,
      capabilitySetId: ws.id,
      targetTools: ["claudecode"],
      policy: "locked",
    });

    // claudecode 落盘 (MCP 在项目根 .mcp.json)
    expectFileExists(proj2, ".claude/skills/multi-skill/SKILL.md");
    expectFileExists(proj2, ".claude/rules/multi-rule.md");
    expectFileExists(proj2, ".mcp.json");
    expectFileExists(proj2, ".claude/commands/multi-cmd.md");

    // 互不干扰: proj1 没有 .claude, proj2 没有 .cursor
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(existsSync(join(proj1, ".claude"))).toBe(false);
    expect(existsSync(join(proj2, ".cursor"))).toBe(false);
  }, 90000);
});
