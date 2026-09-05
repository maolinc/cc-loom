/**
 * L3 两视图一致性 — 能力视图（state.capabilities）与厂商视图
 * （state.vendors[tool].tree + managedAssetCount/externalCount）必须共用同一份真值。
 *
 * 走真实链路：server reconcile → CLI 写 lock（含 serverKeys）→ scanner cell 模型 →
 * 两个视图投影。覆盖三个真实场景：
 *  1. 多 wrapped MCP 跨厂商：资产名 ≠ server key，两视图对齐、不串行、不重复行。
 *  2. external adopt 后：厂商/能力视图的 external 计数与开关一致，无幽灵行。
 *  3. disabled MCP：能力行开关 = 磁盘真实状态，re-enable 后两视图同步恢复。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
  type AssetCreateInput,
} from "@maolinc/cc-loom-testkit";
import type { LocalProjectState, TargetTool } from "@maolinc/cc-loom-shared";

const TOOLS: TargetTool[] = ["cursor", "claudecode"];

/** 构造 wrapped MCP 资产：资产名 ≠ 内层 server key。 */
function wrappedMcpAsset(
  name: string,
  serverKey: string,
  tools: TargetTool[],
): AssetCreateInput {
  return {
    name,
    type: "mcp",
    description: `wrapped mcp ${name}`,
    tags: ["test"],
    files: [
      {
        path: "config.json",
        content: JSON.stringify({ mcpServers: { [serverKey]: { type: "http", url: `https://${serverKey}.example/x` } } }),
      },
    ],
    compatibleTools: tools as any,
    visibility: "public",
    metadata: { transport: "http" as const, url: `https://${serverKey}.example/x` },
  };
}

function readMcpServers(root: string, rel: string): Record<string, unknown> {
  const abs = join(root, rel);
  if (!existsSync(abs)) return {};
  const parsed = JSON.parse(readFileSync(abs, "utf-8")) as { mcpServers?: Record<string, unknown> };
  return parsed.mcpServers ?? {};
}

/** 跨视图一致性断言（counts + 无幽灵 external 行）。 */
function assertConsistency(state: LocalProjectState, tools: TargetTool[]) {
  const caps = state.capabilities ?? [];
  // 无重复 (type, name)
  const names = caps.map((c) => `${c.type}:${c.name}`);
  expect(new Set(names).size).toBe(caps.length);
  for (const tool of tools) {
    const vm = state.vendors[tool];
    if (!vm?.exists) continue;
    const rows = caps.filter((c) => c.vendors[tool]);
    const ext = rows.filter((c) => c.vendors[tool]!.external).length;
    expect(vm.externalCount).toBe(ext);
    expect(vm.managedAssetCount).toBe(rows.length - ext);
    expect(vm.managedAssetCount + vm.externalCount).toBe(rows.length);
  }
}

describe("L3 view-consistency: 能力视图与厂商视图同源", () => {
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

  async function setup(): Promise<{ projectId: string }> {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("viewconsistency@example.com");
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
    return { projectId: agent.projectId };
  }

  it("多 wrapped MCP 跨厂商：资产名 ≠ server key，两视图对齐、不串行", async () => {
    const { projectId } = await setup();
    const a = await api.createAsset(wrappedMcpAsset("mcp_a", "svc_a", TOOLS));
    const b = await api.createAsset(wrappedMcpAsset("mcp_b", "svc_b", TOOLS));
    const ws = await api.createCapabilitySet(
      { name: "ws", description: "ws", targetTools: TOOLS, visibility: "public" },
      [a.id, b.id],
    );
    const { result } = await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: TOOLS, policy: "auto",
    });
    expect(result.success).toBe(true);

    const state = await api.scanState(projectId);
    assertConsistency(state, TOOLS);

    // 能力视图：恰好两行受管 MCP（按资产名），无 external 幽灵行
    const mcps = (state.capabilities ?? []).filter((c) => c.type === "mcp");
    expect(mcps.map((c) => c.name).sort()).toEqual(["mcp_a", "mcp_b"]);
    expect(mcps.every((c) => !c.external)).toBe(true);

    // 厂商视图：mcp.json 的 server 子节点 assetId 与资产正确对应（不串行）
    for (const tool of TOOLS) {
      const vm = state.vendors[tool]!;
      const mcpFile = tool === "claudecode" ? ".mcp.json" : ".cursor/mcp.json";
      const mcpNode = vm.tree.find((n) => n.path === mcpFile);
      const children = mcpNode?.children ?? [];
      const svcA = children.find((c) => c.name === "svc_a");
      const svcB = children.find((c) => c.name === "svc_b");
      expect(svcA?.assetId).toBe(a.id);
      expect(svcB?.assetId).toBe(b.id);
      expect(svcA?.managed).toBe(true);
      expect(svcB?.managed).toBe(true);
      // 两视图计数一致：cursor / claudecode 各 2 项受管、0 外部
      expect(vm.managedAssetCount).toBe(2);
      expect(vm.externalCount).toBe(0);
    }
  });

  it("external adopt 后：external 计数与开关在两视图一致，无幽灵行", async () => {
    const { projectId } = await setup();
    // 预置：用户手写 .mcp.json 含 foreign server pencil（将被 adopt）
    writeFileSync(
      join(projectRoot!, ".mcp.json"),
      JSON.stringify({ mcpServers: { pencil: { command: "npx-pencil" } } }, null, 2),
    );
    // 安装一个受管 wrapped MCP（server key svc_a）
    const a = await api.createAsset(wrappedMcpAsset("mcp_a", "svc_a", ["claudecode"]));
    const ws = await api.createCapabilitySet(
      { name: "ws", description: "ws", targetTools: ["claudecode"], visibility: "public" },
      [a.id],
    );
    await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto",
    });

    // 安装后：受管 mcp_a + 外部 pencil 共存于同一 .mcp.json
    let state = await api.scanState(projectId);
    assertConsistency(state, ["claudecode"]);
    let mcps = (state.capabilities ?? []).filter((c) => c.type === "mcp");
    expect(mcps.map((c) => c.name).sort()).toEqual(["mcp_a", "pencil"]);
    expect(state.vendors.claudecode!.externalCount).toBe(1);
    expect(state.vendors.claudecode!.managedAssetCount).toBe(1);

    // toggle off 外部 pencil（adopt + disable）
    const off = await api.toggleCapability(projectId, {
      assetId: "external:mcp:pencil",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: "pencil", type: "mcp", files: [".mcp.json"] },
    });
    expect(off.adoptedAssetId).toBeTruthy();

    state = await api.scanState(projectId);
    assertConsistency(state, ["claudecode"]);
    // pencil 转为受管关闭：一行，enabled=false，无 external:pencil 幽灵
    mcps = (state.capabilities ?? []).filter((c) => c.type === "mcp");
    expect(mcps.some((c) => c.assetId === "external:mcp:pencil")).toBe(false);
    const pencil = mcps.find((c) => c.name === "pencil")!;
    expect(pencil).toBeTruthy();
    expect(pencil.external ?? false).toBe(false);
    expect(pencil.vendors.claudecode?.enabled).toBe(false);
    // 外部计数归零（pencil 已受管），受管计数仍含两个能力
    expect(state.vendors.claudecode!.externalCount).toBe(0);
    expect(state.vendors.claudecode!.managedAssetCount).toBe(2);
    // 磁盘：pencil 已从 .mcp.json 移除，svc_a 保留
    const servers = readMcpServers(projectRoot!, ".mcp.json");
    expect(Object.keys(servers).sort()).toEqual(["svc_a"]);
  });

  it("disabled MCP：能力行开关 = 磁盘真实状态；re-enable 后两视图同步恢复", async () => {
    const { projectId } = await setup();
    const a = await api.createAsset(wrappedMcpAsset("mcp_a", "svc_a", ["claudecode"]));
    const ws = await api.createCapabilitySet(
      { name: "ws", description: "ws", targetTools: ["claudecode"], visibility: "public" },
      [a.id],
    );
    await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto",
    });

    // 初始：受管 enabled
    let state = await api.scanState(projectId);
    let cap = state.capabilities!.find((c) => c.type === "mcp")!;
    expect(cap.vendors.claudecode?.enabled).toBe(true);
    expect(readMcpServers(projectRoot!, ".mcp.json")["svc_a"]).toBeTruthy();

    // toggle OFF → 能力行 enabled=false，磁盘移除 svc_a
    await api.toggleCapability(projectId, {
      assetId: a.id, tool: "claudecode", enabled: false,
    });
    state = await api.scanState(projectId);
    assertConsistency(state, ["claudecode"]);
    cap = state.capabilities!.find((c) => c.assetId === a.id)!;
    expect(cap.vendors.claudecode?.enabled).toBe(false);
    // 磁盘真实状态：server 已移除（开关 off = 不在磁盘）
    expect(readMcpServers(projectRoot!, ".mcp.json")["svc_a"]).toBeUndefined();
    // 仍是受管能力（关闭中），不变成 external
    expect(cap.external ?? false).toBe(false);
    expect(state.vendors.claudecode!.externalCount).toBe(0);

    // toggle ON → 恢复，两视图同步
    await api.toggleCapability(projectId, {
      assetId: a.id, tool: "claudecode", enabled: true,
    });
    state = await api.scanState(projectId);
    assertConsistency(state, ["claudecode"]);
    cap = state.capabilities!.find((c) => c.assetId === a.id)!;
    expect(cap.vendors.claudecode?.enabled).toBe(true);
    expect(readMcpServers(projectRoot!, ".mcp.json")["svc_a"]).toBeTruthy();
    // 厂商树 mcp-server 子节点恢复 managed + assetId
    const mcpNode = state.vendors.claudecode!.tree.find((n) => n.path === ".mcp.json");
    const svcA = (mcpNode?.children ?? []).find((c) => c.name === "svc_a");
    expect(svcA?.assetId).toBe(a.id);
    expect(svcA?.enabled).toBe(true);
  });
});
