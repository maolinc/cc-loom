/**
 * Wire 协议 v2 的 CLI 端落地执行器。
 *
 * 入参：`WsReconcileRequest` —— server 已渲染完文件级 diff，CLI 只负责把每个 vendor
 * 文件 / 隔离区文件 / 聚合文件按 plan 写进磁盘。详见
 * docs/refactor/wire-protocol-unification.md §4。
 *
 * 流程（与 §4.1 的草稿对齐，并补齐了草稿里漏写的"enabled 桶内 disabled vendor 进
 * 隔离区"分支）：
 *
 *   1. 读旧 lock，推导 `oldFiles` 与 `migrationDisabled`（仅 lockFormat !== "2" 时）。
 *   2. 构造 `newVendorFiles` / `newDisabledFiles` 集合，用于 orphan 清理与 lock 重建。
 *   3. 删除 orphans：
 *      - 旧 lock 中的 vendor 文件不在 newVendorFiles → vendor 目录删；
 *      - 旧 lock 中的 vendor 文件出现在 newDisabledFiles → 由 disabled 写入分支处理；
 *      - aggregates 中 content=null 的路径 → vendor 目录删（pruneEmptyDirs）。
 *   4. 写 enabled 桶：每个 vendor.enabled=true 的 vendor 落 vendor 目录 +
 *      `clearDisabledCopy` 维护不变量。
 *   5. 写 disabled 集合：每个文件路径（enabled 桶内 disabled vendor 的 files +
 *      disabled 桶的所有 vendor files）→ 若 vendor 目录存在该文件则 move 到
 *      隔离区，否则 writeFileAtomic 到隔离区。
 *   6. removed 列表的 asset：其在旧 lock 的所有 vendor / 隔离区文件清理。
 *   7. 写 aggregates：content !== null 写 vendor 目录；content=null 删除。
 *   8. 重建 v2 lock；注入 skill tracker。
 *
 * 与旧 installer / capabilities 三个原语相比，本 handler 是「单一巨型 plan 一次性
 * 落地」语义：任何中间步骤错误 → push 到 errors，最终 success = errors.length === 0。
 */
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AssetType,
  LockAggregateEntry,
  LockAssetEntry,
  LockFile,
  LockVendorState,
  ReconcileAggregate,
  ReconcileAsset,
  ReconcilePlan,
  TargetTool,
  WsReconcileRequest,
  WsReconcileResponseData,
} from "@maolinc/cc-loom-shared";
import {
  isLegacyLock,
  lockedFiles,
  readLock,
  writeLock,
} from "./locks.js";
import { listAdapters, AggregateParseError } from "@maolinc/cc-loom-adapter";
import type { Adapter } from "@maolinc/cc-loom-adapter";
import {
  moveFileBinarySafe,
  pruneEmptyAncestors,
  readIfExists,
  removeFileAndPruneEmptyDirs,
  removeIfExists,
  resolveSafe,
  UnsafePathError,
  writeFileAtomic,
} from "./safe-write.js";
import {
  clearDisabledCopy,
  disabledPath,
  disabledProjectRoot,
} from "./paths.js";
import { applySkillTracker } from "./skill-tracker.js";

export interface ReconcileRunOutcome {
  /** 直接构成 res.payload.data 回传给 server。 */
  response: WsReconcileResponseData;
  /** 用于调用方打日志：本次 plan 内部错误（非 fatal）。 */
  errors: string[];
}

/**
 * 项目卸载/注销时调用:清空该 project 的整个隔离区子树。原属 capabilities.ts,
 * v2 重构后所有"隔离区生命周期"由 reconcile-runner 拥有,统一在此暴露。
 */
export function clearDisabledForProject(projectId: string): void {
  const root = disabledProjectRoot(projectId);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

/**
 * 执行一次 reconcile plan。projectRoot 必须已由调用方校验是注册项目。
 */
export function applyReconcilePlan(
  req: WsReconcileRequest,
  projectRoot: string,
): ReconcileRunOutcome {
  const errors: string[] = [];
  const filesWritten: string[] = [];
  const filesRemoved: string[] = [];

  const oldLock = readLock(req.projectId);

  // 聚合 merge-preserving 需要 adapter：用全量 adapter（不只 req.targetTools）。dropped
  // 厂商（本次 effectiveTools 不含、但 server 仍 emit 了清理聚合）的 adapter 必须能查到，
  // 否则该聚合文件落不到 mergeAggregate、退回 orphan 整文件删除丢失 foreign。
  const adapterByTool = new Map<TargetTool, Adapter>();
  for (const a of listAdapters()) adapterByTool.set(a.tool, a);

  // oldLock 中登记过的聚合文件集合——orphan 清理一律跳过：聚合文件只能由 mergeAggregate
  // 按 ownedKeys 增删条目（保留 foreign），绝不能整文件删除。这是 dropped 厂商 / 边缘
  // 情况下「不丢用户手写内容」的兜底护栏。
  const oldAggregateFiles = new Set<string>();
  if (oldLock?.aggregates) {
    for (const list of Object.values(oldLock.aggregates)) {
      for (const agg of list ?? []) oldAggregateFiles.add(agg.file);
    }
  }

  // ---- migrationDisabled：仅在旧 lock 来自 v1 per-asset 形态（非 legacy）时提取 ----
  const migrationDisabled = oldLock && !isLegacyLock(oldLock) && oldLock.lockFormat !== "2" && oldLock.lockFormat !== "3"
    ? extractDisabledPairs(oldLock)
    : [];

  // ---- 构造期望文件集合 ----
  const newVendorPaths = new Set<string>();      // 应在 vendor 目录的文件
  const newDisabledPaths = new Set<string>();    // 应在隔离区的文件
  const newAggregatePaths = new Set<string>();   // 本次 plan 涉及的聚合路径（merge 步骤自决写/删，orphan 步骤一律跳过）

  for (const a of req.plan.enabled) {
    for (const v of a.vendors) {
      for (const f of v.files) {
        if (v.enabled) newVendorPaths.add(f.path);
        else newDisabledPaths.add(f.path);
      }
    }
  }
  for (const a of req.plan.disabled) {
    for (const v of a.vendors) {
      for (const f of v.files) newDisabledPaths.add(f.path);
    }
  }
  for (const agg of req.plan.aggregates) {
    newAggregatePaths.add(agg.path);
  }

  // ---- 1. orphan 清理：旧 lock vendor 文件不再期望存在于 vendor 目录的，删 ----
  const oldFiles = lockedFiles(oldLock);
  for (const rel of oldFiles) {
    // 仍在新 vendor 集合 / 新 aggregates 集合 → 由后续写入覆盖，不删。
    if (newVendorPaths.has(rel) || newAggregatePaths.has(rel)) continue;
    // oldLock 登记过的聚合文件 → 永不整文件删（交由 mergeAggregate 保留 foreign）。
    if (oldAggregateFiles.has(rel)) continue;
    // 即将作为 disabled 写入隔离区 → 由 disabled 写入分支自然 move 走，不在此预删。
    if (newDisabledPaths.has(rel)) continue;
    try {
      removeFileAndPruneEmptyDirs(projectRoot, rel);
      filesRemoved.push(rel);
    } catch (err) {
      errors.push(`清理 ${rel} 失败: ${formatErr(err)}`);
    }
  }

  // ---- 2. 写 enabled 桶 vendor 文件 ----
  for (const asset of req.plan.enabled) {
    for (const vendor of asset.vendors) {
      if (!vendor.enabled) continue;
      for (const f of vendor.files) {
        try {
          const abs = resolveSafe(projectRoot, f.path);
          writeFileAtomic(abs, f.content, f.encoding);
          clearDisabledCopy(req.projectId, f.path);
          filesWritten.push(f.path);
        } catch (err) {
          errors.push(`${f.path}: ${formatErr(err)}`);
        }
      }
    }
  }

  // ---- 3. 写 disabled（enabled 桶内 disabled vendor + 整 disabled 桶） ----
  for (const asset of req.plan.enabled) {
    for (const vendor of asset.vendors) {
      if (vendor.enabled) continue;
      for (const f of vendor.files) writeDisabled(req.projectId, projectRoot, f.path, f.content, f.encoding, errors);
    }
  }
  for (const asset of req.plan.disabled) {
    for (const vendor of asset.vendors) {
      for (const f of vendor.files) writeDisabled(req.projectId, projectRoot, f.path, f.content, f.encoding, errors);
    }
  }

  // ---- 4. removed assets：删除其 vendor 文件 + 清隔离区副本 ----
  //   plan.removed 自带 vendors[].files（server 渲染的磁盘路径），直接删——覆盖从未入 lock
  //   的外部能力（adopt 后立即 remove）。已在 oldLock 的文件由 orphan 阶段兜底，此处幂等。
  //   隔离区副本：合并 plan files + oldLock 残留路径一并清。
  for (const asset of req.plan.removed) {
    const filesToWipe = new Set<string>();
    for (const v of asset.vendors) for (const f of v.files) filesToWipe.add(f.path);
    const oldEntry = oldLock?.assets[asset.assetId];
    if (oldEntry) {
      for (const f of oldEntry.files ?? []) filesToWipe.add(f);
      if (oldEntry.vendors) {
        for (const v of Object.values(oldEntry.vendors)) {
          for (const f of v?.files ?? []) filesToWipe.add(f);
        }
      }
    }
    for (const rel of filesToWipe) {
      try {
        removeFileAndPruneEmptyDirs(projectRoot, rel);
        filesRemoved.push(rel);
      } catch (err) {
        errors.push(`清理 ${rel} 失败: ${formatErr(err)}`);
      }
      clearDisabledCopy(req.projectId, rel);
    }
  }

  // ---- 5. 写 aggregates（merge-preserving：read-modify-write，保留 foreign 条目） ----
  // 解析失败（JSONC/损坏）的聚合路径：不写盘、不登记 lock，文件原样保留。下次 reconcile
  // 再试；用户修正后即可恢复同步。避免「解析失败=清空」静默丢用户内容。
  const failedAggPaths = new Set<string>();
  for (const agg of req.plan.aggregates) {
    try {
      const adapter = adapterByTool.get(agg.tool);
      if (!adapter) {
        errors.push(`${agg.path}: 无对应 adapter (${agg.tool})`);
        continue;
      }
      const abs = resolveSafe(projectRoot, agg.path);
      const existed = existsSync(abs);
      const existing = existed ? readIfExists(abs) : null;
      const merged = adapter.mergeAggregate(agg.type, agg.path, agg.entries, agg.ownedKeys, existing);
      if (merged === null) {
        // owned 全清且无 foreign → 删除文件（受保护路径删，失败回退直接 remove）
        if (existed) {
          try {
            removeFileAndPruneEmptyDirs(projectRoot, agg.path);
          } catch {
            const fallback = absUnsafe(projectRoot, agg.path);
            if (fallback) removeIfExists(fallback);
          }
          filesRemoved.push(agg.path);
        }
      } else {
        writeFileAtomic(abs, merged);
        clearDisabledCopy(req.projectId, agg.path);
        filesWritten.push(agg.path);
      }
    } catch (err) {
      if (err instanceof AggregateParseError) {
        failedAggPaths.add(agg.path);
        errors.push(`${agg.path}: ${err.message}`);
      } else {
        errors.push(`${agg.path}: ${formatErr(err)}`);
      }
    }
  }

  // ---- 6. 写新 lock（v2 格式） ----
  const newLock = buildV2Lock(req, filesWritten, failedAggPaths);
  try {
    const tracker = applySkillTracker(req.projectId, projectRoot, newLock);
    filesWritten.push(...tracker.written);
    filesRemoved.push(...tracker.removed);
  } catch (err) {
    errors.push(`同步 skill 统计 hook 失败: ${formatErr(err)}`);
  }
  // skill-tracker 出于防御会把 undefined 的 aggregates 提到 {} 再 delete tool 键，
  // 可能留下空对象。统一规整：空 → undefined，与 buildV2Lock 的不变量对齐。
  if (newLock.aggregates && Object.keys(newLock.aggregates).length === 0) {
    delete newLock.aggregates;
  }
  try {
    writeLock(req.projectId, newLock);
  } catch (err) {
    errors.push(`写 lock 失败: ${formatErr(err)}`);
  }

  // ---- 7. 无任何订阅时清空隔离区根 ----
  if (req.subscriptions.length === 0 && newVendorPaths.size === 0 && newDisabledPaths.size === 0) {
    try {
      clearDisabledForProject(req.projectId);
    } catch (err) {
      errors.push(`清理隔离区失败: ${formatErr(err)}`);
    }
  }

  const response: WsReconcileResponseData = {
    filesWritten: dedupe(filesWritten),
    filesRemoved: dedupe(filesRemoved),
    lockWorkspaceIds: newLock.subscriptions
      .map((s) => s.workspaceId)
      .filter((id): id is string => id !== null),
    ...(migrationDisabled.length > 0 ? { migrationDisabled } : {}),
  };
  return { response, errors };
}

// ---------------------------- internals ----------------------------

function writeDisabled(
  projectId: string,
  projectRoot: string,
  rel: string,
  content: string,
  encoding: "base64" | undefined,
  errors: string[],
): void {
  try {
    const dst = disabledPath(projectId, rel);
    let src: string | null = null;
    try {
      src = resolveSafe(projectRoot, rel);
    } catch {
      // 路径不在白名单内（不应发生，server 渲染的路径应符合 safe-write 规则）。
      // 直接 fallback 到写入隔离区。
    }
    if (src && existsSync(src)) {
      moveFileBinarySafe(src, dst);
      // 按「能力最小完整单元」清理：文件移入隔离区后，vendor 目录可能只剩空壳
      // （如 skill 的 .cursor/skills/<name>/），向上 prune 掉空目录，避免残留在
      // 磁盘 / 本地镜像里造成「关了却还在」的错觉。与 orphan/removed 路径的
      // removeFileAndPruneEmptyDirs 行为对齐。
      pruneEmptyAncestors(projectRoot, dirname(src));
    } else {
      writeFileAtomic(dst, content, encoding);
    }
  } catch (err) {
    errors.push(`${rel} (隔离区): ${formatErr(err)}`);
  }
}

function extractDisabledPairs(lock: LockFile): Array<{ assetId: string; tool: TargetTool }> {
  const out: Array<{ assetId: string; tool: TargetTool }> = [];
  for (const [assetId, entry] of Object.entries(lock.assets)) {
    if (!entry.vendors) continue;
    for (const [tool, state] of Object.entries(entry.vendors) as [TargetTool, LockVendorState | undefined][]) {
      if (state && state.enabled === false) out.push({ assetId, tool });
    }
  }
  return out;
}

function buildV2Lock(req: WsReconcileRequest, filesWritten: string[], failedAggPaths: Set<string>): LockFile {
  const successSet = new Set(filesWritten);
  const assets: Record<string, LockAssetEntry> = {};

  const upsert = (a: ReconcileAsset, vendor: { tool: TargetTool; enabled: boolean; files: { path: string }[] }) => {
    const entry = (assets[a.assetId] ??= {
      version: a.version,
      files: [],
      name: a.name,
      type: a.type as AssetType,
      vendors: {},
    });
    const v: LockVendorState = (entry.vendors![vendor.tool] ??= { enabled: vendor.enabled, files: [] });
    v.enabled = vendor.enabled;
    for (const f of vendor.files) {
      // 仅记录"实际写成功"的路径；写失败的不进 lock，下次对账才能正确补救
      const path = f.path;
      // disabled vendor 的文件不在 filesWritten（它们去隔离区），仍要记录在 lock 中
      // 作为"本厂商管辖"的痕迹，让下次 reconcile 的 orphan 算法能感知。
      if (vendor.enabled && !successSet.has(path)) continue;
      if (!v.files.includes(path)) v.files.push(path);
      if (!entry.files.includes(path)) entry.files.push(path);
    }
  };

  for (const a of req.plan.enabled) for (const v of a.vendors) upsert(a, v);
  for (const a of req.plan.disabled) for (const v of a.vendors) upsert(a, v);

  const aggregates: Partial<Record<TargetTool, LockAggregateEntry[]>> = {};
  for (const agg of req.plan.aggregates) {
    // 解析失败的聚合不登记：磁盘文件未改，lock 若登记会导致 lock 与磁盘不一致。
    if (failedAggPaths.has(agg.path)) continue;
    // 仅登记仍有 enabled 贡献的聚合；entries 为空（全 disabled/removed）不登记——
    // 文件可能因 foreign 条目保留，但已非 Loom 拥有，scanner 不应标 managed。
    if (agg.contributingAssetIds.length === 0) continue;
    const list = (aggregates[agg.tool] ??= []);
    const entry: LockAggregateEntry = { file: agg.path, contributingAssetIds: agg.contributingAssetIds };
    // mcp 聚合：持久化 server key → assetId。wrapped 资产的内层 server key 可能
    // ≠ 资产名，scanner 据此把磁盘 server 正确归到受管资产（否则会误判为外部能力，
    // 能力视图出现「资产名」+「server key」两行）。agg.entries 仅含 enabled 资产。
    if (agg.type === "mcp") {
      const serverKeys: Record<string, string> = {};
      for (const e of agg.entries) {
        if (e.assetId && e.key) serverKeys[e.key] = e.assetId;
      }
      if (Object.keys(serverKeys).length > 0) entry.serverKeys = serverKeys;
    }
    list.push(entry);
  }

  return {
    subscriptions: req.subscriptions,
    version: new Date().toISOString(), // workspace 版本——v2 不再依赖此字段做决策，写时间戳便于排查
    assets,
    aggregates: Object.keys(aggregates).length > 0 ? aggregates : undefined,
    lockFormat: "3",
  };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function formatErr(err: unknown): string {
  if (err instanceof UnsafePathError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function absUnsafe(projectRoot: string, rel: string): string | null {
  try {
    return resolveSafe(projectRoot, rel);
  } catch {
    return null;
  }
}
