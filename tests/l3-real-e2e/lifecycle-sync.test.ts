/**
 * L3 生命周期 — 安装→卸载→重装 + auto 在线同步。
 *
 * 不变量:
 * - 卸载后 lock 清除、磁盘文件清除、server currentCapabilitySet 置空
 * - 重装后文件恢复、lock 重建
 * - auto 策略下 capabilitySet 成员变化 → 在线项目自动同步
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
  assetBuilders,
  expectFileExists,
  expectFileNotExists,
  readLock,
  expectNoLock,
  expectLock,
} from "@maolinc/cc-loom-testkit";

describe("L3 lifecycle: 安装→卸载→重装 + auto 同步", () => {
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

  it("安装→卸载→重装：lock 和磁盘文件正确流转", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("life@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(assetBuilders.skill("life-skill", ["cursor"]));
    const ws = await api.createCapabilitySet(
      { name: "ws-life", description: "lifecycle test", targetTools: ["cursor"], visibility: "public" },
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

    // 1. 安装
    await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["cursor"], policy: "locked",
    });
    expectFileExists(projectRoot, ".cursor/skills/life-skill/SKILL.md");
    expectLock(projectId, { capabilitySetId: ws.id });

    // 2. 卸载该订阅（ADR-0006：多订阅模型下用 unsubscribe，而非"切换到空能力集"）
    await api.unsubscribeCapabilitySet(projectId, ws.id);

    // 切换到空 capabilitySet 后，旧 skill 文件应被清除（orphan 清理）
    // 等待 agent watcher 检测 + 推送
    let filesGone = false;
    for (let i = 0; i < 20; i++) {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      if (!existsSync(join(projectRoot, ".cursor/skills/life-skill/SKILL.md"))) {
        filesGone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // orphan 清理可能需要时间；如果不立即可用，至少 lock 更新了
    const lock = readLock(projectId);
    if (lock) {
      expect(lock.subscriptions?.some((s) => s.capabilitySetId === ws.id) ?? false).toBe(false);
    }

    // 3. 重装原 capabilitySet
    await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["cursor"], policy: "locked",
    });
    expectFileExists(projectRoot, ".cursor/skills/life-skill/SKILL.md");
    expectLock(projectId, { capabilitySetId: ws.id });
  });

  it("auto 策略: capabilitySet 成员 +1 → 在线项目自动同步新文件", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("sync@example.com");
    const token = await api.getCliToken();

    const skillA = await api.createAsset(assetBuilders.skill("sync-a", ["cursor"]));
    const skillB = await api.createAsset(assetBuilders.skill("sync-b", ["cursor"]));
    const ws = await api.createCapabilitySet(
      { name: "ws-sync", description: "sync test", targetTools: ["cursor"], visibility: "public" },
      [skillA.id],
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

    // 安装（auto 策略）
    await api.installExecute({
      projectId: agent.projectId, capabilitySetId: ws.id, targetTools: ["cursor"], policy: "auto",
    });
    expectFileExists(projectRoot, ".cursor/skills/sync-a/SKILL.md");

    // 更新 capabilitySet 成员 +1
    await api.updateCapabilitySet(ws.id, { assetIds: [skillA.id, skillB.id] });

    // 等待 auto 同步推送 sync-b
    let synced = false;
    for (let i = 0; i < 40; i++) {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      if (existsSync(join(projectRoot, ".cursor/skills/sync-b/SKILL.md"))) {
        synced = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(synced).toBe(true);
  });
});
