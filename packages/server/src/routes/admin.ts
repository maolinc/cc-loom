import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { requireAdmin } from "../lib/auth.js";
import { authCacheInvalidateUser } from "../lib/auth-cache.js";
import {
  adminUpdateRoleSchema,
  adminUpdateStatusSchema,
  registrationSettingsSchema,
  whitelistSettingsSchema,
} from "@maolinc/cc-loom-shared";
import { appSettings } from "../lib/app-settings.js";
import { tick } from "../marketplace/scheduler.js";

function serializeUser(row: any) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    disabled: !!row.disabled,
    createdAt: row.created_at,
  };
}

export function adminRoutes(app: FastifyInstance) {
  // ---- 用户列表 ----
  app.get("/api/admin/users", { preHandler: [requireAdmin] }, async (request, reply) => {
    const query = (request.query as any)?.query as string | undefined;
    const page = parseInt((request.query as any)?.page as string) || 1;
    const pageSize = parseInt((request.query as any)?.pageSize as string) || 50;

    const conditions: string[] = [];
    const params: any[] = [];
    if (query) {
      conditions.push("email LIKE ?");
      params.push(`%${query}%`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = (db.prepare(`SELECT COUNT(*) as count FROM users ${where}`).get(...params) as any).count;
    const rows = db
      .prepare(`SELECT id, email, role, disabled, created_at FROM users ${where} ORDER BY created_at ASC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    return { success: true, data: rows.map(serializeUser), total, page, pageSize };
  });

  // ---- 修改用户角色 ----
  app.put("/api/admin/users/:id/role", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = adminUpdateRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const targetId = (request.params as any).id as string;
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as any;
    if (!target) {
      return reply.status(404).send({ success: false, error: "用户不存在" });
    }

    // 不能取消自己的 admin 角色（至少保留一个 admin）
    if (targetId === request.user!.userId && parsed.data.role !== "admin") {
      return reply.status(400).send({ success: false, error: "不能取消自己的管理员角色" });
    }

    db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(
      parsed.data.role,
      new Date().toISOString(),
      targetId
    );

    // 失效该用户缓存，让 role 变更立即生效
    authCacheInvalidateUser(targetId);

    const updated = db.prepare("SELECT id, email, role, disabled, created_at FROM users WHERE id = ?").get(targetId) as any;
    return { success: true, data: serializeUser(updated) };
  });

  // ---- 停用/启用用户 ----
  app.put("/api/admin/users/:id/status", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = adminUpdateStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const targetId = (request.params as any).id as string;
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId) as any;
    if (!target) {
      return reply.status(404).send({ success: false, error: "用户不存在" });
    }

    // 不能停用自己
    if (targetId === request.user!.userId) {
      return reply.status(400).send({ success: false, error: "不能停用自己的账户" });
    }

    const disabled = parsed.data.disabled ? 1 : 0;
    db.prepare("UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?").run(
      disabled,
      new Date().toISOString(),
      targetId
    );

    if (parsed.data.disabled) {
      // 停用：清除所有 session，使在线登录态立即失效
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(targetId);
      // 失效缓存，让 CLI token 也立即拒绝
      authCacheInvalidateUser(targetId);
    } else {
      // 启用：仅需失效缓存让 DB 最新状态被读到
      authCacheInvalidateUser(targetId);
    }

    const updated = db.prepare("SELECT id, email, role, disabled, created_at FROM users WHERE id = ?").get(targetId) as any;
    return { success: true, data: serializeUser(updated) };
  });

  // ---- 注册上限设置 ----
  app.get("/api/admin/registration", { preHandler: [requireAdmin] }, async () => {
    const raw = appSettings.get("registration.max_users");
    const maxUsers = raw ? parseInt(raw, 10) || 0 : 0;
    const count = (db.prepare("SELECT COUNT(*) as count FROM users WHERE disabled = 0").get() as any).count;
    return { success: true, data: { maxUsers, currentCount: count } };
  });

  app.put("/api/admin/registration", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = registrationSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    appSettings.set("registration.max_users", String(parsed.data.maxUsers));
    const count = (db.prepare("SELECT COUNT(*) as count FROM users WHERE disabled = 0").get() as any).count;
    return { success: true, data: { maxUsers: parsed.data.maxUsers, currentCount: count } };
  });

  // ---- 白名单设置 ----
  app.get("/api/admin/whitelist", { preHandler: [requireAdmin] }, async () => {
    const enabled = appSettings.get("whitelist.enabled") === "1";
    const raw = appSettings.get("whitelist.emails");
    let emails: string[] = [];
    if (raw) {
      try { emails = JSON.parse(raw); } catch { emails = []; }
    }
    return { success: true, data: { enabled, emails } };
  });

  app.put("/api/admin/whitelist", { preHandler: [requireAdmin] }, async (request, reply) => {
    const parsed = whitelistSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }
    appSettings.set("whitelist.enabled", parsed.data.enabled ? "1" : "0");
    appSettings.set("whitelist.emails", JSON.stringify(parsed.data.emails));
    return { success: true, data: { enabled: parsed.data.enabled, emails: parsed.data.emails } };
  });

  // ---- 立即同步全部数据源 ----
  // 手动触发一次调度遍历（直调 tick，无 withRetry、即时返回），供「立即同步」按钮
  // 与 L3 编排测试使用。逐源失败互不影响（tick 内部已隔离）。
  app.post("/api/admin/marketplaces/sync", { preHandler: [requireAdmin] }, async () => {
    await tick();
    return { success: true };
  });
}
