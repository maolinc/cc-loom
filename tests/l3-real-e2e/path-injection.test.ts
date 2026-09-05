/**
 * L3 path 鉴权注入（ADR-0003）。
 *
 * 真实 server + 真实 agent + 真实磁盘。验证：
 *  - MCP 资产声明 path 绑定 + 用户分发凭据到项目 → reconcile 后 .mcp.json 含注入的真实值。
 *  - 未分发时 .mcp.json 保留作者原始叶子（不注入）。
 *  - 取消分发 / 删值 → 回退作者原始叶子。
 *  - 非字符串叶子注入 → reconcile 失败，不写盘（决策 6）。
 *
 * tapd 场景：http MCP 的 headers.X-Tapd-Access-Token 内联 token。
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
  expectFileExists,
  expectFileContains,
} from "@maolinc/cc-loom-testkit";

const TAPD_SERVER_DEF = JSON.stringify({
  type: "http",
  url: "https://tapd.example.com/mcp",
  timeout: 20000,
  transportType: "streamable-http",
  headers: { "X-Tapd-Access-Token": "PLACEHOLDER" },
});

/**
 * wrapped 形态：mcpServers 内层 server key（tapd_mcp_http）与资产名（tapd-mcp）不同。
 * 复现真实坏场景：reconcile 曾用「资产名 === server key」匹配 path 绑定，wrapped 资产的
 * 注入被整体跳过，凭据值落不到 .mcp.json。
 */
const TAPD_WRAPPED_DEF = JSON.stringify({
  mcpServers: {
    tapd_mcp_http: {
      type: "http",
      url: "https://tapd.example.com/mcp",
      timeout: 20000,
      transportType: "streamable-http",
      headers: { "X-Tapd-Access-Token": "PLACEHOLDER" },
    },
  },
});

describe("L3 path auth injection", () => {
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
    await api.login("path-inject@example.com");
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


  /** 创建一个带 path 绑定的 tapd 风格 http MCP 资产。 */
  async function createTapdAsset(): Promise<string> {
    const asset = await api.createAsset({
      name: "tapd-mcp",
      type: "mcp",
      description: "tapd http mcp",
      tags: [],
      files: [{ path: "mcp.json", content: TAPD_SERVER_DEF }],
      compatibleTools: ["claudecode"],
      visibility: "public",
      metadata: { transport: "http" as const, url: "https://tapd.example.com/mcp" },
      auth: { bindings: [{ credentialName: "tapd-token", kind: "path", path: "headers/X-Tapd-Access-Token" }] },
    });
    return asset.id;
  }

  /** 创建 wrapped 形态（server key ≠ 资产名）的 tapd MCP 资产。 */
  async function createTapdWrappedAsset(): Promise<string> {
    const asset = await api.createAsset({
      name: "tapd-mcp",
      type: "mcp",
      description: "tapd http mcp (wrapped)",
      tags: [],
      files: [{ path: "mcp.json", content: TAPD_WRAPPED_DEF }],
      compatibleTools: ["claudecode"],
      visibility: "public",
      metadata: { transport: "http" as const, url: "https://tapd.example.com/mcp" },
      auth: { bindings: [{ credentialName: "tapd-token", kind: "path", path: "headers/X-Tapd-Access-Token" }] },
    });
    return asset.id;
  }

  it("分发凭据后 .mcp.json 含注入的真实值", async () => {
    const { projectId } = await setup();
    const assetId = await createTapdAsset();

    // 创建凭据值
    const cred = await api.createCredential("tapd-token", "tok_real_secret_123", "path");

    // path 分发到项目
    const dist = await api.distributeCredential(cred.id, "path", [projectId]);
    expect(dist.pushed).toHaveLength(1);

    // 安装该 MCP（capabilitySet 形态）
    const ws = await api.createCapabilitySet(
      { name: "tapd-ws", description: "ws", targetTools: ["claudecode"], visibility: "public" },
      [assetId],
    );
    const { result } = await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto",
    });
    expect(result.success).toBe(true);

    expectFileExists(projectRoot!, ".mcp.json");
    expectFileContains(projectRoot!, ".mcp.json", "tok_real_secret_123");
    // 占位符已被真实值替换
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const content = readFileSync(join(projectRoot!, ".mcp.json"), "utf-8");
    expect(content).not.toContain("PLACEHOLDER");
  });

  it("wrapped 资产（server key ≠ 资产名）分发凭据后注入真实值", async () => {
    const { projectId } = await setup();
    const assetId = await createTapdWrappedAsset();

    const cred = await api.createCredential("tapd-token", "tok_wrapped_secret_456", "path");
    const dist = await api.distributeCredential(cred.id, "path", [projectId]);
    expect(dist.pushed).toHaveLength(1);

    const ws = await api.createCapabilitySet(
      { name: "tapd-ws-wrapped", description: "ws", targetTools: ["claudecode"], visibility: "public" },
      [assetId],
    );
    const { result } = await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto",
    });
    expect(result.success).toBe(true);

    expectFileExists(projectRoot!, ".mcp.json");
    // server key 仍是内层 key（资产名 tapd-mcp ≠ server key tapd_mcp_http）——聚合构建本身正常
    expectFileContains(projectRoot!, ".mcp.json", "tapd_mcp_http");
    // 真实 token 已注入到内层 server def 的 header（曾因 name≠key 匹配失败而跳过）
    expectFileContains(projectRoot!, ".mcp.json", "tok_wrapped_secret_456");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const content = readFileSync(join(projectRoot!, ".mcp.json"), "utf-8");
    expect(content).not.toContain("PLACEHOLDER");
  });

  it("未分发凭据时 .mcp.json 保留作者占位符", async () => {
    const { projectId } = await setup();
    const assetId = await createTapdAsset();
    // 不创建凭据、不分发，直接安装
    const ws = await api.createCapabilitySet(
      { name: "tapd-ws2", description: "ws", targetTools: ["claudecode"], visibility: "public" },
      [assetId],
    );
    const { result } = await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto",
    });
    expect(result.success).toBe(true);

    expectFileContains(projectRoot!, ".mcp.json", "PLACEHOLDER");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const content = readFileSync(join(projectRoot!, ".mcp.json"), "utf-8");
    expect(content).not.toContain("tok_real");
  });

  it("取消分发后回退作者原始叶子", async () => {
    const { projectId } = await setup();
    const assetId = await createTapdAsset();
    const cred = await api.createCredential("tapd-token", "tok_rotate_me", "path");
    await api.distributeCredential(cred.id, "path", [projectId]);

    const ws = await api.createCapabilitySet(
      { name: "tapd-ws3", description: "ws", targetTools: ["claudecode"], visibility: "public" },
      [assetId],
    );
    await api.installExecute({ projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto" });
    expectFileContains(projectRoot!, ".mcp.json", "tok_rotate_me");

    // 取消 path 分发 → re-enqueue 回退作者叶子
    await api.revokeCredential(cred.id, "path", projectId);
    // 等待 re-enqueue 落盘：轮询直到占位符回归
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    let reverted = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const content = readFileSync(join(projectRoot!, ".mcp.json"), "utf-8");
        if (content.includes("PLACEHOLDER") && !content.includes("tok_rotate_me")) {
          reverted = true;
          break;
        }
      } catch { /* 文件可能正在重写 */ }
    }
    expect(reverted).toBe(true);
  });

  it("更新凭据值后轮换到新值", async () => {
    const { projectId } = await setup();
    const assetId = await createTapdAsset();
    const cred = await api.createCredential("tapd-token", "tok_v1", "path");
    await api.distributeCredential(cred.id, "path", [projectId]);

    const ws = await api.createCapabilitySet(
      { name: "tapd-ws4", description: "ws", targetTools: ["claudecode"], visibility: "public" },
      [assetId],
    );
    await api.installExecute({ projectId, capabilitySetId: ws.id, targetTools: ["claudecode"], policy: "auto" });
    expectFileContains(projectRoot!, ".mcp.json", "tok_v1");

    // 更新值 → 轮换
    await api.updateCredential(cred.id, { value: "tok_v2" });
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    let rotated = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const content = readFileSync(join(projectRoot!, ".mcp.json"), "utf-8");
        if (content.includes("tok_v2") && !content.includes("tok_v1")) {
          rotated = true;
          break;
        }
      } catch { /* */ }
    }
    expect(rotated).toBe(true);
  });
});
