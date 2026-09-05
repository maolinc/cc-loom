/**
 * L3 Admin — 超级管理员功能：admin seed、注册上限、白名单、用户管理（角色/停用）、
 * admin 越权操作、普通用户 403。
 *
 * 真实 server 进程 + 真实 HTTP。
 * 不变量:
 *   - admin@loom.test / test-admin-password 可登录且 role=admin
 *   - 普通用户访问 /api/admin/* → 403
 *   - 白名单开启后非白名单拒绝登录（admin 豁免）
 *   - 注册上限达上限拒绝新注册（admin 豁免）
 *   - 停用用户无法登录、会话立即失效
 *   - admin 可编辑/删除任意用户的 asset/workspace
 *   - admin 不能停用自己、不能取消自己的 admin 角色
 */
import { describe, it, expect, afterEach } from "vitest";
import { startServer, stopServer, type ServerHandle } from "@maolinc/cc-loom-testkit";
import { login, request, parseJson } from "./_http.js";

const ADMIN_EMAIL = "admin@loom.test";
const ADMIN_PASSWORD = "test-admin-password";

describe("L3 admin", () => {
  let server: ServerHandle;
  let adminCookie: string;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  async function boot() {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  }

  // ============ admin seed ============

  it("admin@loom.test is seeded with role=admin and default password", async () => {
    server = await startServer();
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.email).toBe(ADMIN_EMAIL);
    expect(body.data.role).toBe("admin");
  });

  it("admin@loom.test rejects wrong password", async () => {
    server = await startServer();
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  // ============ 普通用户 403 ============

  it("non-admin user gets 403 on /api/admin/users", async () => {
    server = await startServer();
    const cookie = await login(server.baseUrl, "user1@example.com");
    const res = await request(server.baseUrl, "GET", "/api/admin/users", { cookie });
    expect(res.status).toBe(403);
  });

  it("non-admin user gets 403 on /api/admin/registration", async () => {
    server = await startServer();
    const cookie = await login(server.baseUrl, "user2@example.com");
    const getRes = await request(server.baseUrl, "GET", "/api/admin/registration", { cookie });
    const putRes = await request(server.baseUrl, "PUT", "/api/admin/registration", { cookie, body: { maxUsers: 10 } });
    expect(getRes.status).toBe(403);
    expect(putRes.status).toBe(403);
  });

  it("non-admin user gets 403 on /api/admin/whitelist", async () => {
    server = await startServer();
    const cookie = await login(server.baseUrl, "user3@example.com");
    const getRes = await request(server.baseUrl, "GET", "/api/admin/whitelist", { cookie });
    const putRes = await request(server.baseUrl, "PUT", "/api/admin/whitelist", { cookie, body: { enabled: true, emails: [] } });
    expect(getRes.status).toBe(403);
    expect(putRes.status).toBe(403);
  });

  it("unauthenticated user gets 401 on admin endpoints", async () => {
    server = await startServer();
    const res = await request(server.baseUrl, "GET", "/api/admin/users");
    expect(res.status).toBe(401);
  });

  // ============ 用户列表 ============

  it("admin can list users including seeded admin", async () => {
    await boot();
    // 额外注册一个普通用户
    await login(server.baseUrl, "listuser@example.com");

    const res = await request(server.baseUrl, "GET", "/api/admin/users", { cookie: adminCookie });
    expect(res.status).toBe(200);
    const body = await parseJson<any>(res);
    expect(body.success).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(2);
    const emails = body.data.map((u: any) => u.email);
    expect(emails).toContain(ADMIN_EMAIL);
    expect(emails).toContain("listuser@example.com");
    // admin 行 role=admin
    const admin = body.data.find((u: any) => u.email === ADMIN_EMAIL);
    expect(admin.role).toBe("admin");
    expect(admin.disabled).toBe(false);
    // 普通用户 role=user
    const user = body.data.find((u: any) => u.email === "listuser@example.com");
    expect(user.role).toBe("user");
  });

  it("admin user list supports email search", async () => {
    await boot();
    await login(server.baseUrl, "searchable@example.com");
    await login(server.baseUrl, "other@example.com");

    const res = await request(server.baseUrl, "GET", "/api/admin/users?query=searchable", { cookie: adminCookie });
    expect(res.status).toBe(200);
    const body = await parseJson<any>(res);
    expect(body.total).toBe(1);
    expect(body.data[0].email).toBe("searchable@example.com");
  });

  // ============ 修改角色 ============

  it("admin can promote a user to admin and demote back", async () => {
    await boot();
    await login(server.baseUrl, "promote@example.com");

    const listRes = await request(server.baseUrl, "GET", "/api/admin/users", { cookie: adminCookie });
    const list = (await parseJson<any>(listRes)).data;
    const target = list.find((u: any) => u.email === "promote@example.com");
    expect(target.role).toBe("user");

    // promote
    const promoteRes = await request(server.baseUrl, "PUT", `/api/admin/users/${target.id}/role`, {
      cookie: adminCookie, body: { role: "admin" },
    });
    expect(promoteRes.status).toBe(200);
    expect((await parseJson<any>(promoteRes)).data.role).toBe("admin");

    // demote
    const demoteRes = await request(server.baseUrl, "PUT", `/api/admin/users/${target.id}/role`, {
      cookie: adminCookie, body: { role: "user" },
    });
    expect(demoteRes.status).toBe(200);
    expect((await parseJson<any>(demoteRes)).data.role).toBe("user");
  });

  it("admin cannot demote self (last admin protection)", async () => {
    await boot();
    // 查自己的 user id
    const meRes = await request(server.baseUrl, "GET", "/api/auth/me", { cookie: adminCookie });
    const meId = (await parseJson<any>(meRes)).data.userId;

    const res = await request(server.baseUrl, "PUT", `/api/admin/users/${meId}/role`, {
      cookie: adminCookie, body: { role: "user" },
    });
    expect(res.status).toBe(400);
    const body = await parseJson<any>(res);
    expect(body.error).toContain("不能取消自己的管理员角色");
  });

  it("admin role change rejects unknown user id with 404", async () => {
    await boot();
    const res = await request(server.baseUrl, "PUT", "/api/admin/users/nonexistent-id/role", {
      cookie: adminCookie, body: { role: "user" },
    });
    expect(res.status).toBe(404);
  });

  // ============ 停用/启用 ============

  it("disabled user cannot login and existing sessions are invalidated", async () => {
    await boot();
    // 注册一个用户并登录
    const userCookie = await login(server.baseUrl, "disableme@example.com");

    // 验证 session 有效
    const meBefore = await request(server.baseUrl, "GET", "/api/auth/me", { cookie: userCookie });
    expect(meBefore.status).toBe(200);

    // admin 停用该用户
    const listRes = await request(server.baseUrl, "GET", "/api/admin/users", { cookie: adminCookie });
    const list = (await parseJson<any>(listRes)).data;
    const target = list.find((u: any) => u.email === "disableme@example.com");

    const disableRes = await request(server.baseUrl, `PUT`, `/api/admin/users/${target.id}/status`, {
      cookie: adminCookie, body: { disabled: true },
    });
    expect(disableRes.status).toBe(200);
    expect((await parseJson<any>(disableRes)).data.disabled).toBe(true);

    // 旧 session 失效
    const meAfter = await request(server.baseUrl, "GET", "/api/auth/me", { cookie: userCookie });
    expect(meAfter.status).toBe(401);

    // 再用正确密码登录也被拒
    const relogin = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "disableme@example.com", password: "test-user-password" }),
    });
    expect(relogin.status).toBe(403);
    const reloginBody = await relogin.json();
    expect(reloginBody.error).toContain("停用");
  });

  it("re-enabling a user restores login ability", async () => {
    await boot();
    await login(server.baseUrl, "reenable@example.com");

    const listRes = await request(server.baseUrl, "GET", "/api/admin/users", { cookie: adminCookie });
    const list = (await parseJson<any>(listRes)).data;
    const target = list.find((u: any) => u.email === "reenable@example.com");

    // 停用
    await request(server.baseUrl, "PUT", `/api/admin/users/${target.id}/status`, {
      cookie: adminCookie, body: { disabled: true },
    });
    // 启用
    const enableRes = await request(server.baseUrl, "PUT", `/api/admin/users/${target.id}/status`, {
      cookie: adminCookie, body: { disabled: false },
    });
    expect(enableRes.status).toBe(200);
    expect((await parseJson<any>(enableRes)).data.disabled).toBe(false);

    // 能正常登录
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "reenable@example.com", password: "test-user-password" }),
    });
    expect(loginRes.status).toBe(200);
  });

  it("admin cannot disable self", async () => {
    await boot();
    const meRes = await request(server.baseUrl, "GET", "/api/auth/me", { cookie: adminCookie });
    const meId = (await parseJson<any>(meRes)).data.userId;

    const res = await request(server.baseUrl, "PUT", `/api/admin/users/${meId}/status`, {
      cookie: adminCookie, body: { disabled: true },
    });
    expect(res.status).toBe(400);
    const body = await parseJson<any>(res);
    expect(body.error).toContain("不能停用自己的账户");
  });

  // ============ 注册上限 ============

  it("registration max_users blocks new user registration", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 先注册一个普通用户
    await login(server.baseUrl, "quota-user1@example.com");

    // 当前 2 人（admin + quota-user1），设上限为 2
    const putRes = await request(server.baseUrl, "PUT", "/api/admin/registration", {
      cookie: adminCookie, body: { maxUsers: 2 },
    });
    expect(putRes.status).toBe(200);
    expect((await parseJson<any>(putRes)).data.maxUsers).toBe(2);

    // 第三个用户注册被拒
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "quota-user2@example.com", password: "test-user-password" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("上限");
  });

  it("registration maxUsers=0 means unlimited", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    await request(server.baseUrl, "PUT", "/api/admin/registration", {
      cookie: adminCookie, body: { maxUsers: 0 },
    });

    // 注册多个用户都成功
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `unlimited-${i}@example.com`, password: "test-user-password" }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("admin is exempt from registration limit", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 设上限为 1
    await request(server.baseUrl, "PUT", "/api/admin/registration", {
      cookie: adminCookie, body: { maxUsers: 1 },
    });

    // admin 仍能登录（已存在，不是注册，但验证不受限）
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
  });

  it("GET /admin/registration returns current count", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await request(server.baseUrl, "GET", "/api/admin/registration", { cookie: adminCookie });
    expect(res.status).toBe(200);
    const body = await parseJson<any>(res);
    expect(body.data.maxUsers).toBe(0); // default unlimited
    expect(body.data.currentCount).toBeGreaterThanOrEqual(1); // at least admin
  });

  // ============ 白名单 ============

  it("whitelist blocks non-whitelisted login (existing user)", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 先注册一个普通用户
    await login(server.baseUrl, "wl-user@example.com");

    // 开启白名单，只放 admin
    const putRes = await request(server.baseUrl, "PUT", "/api/admin/whitelist", {
      cookie: adminCookie,
      body: { enabled: true, emails: [] },
    });
    expect(putRes.status).toBe(200);

    // 已注册的非白名单用户登录被拒
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "wl-user@example.com", password: "test-user-password" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("白名单");
  });

  it("whitelist blocks new registration for non-whitelisted email", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 开启白名单，仅允许 specific@example.com
    await request(server.baseUrl, "PUT", "/api/admin/whitelist", {
      cookie: adminCookie,
      body: { enabled: true, emails: ["specific@example.com"] },
    });

    // 非白名单邮箱注册被拒
    const blocked = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "blocked@example.com", password: "test-user-password" }),
    });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toContain("白名单");

    // 白名单邮箱可注册
    const allowed = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "specific@example.com", password: "test-user-password" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("admin is exempt from whitelist", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 开启白名单，不放 admin
    await request(server.baseUrl, "PUT", "/api/admin/whitelist", {
      cookie: adminCookie,
      body: { enabled: true, emails: ["someone-else@example.com"] },
    });

    // admin 仍能登录
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
  });

  it("disabling whitelist restores open login", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 开启白名单
    await request(server.baseUrl, "PUT", "/api/admin/whitelist", {
      cookie: adminCookie,
      body: { enabled: true, emails: [] },
    });
    // 关闭白名单
    await request(server.baseUrl, "PUT", "/api/admin/whitelist", {
      cookie: adminCookie,
      body: { enabled: false, emails: [] },
    });

    // 任意邮箱可注册
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "freelogin@example.com", password: "test-user-password" }),
    });
    expect(res.status).toBe(200);
  });

  it("GET /admin/whitelist returns stored config", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    const emails = ["a@example.com", "b@example.com"];
    await request(server.baseUrl, "PUT", "/api/admin/whitelist", {
      cookie: adminCookie,
      body: { enabled: true, emails },
    });

    const res = await request(server.baseUrl, "GET", "/api/admin/whitelist", { cookie: adminCookie });
    expect(res.status).toBe(200);
    const body = await parseJson<any>(res);
    expect(body.data.enabled).toBe(true);
    expect(body.data.emails).toEqual(emails);
  });

  it("whitelist PUT rejects invalid email format", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await request(server.baseUrl, "PUT", "/api/admin/whitelist", {
      cookie: adminCookie,
      body: { enabled: true, emails: ["not-an-email"] },
    });
    expect(res.status).toBe(400);
  });

  // ============ admin 越权操作 ============

  it("admin can edit another user's asset", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 普通用户创建 asset
    const userCookie = await login(server.baseUrl, "owner@example.com");
    const createRes = await request(server.baseUrl, "POST", "/api/assets", {
      cookie: userCookie,
      body: {
        name: "admin-edit-test",
        type: "rule",
        description: "original",
        tags: [],
        files: [{ path: "rule.md", content: "# rule" }],
        compatibleTools: ["cursor"],
        visibility: "private",
        metadata: { globs: ["**/*.ts"] },
      },
    });
    expect(createRes.status).toBe(200);
    const asset = (await parseJson<any>(createRes)).data;

    // admin 编辑该 asset
    const editRes = await request(server.baseUrl, "PUT", `/api/assets/${asset.id}`, {
      cookie: adminCookie,
      body: { description: "admin edited" },
    });
    expect(editRes.status).toBe(200);
    expect((await parseJson<any>(editRes)).data.description).toBe("admin edited");
  });

  it("admin can delete another user's asset", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    const userCookie = await login(server.baseUrl, "delowner@example.com");
    const createRes = await request(server.baseUrl, "POST", "/api/assets", {
      cookie: userCookie,
      body: {
        name: "admin-del-test",
        type: "rule",
        description: "to be deleted",
        tags: [],
        files: [{ path: "rule.md", content: "# rule" }],
        compatibleTools: ["cursor"],
        visibility: "private",
        metadata: { globs: ["**/*.ts"] },
      },
    });
    const asset = (await parseJson<any>(createRes)).data;

    const delRes = await request(server.baseUrl, "DELETE", `/api/assets/${asset.id}`, { cookie: adminCookie });
    expect(delRes.status).toBe(200);
  });

  it("admin can edit another user's workspace", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 普通用户创建 workspace
    const userCookie = await login(server.baseUrl, "wsowner@example.com");
    const createRes = await request(server.baseUrl, "POST", "/api/workspaces", {
      cookie: userCookie,
      body: {
        name: "admin-ws-edit",
        description: "original",
        targetTools: ["cursor"],
        visibility: "private",
      },
    });
    const ws = (await parseJson<any>(createRes)).data;

    // admin 编辑
    const editRes = await request(server.baseUrl, "PUT", `/api/workspaces/${ws.id}`, {
      cookie: adminCookie,
      body: { description: "admin edited" },
    });
    expect(editRes.status).toBe(200);
    expect((await parseJson<any>(editRes)).data.description).toBe("admin edited");
  });

  it("admin can delete another user's workspace", async () => {
    server = await startServer();
    adminCookie = await login(server.baseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);

    const userCookie = await login(server.baseUrl, "wsdelowner@example.com");
    const createRes = await request(server.baseUrl, "POST", "/api/workspaces", {
      cookie: userCookie,
      body: {
        name: "admin-ws-del",
        description: "to be deleted",
        targetTools: ["cursor"],
        visibility: "private",
      },
    });
    const ws = (await parseJson<any>(createRes)).data;

    const delRes = await request(server.baseUrl, "DELETE", `/api/workspaces/${ws.id}`, { cookie: adminCookie });
    expect(delRes.status).toBe(200);
  });

  // ============ /me 返回 role ============

  it("login response and /me both include role field", async () => {
    server = await startServer();
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rolecheck@example.com", password: "test-user-password" }),
    });
    const loginBody = await loginRes.json();
    expect(loginBody.data.role).toBe("user");

    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0];
    const meRes = await fetch(`${server.baseUrl}/api/auth/me`, { headers: { cookie } });
    const meBody = await meRes.json();
    expect(meBody.data.role).toBe("user");
  });
});
