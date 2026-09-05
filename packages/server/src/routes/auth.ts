import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { hashPassword, verifyPassword, generateToken, generateId, needsPasswordRehash } from "../lib/crypto.js";
import { loginSchema, changePasswordSchema, passwordPolicySchema } from "@maolinc/cc-loom-shared";
import { requireAuth, requireAnyAuth } from "../lib/auth.js";
import { authCacheInvalidate, authCacheInvalidateUser } from "../lib/auth-cache.js";
import { appSettings } from "../lib/app-settings.js";
import { useSecureCookies } from "../lib/runtime-security.js";

function isBootstrapAdmin(email: string): boolean {
  return email === process.env.LOOM_ADMIN_EMAIL?.trim();
}

/** 读取白名单配置。 */
function getWhitelistSettings(): { enabled: boolean; emails: string[] } {
  const enabled = appSettings.get("whitelist.enabled") === "1";
  const raw = appSettings.get("whitelist.emails");
  let emails: string[] = [];
  if (raw) {
    try { emails = JSON.parse(raw); } catch { emails = []; }
  }
  return { enabled, emails };
}

/** 读取注册上限。0 = 不限制。 */
function getMaxUsers(): number {
  const raw = appSettings.get("registration.max_users");
  return raw ? parseInt(raw, 10) || 0 : 0;
}

export function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute", ban: 0 } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "邮箱格式不正确" });
    }

    const { email, password } = parsed.data;
    let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;

    // 新邮箱 → 自动注册
    if (!user) {
      const passwordResult = passwordPolicySchema.safeParse(password);
      if (!passwordResult.success) {
        return reply.status(400).send({ success: false, error: passwordResult.error.issues[0]?.message || "密码不符合安全要求" });
      }
      // 启动时指定的管理员可以在白名单启用前完成首次登录。
      const wl = getWhitelistSettings();
      if (wl.enabled && !isBootstrapAdmin(email) && !wl.emails.includes(email)) {
        return reply.status(403).send({ success: false, error: "该邮箱未在白名单中，无法注册" });
      }

      // 启动时指定的管理员不计入注册上限。
      const maxUsers = getMaxUsers();
      if (maxUsers > 0 && !isBootstrapAdmin(email)) {
        const count = (db.prepare("SELECT COUNT(*) as count FROM users WHERE disabled = 0").get() as any).count;
        if (count >= maxUsers) {
          return reply.status(403).send({ success: false, error: "注册用户已达上限，请联系管理员" });
        }
      }

      const now = new Date().toISOString();
      const userId = generateId();
      db.prepare(
        "INSERT INTO users (id, email, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'user', 0, ?, ?)"
      ).run(userId, email, hashPassword(password), now, now);
      user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    }

    // 停用检查
    if (user.disabled) {
      return reply.status(403).send({ success: false, error: "该账户已被停用，请联系管理员" });
    }

    // 已有管理员与启动时指定的管理员不受白名单限制，避免把管理入口锁死。
    const wl = getWhitelistSettings();
    if (wl.enabled && user.role !== "admin" && !isBootstrapAdmin(email) && !wl.emails.includes(email)) {
      return reply.status(403).send({ success: false, error: "该邮箱未在白名单中，无法登录" });
    }

    if (!verifyPassword(password, user.password_hash)) {
      return reply.status(401).send({ success: false, error: "密码错误" });
    }
    if (needsPasswordRehash(user.password_hash)) {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(hashPassword(password), new Date().toISOString(), user.id);
    }

    const sessionId = generateId();
    db.prepare("INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)").run(
      sessionId,
      user.id,
      new Date().toISOString()
    );

    reply.setCookie("loom_session", sessionId, {
      httpOnly: true,
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
      sameSite: "lax",
      secure: useSecureCookies(),
    });

    return { success: true, data: { userId: user.id, email: user.email, role: user.role } };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = request.cookies?.loom_session;
    if (sessionId) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      authCacheInvalidate(sessionId);
    }
    reply.clearCookie("loom_session", { path: "/" });
    return { success: true };
  });

  app.get("/api/auth/me", { preHandler: [requireAnyAuth] }, async (request) => {
    return { success: true, data: request.user };
  });

  app.post("/api/auth/change-password", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "请求参数不正确" });
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(request.user!.userId) as any;
    if (!verifyPassword(parsed.data.currentPassword, user.password_hash)) {
      return reply.status(400).send({ success: false, error: "当前密码不正确" });
    }

    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      hashPassword(parsed.data.newPassword),
      new Date().toISOString(),
      user.id
    );
    // 密码变更：失效该用户所有缓存（session + CLI token）
    authCacheInvalidateUser(user.id);

    return { success: true };
  });

  app.get("/api/auth/cli-token", { preHandler: [requireAuth] }, async (request) => {
    let token = db.prepare("SELECT * FROM cli_tokens WHERE user_id = ?").get(request.user!.userId) as any;

    if (!token) {
      const id = generateId();
      const tokenStr = generateToken();
      db.prepare("INSERT INTO cli_tokens (id, user_id, token, created_at) VALUES (?, ?, ?, ?)").run(
        id,
        request.user!.userId,
        tokenStr,
        new Date().toISOString()
      );
      token = db.prepare("SELECT * FROM cli_tokens WHERE id = ?").get(id);
    }

    return { success: true, data: { token: token.token, createdAt: token.created_at } };
  });

  app.post("/api/auth/cli-token/regenerate", { preHandler: [requireAuth] }, async (request) => {
    // 旧 token 先取出以便失效缓存
    const old = db.prepare("SELECT token FROM cli_tokens WHERE user_id = ?").get(request.user!.userId) as { token: string } | undefined;
    db.prepare("DELETE FROM cli_tokens WHERE user_id = ?").run(request.user!.userId);
    if (old) authCacheInvalidate(`cli:${old.token}`);

    const id = generateId();
    const tokenStr = generateToken();
    db.prepare("INSERT INTO cli_tokens (id, user_id, token, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      request.user!.userId,
      tokenStr,
      new Date().toISOString()
    );

    return { success: true, data: { token: tokenStr } };
  });
}
