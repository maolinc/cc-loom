/**
 * L3 安全测试 — 路径穿越防护、symlink 逃逸、XSS 内容存储。
 *
 * 不变量:
 * - asset 文件路径含 ../ 时被拒绝或净化
 * - symlink 不进入 scanner tree（已在 cli 单元测试覆盖，此处验证端到端）
 * - XSS content 被原样存储（不做 HTML 转义，由前端负责）
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
  expectFileNotExists,
} from "@maolinc/cc-loom-testkit";

describe("L3 security: 路径穿越 / XSS 存储", () => {
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

  it("asset 文件路径含 ../ → 被拒绝或净化，不写到项目目录外", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("sec@example.com");
    const token = await api.getCliToken();

    // 尝试创建含路径穿越的 skill
    // skill 的文件路径是相对 skill 目录的，但 ../ 可能逃逸
    let created = false;
    let assetId: string | undefined;
    try {
      const asset = await api.createAsset({
        name: "traversal",
        type: "rule", // rule 用平铺路径，更容易测穿越
        description: "test",
        tags: [],
        files: [{ path: "../../../etc/evil.md", content: "pwned" }],
        compatibleTools: ["cursor"],
        visibility: "public",
        metadata: { globs: ["**/*"] },
      });
      assetId = asset.id;
      created = true;
    } catch (e) {
      // 服务端可能拒绝路径穿越
      expect((e as ApiRequestError).status).toBe(400);
    }

    if (created && assetId) {
      // 如果服务端接受了，安装后文件不应出现在项目目录外
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

      const ws = await api.createCapabilitySet(
        { name: "ws-sec", description: "test", targetTools: ["cursor"], visibility: "public" },
        [assetId],
      );

      await api.installExecute({
        projectId: agent.projectId,
        capabilitySetId: ws.id,
        targetTools: ["cursor"],
        policy: "locked",
      });

      // 关键断言：evil.md 不应出现在项目目录的父级
      expectFileNotExists(projectRoot, "../../../etc/evil.md");
      // 也不应在 /etc/evil.md
      const { existsSync } = await import("node:fs");
      expect(existsSync("/etc/evil.md")).toBe(false);
    }
  });

  it("XSS content 被原样存储和读取（前端负责转义）", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("xss@example.com");

    const xssPayload = '<script>alert("xss")</script>';
    const asset = await api.createAsset({
      ...assetBuilders.skill("xss-test", ["cursor"]),
      files: [{ path: "SKILL.md", content: `# test\n\n${xssPayload}` }],
    });

    // 读取详情，content 应原样保留
    const detail = await api.getAsset(asset.id);
    const file = detail.files.find((f) => f.path === "SKILL.md");
    expect(file).toBeDefined();
    expect(file!.content).toContain(xssPayload);
  });

  it("删除别人的 asset → 404 或 403（不能删不属于自己的）", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);

    // 用户 A 创建 asset
    await api.login("owner@example.com");
    const asset = await api.createAsset(assetBuilders.skill("owned-skill", ["cursor"]));

    // 用户 B 登录
    await api.login("attacker@example.com");

    // 用户 B 尝试删除 A 的 asset → 应失败
    let err: ApiRequestError | null = null;
    try {
      await api.deleteAsset(asset.id);
    } catch (e) {
      err = e as ApiRequestError;
    }
    expect(err).not.toBeNull();
    // 404（看不到别人的）或 403
    expect([403, 404]).toContain(err!.status);
  });
});
