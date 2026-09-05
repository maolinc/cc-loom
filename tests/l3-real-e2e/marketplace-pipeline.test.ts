/**
 * L3 marketplace runImport 不变量 — 走真实 server + 真实 git clone + sync log + 磁盘。
 *
 * 迁移自原 L1 `packages/server/src/marketplace/__tests__/pipeline.test.ts`（直调 runImport +
 * db.prepare 手搓）。L3 改走可观测出口：HTTP（add/refresh/admin sync）+ sync log 的
 * added/updated/removed 计数 + listAssets + agent 磁盘。唯一允许的 mock 是 git clone
 * （createGitFixture 造本地真 git 仓库代替联网）。
 *
 * 覆盖：
 *  - 首次导入：added>0，updated/removed=0，assetCount 一致。
 *  - SHA 不变再 refresh：计数全 0（force 重解析，内容未变）。
 *  - 内容变更后 refresh：updated>0。
 *  - 源中文件消失后 refresh：removed>0 + asset 从库消失。
 *  - 消失但被能力集引用的 asset → 留存（库 404，能力集 retained）。
 *  - clone/fetch 失败 → sync log 记 failed（经 admin sync→tick，无 withRetry，快速）。
 *  - rule/mcp/hook metadata 导入正确（skill metadata 空）。
 *  - mcp 源文件变更后 refresh → metadata 更新。
 *  - 已安装 asset 内容变更 → auto-sync 推送到 agent 磁盘。
 *
 * 未迁移（非黑盒可观测）：
 *  - 「force=true 重解析已擦除的 asset 行」：需直操 DB 擦表后断言重导入，L3 无此口子。
 *    force 标志本身被 refresh 每次行使（force=true）、SHA 短路被 tick 行使（force=false），
 *    两者计数行为由「SHA 不变」「内容变更」两条用例覆盖。
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startServer, stopServer, type ServerHandle,
  startAgent, stopAgent, type AgentHandle,
  makeProject, cleanupProject,
  ApiClient, createGitFixture, type GitFixture, FIXTURE_GENERIC,
} from "@maolinc/cc-loom-testkit";
import { hookEventsOf } from "@maolinc/cc-loom-shared";

const ADMIN_EMAIL = "admin@loom.test";
const ADMIN_PASSWORD = "test-admin-password";

/** sync log 按 started_at DESC 返回，logs[0] 为最新。 */
function lastLog(logs: any[]): any {
  return logs[0]!;
}

describe("L3 marketplace runImport 不变量", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let adminApi: ApiClient;
  let fx: GitFixture | null;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  afterEach(async () => {
    try { if (agent) await stopAgent(agent); } catch { /* ignore */ }
    agent = null;
    try { if (server) await stopServer(server); } catch { /* ignore */ }
    if (projectRoot) cleanupProject(projectRoot);
    projectRoot = null;
    fx?.dispose();
    fx = null;
  });

  async function boot(): Promise<void> {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("user@example.com");
    adminApi = new ApiClient(server.baseUrl);
    await adminApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
    fx = createGitFixture(FIXTURE_GENERIC);
  }

  it("首次导入：added>0，updated/removed=0，assetCount 一致", async () => {
    await boot();
    const source = await adminApi.addMarketplace(fx!.url);
    expect(source.lastSyncStatus).toBe("success");
    expect(source.assetCount).toBeGreaterThan(0);

    const logs = await adminApi.getMarketplaceLogs(source.id);
    const log = lastLog(logs);
    expect(log.trigger).toBe("add");
    expect(log.status).toBe("success");
    expect(log.added).toBeGreaterThan(0);
    expect(log.updated).toBe(0);
    expect(log.removed).toBe(0);
  });

  it("SHA 不变再 refresh：计数全 0", async () => {
    await boot();
    const id = (await adminApi.addMarketplace(fx!.url)).id;

    await adminApi.refreshMarketplace(id);
    const log = lastLog(await adminApi.getMarketplaceLogs(id));
    expect(log.status).toBe("success");
    expect(log.added).toBe(0);
    expect(log.updated).toBe(0);
    expect(log.removed).toBe(0);
  });

  it("内容变更后 refresh：updated>0", async () => {
    await boot();
    const id = (await adminApi.addMarketplace(fx!.url)).id;

    writeFileSync(join(fx!.path, "skills/coding-style.md"), "# Updated content\n");
    fx!.commit();

    await adminApi.refreshMarketplace(id);
    const log = lastLog(await adminApi.getMarketplaceLogs(id));
    expect(log.status).toBe("success");
    expect(log.updated).toBeGreaterThan(0);
  });

  it("源中文件消失后 refresh：removed>0 + asset 从库消失", async () => {
    await boot();
    const id = (await adminApi.addMarketplace(fx!.url)).id;
    const before = (await api.listAssets()).length;

    // 删掉一个 skill 源文件并提交
    const skillFile = join(fx!.path, "skills/coding-style.md");
    const { rmSync } = await import("node:fs");
    rmSync(skillFile, { force: true });
    fx!.commit();

    await adminApi.refreshMarketplace(id);
    const log = lastLog(await adminApi.getMarketplaceLogs(id));
    expect(log.removed).toBeGreaterThan(0);
    expect((await api.listAssets()).length).toBe(before - log.removed);
  });

  it("消失但被能力集引用的 asset → 留存（库 404，能力集 retained）", async () => {
    await boot();
    const id = (await adminApi.addMarketplace(fx!.url)).id;
    const assets = await api.listAssets();
    const skill = assets.find((a) => a.sourcePath === "skills/coding-style")!;
    expect(skill).toBeDefined();

    // 把该 asset 钉到一个用户能力集
    const ws = await api.createCapabilitySet(
      { name: "pin-ws", description: "x", targetTools: ["cursor"], visibility: "private" },
      [skill.id],
    );

    // 删掉源文件并提交 → 该 asset 从源消失但被能力集引用 → 留存
    const { rmSync } = await import("node:fs");
    rmSync(join(fx!.path, "skills/coding-style.md"), { force: true });
    fx!.commit();
    await adminApi.refreshMarketplace(id);

    // 库视角：asset 软删 → 404
    await expect(api.getAsset(skill.id)).rejects.toMatchObject({ status: 404 });
    // 能力集视角：仍保留该成员，标 retained
    const wd = await api.getCapabilitySet(ws.id);
    const member = wd.assets.find((a: any) => a.id === skill.id);
    expect(member).toBeDefined();
    expect((member as any).retained).toBe(true);
  });

  it("clone/fetch 失败 → sync log 记 failed（admin sync→tick，无 withRetry）", async () => {
    await boot();
    const id = (await adminApi.addMarketplace(fx!.url)).id;
    expect((await adminApi.listMarketplaces())[0].lastSyncStatus).toBe("success");

    // 破坏源仓库：tick 直调 runImport（无 withRetry），fetch 失败即时记 failed
    fx!.dispose();
    fx = null;
    await adminApi.syncAllMarketplaces();

    const src = (await adminApi.listMarketplaces()).find((s) => s.id === id)!;
    expect(src.lastSyncStatus).toBe("failed");
    const log = lastLog(await adminApi.getMarketplaceLogs(id));
    expect(log.status).toBe("failed");
    expect(log.trigger).toBe("scheduled");
  });

  it("rule/mcp/hook metadata 导入正确（skill metadata 空）", async () => {
    await boot();
    const id = (await adminApi.addMarketplace(fx!.url)).id;
    const assets = await api.listAssets();

    const skill = assets.find((a) => a.type === "skill");
    expect(skill).toBeDefined();
    expect(skill!.metadata as any).toEqual({});

    const mcps = assets.filter((a) => a.type === "mcp");
    expect(mcps.length).toBeGreaterThanOrEqual(2);
    for (const m of mcps) {
      expect((m.metadata as any).transport).toBe("stdio");
      expect(typeof (m.metadata as any).command).toBe("string");
    }

    const hooks = assets.filter((a) => a.type === "hook");
    expect(hooks.length).toBeGreaterThanOrEqual(2);
    for (const h of hooks) {
      // 多事件契约：events[]（新）或 event（旧单值，plugin registry 导入路径仍产出）
      expect(hookEventsOf(h.metadata as any).length).toBeGreaterThan(0);
      expect(Array.isArray((h.metadata as any).hooks)).toBe(true);
      expect((h.metadata as any).hooks.length).toBeGreaterThan(0);
    }
  });

  it("mcp 源文件变更后 refresh → metadata 更新", async () => {
    await boot();
    const id = (await adminApi.addMarketplace(fx!.url)).id;
    const before = (await api.listAssets()).find((a) => a.type === "mcp" && a.name === "filesystem")!;
    expect(before).toBeDefined();
    expect((before.metadata as any).command).toContain("npx");

    // 改 .mcp.json：filesystem command 变 node
    writeFileSync(join(fx!.path, ".mcp.json"), JSON.stringify({
      mcpServers: {
        filesystem: { command: "node", args: ["custom-fs.js"] },
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      },
    }));
    fx!.commit();

    await adminApi.refreshMarketplace(id);
    const after = (await api.listAssets()).find((a) => a.id === before.id)!;
    expect((after.metadata as any).command).toBe("node custom-fs.js");
  });

  it("已安装 asset 内容变更 → auto-sync 推送到 agent 磁盘", async () => {
    await boot();
    const id = (await adminApi.addMarketplace(fx!.url)).id;
    const skillAsset = (await api.listAssets()).find((a) => a.sourcePath === "skills/coding-style")!;
    expect(skillAsset).toBeDefined();
    const tools = skillAsset.compatibleTools as string[];
    expect(tools.length).toBeGreaterThan(0);
    const tool = tools[0]!;

    const ws = await api.createCapabilitySet(
      { name: "auto-ws", description: "x", targetTools: [tool], visibility: "public" },
      [skillAsset.id],
    );
    const token = await api.getCliToken();
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl, token, projectRoot,
      isOnline: async () => (await api.listDevices()).some((d) => d.status === "online"),
    });
    await api.installExecute({
      projectId: agent.projectId, capabilitySetId: ws.id, targetTools: [tool], policy: "auto",
    });

    // 找到落盘的 SKILL.md
    const skillFile = await findSkillFile(projectRoot!, "SKILL.md");
    expect(skillFile).not.toBeNull();
    const beforeContent = readFileSync(skillFile!, "utf8");
    expect(beforeContent.length).toBeGreaterThan(0);

    // 改源 skill 内容并 refresh → auto-sync 推新内容到磁盘
    writeFileSync(join(fx!.path, "skills/coding-style.md"), "# AUTO-SYNC-MARKER\n");
    fx!.commit();
    await adminApi.refreshMarketplace(id);

    const updated = await waitUntil(async () => {
      if (!existsSync(skillFile!)) return false;
      return readFileSync(skillFile!, "utf8").includes("AUTO-SYNC-MARKER");
    }, 20000);
    expect(updated).toBe(true);
  });
});

async function findSkillFile(root: string, name: string): Promise<string | null> {
  const { readdirSync, statSync } = await import("node:fs");
  function walk(dir: string): string | null {
    for (const n of readdirSync(dir)) {
      if (n === "node_modules" || n === ".git") continue;
      const full = join(dir, n);
      if (statSync(full).isDirectory()) {
        const r = walk(full);
        if (r) return r;
      } else if (n === name) {
        return full;
      }
    }
    return null;
  }
  return walk(root);
}

async function waitUntil(pred: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  for (let i = 0; i < timeoutMs / 250; i++) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
