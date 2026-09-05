/**
 * L3 Marketplace HTTP — 每条 /api/marketplaces/* 走真实 server + 真实 git clone。
 *
 * 用 createGitFixture 把 fixture 目录变成真 git 仓库，server 的 git-runner 真
 * clone/fetch（非 in-process override）。bump SHA = 真提交。
 * 不变量: 鉴权、add/refresh/delete/list/logs、cascade、keepAssets、plugin→workspace。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  startServer, stopServer, type ServerHandle, ApiClient,
  createGitFixture, type GitFixture, FIXTURE_GENERIC, FIXTURE_CC_PLUGIN, FIXTURE_CC_SELF_URL,
} from "@maolinc/cc-loom-testkit";
import { request, parseJson } from "./_http.js";

describe("L3 marketplace HTTP", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let adminApi: ApiClient;
  let fx: GitFixture | null;

  const ADMIN_EMAIL = "admin@loom.test";
  const ADMIN_PASSWORD = "test-admin-password";

  afterEach(async () => {
    fx?.dispose();
    fx = null;
    if (server) await stopServer(server);
  });

  async function boot(fixture = FIXTURE_GENERIC) {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("user@example.com");
    adminApi = new ApiClient(server.baseUrl);
    await adminApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
    fx = createGitFixture(fixture);
  }

  describe("Authorization", () => {
    it("GET /api/marketplaces requires an administrator", async () => {
      server = await startServer();
      const res = await request(server.baseUrl, "GET", "/api/marketplaces");
      expect(res.status).toBe(401);

      const userCookie = await (async () => {
        const user = new ApiClient(server.baseUrl);
        await user.login("marketplace-user@example.com");
        return user.getCookie()!;
      })();
      const forbidden = await request(server.baseUrl, "GET", "/api/marketplaces", { cookie: userCookie });
      expect(forbidden.status).toBe(403);
    });

    it("POST /api/marketplaces requires auth", async () => {
      server = await startServer();
      const res = await request(server.baseUrl, "POST", "/api/marketplaces", { body: { repoUrl: "file:///x" } });
      expect(res.status).toBe(401);
    });

    it("DELETE /api/marketplaces/:id requires auth", async () => {
      server = await startServer();
      const res = await request(server.baseUrl, "DELETE", "/api/marketplaces/abc");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/marketplaces", () => {
    it("creates a source and returns it with counts", async () => {
      await boot();
      const source = await adminApi.addMarketplace(fx!.url);
      expect(source.id).toBeDefined();
      expect(source.repoUrl).toBe(fx!.url);
      expect(source.assetCount).toBeGreaterThan(0);
      expect(source.lastSyncStatus).toBe("success");
    });

    it("rejects malformed URL with 400", async () => {
      await boot();
      const res = await request(server.baseUrl, "POST", "/api/marketplaces", { cookie: adminApi.getCookie()!, body: { repoUrl: "not a url" } });
      expect(res.status).toBe(400);
      expect((await parseJson<any>(res)).success).toBe(false);
    });

    it("returns 409 when adding the same URL twice", async () => {
      await boot();
      await adminApi.addMarketplace(fx!.url);
      await expect(adminApi.addMarketplace(fx!.url)).rejects.toMatchObject({ status: 409 });
    });

    it("assetTypes filter imports only selected types (default = all)", async () => {
      // FIXTURE_GENERIC 含 skill/rule/hook/mcp。传 assetTypes: ["skill"] 后只导入 skill。
      await boot();
      const source = await adminApi.addMarketplace(fx!.url, { assetTypes: ["skill"] });
      expect(source.assetTypesFilter).toEqual(["skill"]);

      const assets = await api.listAssets();
      expect(assets.length).toBeGreaterThan(0);
      const types = new Set(assets.map((a: any) => a.type));
      expect(types).toEqual(new Set(["skill"]));
    });

    it("omitting assetTypes imports all types (normalized to null)", async () => {
      await boot();
      const source = await adminApi.addMarketplace(fx!.url);
      expect(source.assetTypesFilter).toBeNull();
      const assets = await api.listAssets();
      expect(new Set(assets.map((a: any) => a.type)).size).toBeGreaterThan(1);
    });

    it("assetTypes covering all types normalizes to null (all)", async () => {
      await boot();
      // 传完整集合应等价于缺省，规范化为 null。
      const source = await adminApi.addMarketplace(fx!.url, {
        assetTypes: ["skill", "rule", "mcp", "hook", "command", "agent"],
      });
      expect(source.assetTypesFilter).toBeNull();
    });
  });

  describe("GET /api/marketplaces", () => {
    it("returns empty list when no sources exist", async () => {
      server = await startServer();
      api = new ApiClient(server.baseUrl);
      await api.login("empty@example.com");
      adminApi = new ApiClient(server.baseUrl);
      await adminApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(await adminApi.listMarketplaces()).toEqual([]);
    });

    it("returns all sources after add", async () => {
      await boot();
      const fx2 = createGitFixture(FIXTURE_CC_PLUGIN);
      try {
        await adminApi.addMarketplace(fx!.url);
        await adminApi.addMarketplace(fx2.url);
        const list = await adminApi.listMarketplaces();
        expect(list).toHaveLength(2);
        expect(list.map((s) => s.repoUrl).sort()).toEqual([fx!.url, fx2.url].sort());
        expect(list[0].assetCount).toBeGreaterThan(0);
      } finally {
        fx2.dispose();
      }
    });
  });

  describe("DELETE /api/marketplaces/:id", () => {
    it("returns 404 for unknown id", async () => {
      await boot();
      await expect(adminApi.deleteMarketplace("nonexistent-id")).rejects.toMatchObject({ status: 404 });
    });

    it("default cascade deletes source and its assets", async () => {
      await boot();
      const id = (await adminApi.addMarketplace(fx!.url)).id;
      expect((await adminApi.listMarketplaces())[0].assetCount).toBeGreaterThan(0);

      await adminApi.deleteMarketplace(id);

      expect(await adminApi.listMarketplaces()).toHaveLength(0);
      expect(await api.listAssets()).toHaveLength(0);
    });

    it("keepAssets=false succeeds when a source asset is pinned to a user workspace", async () => {
      // 回归: workspace_assets 引用 assets(id) 无 ON DELETE CASCADE，源删除曾触发 FK 违例。
      await boot();
      const id = (await adminApi.addMarketplace(fx!.url)).id;
      const assets = await api.listAssets();
      const sourceAsset = assets[0];

      await api.createWorkspace(
        { name: "user-ws", description: "pins a marketplace asset", targetTools: ["claudecode"], visibility: "private" },
        [sourceAsset.id],
      );

      await adminApi.deleteMarketplace(id);

      expect(await adminApi.listMarketplaces()).toHaveLength(0);
      const remaining = await api.listAssets();
      expect(remaining.find((a) => a.id === sourceAsset.id)).toBeUndefined();
    });

    it("keepAssets=true detaches assets and turns them into normal ones", async () => {
      await boot();
      const id = (await adminApi.addMarketplace(fx!.url)).id;

      await adminApi.deleteMarketplace(id, true);

      expect(await adminApi.listMarketplaces()).toHaveLength(0);
      const assets = await api.listAssets();
      expect(assets.length).toBeGreaterThan(0);
      for (const a of assets) {
        expect(a.sourceId).toBeNull();
        expect(a.author).toMatch(/^imported from /);
      }
    });

    it("list records the administrator as importer", async () => {
      await boot();
      await adminApi.addMarketplace(fx!.url);
      const list = await adminApi.listMarketplaces();
      expect(list).toHaveLength(1);
      expect(list[0].addedBy).toBe(ADMIN_EMAIL);
    });

    it("non-admin cannot view or delete a source", async () => {
      await boot();
      const id = (await adminApi.addMarketplace(fx!.url)).id;

      const apiB = new ApiClient(server.baseUrl);
      await apiB.login("other@example.com");
      await expect(apiB.listMarketplaces()).rejects.toMatchObject({ status: 403 });
      await expect(apiB.deleteMarketplace(id)).rejects.toMatchObject({ status: 403 });

      expect((await adminApi.listMarketplaces()).find((s) => s.id === id)).toBeDefined();
      await adminApi.deleteMarketplace(id);
      expect(await adminApi.listMarketplaces()).toHaveLength(0);
    });
  });

  describe("POST /api/marketplaces/:id/refresh", () => {
    it("returns 404 for unknown id", async () => {
      await boot();
      await expect(adminApi.refreshMarketplace("missing")).rejects.toMatchObject({ status: 404 });
    });

    it("re-imports and reports success after upstream bump", async () => {
      await boot();
      const id = (await adminApi.addMarketplace(fx!.url)).id;
      const shaBefore = fx!.sha();
      fx!.commit();
      expect(fx!.sha()).not.toBe(shaBefore);

      const result = await adminApi.refreshMarketplace(id);
      expect(result.status).toBe("success");
    });
  });

  describe("GET /api/marketplaces/:id/logs", () => {
    it("returns 404 for unknown id", async () => {
      await boot();
      const res = await request(server.baseUrl, "GET", "/api/marketplaces/missing/logs", { cookie: adminApi.getCookie()! });
      expect(res.status).toBe(404);
    });

    it("returns sync log entries after add", async () => {
      await boot();
      const id = (await adminApi.addMarketplace(fx!.url)).id;
      const logs = await adminApi.getMarketplaceLogs(id);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].sourceId).toBe(id);
      expect(logs[0].status).toBe("success");
      expect(logs[0].trigger).toBe("add");
    });
  });

  describe("Plugin → Workspace generation", () => {
    it("creates a Workspace when source is a Claude Code plugin", async () => {
      await boot(FIXTURE_CC_PLUGIN);
      const source = await adminApi.addMarketplace(fx!.url);

      const list = await adminApi.listMarketplaces();
      const src = list.find((s) => s.id === source.id)!;
      expect(src.workspaceCount).toBe(1);

      const workspaces = await api.listWorkspaces();
      const plugin = workspaces.find((w) => w.name === "example-plugin");
      expect(plugin).toBeDefined();
      expect(plugin!.version).toBe("1.2.3");
    });

    it("imports a root plugin whose marketplace URL points to the source itself", async () => {
      await boot(FIXTURE_CC_SELF_URL);
      fx!.commit({ file: ".claude-plugin/marketplace.json", content: JSON.stringify({
        name: "flyai-marketplace",
        owner: { name: "alibaba-flyai" },
        plugins: [{
          name: "flyai",
          version: "1.0.14",
          source: { source: "url", url: fx!.url },
          author: { name: "alibaba-flyai" },
        }],
      }) });

      const source = await adminApi.addMarketplace(fx!.url);

      expect(source.assetCount).toBe(1);
      expect(source.workspaceCount).toBe(1);
      expect((await api.listAssets()).map((asset) => `${asset.type}:${asset.name}`)).toEqual(["skill:flyai"]);
      expect((await api.listWorkspaces()).some((workspace) => workspace.name === "flyai")).toBe(true);
    });
  });
});
