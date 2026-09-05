/**
 * 凭据解析 + path 注入（ADR-0003）。
 *
 * 两件事：
 *  1. `loadDistributedCredentials(userId, projectId)`：查本项目已显式分发（axis=path）
 *     的凭据，解密成 credentialName→明文 映射，供 reconcile 渲染注入用。
 *  2. `applyPathBindings(serverDef, bindings, credValues)`：把 path 绑定的值字面替换进
 *     server def 的对应路径。纯函数，按 ADR 决策 4-6：
 *      - 路径相对**未包装的 server def**，`/` 分隔。
 *      - 单 server（serverDef 即整个 def）→ 路径直指 def。
 *      - 多 server（serverDef 是 {serverKey: def, ...}）→ 路径第一段为 server key。
 *      - 有值且叶子不存在 → 自动创建中间对象与叶子。
 *      - 有值且叶子为字符串 → 覆盖。
 *      - 叶子非字符串 / 路径中途遍历到非对象 → 抛错（调用方将资产标记为 reconcile 失败）。
 *      - 无值（未分发或未配置）→ 不动作者原始叶子（纯函数渲染：保留作者内容）。
 *
 * 凭据值在 reconcile 渲染时解密后存在内存里，绝不落日志（与 env-vars 同口径）。
 */
import { db } from "../db/index.js";
import { decryptSecret } from "./crypto.js";
import type { AssetAuthBinding } from "@maolinc/cc-loom-shared";

/**
 * 按 assetId 列表批量加载其鉴权绑定（从 asset_auth_bindings 子表）。
 * 返回 assetId → bindings[]（按 ordinal 排序，保持 UI 声明顺序）。
 * 无绑定的 asset 不出现在 map 中。
 */
export function loadAuthBindings(assetIds: string[]): Map<string, AssetAuthBinding[]> {
  const out = new Map<string, AssetAuthBinding[]>();
  if (assetIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT asset_id, credential_name, kind, env_key, path, auth_page_url
         FROM asset_auth_bindings
        WHERE asset_id IN (${assetIds.map(() => "?").join(",")})
        ORDER BY asset_id, ordinal`,
    )
    .all(...assetIds) as {
      asset_id: string;
      credential_name: string;
      kind: string;
      env_key: string | null;
      path: string | null;
      auth_page_url: string | null;
    }[];
  for (const r of rows) {
    const b: AssetAuthBinding = {
      credentialName: r.credential_name,
      kind: r.kind as AssetAuthBinding["kind"],
      ...(r.env_key ? { envKey: r.env_key } : {}),
      ...(r.path ? { path: r.path } : {}),
      ...(r.auth_page_url ? { authPageUrl: r.auth_page_url } : {}),
    };
    const arr = out.get(r.asset_id) ?? [];
    arr.push(b);
    out.set(r.asset_id, arr);
  }
  return out;
}

/**
 * 加载本项目已分发（axis=path）且已配置值的凭据，解密为 credentialName→明文。
 * 调用方：reconcile 渲染注入。仅返回 path 轴分发的凭据；env 轴走 env:push 通道，不在此处。
 */
export function loadDistributedCredentials(
  userId: string,
  projectId: string,
): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT c.name AS name, c.value_cipher AS value_cipher
         FROM credentials c
         JOIN credential_distributions d
           ON d.credential_id = c.id AND d.axis = 'path' AND d.target_id = ?
        WHERE c.user_id = ?`,
    )
    .all(projectId, userId) as { name: string; value_cipher: string }[];
  const out = new Map<string, string>();
  for (const r of rows) {
    try {
      out.set(r.name, decryptSecret(r.value_cipher));
    } catch {
      // 解密失败（密钥不匹配/密文损坏）——跳过，等同于「未配置」。
      // 纯函数渲染会保留作者原始叶子；reconcile 不应因单个凭据损坏而整体失败。
    }
  }
  return out;
}

/**
 * 解析「未包装 server def」的形态：
 *  - 单 server：serverDef 即 def 本体（{command,args,...} 或 {type,url,headers,...}）。
 *  - 多 server 包装：serverDef 是 {serverKey: def, ...}，路径第一段需为 server key。
 *
 * 判据：若 serverDef 的所有顶层值都是对象 → 视为多 server 包装；否则单 server。
 * 这与 adapter `parseServerDef` 的口径一致（wrapped 的判定看 mcpServers 外层，但此处
 * 已是 server def 级，我们按「顶层值是否全为对象」识别多 server 包装）。
 */
function isMultiServerWrap(serverDef: unknown): serverDef is Record<string, Record<string, unknown>> {
  if (!serverDef || typeof serverDef !== "object" || Array.isArray(serverDef)) return false;
  const obj = serverDef as Record<string, unknown>;
  const vals = Object.values(obj);
  if (vals.length === 0) return false;
  return vals.every((v) => v && typeof v === "object" && !Array.isArray(v));
}

/** 按 / 分割路径段，保留空段用于精确报错。 */
function splitPath(path: string): string[] {
  return path.split("/");
}

/** 在对象内沿路径写入值；自动创建缺失的中间对象。失败时抛错（非字符串叶子/遍历冲突）。 */
function writeLeaf(root: Record<string, unknown>, segments: string[], value: string): void {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    let next = cur[seg];
    if (next === undefined || next === null) {
      next = {};
      cur[seg] = next;
    } else if (typeof next !== "object" || Array.isArray(next)) {
      throw new Error(`路径 ${segments.join("/")} 在段 "${seg}" 遇到非对象（${Array.isArray(next) ? "数组" : typeof next}），无法注入凭据`);
    }
    cur = next as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1]!;
  const existing = cur[leaf];
  if (existing !== undefined && existing !== null && typeof existing !== "string") {
    throw new Error(`路径 ${segments.join("/")} 的叶子非字符串（${typeof existing}），无法注入凭据`);
  }
  cur[leaf] = value;
}

/**
 * 把 path 绑定的值字面替换进 server def（返回新对象，不改原 def）。
 * 仅处理 kind=path 的绑定；env 绑定不在此处（走 env:push）。
 * 无值的绑定跳过（保留作者原始叶子）。
 *
 * 多 server 包装：路径第一段为 server key，其余相对该 server 的 def。
 * 单 server：路径直接相对 def。
 *
 * @param serverDef 已 unwrap 的 server def（单 server = def 本体；多 server = {key: def}）
 * @param bindings 该资产的所有 path 绑定
 * @param credValues credentialName→明文（仅含已分发且已配置者）
 * @returns 注入后的新 server def；无任何可注入绑定时返回原对象
 * @throws 路径遍历到非对象 / 叶子非字符串
 */
export function applyPathBindings(
  serverDef: unknown,
  bindings: AssetAuthBinding[],
  credValues: Map<string, string>,
): unknown {
  const pathBindings = bindings.filter((b) => b.kind === "path" && b.path);
  if (pathBindings.length === 0) return serverDef;

  // 深拷贝，避免改到 manifest 缓存里的对象。
  const result: unknown = structuredClone(serverDef);
  const multi = isMultiServerWrap(result);
  const root = result as Record<string, unknown>;

  for (const b of pathBindings) {
    const value = credValues.get(b.credentialName);
    if (value === undefined) continue; // 未分发或未配置 → 保留作者叶子
    const segs = splitPath(b.path!);
    if (segs.length === 0 || segs.some((s) => s.length === 0)) {
      throw new Error(`路径 ${b.path} 非法（含空段）`);
    }
    if (multi) {
      const serverKey = segs[0]!;
      const rest = segs.slice(1);
      if (rest.length === 0) {
        throw new Error(`路径 ${b.path} 缺少 server key 之后的路径段（多 server 包装）`);
      }
      let serverDefEntry = root[serverKey];
      if (serverDefEntry === undefined || serverDefEntry === null) {
        serverDefEntry = {};
        root[serverKey] = serverDefEntry;
      } else if (typeof serverDefEntry !== "object" || Array.isArray(serverDefEntry)) {
        throw new Error(`server key "${serverKey}" 对应的值非对象，无法注入凭据`);
      }
      writeLeaf(serverDefEntry as Record<string, unknown>, rest, value);
    } else {
      writeLeaf(root, segs, value);
    }
  }
  return result;
}
