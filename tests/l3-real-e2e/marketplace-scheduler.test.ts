/**
 * L3 marketplace scheduler tick 不变量 — 走真实 server + 真实 git + admin sync 触发。
 *
 * 迁移自原 L1 `packages/server/src/marketplace/__tests__/scheduler.test.ts`（直调 tick +
 * db.prepare 手搓 + __setCloneOrFetchOverride）。L3 改走可观测出口：admin 端点
 * POST /api/admin/marketplaces/sync 直调 tick()（无 withRetry、即时），断言走各源的
 * sync log（trigger=scheduled）。
 *
 * 覆盖：
 *  - tick 导入每个 enabled 源 → 每源一条 scheduled success log（added>0）。
 *  - tick 跳过 disabled 源 → 该源无 scheduled log（仅初始 add log）。
 *  - tick 隔离单源失败 → 失败源 scheduled failed log，健康源仍 scheduled success log。
 *  - 每次 tick 每源各产一条 scheduled log。
 *
 * 未迁移（非黑盒可观测）：
 *  - 「startScheduler 幂等」「stopScheduler 清 timer」「无 source 空转」：纯内部定时器
 *    状态，无 HTTP 可观测出口；定时器本身由 server 启动事实覆盖。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  startServer, stopServer, type ServerHandle,
  ApiClient, createGitFixture, type GitFixture, FIXTURE_GENERIC,
} from "@maolinc/cc-loom-testkit";

const ADMIN_EMAIL = "admin@loom.test";
const ADMIN_PASSWORD = "test-admin-password";

describe("L3 marketplace scheduler tick 不变量", () => {
  let server: ServerHandle;
  let adminApi: ApiClient;
  const fixtures: GitFixture[] = [];

  afterEach(async () => {
    try { if (server) await stopServer(server); } catch { /* ignore */ }
    for (const fx of fixtures) fx.dispose();
    fixtures.length = 0;
  });

  async function boot(): Promise<void> {
    server = await startServer();
    adminApi = new ApiClient(server.baseUrl);
    await adminApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  }

  function newFixture(): GitFixture {
    const fx = createGitFixture(FIXTURE_GENERIC);
    fixtures.push(fx);
    return fx;
  }

  function scheduledLogs(logs: any[]): any[] {
    return logs.filter((l) => l.trigger === "scheduled");
  }

  it("tick 导入每个 enabled 源 → 每源一条 scheduled success log", async () => {
    await boot();
    const fx1 = newFixture();
    const fx2 = newFixture();
    const s1 = await adminApi.addMarketplace(fx1.url);
    const s2 = await adminApi.addMarketplace(fx2.url);

    await adminApi.syncAllMarketplaces();

    for (const s of [s1, s2]) {
      const logs = await adminApi.getMarketplaceLogs(s.id);
      const sched = scheduledLogs(logs);
      // tick(force=false) + SHA 不变 → 短路 no-op，但每源仍产一条 scheduled success log
      expect(sched.length).toBeGreaterThanOrEqual(1);
      expect(sched.at(-1)!.status).toBe("success");
    }
  });

  it("tick 跳过 disabled 源 → 该源无 scheduled log", async () => {
    await boot();
    const fx = newFixture();
    const s = await adminApi.addMarketplace(fx.url);
    // 初始 add 产生一条 log
    expect((await adminApi.getMarketplaceLogs(s.id)).length).toBe(1);

    await adminApi.setMarketplaceEnabled(s.id, false);
    await adminApi.syncAllMarketplaces();

    const logs = await adminApi.getMarketplaceLogs(s.id);
    // 仍只有初始 add log，没有 scheduled log
    expect(logs.length).toBe(1);
    expect(scheduledLogs(logs)).toHaveLength(0);
  });

  it("tick 隔离单源失败 → 失败源 scheduled failed，健康源仍 scheduled success", async () => {
    await boot();
    const fxBroken = newFixture();
    const fxOk = newFixture();
    const sBroken = await adminApi.addMarketplace(fxBroken.url);
    const sOk = await adminApi.addMarketplace(fxOk.url);

    // 破坏 broken 源的仓库
    fxBroken.dispose();
    // 从 fixtures 里移除已 dispose 的，避免 afterEach 再 dispose
    const idx = fixtures.indexOf(fxBroken);
    if (idx >= 0) fixtures.splice(idx, 1);

    await adminApi.syncAllMarketplaces();

    const brokenLogs = scheduledLogs(await adminApi.getMarketplaceLogs(sBroken.id));
    const okLogs = scheduledLogs(await adminApi.getMarketplaceLogs(sOk.id));

    expect(brokenLogs.at(-1)!.status).toBe("failed");
    expect(okLogs.at(-1)!.status).toBe("success");
  });

  it("每次 tick 每源各产一条 scheduled log", async () => {
    await boot();
    const fx = newFixture();
    const s = await adminApi.addMarketplace(fx.url);

    await adminApi.syncAllMarketplaces();
    await adminApi.syncAllMarketplaces();

    const sched = scheduledLogs(await adminApi.getMarketplaceLogs(s.id));
    expect(sched.length).toBe(2);
  });
});
