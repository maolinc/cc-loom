/**
 * L3 /api/install/plan — sourcePath 透传到 adapter（真实 marketplace 导入）。
 *
 * 回归事故: buildPlan 曾漏传 sourcePath，导致 marketplace 目录式 skill
 * （skills/<name>/SKILL.md）被错装成扁平 .cursor/skills/<name>.md。
 *
 * L2 用 DB 直接插 sourcePath 造数据；L3 改用真实 marketplace git fixture 导入，
 * 资产自带 sourcePath，验证 DB → buildPlan → adapter 全链路透传。
 * 不变量: dir-layout skill 保留 <name>/ 目录（不退化扁平）；本地无 sourcePath 单文件
 *         rule 走扁平；hook 落 hooks/<name>/ + hooks.json。
 *
 * 注: adapter 路径规则的细粒度边界（sourcePath 带扩展名等脏数据）由 adapter-layout
 *      单元测试覆盖——真实导入不产生这类脏 sourcePath，此处只盯透传不丢的端到端不变量。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  startServer, stopServer, type ServerHandle, ApiClient,
  startAgent, stopAgent, type AgentHandle,
  makeProject, cleanupProject,
  createGitFixture, type GitFixture, FIXTURE_GENERIC,
} from "@maolinc/cc-loom-testkit";

describe("L3 install plan — sourcePath 透传", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;
  let fx: GitFixture | null;

  afterEach(async () => {
    fx?.dispose();
    fx = null;
    if (agent) await stopAgent(agent);
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  async function bootAndImport() {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("admin@loom.test", "test-admin-password");
    const token = await api.getCliToken();
    fx = createGitFixture(FIXTURE_GENERIC);
    await api.addMarketplace(fx.url);
    return token;
  }

  async function startProj(token: string) {
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl, token, projectRoot,
      isOnline: async () => (await api.listDevices()).some((d) => d.status === "online"),
    });
    return agent.projectId;
  }

  it("marketplace dir-layout skill 保留 <name>/ 目录（不退化扁平）", async () => {
    const token = await bootAndImport();
    const assets = await api.listAssets();
    const brainstorming = assets.find((a) => a.name === "Brainstorming");
    expect(brainstorming).toBeDefined();
    expect(brainstorming!.sourcePath).toBeTruthy();

    const ws = await api.createCapabilitySet(
      { name: "ws-plan", description: "x", targetTools: ["cursor"], visibility: "private" },
      [brainstorming!.id],
    );
    const projectId = await startProj(token);

    const plan = await api.installPlan({
      projectId, capabilitySetId: ws.id, targetTools: ["cursor"], policy: "auto",
    });
    const paths = plan.diff.map((e: any) => e.path);
    expect(paths).toContain(".cursor/skills/Brainstorming/SKILL.md");
    expect(paths).toContain(".cursor/skills/Brainstorming/examples/session.md");
    expect(paths).not.toContain(".cursor/skills/Brainstorming.md");
  });

  it("本地无 sourcePath 单文件 rule 走扁平", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("plan3@example.com");
    const token = await api.getCliToken();

    const rule = await api.createAsset({
      name: "my-rule", type: "rule", description: "x", tags: [],
      files: [{ path: "anything.md", content: "x" }],
      compatibleTools: ["cursor"], visibility: "public", metadata: { globs: ["**/*.ts"] },
    });
    const ws = await api.createCapabilitySet(
      { name: "ws-rule", description: "x", targetTools: ["cursor"], visibility: "private" },
      [rule.id],
    );
    const projectId = await startProj(token);

    const plan = await api.installPlan({
      projectId, capabilitySetId: ws.id, targetTools: ["cursor"], policy: "auto",
    });
    const paths = plan.diff.map((e: any) => e.path);
    expect(paths).toContain(".cursor/rules/my-rule.md");
  });

  it("hook 类型落 hooks/<name>/ + settings.json 的 hooks 字段（claudecode）", async () => {
    const token = await bootAndImport();
    const assets = await api.listAssets();
    const gitHint = assets.find((a: any) => a.name === "git-hint" && a.type === "hook");
    expect(gitHint).toBeDefined();

    const ws = await api.createCapabilitySet(
      { name: "ws-hook", description: "x", targetTools: ["claudecode"], visibility: "private" },
      [gitHint!.id],
    );
    const projectId = await startProj(token);

    const plan = await api.installPlan({
      projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto",
    });
    const paths = plan.diff.map((e: any) => e.path);
    expect(paths).toContain(".claude/hooks/git-hint/hint.sh");
    expect(paths).not.toContain(".claude/hooks/git-hint/hook.json");
    // Claude Code 项目级 hook 注册表嵌 .claude/settings.json 的 hooks 字段（非 hooks/hooks.json）
    expect(paths).toContain(".claude/settings.json");
    expect(paths.some((p: string) => p.endsWith("/hooks.json"))).toBe(false);
  });
});
