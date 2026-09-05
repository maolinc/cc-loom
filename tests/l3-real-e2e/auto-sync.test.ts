/**
 * L3 自动同步（policy=auto）+ 离线补偿 — 真实 agent + 磁盘断言。
 *
 * lifecycle-sync 已覆盖「auto 成员 +1 同步」；本文件覆盖其余不变量:
 *  - 能力集移除成员 → 磁盘文件被移除
 *  - 编辑 asset 内容 → 磁盘文件内容更新
 *  - locked 项目不被自动同步（成员变化不落盘）
 *  - 离线期间能力集成员变化 → 重连后补偿推送全集
 *  - locked 切 auto → 立即同步一次
 *
 * 断言一律走磁盘文件（可观测出口），不查 RPC payload / DB。
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startServer, stopServer, type ServerHandle, ApiClient,
  startAgent, stopAgent, runCli, type AgentHandle,
  makeProject, cleanupProject, assetBuilders,
} from "@maolinc/cc-loom-testkit";

describe("L3 auto-sync + 离线补偿", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  afterEach(async () => {
    try { if (agent) await stopAgent(agent); } catch { /* ignore */ }
    try { await runCli(["stop", "--force"], { timeout: 5000 }); } catch { /* ignore */ }
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  async function bootAndInstall(email: string, assetNames: string[], policy: "auto" | "locked") {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login(email);
    const token = await api.getCliToken();
    const skills = await Promise.all(assetNames.map((n) => api.createAsset(assetBuilders.skill(n, ["cursor"]))));
    const ws = await api.createCapabilitySet(
      { name: "ws-sync", description: "x", targetTools: ["cursor"], visibility: "public" },
      skills.map((s) => s.id),
    );
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl, token, projectRoot,
      isOnline: async () => (await api.listDevices()).some((d) => d.status === "online"),
    });
    await api.installExecute({ projectId: agent.projectId, capabilitySetId: ws.id, targetTools: ["cursor"], policy });
    return { token, ws, skills };
  }

  function waitUntil(pred: () => boolean, timeoutMs = 20000): Promise<boolean> {
    return (async () => {
      for (let i = 0; i < timeoutMs / 250; i++) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })();
  }

  const skillFile = (name: string) => join(projectRoot!, ".cursor/skills", name, "SKILL.md");

  it("能力集移除成员 → 磁盘文件被移除", async () => {
    const { ws, skills } = await bootAndInstall("sync-rm@example.com", ["rm-a", "rm-b"], "auto");
    expect(existsSync(skillFile("rm-a"))).toBe(true);
    expect(existsSync(skillFile("rm-b"))).toBe(true);

    await api.updateCapabilitySet(ws.id, { assetIds: [skills[0]!.id] }); // 移除 rm-b

    const removed = await waitUntil(() => !existsSync(skillFile("rm-b")));
    expect(removed).toBe(true);
    expect(existsSync(skillFile("rm-a"))).toBe(true);
  });

  it("编辑 asset 内容 → 磁盘文件内容更新", async () => {
    const { ws, skills } = await bootAndInstall("sync-edit@example.com", ["edit-a"], "auto");
    const a = skills[0]!;
    await api.updateAsset(a.id, { files: [{ path: "SKILL.md", content: "# v2-updated-content" }] });

    const updated = await waitUntil(() => {
      const f = skillFile("edit-a");
      return existsSync(f) && readFileSync(f, "utf8").includes("v2-updated-content");
    });
    expect(updated).toBe(true);
  });

  it("locked 项目不被自动同步", async () => {
    const { ws, skills } = await bootAndInstall("sync-locked@example.com", ["lk-a"], "locked");
    // 新增第二个 skill 并加入能力集
    const b = await api.createAsset(assetBuilders.skill("lk-b", ["cursor"]));
    await api.updateCapabilitySet(ws.id, { assetIds: [skills[0]!.id, b.id] });

    // 等待一段时间，确认 lk-b 不落盘
    await new Promise((r) => setTimeout(r, 2000));
    expect(existsSync(skillFile("lk-b"))).toBe(false);
  });

  it("离线期间能力集成员变化 → 重连后补偿推送全集", async () => {
    const { token, ws, skills } = await bootAndInstall("sync-offline@example.com", ["off-a"], "auto");
    expect(existsSync(skillFile("off-a"))).toBe(true);

    // 停 agent（离线）
    await stopAgent(agent!);
    agent = null;

    // 离线期间给能力集加 off-b
    const b = await api.createAsset(assetBuilders.skill("off-b", ["cursor"]));
    await api.updateCapabilitySet(ws.id, { assetIds: [skills[0]!.id, b.id] });

    // 重连
    await runCli(["start", "--force"], { timeout: 15000 });
    for (let i = 0; i < 40; i++) {
      if ((await api.listDevices()).some((d) => d.status === "online")) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // 补偿推送全集：off-a + off-b 都在磁盘
    const gotB = await waitUntil(() => existsSync(skillFile("off-b")));
    expect(gotB).toBe(true);
    expect(existsSync(skillFile("off-a"))).toBe(true);
    // 标记 agent 已重启，afterEach 里 stop 走 runCli stop
    agent = { projectRoot: projectRoot!, projectId: agent?.projectId ?? "", stopped: true } as AgentHandle;
  });

  it("locked 切 auto → 立即补一次同步", async () => {
    const { skills, ws } = await bootAndInstall("sync-switch@example.com", ["sw-a"], "locked");
    // 能力集加 sw-b（locked 期间不落盘）
    const b = await api.createAsset(assetBuilders.skill("sw-b", ["cursor"]));
    await api.updateCapabilitySet(ws.id, { assetIds: [skills[0]!.id, b.id] });
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(skillFile("sw-b"))).toBe(false);

    // 切到 auto
    await api.setSubscriptionPolicy(agent!.projectId, ws.id, "auto");

    const synced = await waitUntil(() => existsSync(skillFile("sw-b")));
    expect(synced).toBe(true);
  });
});
