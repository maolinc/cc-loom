/**
 * L3 drift 自愈 — lock 中文件全部从磁盘消失时，agent 重连后 scan 自动清 lock，
 * server 端显式订阅被清空。
 *
 * 不变量（产品文档 §8）:
 * - lock 中 expected 文件全部消失 → Agent scan 自动清 lock (driftCleared)
 * - server 同步清空 current workspace
 *
 * 策略: 安装 → 停 agent → 删文件 → 重启 agent → scan 检测 drift → 清 lock。
 * 不依赖 watcher（串行跑时 watcher 可能未就绪），用 agent 重连的 reconcile 触发 scan。
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
  assetBuilders,
  expectFileExists,
  readLock,
  expectNoLock,
} from "@maolinc/cc-loom-testkit";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("L3 drift-self-heal: lock 文件全缺 → agent 重连后自动清 lock", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  beforeEach(() => {
    agent = null;
    projectRoot = null;
  });

  afterEach(async () => {
    // 尝试停止可能残留的 agent
    try { await runCli(["stop", "--force"], { timeout: 5000 }); } catch { /* ignore */ }
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  it("安装→停agent→删文件→重启agent→lock 被清 + server currentWorkspace 置空", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("drift@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(assetBuilders.skill("drift-skill", ["cursor"]));
    const ws = await api.createWorkspace(
      { name: "ws-drift", description: "drift test", targetTools: ["cursor"], visibility: "public" },
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
    const projectId = agent.projectId;

    // 安装（用 locked 策略：重启后 server 不会 auto-sync 补偿重装，
    // agent scan 才能检测到 drift 并清 lock）
    const { result } = await api.installExecute({
      projectId,
      workspaceId: ws.id,
      targetTools: ["cursor"],
      policy: "locked",
    });
    expect(result.success).toBe(true);
    expectFileExists(projectRoot, ".cursor/skills/drift-skill/SKILL.md");
    expect(readLock(projectId)).not.toBeNull();

    // 停 agent
    await stopAgent(agent);
    agent = null;

    // 删除全部 managed 文件
    rmSync(join(projectRoot, ".cursor"), { recursive: true, force: true });

    // 重启 agent → 重连后 reconcile 触发 scan → driftCleared → 清 lock
    await runCli(["start", "--force"], { timeout: 15000 });

    // 等待设备 online（重启后需要重新连接）
    for (let i = 0; i < 40; i++) {
      const devices = await api.listDevices();
      if (devices.some((d) => d.status === "online")) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // 等待 lock 被清 + server currentWorkspace 置空
    let lockCleared = false;
    let wsCleared = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!lockCleared && readLock(projectId) === null) {
        lockCleared = true;
      }
      if (lockCleared) {
        try {
          const proj = await api.getProject(projectId);
          if (proj.subscriptions.every((s) => s.workspaceId === null)) {
            wsCleared = true;
            break;
          }
        } catch { /* 还在同步 */ }
      }
    }

    expect(lockCleared).toBe(true);
    expect(wsCleared).toBe(true);
    expectNoLock(projectId);
  });
});
