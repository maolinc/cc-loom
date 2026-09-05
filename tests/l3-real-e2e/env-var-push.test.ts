/**
 * L3 真实链路：环境变量下发 → 写入设备系统环境变量文件 → 回收移除。
 *
 * 不变量：
 * - 下发后，agent 宿主的 shell rc 文件（~/.bashrc 或 ~/.zshrc）的 Loom 标记块内
 *   出现 `export <KEY>='<VALUE>'`。
 * - 回收后，该行从标记块移除。
 * - 重复下发（更新）幂等：值替换而非追加。
 *
 * 真实性：server + agent 均为真实进程，通过 HTTP + WebSocket 通信；env:push 走
 * gateway.requestFromAgent 同步 req/res，下发返回时 agent 已落盘。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

const MARK_BEGIN = "# >>> loom-managed env >>>";

/** 复用 agent 端 rc 选择逻辑：返回 agent 会写入的 rc 文件路径。 */
function rcFilePath(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return join(homedir(), ".zshrc");
  if (shell.includes("bash")) return join(homedir(), ".bashrc");
  return join(homedir(), ".bashrc");
}

function readRc(): string {
  try {
    return readFileSync(rcFilePath(), "utf8");
  } catch {
    return "";
  }
}

describe("L3 env-var: 下发 → 落盘 → 回收", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;
  const rcBackupPath = `${rcFilePath()}.loom-test.bak`;

  beforeEach(() => {
    agent = null;
    projectRoot = null;
    // 备份宿主 rc 文件，避免污染开发/容器宿主环境
    if (existsSync(rcFilePath())) {
      writeFileSync(rcBackupPath, readFileSync(rcFilePath()));
    }
  });

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
    // 还原 rc 文件
    const rc = rcFilePath();
    if (existsSync(rcBackupPath)) {
      writeFileSync(rc, readFileSync(rcBackupPath));
      rmSync(rcBackupPath);
    } else if (existsSync(rc)) {
      // 测试前不存在、测试中创建的，删掉
      rmSync(rc, { force: true });
    }
  });

  it("下发后 rc 文件标记块内出现 export 行；回收后移除", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("env@example.com");
    const token = await api.getCliToken();

    projectRoot = makeProject("envvar");
    agent = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot,
      isOnline: async () => {
        try {
          const devices = await api.listDevices();
          return devices.some((d) => d.status === "online");
        } catch {
          return false;
        }
      },
    });

    // 找到在线设备
    const devices = await api.listDevices();
    const online = devices.find((d) => d.status === "online");
    expect(online).toBeDefined();

    // 创建并下发（env 轴：凭据名即环境变量名，推到设备系统环境变量）
    const ev = await api.createCredential("L3_TEST_TOKEN", "secret-value-123");
    const res = await api.distributeCredential(ev.id, "env", [online!.id]);
    expect(res.pushed).toContain(online!.id);

    // 断言 rc 文件含 export 行 + 标记块
    const afterPush = readRc();
    expect(afterPush).toContain(MARK_BEGIN);
    expect(afterPush).toContain("export L3_TEST_TOKEN='secret-value-123'");

    // 分发记录存在
    const dists = await api.listCredentialDistributions();
    expect(dists.some((d) => d.credentialId === ev.id && d.axis === "env" && d.targetId === online!.id)).toBe(true);

    // 回收
    await api.revokeCredential(ev.id, "env", online!.id);
    const afterRevoke = readRc();
    expect(afterRevoke).not.toContain("L3_TEST_TOKEN");
    // 标记块若空则整体移除
    if (afterRevoke.includes(MARK_BEGIN)) {
      // 块仍在则内部不应有 export 行
      const begin = afterRevoke.indexOf(MARK_BEGIN);
      const end = afterRevoke.indexOf("# <<< loom-managed env <<<");
      expect(afterRevoke.slice(begin, end)).not.toContain("export ");
    }

    // 分发记录已删
    const distsAfter = await api.listCredentialDistributions();
    expect(distsAfter.some((d) => d.credentialId === ev.id && d.axis === "env" && d.targetId === online!.id)).toBe(false);
  });

  it("重复下发（更新）幂等：值替换不追加", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("env2@example.com");
    const token = await api.getCliToken();

    projectRoot = makeProject("envvar2");
    agent = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot,
      isOnline: async () => {
        try {
          const devices = await api.listDevices();
          return devices.some((d) => d.status === "online");
        } catch {
          return false;
        }
      },
    });

    const devices = await api.listDevices();
    const online = devices.find((d) => d.status === "online")!;

    const ev = await api.createCredential("L3_UPDATE_KEY", "v1");
    await api.distributeCredential(ev.id, "env", [online.id]);
    await api.distributeCredential(ev.id, "env", [online.id]); // 重复下发 = 更新

    const content = readRc();
    const matches = content.match(/export L3_UPDATE_KEY=/g);
    expect(matches).toHaveLength(1); // 只有一行，没有追加
  });
});
