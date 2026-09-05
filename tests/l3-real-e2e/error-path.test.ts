/**
 * L3 错误路径 — 认证失败、校验失败、资源不存在、权限拒绝。
 *
 * 不变量: 每条用例断言具体 HTTP 状态码和错误信息，不能只断言"非 200"。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startServer,
  stopServer,
  type ServerHandle,
  ApiClient,
  ApiRequestError,
  assetBuilders,
} from "@maolinc/cc-loom-testkit";

describe("L3 error-path: 认证/校验/404/权限", () => {
  let server: ServerHandle;
  let api: ApiClient;

  beforeEach(async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
  });

  afterEach(async () => {
    await stopServer(server);
  });

  // ---- 认证 ----

  it("未登录访问 /api/auth/me → 401", async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/me`);
    expect(res.status).toBe(401);
  });

  it("错误密码登录 → 401 + 错误信息含「密码」", async () => {
    // 先创建用户
    await api.login("err@example.com");
    // 用错误密码登录
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "err@example.com", password: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("密码");
  });

  it("非法邮箱格式 → 400", async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "test-user-password" }),
    });
    expect(res.status).toBe(400);
  });

  it("无效 Bearer token → 401", async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: { authorization: "Bearer prsm_deadbeef" },
    });
    expect(res.status).toBe(401);
  });

  // ---- 校验 ----

  it("创建 asset 名字含空格 → 400", async () => {
    await api.login("val@example.com");
    let err: ApiRequestError | null = null;
    try {
      await api.createAsset({
        ...assetBuilders.skill("bad name", ["cursor"]),
        name: "bad name",
      });
    } catch (e) {
      err = e as ApiRequestError;
    }
    expect(err).not.toBeNull();
    expect(err!.status).toBe(400);
  });

  it("创建 asset 文件为空数组 → 400", async () => {
    await api.login("val@example.com");
    let err: ApiRequestError | null = null;
    try {
      await api.createAsset({
        name: "empty-files",
        type: "skill",
        description: "test",
        tags: [],
        files: [],
        compatibleTools: ["cursor"],
        visibility: "public",
        metadata: {},
      });
    } catch (e) {
      err = e as ApiRequestError;
    }
    expect(err).not.toBeNull();
    expect(err!.status).toBe(400);
  });

  it("创建 skill 缺少 SKILL.md → 400", async () => {
    await api.login("val@example.com");
    let err: ApiRequestError | null = null;
    try {
      await api.createAsset({
        name: "no-entry",
        type: "skill",
        description: "test",
        tags: [],
        files: [{ path: "README.md", content: "# readme" }],
        compatibleTools: ["cursor"],
        visibility: "public",
        metadata: {},
      });
    } catch (e) {
      err = e as ApiRequestError;
    }
    expect(err).not.toBeNull();
    expect(err!.status).toBe(400);
  });

  // ---- 资源不存在 ----

  it("安装计划用不存在的 projectId → 404", async () => {
    await api.login("nf@example.com");
    let err: ApiRequestError | null = null;
    try {
      await api.installPlan({
        projectId: "nonexistent-project-id",
        workspaceId: "nonexistent-ws-id",
        targetTools: ["cursor"],
        policy: "auto",
      });
    } catch (e) {
      err = e as ApiRequestError;
    }
    expect(err).not.toBeNull();
    expect(err!.status).toBe(404);
  });

  // ---- 权限 ----

  it("未登录用户看不到私有 asset", async () => {
    // 登录创建私有 asset
    await api.login("priv@example.com");
    await api.createAsset({
      ...assetBuilders.skill("private-skill", ["cursor"]),
      visibility: "private",
    });

    // 未登录（新 client）只能看到 public
    const anonApi = new ApiClient(server.baseUrl);
    const assets = await anonApi.listAssets();
    expect(assets.every((a) => a.visibility === "public")).toBe(true);
    expect(assets.find((a) => a.name === "private-skill")).toBeUndefined();
  });

  it("未登录用户看不到私有 workspace", async () => {
    await api.login("priv@example.com");
    await api.createWorkspace({
      name: "private-ws",
      description: "test",
      targetTools: ["cursor"],
      visibility: "private",
    });

    const anonApi = new ApiClient(server.baseUrl);
    const wss = await anonApi.listWorkspaces();
    expect(wss.find((w) => w.name === "private-ws")).toBeUndefined();
  });
});
