/**
 * L3 边界测试 — 大内容、分页边界、并发创建。
 *
 * 不变量:
 * - >1MB content 的 asset 能正常创建和安装
 * - 分页 page 超出范围返回空数组（不报错）
 * - 并发创建同名 workspace → 恰好一个成功，另一个 409
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
  ApiRequestError,
  assetBuilders,
  expectFileExists,
} from "@maolinc/cc-loom-testkit";

describe("L3 boundary: 大内容 / 分页 / 并发", () => {
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

  it(">1MB content 的 skill 能创建和安装", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("big@example.com");
    const token = await api.getCliToken();

    // 生成 ~1.5MB 的 SKILL.md 内容
    const bigContent = "# big-skill\n\n" + "x".repeat(1_500_000);
    const skill = await api.createAsset({
      name: "big-skill",
      type: "skill",
      description: "large content test",
      tags: ["test"],
      files: [{ path: "SKILL.md", content: bigContent }],
      compatibleTools: ["cursor"],
      visibility: "public",
      metadata: {},
    });
    expect(skill.id).toBeDefined();

    // 安装并验证磁盘文件大小
    const ws = await api.createWorkspace(
      { name: "ws-big", description: "big", targetTools: ["cursor"], visibility: "public" },
      [skill.id],
    );

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

    const { result } = await api.installExecute({
      projectId: agent.projectId,
      workspaceId: ws.id,
      targetTools: ["cursor"],
      policy: "locked",
    });
    expect(result.success).toBe(true);
    expectFileExists(projectRoot, ".cursor/skills/big-skill/SKILL.md");

    // 验证内容长度
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const written = readFileSync(join(projectRoot, ".cursor/skills/big-skill/SKILL.md"), "utf-8");
    expect(written.length).toBe(bigContent.length);
  });

  it("分页 page 超出范围 → 空数组不报错", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("page@example.com");

    // 创建 1 个 asset
    await api.createAsset(assetBuilders.skill("page-skill", ["cursor"]));

    // page=100 远超范围 → 空数组
    const res = await fetch(`${server.baseUrl}/api/assets?page=100&pageSize=20`, {
      headers: { cookie: api["cookie" as keyof ApiClient] as string },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("并发创建同名 workspace → 恰好一个成功，另一个 409", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("concurrent@example.com");

    // 并发发起两个同名 workspace 创建请求
    const wsInput = {
      name: "concurrent-ws",
      description: "concurrent test",
      targetTools: ["cursor"],
      visibility: "public",
    };

    const results = await Promise.allSettled([
      api.createWorkspace(wsInput),
      api.createWorkspace(wsInput),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // 恰好一个成功，一个被拒（409）
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as ApiRequestError;
    expect(err.status).toBe(409);
  });
});
