/**
 * L3 全链路 happy-path — add → import → refresh → settings → delete 完整周期。
 *
 * 真实 server + 真实 git clone（cc-plugin fixture）。bump SHA = 真提交。
 * 不变量: 空→默认 360→add 成功带 counts→assets 只读标记→workspace 自动生成→
 *         refresh 增日志→settings 持久化→重复 add 409→delete 清空。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  startServer, stopServer, type ServerHandle, ApiClient, ApiRequestError,
  createGitFixture, type GitFixture, FIXTURE_CC_PLUGIN,
} from "@maolinc/cc-loom-testkit";

describe("L3 full marketplace flow", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let fx: GitFixture | null;

  afterEach(async () => {
    fx?.dispose();
    fx = null;
    if (server) await stopServer(server);
  });

  it("supports the full add → import → refresh → delete cycle", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("admin@loom.test", "test-admin-password");
    fx = createGitFixture(FIXTURE_CC_PLUGIN);

    // 1. 初始空列表 + 默认轮询
    expect(await api.listMarketplaces()).toEqual([]);
    const settings = await api.get<{ pollIntervalMinutes: number }>("/api/settings/marketplace");
    expect(settings.pollIntervalMinutes).toBe(360);

    // 2. add plugin source
    const source = await api.addMarketplace(fx.url);
    expect(source.lastSyncStatus).toBe("success");
    expect(source.assetCount).toBeGreaterThan(0);
    expect(source.workspaceCount).toBe(1);

    // 3. list 含此源
    const list = await api.listMarketplaces();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(source.id);

    // 4. assets 全部归属此源
    const assets = await api.listAssets();
    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets) {
      expect(a.sourceId).toBe(source.id);
    }

    // 5. 自动生成的 workspace
    const wss = await api.listWorkspaces();
    const plugin = wss.find((w) => w.name === "example-plugin");
    expect(plugin).toBeDefined();

    // 6. bump SHA + refresh → 日志增长
    fx.commit();
    const refresh = await api.refreshMarketplace(source.id);
    expect(refresh.status).toBe("success");

    const logs = await api.getMarketplaceLogs(source.id);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.trigger === "add")).toBe(true);
    expect(logs.some((l) => l.trigger === "manual")).toBe(true);

    // 7. settings 持久化
    await api.put("/api/settings/marketplace", { pollIntervalMinutes: 60 });
    const settingsAfter = await api.get<{ pollIntervalMinutes: number }>("/api/settings/marketplace");
    expect(settingsAfter.pollIntervalMinutes).toBe(60);

    // 8. 重复 add 同 URL → 409
    await expect(api.addMarketplace(fx.url)).rejects.toMatchObject({ status: 409 });

    // 9. delete (cascade)
    await api.deleteMarketplace(source.id);

    // 10. 一切归零
    expect(await api.listMarketplaces()).toEqual([]);
    expect(await api.listAssets()).toEqual([]);
    const wsAfter = await api.listWorkspaces();
    expect(wsAfter.find((w) => w.name === "example-plugin")).toBeUndefined();
  });
});
