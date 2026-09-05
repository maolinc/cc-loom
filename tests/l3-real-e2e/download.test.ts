/**
 * L3 下载端点 — `/api/assets/:id/download` 与 `/api/capability-sets/:id/download`。
 *
 * 不变量：
 *  - 单能力下载：200 + application/zip + Content-Disposition 带文件名 + body 为 zip（PK 魔数）。
 *  - 能力集无厂商下载：200 + zip，包含全部成员能力（无 X-Loom-Skipped）。
 *  - 能力集厂商下载：不兼容类型走 skipped，响应头 X-Loom-Skipped 标注被排除能力。
 *  - 可见性：private 能力非 owner / 非 admin 下载 → 404。
 *
 * 结构正确性（zip 内路径）由 L1 `download-archive.test.ts` 覆盖；此处只断言 HTTP 契约。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  startServer, stopServer, type ServerHandle, ApiClient, assetBuilders,
} from "@maolinc/cc-loom-testkit";

describe("L3 download: /assets/:id/download & /capability-sets/:id/download", () => {
  let server: ServerHandle;

  afterEach(async () => {
    if (server) await stopServer(server);
  });

  async function boot(email = "dl@example.com") {
    server = await startServer();
    const api = new ApiClient(server.baseUrl);
    await api.login(email);
    return api;
  }

  async function download(path: string, cookie: string): Promise<Response> {
    return fetch(`${server.baseUrl}${path}`, { headers: { cookie } });
  }

  it("单能力下载：200 + zip + Content-Disposition", async () => {
    const api = await boot();
    const skill = await api.createAsset(assetBuilders.skill("dl-skill", ["cursor"]));
    const res = await download(`/api/assets/${skill.id}/download`, api.getCookie()!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("dl-skill.zip");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
  });

  it("能力集无厂商下载：200 + zip，无 skipped 头", async () => {
    const api = await boot();
    const s = await api.createAsset(assetBuilders.skill("ws-skill", ["cursor"]));
    const m = await api.createAsset(assetBuilders.mcp("ws-mcp", "echo", ["cursor"]));
    const ws = await api.createCapabilitySet(
      { name: "ws-dl", description: "x", targetTools: ["cursor"], visibility: "public" },
      [s.id, m.id],
    );
    const res = await download(`/api/capability-sets/${ws.id}/download`, api.getCookie()!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("x-loom-skipped")).toBeNull();
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it("能力集厂商下载：codex + command（不兼容）→ X-Loom-Skipped 标注", async () => {
    const api = await boot();
    // command 不被 codex 支持（codex supportedTypes: skill/rule/mcp/hook/agent）
    const cmd = await api.createAsset(assetBuilders.command("reviewer", "manual", ["codex"]));
    const sk = await api.createAsset(assetBuilders.skill("ok-skill", ["codex"]));
    const ws = await api.createCapabilitySet(
      { name: "ws-mix", description: "x", targetTools: ["codex"], visibility: "public" },
      [cmd.id, sk.id],
    );
    const res = await download(`/api/capability-sets/${ws.id}/download?tool=codex`, api.getCookie()!);
    expect(res.status).toBe(200);
    const skipped = res.headers.get("x-loom-skipped");
    expect(skipped).toBeTruthy();
    const decoded = JSON.parse(decodeURIComponent(skipped!)) as { assetName: string; type: string; tool: string }[];
    expect(decoded.some((s) => s.assetName === "reviewer" && s.type === "command")).toBe(true);
  });

  it("能力集多厂商下载：claudecode + cursor 并排，agent 双厂商均收录", async () => {
    const api = await boot();
    const ag = await api.createAsset(assetBuilders.agent("reviewer", ["claudecode", "cursor"]));
    const sk = await api.createAsset(assetBuilders.skill("ok-skill", ["claudecode", "cursor"]));
    const ws = await api.createCapabilitySet(
      { name: "ws-multi", description: "x", targetTools: ["claudecode", "cursor"], visibility: "public" },
      [ag.id, sk.id],
    );
    const res = await download(`/api/capability-sets/${ws.id}/download?tool=cursor,claudecode`, api.getCookie()!);
    expect(res.status).toBe(200);
    // agent 现 cursor + claudecode 均收录 → 无 skipped
    expect(res.headers.get("x-loom-skipped")).toBeNull();
  });

  it("可见性：private 能力非 owner 下载 → 404", async () => {
    const owner = await boot("owner@example.com");
    const other = new ApiClient(server.baseUrl);
    await other.login("other@example.com");
    const skill = await owner.createAsset({
      ...assetBuilders.skill("secret-skill", ["cursor"]),
      visibility: "private",
    });
    const res = await download(`/api/assets/${skill.id}/download`, other.getCookie()!);
    expect(res.status).toBe(404);
  });

  it("未知 tool 参数静默忽略，按无厂商结构下载", async () => {
    const api = await boot();
    const s = await api.createAsset(assetBuilders.skill("s1", ["cursor"]));
    const ws = await api.createCapabilitySet(
      { name: "ws-x", description: "x", targetTools: ["cursor"], visibility: "public" },
      [s.id],
    );
    const res = await download(`/api/capability-sets/${ws.id}/download?tool=unknown-tool`, api.getCookie()!);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-loom-skipped")).toBeNull();
  });
});
