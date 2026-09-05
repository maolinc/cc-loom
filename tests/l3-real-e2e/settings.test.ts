/**
 * L3 Settings — /api/settings/marketplace 与 /api/settings/ai GET/PUT。
 *
 * 真实 server 进程 + 真实 HTTP。
 * 不变量: 默认轮询间隔 360、PUT 持久化、非法值 400、AI key 只写不读、需鉴权。
 */
import { describe, it, expect, afterEach } from "vitest";
import { startServer, stopServer, type ServerHandle } from "@maolinc/cc-loom-testkit";
import { login, request, parseJson } from "./_http.js";

describe("L3 settings", () => {
  let server: ServerHandle;
  let cookie: string;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  async function boot(email = "settings-user@example.com", password = "test-user-password") {
    server = await startServer();
    cookie = await login(server.baseUrl, email, password);
  }

  it("GET returns the seeded default poll interval", async () => {
    await boot("admin@loom.test", "test-admin-password");
    const res = await request(server.baseUrl, "GET", "/api/settings/marketplace", { cookie });
    expect(res.status).toBe(200);
    expect((await parseJson<any>(res)).data.pollIntervalMinutes).toBe(360);
  });

  it("PUT updates the value and reflects on subsequent GET", async () => {
    await boot("admin@loom.test", "test-admin-password");
    const put = await request(server.baseUrl, "PUT", "/api/settings/marketplace", { cookie, body: { pollIntervalMinutes: 60 } });
    expect(put.status).toBe(200);
    expect((await parseJson<any>(put)).data.pollIntervalMinutes).toBe(60);
    const get = await request(server.baseUrl, "GET", "/api/settings/marketplace", { cookie });
    expect((await parseJson<any>(get)).data.pollIntervalMinutes).toBe(60);
  });

  it("PUT rejects values outside the allowed set with 400", async () => {
    await boot("admin@loom.test", "test-admin-password");
    const res = await request(server.baseUrl, "PUT", "/api/settings/marketplace", { cookie, body: { pollIntervalMinutes: 7 } });
    expect(res.status).toBe(400);
  });

  it("PUT rejects non-numeric value with 400", async () => {
    await boot("admin@loom.test", "test-admin-password");
    const res = await request(server.baseUrl, "PUT", "/api/settings/marketplace", { cookie, body: { pollIntervalMinutes: "many" } });
    expect(res.status).toBe(400);
  });

  it("GET/PUT stores AI generation settings without returning the API key", async () => {
    await boot();
    const initial = await request(server.baseUrl, "GET", "/api/settings/ai", { cookie });
    expect(initial.status).toBe(200);
    expect((await parseJson<any>(initial)).data).toMatchObject({ baseUrl: "", model: "gpt-4o-mini", apiKeyConfigured: false });

    const put = await request(server.baseUrl, "PUT", "/api/settings/ai", {
      cookie, body: { baseUrl: "https://api.example.com/v1", model: "model-a", apiKey: "sk-test" },
    });
    expect(put.status).toBe(200);
    expect((await parseJson<any>(put)).data).toEqual({ baseUrl: "https://api.example.com/v1", model: "model-a", apiKeyConfigured: true });

    const get = await request(server.baseUrl, "GET", "/api/settings/ai", { cookie });
    const getText = await get.text();
    const getData = JSON.parse(getText).data;
    expect(getData).toEqual({ baseUrl: "https://api.example.com/v1", model: "model-a", apiKeyConfigured: true });
    expect(getText).not.toContain("sk-test");
  });

  it("rejects Marketplace settings access from normal users", async () => {
    await boot();
    const get = await request(server.baseUrl, "GET", "/api/settings/marketplace", { cookie });
    const put = await request(server.baseUrl, "PUT", "/api/settings/marketplace", {
      cookie,
      body: { pollIntervalMinutes: 60 },
    });
    expect(get.status).toBe(403);
    expect(put.status).toBe(403);
  });

  it("PUT rejects invalid AI Base URL with 400", async () => {
    await boot();
    const res = await request(server.baseUrl, "PUT", "/api/settings/ai", {
      cookie, body: { baseUrl: "not-a-url", model: "model-a", apiKey: "sk-test" },
    });
    expect(res.status).toBe(400);
  });

  it("AI settings are isolated per user — one user's config is invisible to another", async () => {
    await boot("alice@example.com");
    // Alice 配置自己的 AI 设置
    const putA = await request(server.baseUrl, "PUT", "/api/settings/ai", {
      cookie, body: { baseUrl: "https://alice.example.com/v1", model: "alice-model", apiKey: "sk-alice" },
    });
    expect(putA.status).toBe(200);

    // Bob 登录后应看到默认空配置，看不到 Alice 的 baseUrl/model/key
    const cookieB = await login(server.baseUrl, "bob@example.com");
    const getB = await request(server.baseUrl, "GET", "/api/settings/ai", { cookie: cookieB });
    expect(getB.status).toBe(200);
    const textB = await getB.text();
    const dataB = JSON.parse(textB).data;
    expect(dataB).toEqual({ baseUrl: "", model: "gpt-4o-mini", apiKeyConfigured: false });
    expect(textB).not.toContain("sk-alice");
    expect(textB).not.toContain("alice.example.com");

    // Bob 配置自己的 AI 设置
    const putB = await request(server.baseUrl, "PUT", "/api/settings/ai", {
      cookie: cookieB, body: { baseUrl: "https://bob.example.com/v1", model: "bob-model", apiKey: "sk-bob" },
    });
    expect(putB.status).toBe(200);

    // Alice 再次读取，仍是自己的配置，不受 Bob 影响
    const getA2 = await request(server.baseUrl, "GET", "/api/settings/ai", { cookie });
    const textA2 = await getA2.text();
    const dataA2 = JSON.parse(textA2).data;
    expect(dataA2).toEqual({ baseUrl: "https://alice.example.com/v1", model: "alice-model", apiKeyConfigured: true });
    expect(textA2).not.toContain("sk-bob");
  });

  it("requires auth", async () => {
    server = await startServer();
    const get = await request(server.baseUrl, "GET", "/api/settings/marketplace");
    const put = await request(server.baseUrl, "PUT", "/api/settings/marketplace", { body: { pollIntervalMinutes: 60 } });
    const getAi = await request(server.baseUrl, "GET", "/api/settings/ai");
    const putAi = await request(server.baseUrl, "PUT", "/api/settings/ai", {
      body: { baseUrl: "https://api.example.com/v1", model: "model-a", apiKey: "sk-test" },
    });
    expect(get.status).toBe(401);
    expect(put.status).toBe(401);
    expect(getAi.status).toBe(401);
    expect(putAi.status).toBe(401);
  });
});
