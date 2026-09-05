/**
 * Codex / Claude Code 用户级配置档。
 *
 * Secret 使用现有 master.key 加密，REST 永不返回明文；只有用户显式选择在线设备
 * 下发时才解密并通过 WS 发送。设备每个工具只保留最近成功下发的 profile 记录。
 */
import type { FastifyInstance } from "fastify";
import type { ToolConfigDistribution, ToolConfigProfile, WsToolConfigApplyPayload } from "@maolinc/cc-loom-shared";
import {
  toolConfigDistributeSchema,
  toolConfigProfileCreateSchema,
  toolConfigProfileUpdateSchema,
} from "@maolinc/cc-loom-shared";
import { db } from "../db/index.js";
import { decryptSecret, encryptSecret, generateId } from "../lib/crypto.js";
import { requireAuth } from "../lib/auth.js";
import { getAgent, requestFromAgent } from "../ws/gateway.js";

const APPLY_TIMEOUT_MS = 20_000;

function loadOwned(id: string, userId: string): any | null {
  return db.prepare("SELECT * FROM tool_config_profiles WHERE id = ? AND user_id = ?").get(id, userId) as any ?? null;
}

function rowToProfile(row: any): ToolConfigProfile {
  const base = {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    secretConfigured: !!row.secret_cipher,
    lastPushedAt: row.last_pushed_at ?? null,
    deviceCount: Number(row.device_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const config = JSON.parse(row.config_json);
  return row.tool === "codex"
    ? { ...base, tool: "codex", config }
    : { ...base, tool: "claudecode", config };
}

export function toolConfigProfileRoutes(app: FastifyInstance) {
  app.get("/api/tool-config-profiles", { preHandler: [requireAuth] }, async (request) => {
    const rows = db.prepare(`
      SELECT p.*, MAX(d.pushed_at) AS last_pushed_at, COUNT(d.device_id) AS device_count
        FROM tool_config_profiles p
   LEFT JOIN tool_config_distributions d ON d.profile_id = p.id
       WHERE p.user_id = ?
    GROUP BY p.id
       ORDER BY CASE p.tool WHEN 'codex' THEN 0 ELSE 1 END, p.updated_at DESC
    `).all(request.user!.userId) as any[];
    return { success: true, data: rows.map(rowToProfile) };
  });

  app.get("/api/tool-config-profiles/distributions", { preHandler: [requireAuth] }, async (request) => {
    const rows = db.prepare(`
      SELECT d.profile_id, d.tool, d.device_id, d.pushed_at, dv.device_name
        FROM tool_config_distributions d
        JOIN tool_config_profiles p ON p.id = d.profile_id
        JOIN devices dv ON dv.id = d.device_id
       WHERE p.user_id = ?
       ORDER BY d.pushed_at DESC
    `).all(request.user!.userId) as any[];
    const data: ToolConfigDistribution[] = rows.map((row) => ({
      profileId: row.profile_id,
      tool: row.tool,
      deviceId: row.device_id,
      deviceName: row.device_name,
      pushedAt: row.pushed_at,
    }));
    return { success: true, data };
  });

  app.post("/api/tool-config-profiles", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = toolConfigProfileCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message ?? "参数不正确" });
    }
    const input = parsed.data;
    const duplicate = db.prepare(
      "SELECT id FROM tool_config_profiles WHERE user_id = ? AND tool = ? AND name = ?",
    ).get(request.user!.userId, input.tool, input.name);
    if (duplicate) return reply.status(409).send({ success: false, error: "该工具下已存在同名配置" });

    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO tool_config_profiles (id, user_id, name, tool, config_json, secret_cipher, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, request.user!.userId, input.name, input.tool, JSON.stringify(input.config), encryptSecret(input.secret), now, now);
    const row = db.prepare("SELECT *, NULL AS last_pushed_at, 0 AS device_count FROM tool_config_profiles WHERE id = ?").get(id);
    return { success: true, data: rowToProfile(row) };
  });

  app.put("/api/tool-config-profiles/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = loadOwned((request.params as any).id, request.user!.userId);
    if (!existing) return reply.status(404).send({ success: false, error: "配置档不存在" });
    const parsed = toolConfigProfileUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message ?? "参数不正确" });
    }
    const input = parsed.data;
    if (input.tool !== existing.tool) {
      return reply.status(400).send({ success: false, error: "配置档工具类型不可更改" });
    }
    const duplicate = db.prepare(
      "SELECT id FROM tool_config_profiles WHERE user_id = ? AND tool = ? AND name = ? AND id != ?",
    ).get(request.user!.userId, input.tool, input.name, existing.id);
    if (duplicate) return reply.status(409).send({ success: false, error: "该工具下已存在同名配置" });

    const sets = ["name = ?", "config_json = ?", "updated_at = ?"];
    const params: unknown[] = [input.name, JSON.stringify(input.config), new Date().toISOString()];
    if (input.secret !== undefined) {
      sets.push("secret_cipher = ?");
      params.push(encryptSecret(input.secret));
    }
    params.push(existing.id);
    db.prepare(`UPDATE tool_config_profiles SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const row = db.prepare(`
      SELECT p.*, MAX(d.pushed_at) AS last_pushed_at, COUNT(d.device_id) AS device_count
        FROM tool_config_profiles p LEFT JOIN tool_config_distributions d ON d.profile_id = p.id
       WHERE p.id = ? GROUP BY p.id
    `).get(existing.id);
    return { success: true, data: rowToProfile(row) };
  });

  app.delete("/api/tool-config-profiles/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = loadOwned((request.params as any).id, request.user!.userId);
    if (!existing) return reply.status(404).send({ success: false, error: "配置档不存在" });
    db.prepare("DELETE FROM tool_config_profiles WHERE id = ?").run(existing.id);
    return { success: true };
  });

  app.post("/api/tool-config-profiles/:id/distribute", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = loadOwned((request.params as any).id, request.user!.userId);
    if (!existing) return reply.status(404).send({ success: false, error: "配置档不存在" });
    const parsed = toolConfigDistributeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message ?? "参数不正确" });
    }

    const secret = decryptSecret(existing.secret_cipher);
    const payload = {
      profileName: existing.name,
      tool: existing.tool,
      config: JSON.parse(existing.config_json),
      secret,
    } as WsToolConfigApplyPayload;
    const pushed: string[] = [];
    const skipped: { deviceId: string; reason: string }[] = [];

    for (const deviceId of [...new Set(parsed.data.deviceIds)]) {
      const device = db.prepare("SELECT id, status FROM devices WHERE id = ? AND user_id = ?")
        .get(deviceId, request.user!.userId) as { id: string; status: string } | undefined;
      if (!device) {
        skipped.push({ deviceId, reason: "设备不存在或无权访问" });
        continue;
      }
      const agent = getAgent(deviceId);
      if (device.status !== "online" || !agent) {
        skipped.push({ deviceId, reason: "设备不在线" });
        continue;
      }
      if (agent.capabilities.toolConfigProfiles !== true) {
        skipped.push({ deviceId, reason: "设备上的 Loom CLI 版本过旧，请升级后重试" });
        continue;
      }
      try {
        await requestFromAgent(deviceId, "tool-config:apply", payload, APPLY_TIMEOUT_MS);
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO tool_config_distributions (device_id, tool, profile_id, pushed_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(device_id, tool) DO UPDATE SET profile_id = excluded.profile_id, pushed_at = excluded.pushed_at
        `).run(deviceId, existing.tool, existing.id, now);
        pushed.push(deviceId);
      } catch (err) {
        skipped.push({ deviceId, reason: err instanceof Error ? err.message : "设备写入失败" });
      }
    }

    return { success: true, data: { pushed, skipped } };
  });
}
