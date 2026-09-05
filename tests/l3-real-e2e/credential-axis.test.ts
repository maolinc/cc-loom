/**
 * L3 凭据轴定型（ADR-0004）：一凭据一轴，禁止跨轴分发。
 *
 * 不变量：
 * - env 轴凭据分发到项目（axis=path）→ 400（环境变量凭据只能下发到设备）。
 * - path 轴凭据下发到设备（axis=env）→ 400（MCP 路径凭据只能分发到项目）。
 *
 * 真实性：guard 在 server 路由层拦截，发生在任何设备/项目校验之前。用真实在线设备
 * + 真实项目作为 targetId，使回归信号明确——若 guard 被移除，分发会真正成功
 * （而非因 targetId 非法而 400），测试从而失败。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
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
} from "@maolinc/cc-loom-testkit";

function rcFilePath(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return join(homedir(), ".zshrc");
  return join(homedir(), ".bashrc");
}

describe("L3 credential axis: 禁止跨轴分发", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;
  const rcBackupPath = `${rcFilePath()}.loom-test.bak`;

  beforeEach(() => {
    agent = null;
    projectRoot = null;
    if (existsSync(rcFilePath())) writeFileSync(rcBackupPath, readFileSync(rcFilePath()));
  });

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
    const rc = rcFilePath();
    if (existsSync(rcBackupPath)) {
      writeFileSync(rc, readFileSync(rcBackupPath));
      rmSync(rcBackupPath);
    } else if (existsSync(rc)) {
      rmSync(rc, { force: true });
    }
  });

  it("env 凭据不可分发到项目；path 凭据不可下发到设备", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("axis@example.com");
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

    const devices = await api.listDevices();
    const online = devices.find((d) => d.status === "online");
    expect(online).toBeDefined();
    const projectId = agent.projectId;

    // env 轴凭据 → 尝试 path 分发到项目 → 400
    const envCred = await api.createCredential("ENV_AXIS_TOKEN", "v", "env");
    await expect(api.distributeCredential(envCred.id, "path", [projectId])).rejects.toMatchObject({
      status: 400,
    });

    // path 轴凭据 → 尝试 env 下发到设备 → 400
    const pathCred = await api.createCredential("PATH_AXIS_TOKEN", "v", "path");
    await expect(api.distributeCredential(pathCred.id, "env", [online!.id])).rejects.toMatchObject({
      status: 400,
    });

    // 同轴分发仍正常（正向路径不被误伤）
    const dist = await api.distributeCredential(envCred.id, "env", [online!.id]);
    expect(dist.pushed).toContain(online!.id);
  });

  it("创建凭据时 axis 落库并在列表返回", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("axis-list@example.com");

    await api.createCredential("ENV_LIST_TOKEN", "v", "env");
    await api.createCredential("PATH_LIST_TOKEN", "v", "path");

    const list = await api.listCredentials();
    const env = list.find((c) => c.name === "ENV_LIST_TOKEN");
    const path = list.find((c) => c.name === "PATH_LIST_TOKEN");
    expect(env?.axis).toBe("env");
    expect(path?.axis).toBe("path");
  });
});
