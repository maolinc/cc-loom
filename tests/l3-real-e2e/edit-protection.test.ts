/**
 * L3 Edit-protection — 导入资产/工作空间可被导入者编辑，破坏性操作受保护。
 *
 * 真实 server + 真实 git clone（generic-skills / cc-plugin fixture）。
 * 不变量: 导入资产 PUT 200 / DELETE 403、用户资产 PUT/DELETE 200、跨用户 403、
 *         别名/改名/元数据保留、plugin workspace PUT 200 / DELETE 403。
 */
import { describe, it, expect, afterEach } from "vitest";
import type { TargetTool } from "@maolinc/cc-loom-shared";
import {
  startServer, stopServer, type ServerHandle, ApiClient,
  createGitFixture, type GitFixture, FIXTURE_GENERIC, FIXTURE_CC_PLUGIN,
} from "@maolinc/cc-loom-testkit";
import { login, request, parseJson } from "./_http.js";

describe("L3 edit-protection", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let cookie: string;
  let fx: GitFixture | null;

  afterEach(async () => {
    fx?.dispose();
    fx = null;
    if (server) await stopServer(server);
  });

  async function boot(fixture = FIXTURE_GENERIC) {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("admin@loom.test", "test-admin-password");
    cookie = api.getCookie()!;
    fx = createGitFixture(fixture);
  }

  async function importGenericSource(): Promise<{ sourceId: string; assetId: string }> {
    const source = await api.addMarketplace(fx!.url);
    const assets = await api.listAssets();
    expect(assets.length).toBeGreaterThan(0);
    return { sourceId: source.id, assetId: assets[0]!.id };
  }

  async function createSkill(name: string, cookieOverride?: string): Promise<{ id: string; cookie: string }> {
    const c = cookieOverride ?? cookie;
    const res = await request(server.baseUrl, "POST", "/api/assets", {
      cookie: c,
      body: { name, type: "skill", description: "x", tags: [], files: [{ path: "SKILL.md", content: "body" }], compatibleTools: ["cursor"], visibility: "private" },
    });
    expect(res.status).toBe(200);
    return { id: (await parseJson<any>(res)).data.id, cookie: c };
  }

  describe("Asset", () => {
    it("PUT on source-imported asset by importer returns 200", async () => {
      await boot();
      const { assetId } = await importGenericSource();
      const res = await request(server.baseUrl, "PUT", `/api/assets/${assetId}`, {
        cookie, body: { description: "edited imported", sourceUrl: "https://example.com/original" },
      });
      expect(res.status).toBe(200);
      const data = (await parseJson<any>(res)).data;
      expect(data.description).toBe("edited imported");
      expect(data.sourceUrl).toBe("https://example.com/original");
    });

    it("DELETE on source-imported asset returns 403", async () => {
      await boot();
      const { assetId } = await importGenericSource();
      const res = await request(server.baseUrl, "DELETE", `/api/assets/${assetId}`, { cookie });
      expect(res.status).toBe(403);
      expect((await parseJson<any>(res)).error).toContain("只读");
    });

    it("PUT on user-created asset works (control)", async () => {
      await boot();
      const { id } = await createSkill("my-skill");
      const update = await request(server.baseUrl, "PUT", `/api/assets/${id}`, { cookie, body: { description: "updated" } });
      expect(update.status).toBe(200);
      expect((await parseJson<any>(update)).data.description).toBe("updated");
    });

    it("Asset list response includes source/import metadata and importer", async () => {
      await boot();
      await importGenericSource();
      const assets = await api.listAssets();
      expect(assets.length).toBeGreaterThan(0);
      const imported = assets.find((a) => a.sourceId !== null)!;
      expect(imported).toBeDefined();
      expect(imported.sourcePath).toBeDefined();
      expect("sourceOriginAuthor" in imported).toBe(true);
      expect(typeof imported.metadata).toBe("object");
      expect(imported.metadata).not.toBeNull();
      expect(typeof imported.sourceDisplayName).toBe("string");
      expect(imported.sourceDisplayName.length).toBeGreaterThan(0);
      expect(imported.sourceAddedBy).toBe("admin@loom.test");
    });

    it("PUT on another user's asset returns 403", async () => {
      await boot();
      const aliceCookie = await login(server.baseUrl, "alice@example.com");
      const { id } = await createSkill("alice-skill", aliceCookie);
      const bobCookie = await login(server.baseUrl, "bob@example.com");
      const res = await request(server.baseUrl, "PUT", `/api/assets/${id}`, { cookie: bobCookie, body: { description: "trying to edit" } });
      expect(res.status).toBe(403);
      expect((await parseJson<any>(res)).error).toContain("自己");
    });

    it("DELETE on another user's asset returns 403", async () => {
      await boot();
      const aliceCookie = await login(server.baseUrl, "alice2@example.com");
      const { id } = await createSkill("alice-skill-2", aliceCookie);
      const bobCookie = await login(server.baseUrl, "bob2@example.com");
      const res = await request(server.baseUrl, "DELETE", `/api/assets/${id}`, { cookie: bobCookie });
      expect(res.status).toBe(403);
      expect((await parseJson<any>(res)).error).toContain("自己");
    });

    it("DELETE on own asset returns 200", async () => {
      await boot();
      const ownerCookie = await login(server.baseUrl, "owner@example.com");
      const { id } = await createSkill("owned", ownerCookie);
      const res = await request(server.baseUrl, "DELETE", `/api/assets/${id}`, { cookie: ownerCookie });
      expect(res.status).toBe(200);
    });

    it("validates asset name, persists alias, and searches by alias", async () => {
      await boot();
      const c = await login(server.baseUrl, "alias-user@example.com");
      const invalid = await request(server.baseUrl, "POST", "/api/assets", {
        cookie: c,
        body: { name: "中文名", type: "skill", description: "x", tags: [], files: [{ path: "SKILL.md", content: "x" }], compatibleTools: ["cursor"], visibility: "public" },
      });
      expect(invalid.status).toBe(400);

      const create = await request(server.baseUrl, "POST", "/api/assets", {
        cookie: c,
        body: { name: "react_helper", alias: "React 助手", type: "skill", description: "x", tags: ["前端", "React"], files: [{ path: "SKILL.md", content: "x" }], compatibleTools: ["cursor"], visibility: "public" },
      });
      expect(create.status).toBe(200);
      const created = (await parseJson<any>(create)).data;
      expect(created.alias).toBe("React 助手");

      const search = await request(server.baseUrl, "GET", "/api/assets?query=React%20%E5%8A%A9%E6%89%8B", { cookie: c });
      expect((await parseJson<any>(search)).data.map((a: any) => a.id)).toContain(created.id);
    });

    it("blocks renaming a referenced asset but allows alias updates", async () => {
      await boot();
      const c = await login(server.baseUrl, "rename-guard@example.com");
      const create = await request(server.baseUrl, "POST", "/api/assets", {
        cookie: c,
        body: { name: "stable_name", alias: "旧别名", type: "skill", description: "x", tags: [], files: [{ path: "SKILL.md", content: "x" }], compatibleTools: ["cursor"], visibility: "public" },
      });
      expect(create.status).toBe(200);
      const assetId = (await parseJson<any>(create)).data.id;

      const ws = await request(server.baseUrl, "POST", "/api/workspaces", { cookie: c, body: { name: "rename-ws", description: "x", targetTools: ["cursor"], visibility: "private", assetIds: [assetId] } });
      expect(ws.status).toBe(200);

      const rename = await request(server.baseUrl, "PUT", `/api/assets/${assetId}`, { cookie: c, body: { name: "new_stable_name" } });
      expect(rename.status).toBe(409);
      expect((await parseJson<any>(rename)).error).toContain("不能修改名称");

      const alias = await request(server.baseUrl, "PUT", `/api/assets/${assetId}`, { cookie: c, body: { alias: "新别名" } });
      expect(alias.status).toBe(200);
      const aliasData = (await parseJson<any>(alias)).data;
      expect(aliasData.name).toBe("stable_name");
      expect(aliasData.alias).toBe("新别名");
    });

    it("PUT without metadata field preserves existing metadata", async () => {
      await boot();
      const c = await login(server.baseUrl, "meta-keeper@example.com");
      const create = await request(server.baseUrl, "POST", "/api/assets", {
        cookie: c,
        body: { name: "m", type: "rule", description: "x", tags: [], files: [{ path: "README.md", content: "x" }], compatibleTools: ["cursor"], visibility: "public", metadata: { globs: ["**/*.tsx"] } },
      });
      expect(create.status).toBe(200);
      const id = (await parseJson<any>(create)).data.id;

      const put = await request(server.baseUrl, "PUT", `/api/assets/${id}`, { cookie: c, body: { description: "updated" } });
      expect(put.status).toBe(200);

      const get = await request(server.baseUrl, "GET", `/api/assets/${id}`, { cookie: c });
      const data = (await parseJson<any>(get)).data;
      expect(data.metadata).toEqual({ globs: ["**/*.tsx"] });
      expect(data.description).toBe("updated");
    });
  });

  describe("Workspace", () => {
    async function importPluginAndGetWorkspace(): Promise<string> {
      // 切到 cc-plugin fixture
      fx?.dispose();
      fx = createGitFixture(FIXTURE_CC_PLUGIN);
      await api.addMarketplace(fx.url);
      const wss = await api.listWorkspaces();
      const plugin = wss.find((w) => w.name === "example-plugin")!;
      expect(plugin).toBeDefined();
      return plugin.id;
    }

    it("PUT on plugin-derived workspace by importer returns 200", async () => {
      await boot();
      const wsId = await importPluginAndGetWorkspace();
      const res = await request(server.baseUrl, "PUT", `/api/workspaces/${wsId}`, { cookie, body: { description: "edited imported workspace" } });
      expect(res.status).toBe(200);
      expect((await parseJson<any>(res)).data.description).toBe("edited imported workspace");
    });

    it("DELETE on plugin-derived workspace returns 403", async () => {
      await boot();
      const wsId = await importPluginAndGetWorkspace();
      const res = await request(server.baseUrl, "DELETE", `/api/workspaces/${wsId}`, { cookie });
      expect(res.status).toBe(403);
      expect((await parseJson<any>(res)).error).toContain("只读");
    });

    it("PUT on user-created workspace works (control)", async () => {
      await boot();
      const create = await request(server.baseUrl, "POST", "/api/workspaces", { cookie, body: { name: "my-ws", description: "manual", targetTools: ["cursor"], visibility: "private" } });
      expect(create.status).toBe(200);
      const wsId = (await parseJson<any>(create)).data.id;
      const update = await request(server.baseUrl, "PUT", `/api/workspaces/${wsId}`, { cookie, body: { description: "updated" } });
      expect(update.status).toBe(200);
    });
  });
});
