/**
 * 查询向量缓存（docs/sqlite-vec-search-design.md §4.x）。
 *
 * 语义检索需要把用户查询词 embed 成向量。与索引向量不同，查询词是用户实时输入、
 * 高频重复（来回切换筛选、分页、多人搜同一热词），每次都打远程 embedding 接口既慢
 * 又费配额。这里在内存里缓存「查询词 → 向量」映射，命中即跳过接口调用。
 *
 * 容量与时效由调用方语义决定：
 * - 上限 10 条（LRU）：查询词组合远比资产少，小容量足够覆盖典型反复搜索。
 * - TTL 60s：embedding 模型/索引内容变化后，旧向量短时失效；超时即重算。
 *
 * 说明：本缓存只针对「查询向量」（mode="query"）。索引向量（passage）每条资产唯一、
 * 由 search-indexer 写库，无需在此缓存。
 */

interface CacheEntry {
  /** 向量，命中时直接复用，免远程调用。 */
  vec: number[];
  /** 写入时刻（ms）。用于 TTL 判断；命中时无需续期（避免热词常驻不失效）。 */
  at: number;
}

const CAPACITY = 10;
const TTL_MS = 60_000;

const store = new Map<string, CacheEntry>();

/**
 * 取缓存的查询向量。命中（未超 TTL）返回向量，否则 undefined。
 *
 * Map 的迭代顺序即插入顺序；LRU 复用靠 delete + 重新 set 实现「命中即提到末尾」。
 * 不做访问频次统计——容量小，单纯按最近活跃淘汰即可。
 */
export function getQueryVector(key: string, now: number): number[] | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (now - e.at >= TTL_MS) {
    store.delete(key);
    return undefined;
  }
  // 命中提到末尾：先删再插，使其成为最新条目，避免被 LRU 淘汰。
  store.delete(key);
  store.set(key, e);
  return e.vec;
}

/**
 * 写入查询向量。超容量时淘汰最旧条目（Map 迭代首项）。
 * `now` 由调用方传入，便于测试注入；运行时取 Date.now()。
 */
export function setQueryVector(key: string, vec: number[], now: number): void {
  store.delete(key);
  store.set(key, { vec, at: now });
  while (store.size > CAPACITY) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** 清空缓存（仅测试/重置用）。 */
export function clearQueryVectorCache(): void {
  store.clear();
}
