/**
 * `~/.loom/locks/<project-id>.json` —— 项目当前安装的 CapabilitySet 锁。
 *
 * 字段直接复用 `LockFile`（@maolinc/cc-loom-shared）。两种历史形态：
 *
 * - **legacy**：assets = { __plan__: { version, files } }，无 vendors/aggregates。
 *   capabilities 流程不可用；UI 据此提示用户「重新安装」。
 * - **per-asset**：assets = { <assetId>: { name, type, vendors{...}, files } }，
 *   配合 `aggregates` 记录 mcp.json / hooks.json 的归属。
 *
 * 写入永远使用 per-asset；读取兼容两种。`isLegacyLock` 暴露给上层做判定。
 */
import type {
  AssetType,
  CapabilitySetSubscription,
  LockAssetEntry,
  LockFile,
  LockVendorState,
  ManifestAssetEntry,
  SyncPolicy,
  TargetTool,
} from "@maolinc/cc-loom-shared";
import { lockFile, ensureLoomDirs } from "./paths.js";
import { readJson, writeJsonAtomic, removeIfExists } from "./atomic.js";

export const LOCK_PLAN_KEY = "__plan__";

type PersistedSubscription = Omit<CapabilitySetSubscription, "capabilitySetId"> & {
  capabilitySetId?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
};

type PersistedLock = Omit<Partial<LockFile>, "subscriptions"> & Pick<LockFile, "assets" | "version"> & {
  capabilitySetId?: string | null;
  workspaceId?: string | null;
  policy?: SyncPolicy;
  subscriptions?: PersistedSubscription[];
};

export function readLock(projectId: string): LockFile | null {
  const raw = readJson<PersistedLock>(lockFile(projectId));
  if (!raw) return null;

  // Capability Set rename migration. Old lock keys are accepted only here;
  // every subsequent reconcile writes the canonical capabilitySet* shape.
  const legacyCapabilitySetId = raw.capabilitySetId ?? raw.workspaceId ?? null;
  if (Array.isArray(raw.subscriptions)) {
    raw.subscriptions = raw.subscriptions.map((subscription) => {
      const { workspaceId, workspaceName, ...canonical } = subscription;
      return {
        ...canonical,
        capabilitySetId: subscription.capabilitySetId ?? workspaceId ?? null,
        capabilitySetName: subscription.capabilitySetName ?? workspaceName ?? null,
      };
    });
  } else {
    raw.subscriptions = legacyCapabilitySetId
      ? [{
          capabilitySetId: legacyCapabilitySetId,
          capabilitySetName: null,
          syncPolicy: raw.policy === "locked" ? "locked" : "auto",
          targetTools: null,
          installedAt: "",
        }]
      : [];
  }
  delete raw.capabilitySetId;
  delete raw.workspaceId;
  delete raw.policy;
  return raw as LockFile;
}

export function writeLock(projectId: string, lock: LockFile): void {
  ensureLoomDirs();
  writeJsonAtomic(lockFile(projectId), lock);
}

export function removeLock(projectId: string): void {
  removeIfExists(lockFile(projectId));
}

/** 取 lock 当前记录的所有文件路径（去重，含 aggregates）。 */
export function lockedFiles(lock: LockFile | null): string[] {
  if (!lock) return [];
  const set = new Set<string>();
  for (const entry of Object.values(lock.assets)) {
    for (const f of entry.files) set.add(f);
  }
  if (lock.aggregates) {
    for (const list of Object.values(lock.aggregates)) {
      for (const agg of list ?? []) set.add(agg.file);
    }
  }
  return [...set];
}

/**
 * legacy lock 判定：
 *   - 仅含 LOCK_PLAN_KEY 一个 asset entry；
 *   - 且该 entry 没有 vendors 字段。
 *
 * capabilities 流程拒绝在 legacy lock 上做 toggle/add/remove，UI 也据此 disable
 * 操作并提示用户重新安装。
 */
export function isLegacyLock(lock: LockFile | null): boolean {
  if (!lock) return false;
  const keys = Object.keys(lock.assets);
  if (keys.length === 1 && keys[0] === LOCK_PLAN_KEY) {
    const entry = lock.assets[LOCK_PLAN_KEY];
    if (!entry?.vendors) return true;
  }
  return false;
}

/** 取某 asset 的 vendor 状态；不存在返回 undefined。 */
export function getLockVendor(
  lock: LockFile | null,
  assetId: string,
  tool: TargetTool,
): LockVendorState | undefined {
  return lock?.assets?.[assetId]?.vendors?.[tool];
}

/** 列出当前 enabled=true 的 (assetId, tool) 对。 */
export function listEnabledByTool(lock: LockFile | null, tool: TargetTool): string[] {
  if (!lock) return [];
  const out: string[] = [];
  for (const [id, entry] of Object.entries(lock.assets)) {
    const v = entry.vendors?.[tool];
    if (v?.enabled) out.push(id);
  }
  return out;
}

/** 列出某厂商上指定类型的 enabled assets，常用于 mcp/hook aggregate 重算。 */
export function listEnabledByToolAndType(
  lock: LockFile | null,
  tool: TargetTool,
  type: AssetType,
): { assetId: string; entry: LockAssetEntry }[] {
  if (!lock) return [];
  const out: { assetId: string; entry: LockAssetEntry }[] = [];
  for (const [id, entry] of Object.entries(lock.assets)) {
    if (entry.type !== type) continue;
    const v = entry.vendors?.[tool];
    if (v?.enabled) out.push({ assetId: id, entry });
  }
  return out;
}

/**
 * upsert 单 asset entry。`files` 字段统一从 vendors 扁平化得出，调用方不必维护。
 * 如果 entry.vendors 为空（无 tool），整个 entry 被删除（视为 asset 不再被任何 tool 持有）。
 */
export function upsertLockAsset(
  lock: LockFile,
  assetId: string,
  patch: Partial<LockAssetEntry> & { vendors?: Partial<Record<TargetTool, LockVendorState>> },
): void {
  const prev = lock.assets[assetId] ?? { version: "1", files: [] };
  const merged: LockAssetEntry = { ...prev, ...patch };
  // 合并 vendors 时按 tool 维度逐个 patch，传入的 vendors 是「目标完整状态」（不做深 merge）
  if (patch.vendors !== undefined) {
    merged.vendors = { ...prev.vendors, ...patch.vendors };
  }
  // 清理空 vendor 槽
  if (merged.vendors) {
    for (const [tool, state] of Object.entries(merged.vendors)) {
      if (!state) delete (merged.vendors as Record<string, unknown>)[tool];
    }
    if (Object.keys(merged.vendors).length === 0) {
      delete merged.vendors;
    }
  }
  // files 由 vendors 自动展平 + 保留聚合外文件能力（capabilities 流程不会有，留给 legacy）
  if (merged.vendors) {
    const files = new Set<string>();
    for (const v of Object.values(merged.vendors)) {
      for (const f of v?.files ?? []) files.add(f);
    }
    merged.files = [...files];
  }
  // 全空则删除整个 entry
  if (!merged.vendors && (!merged.files || merged.files.length === 0)) {
    delete lock.assets[assetId];
    return;
  }
  lock.assets[assetId] = merged;
}

/** 删除单 asset entry（capabilities remove 路径用；不动 aggregates，由调用方协调）。 */
export function removeLockAsset(lock: LockFile, assetId: string): void {
  delete lock.assets[assetId];
}

/** 写入或清理某 tool 的某聚合文件登记。`contributingAssetIds` 为空时该登记被删除。 */
export function setLockAggregate(
  lock: LockFile,
  tool: TargetTool,
  file: string,
  contributingAssetIds: string[],
): void {
  if (!lock.aggregates) lock.aggregates = {};
  const list = lock.aggregates[tool] ?? [];
  const idx = list.findIndex((a) => a.file === file);
  if (contributingAssetIds.length === 0) {
    if (idx >= 0) list.splice(idx, 1);
  } else if (idx >= 0) {
    list[idx] = { file, contributingAssetIds };
  } else {
    list.push({ file, contributingAssetIds });
  }
  if (list.length === 0) {
    delete lock.aggregates[tool];
  } else {
    lock.aggregates[tool] = list;
  }
  if (Object.keys(lock.aggregates).length === 0) {
    delete lock.aggregates;
  }
}

/** 把 ManifestAssetEntry 投影成 LockAssetEntry 的元数据部分（不含 vendors / files）。 */
export function metaFromManifestAsset(asset: ManifestAssetEntry): Pick<LockAssetEntry, "name" | "type" | "version"> {
  return { name: asset.name, type: asset.type, version: asset.version };
}
