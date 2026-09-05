/**
 * 简单的 LRU 认证缓存。避免每请求重复查询 sessions + users 表。
 * - 容量上限 200 条
 * - TTL 60 秒
 * - 登出/token 删除时主动失效
 */

import type { UserRole } from "@maolinc/cc-loom-shared";

interface CacheEntry {
  userId: string;
  email: string;
  role: UserRole;
  cachedAt: number;
}

const MAX_SIZE = 200;
const TTL_MS = 60_000;

// key: sessionId 或 cliToken
const cache = new Map<string, CacheEntry>();

export function authCacheGet(key: string): { userId: string; email: string; role: UserRole } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > TTL_MS) {
    cache.delete(key);
    return null;
  }
  // LRU: 重新插入让其排到末尾
  cache.delete(key);
  cache.set(key, entry);
  return { userId: entry.userId, email: entry.email, role: entry.role };
}

export function authCacheSet(key: string, userId: string, email: string, role: UserRole): void {
  // 超出容量时驱逐最旧条目（Map 迭代顺序 = 插入顺序）
  if (cache.size >= MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { userId, email, role, cachedAt: Date.now() });
}

export function authCacheInvalidate(key: string): void {
  cache.delete(key);
}

/** 失效某用户的所有缓存条目（用于密码修改、角色变更、停用等场景） */
export function authCacheInvalidateUser(userId: string): void {
  for (const [k, v] of cache.entries()) {
    if (v.userId === userId) cache.delete(k);
  }
}
