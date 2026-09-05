/**
 * L3 凭据值管理 + 能力鉴权声明（ADR-0003 统一绑定列表）。
 *
 * 真实 server + 真实 HTTP。
 * 不变量：凭据值加密、REST 永不返回明文（只 hasValue）、非法名 400、同 name 409、
 *   更新留空保原值、description 回环、env 下发仅在线设备（离线进 skipped）、需鉴权；
 *   能力 auth bindings 创建/读取/编辑闭环、缺 envKey/path 400、path 绑定仅对 mcp 有效。
 * 注：AI 生成相关用例按 principles §4「AI 接口不测」剔除（外部依赖）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { startServer, stopServer, type ServerHandle } from "@maolinc/cc-loom-testkit";
import { login, getCliToken, request, parseJson } from "./_http.js";

describe("L3 credentials + asset auth bindings", () => {
  let server: ServerHandle;
  let cookie: string;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  async function boot() {
    server = await startServer();
    cookie = await login(server.baseUrl, "cred-user@example.com");
  }

  it("创建凭据后列表只返回 hasValue，不返回明文", async () => {
    await boot();
    const create = await request(server.baseUrl, "POST", "/api/credentials", { cookie, body: { name: "GITHUB_TOKEN", axis: "env", value: "ghp_secret_value" } });
    expect(create.status).toBe(200);
    const created = (await parseJson<any>(create)).data;
    expect(created.name).toBe("GITHUB_TOKEN");
    expect(created.hasValue).toBe(true);

    const list = await request(server.baseUrl, "GET", "/api/credentials", { cookie });
    const listText = await list.text();
    const data = JSON.parse(listText).data;
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("GITHUB_TOKEN");
    expect(data[0].hasValue).toBe(true);
    expect(listText).not.toContain("ghp_secret_value");
  });

  it("拒绝非法凭据名", async () => {
    await boot();
    const res = await request(server.baseUrl, "POST", "/api/credentials", { cookie, body: { name: "1bad", axis: "env", value: "v" } });
    expect(res.status).toBe(400);
  });

  it("同 name 重复创建返回 409", async () => {
    await boot();
    await request(server.baseUrl, "POST", "/api/credentials", { cookie, body: { name: "MY_KEY", axis: "env", value: "v1" } });
    const dup = await request(server.baseUrl, "POST", "/api/credentials", { cookie, body: { name: "MY_KEY", axis: "env", value: "v2" } });
    expect(dup.status).toBe(409);
  });

  it("更新 value 留空保持原值", async () => {
    await boot();
    const create = await request(server.baseUrl, "POST", "/api/credentials", { cookie, body: { name: "K1", axis: "env", value: "original" } });
    const id = (await parseJson<any>(create)).data.id;
    const upd = await request(server.baseUrl, "PUT", `/api/credentials/${id}`, { cookie, body: { name: "K1" } });
    expect(upd.status).toBe(200);
    expect((await parseJson<any>(upd)).data.hasValue).toBe(true);
  });

  it("description 字段创建与回环", async () => {
    await boot();
    const create = await request(server.baseUrl, "POST", "/api/credentials", { cookie, body: { name: "WITH_DESC", axis: "env", value: "v", description: "GitHub API 凭据" } });
    expect(create.status).toBe(200);
    const id = (await parseJson<any>(create)).data.id;
    const list = await request(server.baseUrl, "GET", "/api/credentials", { cookie });
    const item = (await parseJson<any>(list)).data.find((x: any) => x.name === "WITH_DESC");
    expect(item.description).toBe("GitHub API 凭据");

    const upd = await request(server.baseUrl, "PUT", `/api/credentials/${id}`, { cookie, body: { description: "改后的描述" } });
    expect(upd.status).toBe(200);
    expect((await parseJson<any>(upd)).data.description).toBe("改后的描述");
  });

  it("env 下发到离线设备进 skipped，不发 WS", async () => {
    await boot();
    const token = await getCliToken(server.baseUrl, "cred-user@example.com");
    const devReg = await request(server.baseUrl, "POST", "/api/devices/register", { bearer: token, body: { deviceName: "offline-dev" } });
    const deviceId = (await parseJson<any>(devReg)).data.id;

    const create = await request(server.baseUrl, "POST", "/api/credentials", { cookie, body: { name: "OFFLINE_KEY", axis: "env", value: "v" } });
    const id = (await parseJson<any>(create)).data.id;

    const dist = await request(server.baseUrl, "POST", `/api/credentials/${id}/distribute`, { cookie, body: { axis: "env", targetIds: [deviceId] } });
    expect(dist.status).toBe(200);
    const data = (await parseJson<any>(dist)).data;
    expect(data.pushed).toHaveLength(0);
    expect(data.skipped).toHaveLength(1);
    expect(data.skipped[0].reason).toContain("离线");
  });

  it("未登录访问被拒", async () => {
    await boot();
    const res = await request(server.baseUrl, "GET", "/api/credentials");
    expect(res.status).toBe(401);
  });

  it("创建带 env 绑定的能力，读取回环", async () => {
    await boot();
    const create = await request(server.baseUrl, "POST", "/api/assets", {
      cookie,
      body: {
        name: "authd_capability", type: "mcp", description: "needs token", tags: [],
        files: [{ path: "mcp.json", content: "{}" }], compatibleTools: ["cursor"], visibility: "private",
        metadata: { transport: "http", url: "https://example.com" },
        auth: { bindings: [{ credentialName: "MY_API_KEY", kind: "env", envKey: "MY_API_KEY", authPageUrl: "https://example.com/keys" }] },
      },
    });
    expect(create.status).toBe(200);
    const id = (await parseJson<any>(create)).data.id;

    const get = await request(server.baseUrl, "GET", `/api/assets/${id}`, { cookie });
    const auth = (await parseJson<any>(get)).data.auth;
    expect(auth?.bindings).toHaveLength(1);
    expect(auth.bindings[0].credentialName).toBe("MY_API_KEY");
    expect(auth.bindings[0].kind).toBe("env");
    expect(auth.bindings[0].envKey).toBe("MY_API_KEY");
    expect(auth.bindings[0].authPageUrl).toBe("https://example.com/keys");
  });

  it("env 绑定缺 envKey 被拒", async () => {
    await boot();
    const res = await request(server.baseUrl, "POST", "/api/assets", {
      cookie,
      body: {
        name: "bad_auth", type: "skill", description: "x", tags: [],
        files: [{ path: "SKILL.md", content: "x" }], compatibleTools: ["cursor"], visibility: "private",
        auth: { bindings: [{ credentialName: "X", kind: "env" }] },
      },
    });
    expect(res.status).toBe(400);
  });

  it("path 绑定缺 path 被拒", async () => {
    await boot();
    const res = await request(server.baseUrl, "POST", "/api/assets", {
      cookie,
      body: {
        name: "bad_path", type: "mcp", description: "x", tags: [],
        files: [{ path: "mcp.json", content: "{}" }], compatibleTools: ["cursor"], visibility: "private",
        metadata: { transport: "http", url: "https://example.com" },
        auth: { bindings: [{ credentialName: "tapd-token", kind: "path" }] },
      },
    });
    expect(res.status).toBe(400);
  });

  it("path 绑定对非 mcp 能力被拒", async () => {
    await boot();
    const res = await request(server.baseUrl, "POST", "/api/assets", {
      cookie,
      body: {
        name: "path_on_skill", type: "skill", description: "x", tags: [],
        files: [{ path: "SKILL.md", content: "x" }], compatibleTools: ["cursor"], visibility: "private",
        auth: { bindings: [{ credentialName: "c", kind: "path", path: "headers/X" }] },
      },
    });
    expect(res.status).toBe(400);
  });

  it("编辑能力可把 auth 从空改为 env 绑定", async () => {
    await boot();
    const create = await request(server.baseUrl, "POST", "/api/assets", {
      cookie,
      body: { name: "edit_auth", type: "skill", description: "x", tags: [], files: [{ path: "SKILL.md", content: "x" }], compatibleTools: ["cursor"], visibility: "private" },
    });
    const id = (await parseJson<any>(create)).data.id;
    const upd = await request(server.baseUrl, "PUT", `/api/assets/${id}`, { cookie, body: { auth: { bindings: [{ credentialName: "EDIT_KEY", kind: "env", envKey: "EDIT_KEY" }] } } });
    expect(upd.status).toBe(200);
    const auth = (await parseJson<any>(upd)).data.auth;
    expect(auth?.bindings).toHaveLength(1);
    expect(auth.bindings[0].envKey).toBe("EDIT_KEY");
  });

  it("同资产内凭据名重复被拒", async () => {
    await boot();
    const res = await request(server.baseUrl, "POST", "/api/assets", {
      cookie,
      body: {
        name: "dup_cred", type: "mcp", description: "x", tags: [],
        files: [{ path: "mcp.json", content: "{}" }], compatibleTools: ["cursor"], visibility: "private",
        metadata: { transport: "http", url: "https://example.com" },
        auth: { bindings: [
          { credentialName: "DUP", kind: "env", envKey: "DUP" },
          { credentialName: "DUP", kind: "path", path: "headers/X" },
        ] },
      },
    });
    expect(res.status).toBe(400);
  });
});
