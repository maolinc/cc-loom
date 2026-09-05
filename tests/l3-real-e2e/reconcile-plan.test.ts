/**
 * L3 reconcileProject 不变量 — 走真实 server + agent + WS + 磁盘。
 *
 * 迁移自原 L1 `packages/server/src/__tests__/reconcile-plan.test.ts`（直接读写 DB）。
 * L3 改走可观测出口：HTTP（install/execute、capabilities/toggle、targets）+ 磁盘文件
 * + lock 文件断言，不直查 DB、不手搓 seed。
 *
 * 覆盖：
 *  - 项目不存在 → install/plan 404。
 *  - 单 skill 安装 → enabled 落盘 + lock vendor.enabled=true。
 *  - removed = 上次账本 - 当前 plan：切换能力集 → 旧能力集独有 asset 文件被删。
 *  - toggle off 单 vendor → 该 vendor 文件移除、lock 标 disabled，asset 仍在 lock。
 *  - toggle off 全部 vendor → asset 主目录文件全部移除。
 *  - mcp 聚合：3 个 mcp + 1 个 toggle off → .mcp.json 仅含 2 个 server。
 *  - 能力集软删 → 触发 reconcile 后文件被移除、lock capabilitySetId=null、assets 清空。
 *
 * 未迁移（HTTP 不可构造）：
 *  - 「私有 asset 非作者过滤」：API 层不允许把他人 private asset 加入能力集，
 *    危险状态在入口即被阻断，内部过滤属防御性兜底，L3 无可观测出口。
 *  - 「空能力集 per-tool 空聚合结构」：聚合 payload 结构非磁盘可观测，L3 不再细测。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  startServer, stopServer, type ServerHandle,
  startAgent, stopAgent, type AgentHandle,
  makeProject, cleanupProject,
  ApiClient, assetBuilders,
  expectFileExists, expectFileNotExists,
  expectLock, expectLockVendorState, readLock,
} from "@maolinc/cc-loom-testkit";
import { request } from "./_http.js";

describe("L3 reconcileProject 不变量", () => {
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

  async function boot(email = "rec@example.com"): Promise<{ projectId: string; token: string }> {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login(email);
    const token = await api.getCliToken();
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl, token, projectRoot,
      isOnline: async () => (await api.listDevices()).some((d) => d.status === "online"),
    });
    return { projectId: agent.projectId, token };
  }

  /**
   * 同步触发一次 reconcile：POST /targets 用同一组厂商 → enqueueReconcileAndWait 等 CLI 落盘。
   * 比 sync-policy（fire-and-forget）更确定，避免读 lock 时 reconcile 未完成。
   */
  async function triggerReconcile(projectId: string, targets: string[] = ["claudecode"]): Promise<void> {
    const res = await request(server.baseUrl, "POST", `/api/projects/${projectId}/targets`, {
      cookie: api.getCookie()!, body: { targets },
    });
    expect(res.status).toBe(200);
  }

  it("项目不存在 → install/plan 404", async () => {
    await boot();
    await expect(
      api.installPlan({ projectId: "nope", capabilitySetId: "nope", targetTools: ["claudecode"], policy: "auto" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("单 skill 安装 → enabled 落盘 + lock vendor.enabled=true", async () => {
    const { projectId } = await boot();
    const skill = await api.createAsset(assetBuilders.skill("my-skill", ["claudecode"]));
    const ws = await api.createCapabilitySet(
      { name: "ws", description: "x", targetTools: ["claudecode"], visibility: "public" },
      [skill.id],
    );
    const { result } = await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto",
    });
    expect(result.success).toBe(true);
    expectFileExists(projectRoot!, ".claude/skills/my-skill/SKILL.md");
    expectLock(projectId, { capabilitySetId: ws.id, policy: "auto" });
    expectLockVendorState(projectId, skill.id, "claudecode", true);
  });

  it("removed = 上次账本 - 当前 plan：卸载订阅 → 其独有 asset 被删、共享 asset 保留（ADR-0006）", async () => {
    const { projectId } = await boot();
    const a = await api.createAsset(assetBuilders.skill("keep-skill", ["claudecode"]));
    const b = await api.createAsset(assetBuilders.skill("drop-skill", ["claudecode"]));
    const ws1 = await api.createCapabilitySet(
      { name: "ws1", description: "x", targetTools: ["claudecode"], visibility: "public" },
      [a.id, b.id],
    );
    const ws2 = await api.createCapabilitySet(
      { name: "ws2", description: "x", targetTools: ["claudecode"], visibility: "public" },
      [a.id],
    );

    await api.installExecute({ projectId, capabilitySetId: ws1.id, targetTools: ["claudecode"], policy: "auto" });
    expectFileExists(projectRoot!, ".claude/skills/drop-skill/SKILL.md");

    // 多订阅叠加：装 ws2 不再顶替 ws1，drop-skill 仍在
    await api.installExecute({ projectId, capabilitySetId: ws2.id, targetTools: ["claudecode"], policy: "auto" });
    expectFileExists(projectRoot!, ".claude/skills/keep-skill/SKILL.md");
    expectFileExists(projectRoot!, ".claude/skills/drop-skill/SKILL.md");
    expectLock(projectId, { capabilitySetId: ws2.id });

    // 卸载 ws1：其独有的 drop-skill 被删；keep-skill 仍被 ws2 引用而保留
    await api.unsubscribeCapabilitySet(projectId, ws1.id);
    expectFileExists(projectRoot!, ".claude/skills/keep-skill/SKILL.md");
    expectFileNotExists(projectRoot!, ".claude/skills/drop-skill/SKILL.md");
  });

  it("toggle off 单 vendor → 该 vendor 文件移除、lock disabled，asset 仍在 lock", async () => {
    const { projectId } = await boot();
    const skill = await api.createAsset(assetBuilders.skill("multi-skill", ["claudecode", "cursor"]));
    const ws = await api.createCapabilitySet(
      { name: "ws", description: "x", targetTools: ["claudecode", "cursor"], visibility: "public" },
      [skill.id],
    );
    await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["claudecode", "cursor"], policy: "auto",
    });
    expectFileExists(projectRoot!, ".claude/skills/multi-skill/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/multi-skill/SKILL.md");

    await api.toggleCapability(projectId, { assetId: skill.id, tool: "cursor", enabled: false });

    expectFileExists(projectRoot!, ".claude/skills/multi-skill/SKILL.md");
    expectFileNotExists(projectRoot!, ".cursor/skills/multi-skill/SKILL.md");
    expectLockVendorState(projectId, skill.id, "claudecode", true);
    expectLockVendorState(projectId, skill.id, "cursor", false);
  });

  it("toggle off 全部 vendor → asset 主目录文件全部移除", async () => {
    const { projectId } = await boot();
    const skill = await api.createAsset(assetBuilders.skill("all-off-skill", ["claudecode"]));
    const ws = await api.createCapabilitySet(
      { name: "ws", description: "x", targetTools: ["claudecode"], visibility: "public" },
      [skill.id],
    );
    await api.installExecute({ projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto" });
    expectFileExists(projectRoot!, ".claude/skills/all-off-skill/SKILL.md");

    await api.toggleCapability(projectId, { assetId: skill.id, tool: "claudecode", enabled: false });

    expectFileNotExists(projectRoot!, ".claude/skills/all-off-skill/SKILL.md");
    expectLockVendorState(projectId, skill.id, "claudecode", false);
  });

  it("mcp 聚合：3 个 mcp + 1 个 toggle off → .mcp.json 仅含 2 个 server", async () => {
    const { projectId } = await boot();
    const mcp1 = await api.createAsset(assetBuilders.mcp("mcp1", "cmd1", ["claudecode"]));
    const mcp2 = await api.createAsset(assetBuilders.mcp("mcp2", "cmd2", ["claudecode"]));
    const mcp3 = await api.createAsset(assetBuilders.mcp("mcp3", "cmd3", ["claudecode"]));
    const ws = await api.createCapabilitySet(
      { name: "ws", description: "x", targetTools: ["claudecode"], visibility: "public" },
      [mcp1.id, mcp2.id, mcp3.id],
    );
    await api.installExecute({ projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto" });

    const mcpPath = `${projectRoot!}/.mcp.json`;
    expect(existsSync(mcpPath)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers).sort()).toEqual(
      ["mcp1", "mcp2", "mcp3"],
    );

    await api.toggleCapability(projectId, { assetId: mcp2.id, tool: "claudecode", enabled: false });

    const servers = Object.keys(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers).sort();
    expect(servers).toEqual(["mcp1", "mcp3"]);
  });

  it("能力集软删 → 触发 reconcile 后文件被移除、lock assets 清空、订阅留存", async () => {
    const { projectId } = await boot();
    const skill = await api.createAsset(assetBuilders.skill("del-skill", ["claudecode"]));
    const ws = await api.createCapabilitySet(
      { name: "ws", description: "x", targetTools: ["claudecode"], visibility: "public" },
      [skill.id],
    );
    await api.installExecute({ projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto" });
    expectFileExists(projectRoot!, ".claude/skills/del-skill/SKILL.md");

    // 被项目安装引用 → 软删（留存）；删除本身不触发 reconcile
    await api.deleteCapabilitySet(ws.id);
    expectFileExists(projectRoot!, ".claude/skills/del-skill/SKILL.md");

    // 主动触发一次同步 reconcile（targets 走 enqueueReconcileAndWait 等 CLI 落盘）
    await triggerReconcile(projectId, ["claudecode"]);

    expectFileNotExists(projectRoot!, ".claude/skills/del-skill/SKILL.md");
    const lock = readLock(projectId);
    expect(lock).not.toBeNull();
    // 软删（留存）能力集的成员不再落盘，但订阅关系保留（UI 展示「已下架·留存」徽标）
    expect(lock!.assets).toEqual({});
    expect(lock!.subscriptions?.some((s) => s.capabilitySetId === ws.id)).toBe(true);
  });

  /**
   * 工具从订阅 targetTools 退出时，该厂商聚合文件中：
   *  - Loom owned 条目被清掉（dropped 厂商仍 emit 清理聚合）
   *  - 用户手写 foreign 条目保留（不整文件删除）
   * 回归：此前 dropped 厂商无 adapter → 聚合文件被 orphan 整文件删，foreign 丢失。
   */
  it("厂商退出 effectiveTools：清 owned、留 foreign，不整文件删", async () => {
    const { projectId } = await boot();
    const mcp = await api.createAsset(assetBuilders.mcp("cursor-mcp", "cmd1", ["cursor"]));
    const ws = await api.createCapabilitySet(
      { name: "ws", description: "x", targetTools: ["cursor", "claudecode"], visibility: "public" },
      [mcp.id],
    );
    await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["cursor", "claudecode"], policy: "auto",
    });
    const mcpPath = `${projectRoot!}/.cursor/mcp.json`;
    expect(existsSync(mcpPath)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers)).toEqual(["cursor-mcp"]);

    // 用户手写 foreign server 进同一文件
    const withForeign = JSON.parse(readFileSync(mcpPath, "utf8"));
    withForeign.mcpServers["user-srv"] = { command: "user-foreign" };
    writeFileSync(mcpPath, JSON.stringify(withForeign, null, 2));

    // 收窄该订阅的 targetTools：cursor 退出（只保留 claudecode）
    await api.setSubscriptionTargets(projectId, ws.id, ["claudecode"]);

    // owned "cursor-mcp" 被清；foreign "user-srv" 保留；文件仍在
    expect(existsSync(mcpPath)).toBe(true);
    const servers = Object.keys(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers).sort();
    expect(servers).toEqual(["user-srv"]);
  });
});
