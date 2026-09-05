/**
 * L3 `loom push` — POST /api/push 核心场景 + capabilitySet 同名唯一约束。
 *
 * 真实 server 进程 + 真实 HTTP（Bearer 鉴权）。
 * 不变量: 首推建 ws、同名覆盖、upsert 资产、鉴权、空 assets 400、单推内同名冲突 409、ws 名唯一。
 */
import { describe, it, expect, afterEach } from "vitest";
import { startServer, stopServer, type ServerHandle } from "@maolinc/cc-loom-testkit";
import { login, getCliToken, request, parseJson } from "./_http.js";

describe("L3 push", () => {
  let server: ServerHandle;
  let cookie: string;
  let cliToken: string;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  async function boot() {
    server = await startServer();
    cookie = await login(server.baseUrl, "push-user@example.com");
    cliToken = await getCliToken(server.baseUrl, "push-user@example.com");
  }

  function pushPayload(name: string, overrides: Record<string, any> = {}) {
    return {
      name,
      visibility: "private",
      targetTool: "claudecode",
      assets: [
        {
          sourcePath: "skills/my-skill",
          name: "my-skill",
          type: "skill" as const,
          description: "test skill",
          files: [{ path: "SKILL.md", content: "# My Skill" }],
          compatibleTools: ["claudecode"],
          version: "1.0.0",
          tags: [],
          originAuthor: null,
          metadata: {},
        },
      ],
      ...overrides,
    };
  }

  it("creates a new capabilitySet on first push", async () => {
    await boot();
    const res = await request(server.baseUrl, "POST", "/api/push", { bearer: cliToken, body: pushPayload("push-user/my-project") });
    expect(res.status).toBe(200);
    const data = (await parseJson<any>(res)).data;
    expect(data.created).toBe(true);
    expect(data.capabilitySetName).toBe("push-user/my-project");
    expect(data.assetCount).toBe(1);

    const detail = await request(server.baseUrl, "GET", `/api/capability-sets/${data.capabilitySetId}`, { cookie });
    expect(detail.status).toBe(200);
    const ws = (await parseJson<any>(detail)).data;
    expect(ws.name).toBe("push-user/my-project");
    expect(ws.assets).toHaveLength(1);
    expect(ws.assets[0].name).toBe("my-skill");
  });

  it("overwrites capabilitySet members on re-push with same name", async () => {
    await boot();
    const first = await request(server.baseUrl, "POST", "/api/push", { bearer: cliToken, body: pushPayload("push-user/repush") });
    expect(first.status).toBe(200);
    const firstData = (await parseJson<any>(first)).data;
    expect(firstData.created).toBe(true);

    const second = await request(server.baseUrl, "POST", "/api/push", {
      bearer: cliToken,
      body: pushPayload("push-user/repush", {
        assets: [
          {
            sourcePath: "rules/my-rule", name: "my-rule", type: "rule", description: "test rule",
            files: [{ path: "my-rule.md", content: "be strict" }], compatibleTools: ["claudecode"],
            version: "1.0.0", tags: [], originAuthor: null, metadata: { globs: ["*.ts"] },
          },
        ],
      }),
    });
    expect(second.status).toBe(200);
    const secondData = (await parseJson<any>(second)).data;
    expect(secondData.created).toBe(false);
    expect(secondData.capabilitySetId).toBe(firstData.capabilitySetId);
    expect(secondData.assetCount).toBe(1);

    const detail = await request(server.baseUrl, "GET", `/api/capability-sets/${secondData.capabilitySetId}`, { cookie });
    const ws = (await parseJson<any>(detail)).data;
    expect(ws.assets).toHaveLength(1);
    expect(ws.assets[0].name).toBe("my-rule");
    expect(ws.assets[0].type).toBe("rule");
  });

  it("upserts assets by (author, type, name) on re-push", async () => {
    await boot();
    await request(server.baseUrl, "POST", "/api/push", { bearer: cliToken, body: pushPayload("push-user/upsert") });
    const second = await request(server.baseUrl, "POST", "/api/push", {
      bearer: cliToken,
      body: pushPayload("push-user/upsert", {
        assets: [
          {
            sourcePath: "skills/my-skill", name: "my-skill", type: "skill", description: "updated skill",
            files: [{ path: "SKILL.md", content: "# Updated Content" }], compatibleTools: ["claudecode"],
            version: "2.0.0", tags: [], originAuthor: null, metadata: {},
          },
        ],
      }),
    });
    expect(second.status).toBe(200);

    const wsDetail = await request(server.baseUrl, "GET", `/api/capability-sets/${(await parseJson<any>(second)).data.capabilitySetId}`, { cookie });
    const ws = (await parseJson<any>(wsDetail)).data;
    expect(ws.assets[0].files).toHaveLength(1);

    const fileRes = await request(server.baseUrl, "GET", `/api/assets/${ws.assets[0].id}/file?path=SKILL.md`, { cookie });
    const fileData = (await parseJson<any>(fileRes)).data;
    expect(fileData.content).toBe("# Updated Content");
  });

  it("rejects push without CLI auth", async () => {
    await boot();
    const res = await request(server.baseUrl, "POST", "/api/push", { body: pushPayload("no-auth/test") });
    expect(res.status).toBe(401);
  });

  it("rejects empty assets array", async () => {
    await boot();
    const res = await request(server.baseUrl, "POST", "/api/push", {
      bearer: cliToken,
      body: { name: "empty/test", visibility: "private", targetTool: "claudecode", assets: [] },
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate (type, name) within one push (collision)", async () => {
    await boot();
    const res = await request(server.baseUrl, "POST", "/api/push", {
      bearer: cliToken,
      body: {
        name: "dup/test", visibility: "private", targetTool: "claudecode",
        assets: [
          { sourcePath: "skills/westock-data", name: "westock-data", type: "skill", description: "data v1", files: [{ path: "SKILL.md", content: "# v1" }], compatibleTools: ["claudecode"], version: "1.0.0", tags: [], originAuthor: null, metadata: {} },
          { sourcePath: "skills/westock-data2", name: "westock-data", type: "skill", description: "data v2", files: [{ path: "SKILL.md", content: "# v2" }], compatibleTools: ["claudecode"], version: "1.0.0", tags: [], originAuthor: null, metadata: {} },
        ],
      },
    });
    expect(res.status).toBe(409);
    const body = await parseJson<any>(res);
    expect(body.success).toBe(false);
    expect(body.error).toContain("skills/westock-data");
    expect(body.error).toContain("skills/westock-data2");

    const list = await request(server.baseUrl, "GET", "/api/capability-sets?page=1&pageSize=30", { cookie });
    const names = (await parseJson<any>(list)).data.map((w: any) => w.name);
    expect(names).not.toContain("dup/test");
  });
});

describe("L3 capabilitySet name uniqueness", () => {
  let server: ServerHandle;
  let cookie: string;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  async function boot() {
    server = await startServer();
    cookie = await login(server.baseUrl, "unique-user@example.com");
  }

  it("POST /api/capability-sets rejects duplicate name for same user", async () => {
    await boot();
    const payload = { name: "my-capabilitySet", description: "first", targetTools: ["cursor"], visibility: "private" };
    const first = await request(server.baseUrl, "POST", "/api/capability-sets", { cookie, body: payload });
    expect(first.status).toBe(200);
    const second = await request(server.baseUrl, "POST", "/api/capability-sets", { cookie, body: payload });
    expect(second.status).toBe(409);
  });

  it("PUT /api/capability-sets rejects rename to existing name", async () => {
    await boot();
    const ws1 = await request(server.baseUrl, "POST", "/api/capability-sets", { cookie, body: { name: "ws-one", description: "1", targetTools: ["cursor"], visibility: "private" } });
    const ws1Id = (await parseJson<any>(ws1)).data.id;
    await request(server.baseUrl, "POST", "/api/capability-sets", { cookie, body: { name: "ws-two", description: "2", targetTools: ["cursor"], visibility: "private" } });

    const rename = await request(server.baseUrl, "PUT", `/api/capability-sets/${ws1Id}`, { cookie, body: { name: "ws-two" } });
    expect(rename.status).toBe(409);
  });

  it("allows different users to have same capabilitySet name", async () => {
    await boot();
    const otherCookie = await login(server.baseUrl, "other-user@example.com");
    const first = await request(server.baseUrl, "POST", "/api/capability-sets", { cookie, body: { name: "shared-name", description: "1", targetTools: ["cursor"], visibility: "private" } });
    expect(first.status).toBe(200);
    const second = await request(server.baseUrl, "POST", "/api/capability-sets", { cookie: otherCookie, body: { name: "shared-name", description: "2", targetTools: ["cursor"], visibility: "private" } });
    expect(second.status).toBe(200);
  });
});
