/**
 * L3 安装落盘验证 — 六类 asset × 四种 targetTool（D8: 必须覆盖 Codex/ClaudeCode）。
 *
 * 不变量: 每种 (asset type, target tool) 组合的落盘路径与产品文档 §6.2 一致。
 * 不支持的组合不产生文件（不视为失败）。
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
  expectFileNotExists,
  expectFileContains,
} from "@maolinc/cc-loom-testkit";

describe("L3 install-flow: 六类 asset × 四种 tool 落盘", () => {
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

  async function setup(endpoint: string, token: string): Promise<void> {
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint,
      token,
      projectRoot,
      isOnline: async () => {
        const devices = await api.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });
  }

  async function installAndAssert(
    wsId: string,
    targetTool: string,
    expectFiles: string[],
    expectAbsent: string[],
  ): Promise<void> {
    const { result } = await api.installExecute({
      projectId: agent!.projectId,
      capabilitySetId: wsId,
      targetTools: [targetTool as any],
      policy: "locked",
    });
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    for (const f of expectFiles) expectFileExists(projectRoot!, f);
    for (const f of expectAbsent) expectFileNotExists(projectRoot!, f);
  }

  it("cursor: skill + rule + mcp + command + hook + agent 落盘", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("cursor@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(assetBuilders.skill("c-skill", ["cursor"]));
    const rule = await api.createAsset(assetBuilders.rule("c-rule", ["**/*.ts"], ["cursor"]));
    const mcp = await api.createAsset(assetBuilders.mcp("c-mcp", "npx fs-server", ["cursor"]));
    const cmd = await api.createAsset(assetBuilders.command("c-cmd", "/lint", ["cursor"]));
    // PreToolUse 可映射到 Cursor 的 preToolUse → 应落盘到 .cursor/hooks.json + 附属脚本
    const hook = await api.createAsset(assetBuilders.hook("c-hook", "PreToolUse", ["cursor"]));
    // PostCompact 在 Cursor 无对应事件 → 不落盘、不产生附属文件
    const unmappable = await api.createAsset(assetBuilders.hook("c-unmappable", "PostCompact", ["cursor"]));
    const agentAsset = await api.createAsset(assetBuilders.agent("c-agent", ["cursor"]));

    const ws = await api.createCapabilitySet(
      { name: "ws-cursor", description: "cursor test", targetTools: ["cursor"], visibility: "public" },
      [skill.id, rule.id, mcp.id, cmd.id, hook.id, unmappable.id, agentAsset.id],
    );

    await setup(server.baseUrl, token);

    await installAndAssert(ws.id, "cursor", [
      ".cursor/skills/c-skill/SKILL.md",
      ".cursor/rules/c-rule.md",
      ".cursor/mcp.json",
      ".cursor/commands/c-cmd.md",
      ".cursor/hooks.json",
      ".cursor/hooks/c-hook/c-hook.sh",
      ".cursor/agents/c-agent.md",
    ], [
      // 不可映射事件的 hook 不落盘（无附属文件、无注册表条目）
      ".cursor/hooks/c-unmappable",
    ]);

    // mcp.json 应包含 c-mcp server
    expectFileContains(projectRoot!, ".cursor/mcp.json", "c-mcp");
    // hooks.json：含 version:1、camelCase 事件名 preToolUse、项目相对命令路径
    expectFileContains(projectRoot!, ".cursor/hooks.json", '"version": 1');
    expectFileContains(projectRoot!, ".cursor/hooks.json", "preToolUse");
    expectFileContains(projectRoot!, ".cursor/hooks.json", ".cursor/hooks/c-hook/c-hook.sh");
  });

  it("claudecode: skill + rule + mcp(根 .mcp.json) + command + hook + agent 全部落盘", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("cc@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(assetBuilders.skill("cc-skill", ["claudecode"]));
    const rule = await api.createAsset(assetBuilders.rule("cc-rule", ["**/*.ts"], ["claudecode"]));
    const mcp = await api.createAsset(assetBuilders.mcp("cc-mcp", "npx fs", ["claudecode"]));
    const cmd = await api.createAsset(assetBuilders.command("cc-cmd", "/review", ["claudecode"]));
    const hook = await api.createAsset(assetBuilders.hook("cc-hook", "PreToolUse", ["claudecode"]));
    const agentAsset = await api.createAsset(assetBuilders.agent("cc-agent", ["claudecode"]));

    const ws = await api.createCapabilitySet(
      { name: "ws-cc", description: "claudecode test", targetTools: ["claudecode"], visibility: "public" },
      [skill.id, rule.id, mcp.id, cmd.id, hook.id, agentAsset.id],
    );

    await setup(server.baseUrl, token);

    await installAndAssert(ws.id, "claudecode", [
      ".claude/skills/cc-skill/SKILL.md",
      ".claude/rules/cc-rule.md",
      ".claude/commands/cc-cmd.md",
      ".claude/agents/cc-agent.md",
      // MCP: claudecode 写项目根 .mcp.json（不是 .claude/mcp.json）
      ".mcp.json",
    ], []);

    expectFileContains(projectRoot!, ".mcp.json", "cc-mcp");
    // hook 附属文件 + registry（registry 嵌 .claude/settings.json，非 hooks/hooks.json）
    expectFileExists(projectRoot!, ".claude/hooks/cc-hook/cc-hook.sh");
    expectFileExists(projectRoot!, ".claude/settings.json");
    expectFileContains(projectRoot!, ".claude/settings.json", "cc-hook");
    // skill 装上后 tracker 旁路注入到 .claude/settings.local.json（机器专属，与可共享 settings.json 分离）
    expectFileContains(projectRoot!, ".claude/settings.local.json", "skill-usage-tracker");
    // 旧路径 hooks/hooks.json 不应被 Claude Code 读取，故不再落盘
    expectFileNotExists(projectRoot!, ".claude/hooks/hooks.json");
  });

  it("codex: skill + rule + mcp + hook 落盘（command/agent 不支持）", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("codex@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(assetBuilders.skill("cx-skill", ["codex"]));
    const rule = await api.createAsset(assetBuilders.rule("cx-rule", ["**/*.ts"], ["codex"]));
    const mcp = await api.createAsset(assetBuilders.mcp("cx-mcp", "npx fs", ["codex"]));
    const hook = await api.createAsset(assetBuilders.hook("cx-hook", "PreToolUse", ["codex"]));
    const cmd = await api.createAsset(assetBuilders.command("cx-cmd", "/test", ["cursor"]));
    const agentAsset = await api.createAsset(assetBuilders.agent("cx-agent", ["codebuddy"]));

    const ws = await api.createCapabilitySet(
      { name: "ws-codex", description: "codex test", targetTools: ["codex"], visibility: "public" },
      [skill.id, rule.id, mcp.id, hook.id, cmd.id, agentAsset.id],
    );

    await setup(server.baseUrl, token);

    await installAndAssert(ws.id, "codex", [
      ".codex/skills/cx-skill/SKILL.md",
      ".codex/rules/cx-rule.md",
      ".codex/mcp.json",
    ], [
      // command / agent 不被 codex 支持
      ".codex/commands/cx-cmd.md",
      ".codex/agents/cx-agent.md",
    ]);

    // hook 附属文件 + registry
    expectFileExists(projectRoot!, ".codex/hooks/cx-hook/cx-hook.sh");
    expectFileExists(projectRoot!, ".codex/hooks.json");
  });
});
