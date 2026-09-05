/**
 * L3 Workspaces — POST 持久化 assetIds、GET 详情、DELETE、跨用户 403。
 *
 * 真实 server 进程 + 真实 HTTP。
 * 不变量: 创建时 assetIds 不丢失、详情一致、删除后 404、非 owner 403。
 */
import { describe, it, expect, afterEach } from "vitest";
import { startServer, stopServer, type ServerHandle } from "@maolinc/cc-loom-testkit";
import { login, request, parseJson } from "./_http.js";

describe("L3 workspaces", () => {
  let server: ServerHandle;
  let cookie: string;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  async function boot(email = "ws-user@example.com") {
    server = await startServer();
    cookie = await login(server.baseUrl, email);
  }

  async function createAsset(name: string): Promise<string> {
    const res = await request(server.baseUrl, "POST", "/api/assets", {
      cookie,
      body: { name, type: "skill", description: "x", tags: [], files: [{ path: "SKILL.md", content: "body" }], compatibleTools: ["cursor"], visibility: "private" },
    });
    expect(res.status).toBe(200);
    return (await parseJson<any>(res)).data.id;
  }

  it("POST persists assetIds and GET returns them", async () => {
    await boot();
    const a1 = await createAsset("asset-1");
    const a2 = await createAsset("asset-2");

    const create = await request(server.baseUrl, "POST", "/api/workspaces", {
      cookie,
      body: { name: "ws-with-assets", description: "preview should not be empty", targetTools: ["cursor"], visibility: "private", assetIds: [a1, a2] },
    });
    expect(create.status).toBe(200);
    const created = (await parseJson<any>(create)).data;
    expect(created.assets).toHaveLength(2);
    expect(created.assets.map((a: any) => a.id).sort()).toEqual([a1, a2].sort());

    const detail = await request(server.baseUrl, "GET", `/api/workspaces/${created.id}`, { cookie });
    expect(detail.status).toBe(200);
    const detailData = (await parseJson<any>(detail)).data;
    expect(detailData.assets).toHaveLength(2);
    expect(detailData.assets.map((a: any) => a.id).sort()).toEqual([a1, a2].sort());
  });

  it("POST without assetIds creates an empty workspace", async () => {
    await boot();
    const create = await request(server.baseUrl, "POST", "/api/workspaces", {
      cookie,
      body: { name: "ws-empty", description: "no assets yet", targetTools: ["cursor"], visibility: "private" },
    });
    expect(create.status).toBe(200);
    expect((await parseJson<any>(create)).data.assets).toEqual([]);
  });

  it("DELETE removes the workspace and its asset relations", async () => {
    await boot();
    const a1 = await createAsset("asset-del");
    const create = await request(server.baseUrl, "POST", "/api/workspaces", {
      cookie,
      body: { name: "ws-to-delete", description: "x", targetTools: ["cursor"], visibility: "private", assetIds: [a1] },
    });
    const wsId = (await parseJson<any>(create)).data.id;

    const del = await request(server.baseUrl, "DELETE", `/api/workspaces/${wsId}`, { cookie });
    expect(del.status).toBe(200);

    const after = await request(server.baseUrl, "GET", `/api/workspaces/${wsId}`, { cookie });
    expect(after.status).toBe(404);
  });

  it("DELETE by a non-owner returns 403", async () => {
    await boot();
    const create = await request(server.baseUrl, "POST", "/api/workspaces", {
      cookie,
      body: { name: "ws-someone-elses", description: "x", targetTools: ["cursor"], visibility: "private" },
    });
    const wsId = (await parseJson<any>(create)).data.id;

    const otherCookie = await login(server.baseUrl, "intruder@example.com");
    const del = await request(server.baseUrl, "DELETE", `/api/workspaces/${wsId}`, { cookie: otherCookie });
    expect(del.status).toBe(403);
  });
});
