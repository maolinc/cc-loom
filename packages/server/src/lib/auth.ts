import type { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/index.js";
import type { SessionUser, UserRole } from "@maolinc/cc-loom-shared";
import { authCacheGet, authCacheSet } from "./auth-cache.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
    isAuthenticated: boolean;
  }
}

/** 从 DB 查询用户身份（含 role/disabled），返回 SessionUser 或 null。 */
function loadUser(userId: string): SessionUser | null {
  const user = db
    .prepare("SELECT id, email, role, disabled FROM users WHERE id = ?")
    .get(userId) as { id: string; email: string; role: UserRole; disabled: number } | undefined;

  if (!user) return null;
  return { userId: user.id, email: user.email, role: user.role };
}

export async function sessionHook(
  request: FastifyRequest,
  _reply: FastifyReply
) {
  const sessionId = request.cookies?.loom_session;
  if (!sessionId) {
    request.isAuthenticated = false;
    return;
  }

  // 先查缓存
  const cached = authCacheGet(sessionId);
  if (cached) {
    request.user = cached;
    request.isAuthenticated = true;
    return;
  }

  const session = db
    .prepare("SELECT user_id FROM sessions WHERE id = ?")
    .get(sessionId) as { user_id: string } | undefined;

  if (!session) {
    request.isAuthenticated = false;
    return;
  }

  const user = loadUser(session.user_id);

  if (!user) {
    request.isAuthenticated = false;
    return;
  }

  // 写入缓存
  authCacheSet(sessionId, user.userId, user.email, user.role);
  request.user = user;
  request.isAuthenticated = true;
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!request.isAuthenticated) {
    return reply.status(401).send({ success: false, error: "请先登录" });
  }
  // 停用检查：缓存可能滞后 60s，此处兜底查 DB
  const row = db.prepare("SELECT disabled FROM users WHERE id = ?").get(request.user!.userId) as { disabled: number } | undefined;
  if (row?.disabled) {
    return reply.status(403).send({ success: false, error: "该账户已被停用" });
  }
}

export async function requireCliAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return reply.status(401).send({ success: false, error: "缺少认证 Token" });
  }

  const token = header.slice(7);

  // 先查缓存
  const cached = authCacheGet(`cli:${token}`);
  if (cached) {
    // 停用检查
    const row = db.prepare("SELECT disabled FROM users WHERE id = ?").get(cached.userId) as { disabled: number } | undefined;
    if (row?.disabled) {
      return reply.status(403).send({ success: false, error: "该账户已被停用" });
    }
    request.user = cached;
    request.isAuthenticated = true;
    return;
  }

  const cliToken = db
    .prepare("SELECT user_id FROM cli_tokens WHERE token = ?")
    .get(token) as { user_id: string } | undefined;

  if (!cliToken) {
    return reply.status(401).send({ success: false, error: "无效的 Token" });
  }

  const user = loadUser(cliToken.user_id);

  if (!user) {
    return reply.status(401).send({ success: false, error: "用户不存在" });
  }

  // 停用检查
  const row = db.prepare("SELECT disabled FROM users WHERE id = ?").get(user.userId) as { disabled: number } | undefined;
  if (row?.disabled) {
    return reply.status(403).send({ success: false, error: "该账户已被停用" });
  }

  authCacheSet(`cli:${token}`, user.userId, user.email, user.role);
  request.user = user;
  request.isAuthenticated = true;
}

export async function requireAnyAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Check session first (already resolved by sessionHook with cache)
  if (request.isAuthenticated) {
    // 停用检查
    const row = db.prepare("SELECT disabled FROM users WHERE id = ?").get(request.user!.userId) as { disabled: number } | undefined;
    if (row?.disabled) {
      return reply.status(403).send({ success: false, error: "该账户已被停用" });
    }
    return;
  }

  // Check CLI token
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7);

    // 先查缓存
    const cached = authCacheGet(`cli:${token}`);
    if (cached) {
      const row = db.prepare("SELECT disabled FROM users WHERE id = ?").get(cached.userId) as { disabled: number } | undefined;
      if (row?.disabled) {
        return reply.status(403).send({ success: false, error: "该账户已被停用" });
      }
      request.user = cached;
      request.isAuthenticated = true;
      return;
    }

    const cliToken = db
      .prepare("SELECT user_id FROM cli_tokens WHERE token = ?")
      .get(token) as { user_id: string } | undefined;

    if (cliToken) {
      const user = loadUser(cliToken.user_id);

      if (user) {
        const row = db.prepare("SELECT disabled FROM users WHERE id = ?").get(user.userId) as { disabled: number } | undefined;
        if (row?.disabled) {
          return reply.status(403).send({ success: false, error: "该账户已被停用" });
        }
        authCacheSet(`cli:${token}`, user.userId, user.email, user.role);
        request.user = user;
        request.isAuthenticated = true;
        return;
      }
    }
  }

  return reply.status(401).send({ success: false, error: "请先登录" });
}

/** 要求 admin 角色。 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!request.isAuthenticated) {
    return reply.status(401).send({ success: false, error: "请先登录" });
  }
  if (request.user!.role !== "admin") {
    return reply.status(403).send({ success: false, error: "需要管理员权限" });
  }
}
