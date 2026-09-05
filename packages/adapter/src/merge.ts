import type { MergeStrategy } from "./types.js";

/**
 * 把传入的 hooks-registry JSON 与现存文件合并。
 *
 * 输入/输出形态：`{ hooks: { <eventName>: Array<{ matcher?, hooks: [...] }> } }`
 *
 * 合并语义：
 * - 顶层 `hooks` 字段以外的字段：保留 existing。
 * - `version`（schema 版本号，非用户数据，如 Cursor hooks.json 的 `version:1`）：
 *   existing 没有时从 incoming 取，保证首次写入/合并不丢 schema 标记。
 * - 同一 event 下：按 matcher 合并条目。
 *   - 若 incoming 与 existing 在 (event, matcher) 上重合：incoming 的 hooks[] 数组**追加**到 existing 同位置 hooks[] 之后（保持顺序、不去重，由作者负责幂等）。
 *   - 若仅一方存在：原样保留。
 *
 * existing 为空字符串或非法 JSON 时视为空对象，相当于纯 incoming。
 */
export function mergeHooksRegistry(existing: string, incoming: string): string {
  const existingObj = parseObject(existing);
  const incomingObj = parseObject(incoming);

  const merged = { ...existingObj };
  const hooksOut = mergeHooksField(
    existingObj.hooks as Record<string, unknown> | undefined,
    incomingObj.hooks as Record<string, unknown> | undefined,
  );
  if (hooksOut) merged.hooks = hooksOut;
  if (merged.version === undefined && incomingObj.version !== undefined) {
    merged.version = incomingObj.version;
  }

  return JSON.stringify(merged, null, 2);
}

/**
 * 合并 settings.json：顶层字段浅合并（incoming 同名字段覆盖 existing），
 * 但 hooks 子字段走 mergeHooksRegistry 的深度合并语义。
 */
export function mergeSettingsWithHooks(existing: string, incoming: string): string {
  const existingObj = parseObject(existing);
  const incomingObj = parseObject(incoming);

  // 先做顶层浅合并（不含 hooks）
  const merged: Record<string, unknown> = { ...existingObj };
  for (const [k, v] of Object.entries(incomingObj)) {
    if (k === "hooks") continue;
    merged[k] = v;
  }

  // hooks 字段做深度合并
  const hooksOut = mergeHooksField(
    existingObj.hooks as Record<string, unknown> | undefined,
    incomingObj.hooks as Record<string, unknown> | undefined,
  );
  if (hooksOut) merged.hooks = hooksOut;
  else if ("hooks" in existingObj) merged.hooks = existingObj.hooks;

  return JSON.stringify(merged, null, 2);
}

/**
 * 合并 mcp.json — 把 incoming 的 `mcpServers[name]` 条目合并进 existing 的 `mcpServers`，
 * 同名 server 以 incoming 为准（更新场景），existing 中未被 incoming 提及的保留（用户自配置不被抹）。
 *
 * 容错：
 * - existing 为空 / 非 JSON / 不是对象 → 视为空 mcpServers。
 * - incoming 顶层没有 mcpServers 但是个 plain object → 整体当 mcpServers（兼容旧数据）。
 */
export function mergeMcpServers(existing: string, incoming: string): string {
  const existingObj = parseObject(existing);
  const incomingObj = parseObject(incoming);

  const existingServers = pickServers(existingObj);
  const incomingServers = pickServers(incomingObj);

  const merged: Record<string, unknown> = { ...existingObj };
  merged.mcpServers = { ...existingServers, ...incomingServers };

  return JSON.stringify(merged, null, 2);
}

/** 派发：根据 strategy 选择合并函数。 */
export function mergeContent(
  strategy: MergeStrategy,
  existing: string,
  incoming: string,
): string {
  switch (strategy) {
    case "hooks-registry":
      return mergeHooksRegistry(existing, incoming);
    case "settings-with-hooks":
      return mergeSettingsWithHooks(existing, incoming);
    case "mcp-servers":
      return mergeMcpServers(existing, incoming);
  }
}

// ----- helpers -----

function parseObject(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore — treat as empty
  }
  return {};
}

/** hooks 字段（{event: matcherEntries[]}）的合并；返回 undefined 表示双方都没有。 */
function mergeHooksField(
  existingHooks: Record<string, unknown> | undefined,
  incomingHooks: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const a = isPlainObject(existingHooks) ? (existingHooks as Record<string, unknown>) : undefined;
  const b = isPlainObject(incomingHooks) ? (incomingHooks as Record<string, unknown>) : undefined;
  if (!a && !b) return undefined;
  if (!a) return b!;
  if (!b) return a;

  const out: Record<string, unknown> = { ...a };
  for (const [event, incomingEntries] of Object.entries(b)) {
    if (!Array.isArray(incomingEntries)) continue;
    const existingEntries = Array.isArray(out[event]) ? (out[event] as unknown[]) : [];
    out[event] = mergeMatcherEntries(existingEntries, incomingEntries);
  }
  return out;
}

/** 同一 event 下，按 matcher 合并 matcherEntries 数组。 */
function mergeMatcherEntries(existing: unknown[], incoming: unknown[]): unknown[] {
  const result = existing.map((e) => clone(e));
  for (const inc of incoming) {
    if (!isPlainObject(inc)) continue;
    const incObj = inc as Record<string, unknown>;
    const incMatcher = typeof incObj.matcher === "string" ? incObj.matcher : undefined;
    const idx = result.findIndex((e) => {
      if (!isPlainObject(e)) return false;
      const m = (e as Record<string, unknown>).matcher;
      const eMatcher = typeof m === "string" ? m : undefined;
      return eMatcher === incMatcher;
    });
    if (idx === -1) {
      result.push(clone(incObj));
    } else {
      const existingHooks = Array.isArray((result[idx] as any).hooks) ? (result[idx] as any).hooks as unknown[] : [];
      const incomingHooks = Array.isArray(incObj.hooks) ? (incObj.hooks as unknown[]) : [];
      result[idx] = {
        ...(result[idx] as object),
        hooks: [...existingHooks, ...incomingHooks],
      };
    }
  }
  return result;
}

function isPlainObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 从 mcp 配置对象中提取 server 字典。容忍两种形态：
 * - 标准 `{ mcpServers: { ... } }`
 * - 历史/裸 `{ <name>: <def>, ... }`（顶层即 server 字典，没有 mcpServers 包装）
 */
function pickServers(obj: Record<string, unknown>): Record<string, unknown> {
  if (isPlainObject(obj.mcpServers)) {
    return obj.mcpServers as Record<string, unknown>;
  }
  // 顶层就是 server 字典；用粗判：所有 value 都是 plain object 时认为是
  if (Object.values(obj).every(isPlainObject)) {
    return obj;
  }
  return {};
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
