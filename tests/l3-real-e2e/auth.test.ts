/**
 * L3 Auth — login (auto-create), session cookie behavior, logout, /me, password change.
 *
 * 真实 server 进程 + 真实 HTTP（非 fastify.inject）。
 * 不变量: 登录自动建号、错误密码 401、cookie/Bearer 双通道鉴权、logout 失效 session。
 */
import { describe, it, expect, afterEach } from "vitest";
import { startServer, stopServer, type ServerHandle } from "@maolinc/cc-loom-testkit";

describe("L3 auth", () => {
  let server: ServerHandle;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  it("auto-creates a user with the submitted password", async () => {
    server = await startServer();
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", password: "test-user-password" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.email).toBe("alice@example.com");
    expect(res.headers.get("set-cookie")).toBeDefined();
  });

  it("rejects a weak password when registering a new user", async () => {
    server = await startServer();
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "weak@example.com", password: "short" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("6");
  });

  it("rejects login with wrong password on existing account", async () => {
    server = await startServer();
    await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com", password: "test-user-password" }),
    });
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com", password: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("密码");
  });

  it("rejects login with malformed email", async () => {
    server = await startServer();
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "test-user-password" }),
    });
    expect(res.status).toBe(400);
  });

  it("/api/auth/me returns user when session cookie is valid", async () => {
    server = await startServer();
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "carol@example.com", password: "test-user-password" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];

    const res = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.email).toBe("carol@example.com");
  });

  it("/api/auth/me returns 401 without cookie", async () => {
    server = await startServer();
    const res = await fetch(`${server.baseUrl}/api/auth/me`);
    expect(res.status).toBe(401);
  });

  // 回归: CLI 用 Bearer token 调 /api/auth/me 必须能通过 (requireAnyAuth)
  it("/api/auth/me accepts a valid CLI Bearer token", async () => {
    server = await startServer();
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "henry@example.com", password: "test-user-password" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];
    const tokenRes = await fetch(`${server.baseUrl}/api/auth/cli-token`, {
      headers: { cookie },
    });
    const token = (await tokenRes.json()).data.token;

    const meRes = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).data.email).toBe("henry@example.com");
  });

  it("/api/auth/me rejects an unknown Bearer token with 401", async () => {
    server = await startServer();
    const res = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: { authorization: "Bearer prsm_deadbeef" },
    });
    expect(res.status).toBe(401);
  });

  it("logout invalidates session cookie", async () => {
    server = await startServer();
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dave@example.com", password: "test-user-password" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];

    const logoutRes = await fetch(`${server.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    expect(logoutRes.status).toBe(200);

    const meRes = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: { cookie },
    });
    expect(meRes.status).toBe(401);
  });

  it("change-password updates hash and rejects old password afterwards", async () => {
    server = await startServer();
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "eve@example.com", password: "test-user-password" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];

    const change = await fetch(`${server.baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "test-user-password", newPassword: "new-secure-password" }),
    });
    expect(change.status).toBe(200);

    const oldLogin = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "eve@example.com", password: "test-user-password" }),
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "eve@example.com", password: "new-secure-password" }),
    });
    expect(newLogin.status).toBe(200);
  });

  it("cli-token endpoint creates and returns a stable token", async () => {
    server = await startServer();
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "frank@example.com", password: "test-user-password" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];

    const a = await fetch(`${server.baseUrl}/api/auth/cli-token`, { headers: { cookie } });
    const b = await fetch(`${server.baseUrl}/api/auth/cli-token`, { headers: { cookie } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const tokenA = (await a.json()).data.token;
    const tokenB = (await b.json()).data.token;
    expect(tokenA).toBe(tokenB);
    expect(tokenA).toMatch(/^prsm_[a-f0-9]+$/);
  });

  it("cli-token regenerate replaces the old token", async () => {
    server = await startServer();
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "grace@example.com", password: "test-user-password" }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];

    const before = (await (await fetch(`${server.baseUrl}/api/auth/cli-token`, { headers: { cookie } })).json()).data.token;
    const regen = await fetch(`${server.baseUrl}/api/auth/cli-token/regenerate`, {
      method: "POST",
      headers: { cookie },
    });
    expect(regen.status).toBe(200);
    const after = (await regen.json()).data.token;
    expect(after).not.toBe(before);
  });
});
