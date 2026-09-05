import { describe, it, expect, beforeEach } from "vitest";
import { getQueryVector, setQueryVector, clearQueryVectorCache } from "../lib/query-vector-cache.js";

// L1：验证查询向量缓存的基础语义——命中复用、TTL 失效、LRU 淘汰。
// 保护的不变量：同一搜索词在 TTL 内不重复计算；超容量淘汰最旧；超时回收。

beforeEach(() => { clearQueryVectorCache(); });

describe("query-vector-cache", () => {
  it("未命中返回 undefined；写入后命中返回同一向量", () => {
    expect(getQueryVector("react", 1000)).toBeUndefined();
    setQueryVector("react", [1, 2, 3], 1000);
    expect(getQueryVector("react", 1000)).toEqual([1, 2, 3]);
  });

  it("TTL 60s：未过期命中，过期后回收", () => {
    setQueryVector("react", [1, 2, 3], 1_000);
    expect(getQueryVector("react", 1_000 + 59_999)).toEqual([1, 2, 3]);
    expect(getQueryVector("react", 1_000 + 60_000)).toBeUndefined();
  });

  it("LRU：容量 10，第 11 条写入淘汰最旧（首项）", () => {
    for (let i = 0; i < 10; i++) setQueryVector(`q${i}`, [i], 1_000);
    // 全部命中，确认 10 条都在
    for (let i = 0; i < 10; i++) expect(getQueryVector(`q${i}`, 1_000)).toEqual([i]);
    // 命中 q0 把它提到末尾 → q1 成为最旧
    void getQueryVector("q0", 1_000);
    setQueryVector("q10", [10], 1_000);
    expect(getQueryVector("q1", 1_000)).toBeUndefined(); // 被淘汰
    expect(getQueryVector("q0", 1_000)).toEqual([0]);   // 仍存活
    expect(getQueryVector("q10", 1_000)).toEqual([10]);
  });

  it("重复写入同一 key 刷新值与时间，不增加条目", () => {
    setQueryVector("react", [1], 1_000);
    setQueryVector("react", [9, 9, 9], 1_000 + 30_000);
    expect(getQueryVector("react", 1_000 + 30_000)).toEqual([9, 9, 9]);
    // 刷新后 TTL 从新写入时刻起算：30s 后仍有效
    expect(getQueryVector("react", 1_000 + 30_000 + 30_000)).toEqual([9, 9, 9]);
    expect(getQueryVector("react", 1_000 + 30_000 + 60_000)).toBeUndefined();
  });
});
