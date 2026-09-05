/**
 * sync_outbox_v2 可见性 + 操作 API（项目维度）。
 *
 * 同步队列是运行态（哪些变更在等 agent 上线 / 重试耗尽），不是用户偏好，
 * 因此入口放在本地控制台的项目详情里、跟着项目走，而非设置页。
 *
 * 只读（按项目）:
 *  - GET /api/projects/:id/sync-outbox        → 该项目未完成（含 dead-letter）的 outbox 行
 *  - GET /api/projects/:id/sync-outbox/stats  → ready / backoff / deadLetter 三档计数
 *
 * 全局（CLI `loom status` 速览用）:
 *  - GET /api/sync-outbox/stats → 当前用户名下 ready / backoff / deadLetter 计数
 *
 * 写操作:
 *  - POST /api/sync-outbox/:id/retry                   → 单行 attempts 归零 + scheduled_at=now + 唤醒 device
 *  - DELETE /api/sync-outbox/:id                       → 单行标记 completed_at=now（放弃这条任务）
 *  - POST /api/projects/:id/sync-outbox/retry-dead     → 该项目所有 dead-letter 行复活
 *
 * 安全:所有路由都过 requireAnyAuth + 校验 project / outbox 行归属当前 user。
 */
import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { requireAnyAuth } from "../lib/auth.js";
import { wakeDeviceV2 } from "../lib/outbox-worker-v2.js";

interface OutboxView {
  id: number;
  deviceId: string;
  projectId: string;
  projectName: string;
  attempts: number;
  lastError: string | null;
  scheduledAt: string;
  createdAt: string;
  deadLetter: boolean;
}

/** 与 outbox-worker-v2.ts 中的 MAX_ATTEMPTS 保持一致(指数退避档位数)。 */
const MAX_ATTEMPTS = 8;

/**
 * 校验项目归属当前用户。返回 device_id（用于唤醒），不存在或不属于该用户返回 null。
 */
function loadOwnedProject(projectId: string, userId: string): { device_id: string } | null {
  const row = db
    .prepare("SELECT device_id, user_id FROM projects WHERE id = ?")
    .get(projectId) as { device_id: string; user_id: string } | undefined;
  if (!row || row.user_id !== userId) return null;
  return { device_id: row.device_id };
}

/**
 * 取 outbox 行并校验归属。返回 null 表示行不存在或不属于当前用户(统一返回 404)。
 */
function loadOwnedRow(id: number, userId: string): { device_id: string } | null {
  const row = db
    .prepare(
      `SELECT o.device_id, p.user_id
         FROM sync_outbox_v2 o
         JOIN projects p ON p.id = o.project_id
        WHERE o.id = ?`,
    )
    .get(id) as { device_id: string; user_id: string } | undefined;
  if (!row || row.user_id !== userId) return null;
  return { device_id: row.device_id };
}

export function syncOutboxRoutes(app: FastifyInstance) {
// 全局三档计数（CLI `loom status` 用，做账号级健康速览；Web UI 走项目级端点）。
  app.get("/api/sync-outbox/stats", { preHandler: [requireAnyAuth] }, async (request) => {
    const now = new Date().toISOString();
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN o.scheduled_at <= ? AND o.attempts < ? THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN o.scheduled_at >  ? AND o.attempts < ? THEN 1 ELSE 0 END) AS backoff,
        SUM(CASE WHEN o.attempts >= ?                        THEN 1 ELSE 0 END) AS dead_letter
        FROM sync_outbox_v2 o
        JOIN projects p ON p.id = o.project_id
       WHERE p.user_id = ?
         AND o.completed_at IS NULL
    `).get(now, MAX_ATTEMPTS, now, MAX_ATTEMPTS, MAX_ATTEMPTS, request.user!.userId) as any;

    return {
      success: true,
      data: {
        ready: row?.ready ?? 0,
        backoff: row?.backoff ?? 0,
        deadLetter: row?.dead_letter ?? 0,
      },
    };
  });

  // 该项目未完成的 outbox 行（含 dead-letter）。
  app.get("/api/projects/:id/sync-outbox", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id;
    const owned = loadOwnedProject(projectId, request.user!.userId);
    if (!owned) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }
    const rows = db.prepare(`
      SELECT o.id, o.device_id, o.project_id, p.project_name,
             o.attempts, o.last_error, o.scheduled_at, o.created_at
        FROM sync_outbox_v2 o
        JOIN projects p ON p.id = o.project_id
       WHERE o.project_id = ?
         AND o.completed_at IS NULL
       ORDER BY o.id DESC
       LIMIT 500
    `).all(projectId) as any[];

    const data: OutboxView[] = rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      projectId: r.project_id,
      projectName: r.project_name,
      attempts: r.attempts,
      lastError: r.last_error,
      scheduledAt: r.scheduled_at,
      createdAt: r.created_at,
      deadLetter: r.attempts >= MAX_ATTEMPTS,
    }));

    return { success: true, data };
  });

  // 该项目三档计数。
  app.get("/api/projects/:id/sync-outbox/stats", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id;
    const owned = loadOwnedProject(projectId, request.user!.userId);
    if (!owned) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }
    const now = new Date().toISOString();
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN o.scheduled_at <= ? AND o.attempts < ? THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN o.scheduled_at >  ? AND o.attempts < ? THEN 1 ELSE 0 END) AS backoff,
        SUM(CASE WHEN o.attempts >= ?                        THEN 1 ELSE 0 END) AS dead_letter
        FROM sync_outbox_v2 o
       WHERE o.project_id = ?
         AND o.completed_at IS NULL
    `).get(now, MAX_ATTEMPTS, now, MAX_ATTEMPTS, MAX_ATTEMPTS, projectId) as any;

    return {
      success: true,
      data: {
        ready: row?.ready ?? 0,
        backoff: row?.backoff ?? 0,
        deadLetter: row?.dead_letter ?? 0,
      },
    };
  });

  // 单行立即重试:attempts 归零 + scheduled_at=now + last_error 清空 + 唤醒 device。
  // 用于 dead-letter 救援,也兼任「我等不及退避了」的快捷动作。
  app.post("/api/sync-outbox/:id/retry", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const id = Number((request.params as any).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ success: false, error: "无效的 id" });
    }
    const owned = loadOwnedRow(id, request.user!.userId);
    if (!owned) {
      return reply.status(404).send({ success: false, error: "任务不存在" });
    }
    db.prepare(
      "UPDATE sync_outbox_v2 SET attempts = 0, last_error = NULL, scheduled_at = ? WHERE id = ? AND completed_at IS NULL",
    ).run(new Date().toISOString(), id);
    wakeDeviceV2(owned.device_id);
    return { success: true, data: { id } };
  });

  // 单行丢弃:标记 completed_at 即可,物理保留行(便于审计/排查)。
  app.delete("/api/sync-outbox/:id", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const id = Number((request.params as any).id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ success: false, error: "无效的 id" });
    }
    const owned = loadOwnedRow(id, request.user!.userId);
    if (!owned) {
      return reply.status(404).send({ success: false, error: "任务不存在" });
    }
    db.prepare(
      "UPDATE sync_outbox_v2 SET completed_at = ? WHERE id = ? AND completed_at IS NULL",
    ).run(new Date().toISOString(), id);
    return { success: true, data: { id } };
  });

  // 该项目 dead-letter 批量复活。
  app.post("/api/projects/:id/sync-outbox/retry-dead", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id;
    const owned = loadOwnedProject(projectId, request.user!.userId);
    if (!owned) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }
    const targets = db.prepare(`
      SELECT o.id, o.device_id
        FROM sync_outbox_v2 o
       WHERE o.project_id = ?
         AND o.completed_at IS NULL
         AND o.attempts >= ?
    `).all(projectId, MAX_ATTEMPTS) as { id: number; device_id: string }[];

    if (targets.length === 0) {
      return { success: true, data: { revived: 0 } };
    }
    const now = new Date().toISOString();
    const ids = targets.map((t) => t.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE sync_outbox_v2 SET attempts = 0, last_error = NULL, scheduled_at = ?
        WHERE id IN (${placeholders})`,
    ).run(now, ...ids);
    wakeDeviceV2(owned.device_id);
    return { success: true, data: { revived: targets.length } };
  });
}
