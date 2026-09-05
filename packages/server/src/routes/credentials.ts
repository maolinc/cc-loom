/**
 * 凭据值管理 + 显式分发（设置页「能力鉴权配置」，ADR-0003）。
 *
 * 统一承载 env 与 path 两类鉴权的凭据值。值 AES-256-GCM 加密落 DB（复用 master.key），
 * 明文永不通过 REST 返回。分发显式 opt-in：
 *  - axis=env：解密后通过 WS env:push 实时推到在线设备的系统环境变量（与旧 env-vars 同）。
 *  - axis=path：写 credential_distributions 记录；下次 reconcile 渲染时把值字面替换进项目
 *    .mcp.json 对应路径。发分发即触发受影响项目 re-enqueue（path 轴），让值尽快落地。
 *
 * 凭据「被用到哪里」由 credential_usages（reconcile-end 钩子维护）+ credential_distributions
 * 共同表达：前者是声明侧使用（资产×项目×路径），后者是值侧分发（凭据×轴×目标）。
 *
 * 绝不记录 secret / 凭据明文 / reconcile payload 文件内容（ADR-0003 安全后果）。
 */
import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { generateId, encryptSecret, decryptSecret } from "../lib/crypto.js";
import { requireAuth } from "../lib/auth.js";
import { getAgent, requestFromAgent } from "../ws/gateway.js";
import { enqueueReconcile, wakeDeviceV2 } from "../lib/outbox-worker-v2.js";
import {
  credentialCreateSchema,
  credentialUpdateSchema,
  credentialDistributeSchema,
  type Credential,
  type CredentialDistribution,
} from "@maolinc/cc-loom-shared";

const ENV_PUSH_TIMEOUT_MS = 15_000;

/** SQLite 行 → 对外 Credential（不含 value）。 */
function rowToCredential(row: any): Credential {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    axis: row.axis ?? "env",
    description: row.description ?? "",
    hasValue: !!row.value_cipher,
    lastPushedAt: row.last_pushed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadOwned(credentialId: string, userId: string): any | null {
  const row = db.prepare("SELECT * FROM credentials WHERE id = ? AND user_id = ?").get(credentialId, userId) as any;
  return row ?? null;
}

/** env 轴分发：解密 → WS env:push 到单台在线设备 → upsert 分发记录。 */
async function pushEnvToOne(credRow: any, deviceId: string): Promise<void> {
  const value = decryptSecret(credRow.value_cipher);
  await requestFromAgent(deviceId, "env:push", { key: credRow.name, value }, ENV_PUSH_TIMEOUT_MS);
}

/**
 * path 轴分发：写 credential_distributions 记录 + 触发该项目 re-enqueue（让值尽快注入）。
 * 不在线的项目由下次 reconcile 补齐（worker 折叠 + 离线补偿）。
 */
function distributePathToProject(credRow: any, projectId: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO credential_distributions (credential_id, axis, target_id, pushed_at)
    VALUES (?, 'path', ?, ?)
    ON CONFLICT(credential_id, axis, target_id) DO UPDATE SET pushed_at = excluded.pushed_at
  `).run(credRow.id, projectId, now);
  const project = db.prepare("SELECT device_id, sync_policy, status FROM projects WHERE id = ?").get(projectId) as
    | { device_id: string; sync_policy: string; status: string }
    | undefined;
  if (project && project.status !== "unregistered") {
    // path 分发是用户的显式动作 → force，即使项目 locked 也照常注入（与 install/capabilities 同口径）。
    enqueueReconcile(project.device_id, projectId, { force: true });
    wakeDeviceV2(project.device_id);
  }
}

/**
 * 找出 path 轴分发到的所有项目（用于值更新轮换 / 删除时 re-enqueue）。
 */
function pathDistributedProjects(credentialId: string): { projectId: string; deviceId: string }[] {
  const rows = db.prepare(`
    SELECT d.target_id AS projectId, p.device_id AS deviceId
      FROM credential_distributions d
      JOIN projects p ON p.id = d.target_id
     WHERE d.credential_id = ? AND d.axis = 'path'
  `).all(credentialId) as { projectId: string; deviceId: string }[];
  return rows;
}

/** re-enqueue path 分发的全部项目（值更新轮换 / 删除时调用）。 */
function reenqueuePathProjects(credentialId: string): void {
  for (const { projectId, deviceId } of pathDistributedProjects(credentialId)) {
    enqueueReconcile(deviceId, projectId, { force: true });
    wakeDeviceV2(deviceId);
  }
}

export function credentialRoutes(app: FastifyInstance) {
  // ---- 列表（附最近分发时间）----
  app.get("/api/credentials", { preHandler: [requireAuth] }, async (request) => {
    const rows = db.prepare(`
      SELECT c.*, MAX(d.pushed_at) AS last_pushed_at
        FROM credentials c
   LEFT JOIN credential_distributions d ON d.credential_id = c.id
       WHERE c.user_id = ?
    GROUP BY c.id
       ORDER BY c.name
    `).all(request.user!.userId) as any[];
    return { success: true, data: rows.map(rowToCredential) };
  });

  // ---- 创建 ----
  app.post("/api/credentials", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = credentialCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    const { name, axis, value, description } = parsed.data;
    const dup = db.prepare("SELECT id FROM credentials WHERE user_id = ? AND name = ?").get(request.user!.userId, name);
    if (dup) {
      return reply.status(409).send({ success: false, error: "该凭据名已存在" });
    }
    const now = new Date().toISOString();
    const id = generateId();
    db.prepare(
      "INSERT INTO credentials (id, user_id, name, axis, value_cipher, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, request.user!.userId, name, axis, encryptSecret(value), description ?? "", now, now);
    const row = db.prepare("SELECT * FROM credentials WHERE id = ?").get(id);
    return { success: true, data: rowToCredential(row) };
  });

  // ---- 更新（value 留空 = 保持原值；值变化触发 path 分发项目轮换）----
  app.put("/api/credentials/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = loadOwned((request.params as any).id, request.user!.userId);
    if (!existing) return reply.status(404).send({ success: false, error: "凭据不存在" });

    const parsed = credentialUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    const d = parsed.data;
    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [new Date().toISOString()];
    let valueChanged = false;

    if (d.name !== undefined && d.name !== existing.name) {
      const dup = db.prepare("SELECT id FROM credentials WHERE user_id = ? AND name = ? AND id != ?").get(request.user!.userId, d.name, existing.id);
      if (dup) return reply.status(409).send({ success: false, error: "该凭据名已存在" });
      sets.push("name = ?"); params.push(d.name);
    }
    if (d.value !== undefined && d.value.length > 0) {
      sets.push("value_cipher = ?"); params.push(encryptSecret(d.value));
      valueChanged = true;
    }
    if (d.description !== undefined) { sets.push("description = ?"); params.push(d.description); }

    params.push(existing.id);
    db.prepare(`UPDATE credentials SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    // 值变化 → 轮换 path 分发的项目（re-render 注入新值）。env 分发的设备由用户主动重新下发。
    if (valueChanged) {
      reenqueuePathProjects(existing.id);
    }
    const row = db.prepare("SELECT * FROM credentials WHERE id = ?").get(existing.id);
    return { success: true, data: rowToCredential(row) };
  });

  // ---- 删除：回收 env 分发的设备 + re-enqueue path 分发的项目（回退作者叶子）----
  app.delete("/api/credentials/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = loadOwned((request.params as any).id, request.user!.userId);
    if (!existing) return reply.status(404).send({ success: false, error: "凭据不存在" });

    // 回收 env 分发的在线设备
    const envDists = db.prepare(
      "SELECT target_id AS device_id FROM credential_distributions WHERE credential_id = ? AND axis = 'env'",
    ).all(existing.id) as { device_id: string }[];
    for (const { device_id } of envDists) {
      if (getAgent(device_id)) {
        try { await requestFromAgent(device_id, "env:revoke", { key: existing.name }, ENV_PUSH_TIMEOUT_MS); }
        catch { /* 在线但超时：仍删 DB 记录，避免阻塞删除 */ }
      }
    }
    // re-enqueue path 分发的项目（值删除 → 下次 reconcile 回退作者叶子）
    reenqueuePathProjects(existing.id);
    // 删凭据行（CASCADE 清 credential_distributions）
    db.prepare("DELETE FROM credentials WHERE id = ?").run(existing.id);
    return { success: true };
  });

  // ---- 分发列表（凭据 × 轴 × 目标）----
  app.get("/api/credentials/distributions", { preHandler: [requireAuth] }, async (request) => {
    const rows = db.prepare(`
      SELECT d.credential_id, d.axis, d.target_id, d.pushed_at,
             dv.device_name AS device_name, p.project_name AS project_name
        FROM credential_distributions d
        JOIN credentials c ON c.id = d.credential_id
        LEFT JOIN devices dv ON dv.id = d.target_id AND d.axis = 'env'
        LEFT JOIN projects p ON p.id = d.target_id AND d.axis = 'path'
       WHERE c.user_id = ?
       ORDER BY d.pushed_at DESC
    `).all(request.user!.userId) as any[];
    const data: CredentialDistribution[] = rows.map((r) => ({
      credentialId: r.credential_id,
      axis: r.axis,
      targetId: r.target_id,
      targetName: r.device_name ?? r.project_name ?? r.target_id,
      pushedAt: r.pushed_at,
    }));
    return { success: true, data };
  });

  // ---- 分发：env→在线设备（多选）；path→项目（多选）----
  app.post("/api/credentials/:id/distribute", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = loadOwned((request.params as any).id, request.user!.userId);
    if (!existing) return reply.status(404).send({ success: false, error: "凭据不存在" });

    const parsed = credentialDistributeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    const { axis, targetIds } = parsed.data;
    // ADR-0004：禁止跨轴分发——env 凭据只能下发设备，path 凭据只能分发项目。
    if (axis !== existing.axis) {
      return reply.status(400).send({
        success: false,
        error: existing.axis === "env" ? "环境变量凭据只能下发到设备" : "MCP 路径凭据只能分发到项目",
      });
    }
    const now = new Date().toISOString();
    const pushed: string[] = [];
    const skipped: { targetId: string; reason: string }[] = [];

    if (axis === "env") {
      for (const deviceId of targetIds) {
        const dev = db.prepare("SELECT user_id FROM devices WHERE id = ?").get(deviceId) as any;
        if (!dev || dev.user_id !== request.user!.userId) {
          skipped.push({ targetId: deviceId, reason: "设备不存在或不属于当前用户" });
          continue;
        }
        if (!getAgent(deviceId)) {
          skipped.push({ targetId: deviceId, reason: "设备离线" });
          continue;
        }
        try {
          await pushEnvToOne(existing, deviceId);
          db.prepare(`
            INSERT INTO credential_distributions (credential_id, axis, target_id, pushed_at)
            VALUES (?, 'env', ?, ?)
            ON CONFLICT(credential_id, axis, target_id) DO UPDATE SET pushed_at = excluded.pushed_at
          `).run(existing.id, deviceId, now);
          pushed.push(deviceId);
        } catch (err: any) {
          skipped.push({ targetId: deviceId, reason: err?.message ?? "下发失败" });
        }
      }
    } else {
      // axis === "path"
      for (const projectId of targetIds) {
        const proj = db.prepare("SELECT user_id FROM projects WHERE id = ?").get(projectId) as any;
        if (!proj || proj.user_id !== request.user!.userId) {
          skipped.push({ targetId: projectId, reason: "项目不存在或不属于当前用户" });
          continue;
        }
        distributePathToProject(existing, projectId);
        pushed.push(projectId);
      }
    }
    return { success: true, data: { pushed, skipped } };
  });

  // ---- 回收：env=从单台设备移除；path=删分发记录 + re-enqueue 回退作者叶子 ----
  app.post("/api/credentials/:id/revoke", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = loadOwned((request.params as any).id, request.user!.userId);
    if (!existing) return reply.status(404).send({ success: false, error: "凭据不存在" });
    const targetId = (request.body as any)?.targetId as string | undefined;
    const axis = (request.body as any)?.axis as "env" | "path" | undefined;
    if (!targetId || !axis) return reply.status(400).send({ success: false, error: "缺少 targetId 或 axis" });

    const dist = db.prepare(
      "SELECT 1 FROM credential_distributions WHERE credential_id = ? AND axis = ? AND target_id = ?",
    ).get(existing.id, axis, targetId);
    if (!dist) return reply.status(404).send({ success: false, error: "该凭据未分发到此目标" });

    if (axis === "env") {
      if (getAgent(targetId)) {
        try { await requestFromAgent(targetId, "env:revoke", { key: existing.name }, ENV_PUSH_TIMEOUT_MS); }
        catch { /* 超时仍删记录 */ }
      }
    }
    // 先删分发记录再 re-enqueue：worker 被 wake 后可能立刻跑 reconcileProject，
    // 若删除在后，这次 reconcile 仍会读到分发记录、继续注入真实值（竞态）。
    db.prepare(
      "DELETE FROM credential_distributions WHERE credential_id = ? AND axis = ? AND target_id = ?",
    ).run(existing.id, axis, targetId);
    if (axis === "path") {
      // path：re-enqueue 该项目回退作者叶子
      const project = db.prepare("SELECT device_id FROM projects WHERE id = ?").get(targetId) as { device_id: string } | undefined;
      if (project) {
        enqueueReconcile(project.device_id, targetId, { force: true });
        wakeDeviceV2(project.device_id);
      }
    }
    return { success: true };
  });

  // ---- 使用关系（凭据被哪些资产/项目用到，驱动设置页「被用到哪里」）----
  // credential_usages 由 reconcile-end 钩子维护（path 绑定的声明侧使用）。
  // 读侧 LEFT JOIN project_installed_assets 过滤项目已不再装该资产的孤儿行。
  app.get("/api/credentials/usages", { preHandler: [requireAuth] }, async (request) => {
    const rows = db.prepare(`
      SELECT u.credential_name, u.project_id, u.asset_id, u.path,
             p.project_name, a.name AS asset_name, a.type AS asset_type
        FROM credential_usages u
        JOIN projects p ON p.id = u.project_id
        JOIN assets a ON a.id = u.asset_id
   LEFT JOIN project_installed_assets pia ON pia.project_id = u.project_id AND pia.asset_id = u.asset_id
       WHERE u.user_id = ?
         AND pia.asset_id IS NOT NULL
       ORDER BY u.credential_name, p.project_name
    `).all(request.user!.userId) as any[];
    const data = rows.map((r) => ({
      credentialName: r.credential_name,
      projectId: r.project_id,
      projectName: r.project_name,
      assetId: r.asset_id,
      assetName: r.asset_name,
      assetType: r.asset_type,
      path: r.path,
    }));
    return { success: true, data };
  });
}
