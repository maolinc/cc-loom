/**
 * L3 token 生命周期 — 重生成 token 后旧 token 失效，新 token 可用。
 *
 * 不变量（产品文档 §3.2）:
 * - POST /api/auth/cli-token/regenerate 后旧 token 无法通过认证
 * - 新 token 可以 login + start
 *
 * 注意: 重生成 token 不会主动断开已有 WebSocket（连接保持直到自然断开）。
 * 因此测试策略: 停旧 agent → 旧 token 重新 login 失败 → 新 token login 成功 → 重连。
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
} from "@maolinc/cc-loom-testkit";

describe("L3 token-lifecycle: 重生成 token 后旧 token 失效", () => {
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

  it("旧 token 启动 agent → 重生成 → 旧 token login 失败 → 新 token 可用", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("token@example.com");
    const oldToken = await api.getCliToken();

    // 1. 旧 token 启动 agent → 设备 online
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl,
      token: oldToken,
      projectRoot,
      isOnline: async () => {
        const devices = await api.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });
    expect(agent.projectId).toBeDefined();

    // 2. 重生成 token
    const regenRes = await api.post<{ token: string }>("/api/auth/cli-token/regenerate", {});
    const newToken = regenRes.token;
    expect(newToken).not.toBe(oldToken);

    // 3. 停旧 agent
    await stopAgent(agent);
    agent = null;

    // 4. 旧 token 重新 login → 必须失败（401）
    let oldLoginFailed = false;
    try {
      await runCli(["login", "--endpoint", server.baseUrl, "--token", oldToken, "--force"]);
    } catch {
      oldLoginFailed = true;
    }
    expect(oldLoginFailed).toBe(true);

    // 5. 新 token login → 成功
    await runCli(["login", "--endpoint", server.baseUrl, "--token", newToken, "--force"]);

    // 6. 新 token 启动 agent → 设备恢复 online
    await runCli(["start", "--force"], { timeout: 15000 });

    // 等待设备 online
    let online = false;
    for (let i = 0; i < 40; i++) {
      const devices = await api.listDevices();
      if (devices.some((d) => d.status === "online")) {
        online = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(online).toBe(true);

    // 7. 旧 token 调 API → 401
    api.setToken(oldToken);
    let oldApiFailed = false;
    try {
      await api.listDevices();
    } catch {
      oldApiFailed = true;
    }
    expect(oldApiFailed).toBe(true);
  });
});
