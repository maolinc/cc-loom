/**
 * L3 Projects 路由鉴权 — /api/projects GET 对 Bearer(CLI) 与 Session(Web) 双通道支持。
 *
 * 真实 server 进程 + 真实 HTTP。
 * 不变量: 两种凭据都能拿到列表；无凭据 401；无效 Bearer 401；鉴权过后不存在项目 404。
 */
import { describe, it, expect, afterEach } from "vitest";
import { startServer, stopServer, type ServerHandle } from "@maolinc/cc-loom-testkit";
import { login, getCliToken, request, parseJson } from "./_http.js";

describe("L3 projects routes auth", () => {
  let server: ServerHandle;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  it("GET /api/projects 用 Bearer token 能拿到列表（CLI 调用路径）", async () => {
    server = await startServer();
    const token = await getCliToken(server.baseUrl, "ivy@example.com");
    const res = await request(server.baseUrl, "GET", "/api/projects", { bearer: token });
    expect(res.status).toBe(200);
    expect((await parseJson<any>(res)).data).toEqual([]);
  });

  it("GET /api/projects 用 session cookie 也能拿到列表（Web 调用路径）", async () => {
    server = await startServer();
    const cookie = await login(server.baseUrl, "jack@example.com");
    const res = await request(server.baseUrl, "GET", "/api/projects", { cookie });
    expect(res.status).toBe(200);
    expect((await parseJson<any>(res)).data).toEqual([]);
  });

  it("GET /api/projects 没凭据时返回 401", async () => {
    server = await startServer();
    const res = await request(server.baseUrl, "GET", "/api/projects");
    expect(res.status).toBe(401);
  });

  it("GET /api/projects 用无效 Bearer 返回 401", async () => {
    server = await startServer();
    const res = await request(server.baseUrl, "GET", "/api/projects", { bearer: "prsm_deadbeef" });
    expect(res.status).toBe(401);
  });

  it("GET /api/projects/:id 用 Bearer token 也能查（不存在时 404 而非 401）", async () => {
    server = await startServer();
    const token = await getCliToken(server.baseUrl, "kate@example.com");
    const res = await request(server.baseUrl, "GET", "/api/projects/does-not-exist", { bearer: token });
    expect(res.status).toBe(404);
  });
});
