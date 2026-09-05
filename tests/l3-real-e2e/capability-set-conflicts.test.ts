/**
 * L3 CapabilitySet 落盘身份冲突拦截（docs/asset-uniqueness-design.md §6）。
 *
 * 「加入能力集」那一刻，对每个 Asset 的每个 compatibleTool 各算 InstallKey；
 * 任一 (tool, 身份载体) 被两个 Asset 抢占即 409，强制二选一。
 * 真实 server 进程 + 真实 HTTP。
 */
import { describe, it, expect, afterEach } from "vitest";
import type { TargetTool } from "@maolinc/cc-loom-shared";
import { startServer, stopServer, type ServerHandle } from "@maolinc/cc-loom-testkit";
import { login, request, parseJson } from "./_http.js";

describe("L3 capabilitySet install-key conflicts", () => {
  let server: ServerHandle;
  let cookie: string;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  async function boot() {
    server = await startServer();
    cookie = await login(server.baseUrl, "conflict-user@example.com");
  }

  async function createSkill(name: string, compatibleTools: TargetTool[]): Promise<string> {
    const res = await request(server.baseUrl, "POST", "/api/assets", {
      cookie,
      body: { name, type: "skill", description: "x", tags: [], files: [{ path: "SKILL.md", content: "body" }], compatibleTools, visibility: "private" },
    });
    expect(res.status).toBe(200);
    return (await parseJson<any>(res)).data.id;
  }

  async function createCapabilitySet(assetIds: string[]) {
    return request(server.baseUrl, "POST", "/api/capability-sets", {
      cookie,
      body: { name: "ws", description: "d", targetTools: ["cursor"], visibility: "private", assetIds },
    });
  }

  it("blocks two same-name skills that share a tool (409 with conflicts)", async () => {
    await boot();
    const a = await createSkill("dup", ["cursor"]);
    const b = await createSkill("dup", ["cursor"]);
    const res = await createCapabilitySet([a, b]);
    expect(res.status).toBe(409);
    const body = await parseJson<any>(res);
    expect(body.success).toBe(false);
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]).toMatchObject({ tool: "cursor", scope: "skill", identity: "dup" });
    expect(body.conflicts[0].assetIds.sort()).toEqual([a, b].sort());
  });

  it("allows same-name skills that target disjoint tools", async () => {
    await boot();
    const a = await createSkill("dup", ["cursor"]);
    const b = await createSkill("dup", ["codex"]);
    const res = await createCapabilitySet([a, b]);
    expect(res.status).toBe(200);
    expect((await parseJson<any>(res)).data.assets).toHaveLength(2);
  });

  it("treats name case-insensitively when computing identity", async () => {
    await boot();
    const a = await createSkill("Dup", ["cursor"]);
    const b = await createSkill("dup", ["cursor"]);
    const res = await createCapabilitySet([a, b]);
    expect(res.status).toBe(409);
  });

  it("PUT also blocks conflicting assetIds", async () => {
    await boot();
    const a = await createSkill("alpha", ["cursor"]);
    const create = await createCapabilitySet([a]);
    expect(create.status).toBe(200);
    const wsId = (await parseJson<any>(create)).data.id;

    const dup1 = await createSkill("beta", ["cursor"]);
    const dup2 = await createSkill("beta", ["cursor"]);
    const put = await request(server.baseUrl, "PUT", `/api/capability-sets/${wsId}`, { cookie, body: { assetIds: [dup1, dup2] } });
    expect(put.status).toBe(409);
  });
});
