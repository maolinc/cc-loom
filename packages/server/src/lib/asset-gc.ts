/**
 * 单项能力（asset）「留存（retained）」生命周期 —— 引用计数 + GC + 安装账本对账。
 *
 * 模型（与能力集留存对称）：
 *   - asset 被「使用中」当且仅当：被任一能力集（在库或留存）通过 capability_set_assets
 *     引用，或被任一项目安装账本 project_installed_assets 引用。
 *   - 从库删除 asset 时：使用中 → 软删（deleted_at，从库隐藏但仍服务已安装项目）；
 *     未使用 → 直接硬删除。
 *   - 任何「失去引用」的路径（卸载/移除能力/drift、能力集删除或编辑移除该 asset）
 *     都应调用 maybeGcRetiredAsset：已软删且引用归零时硬删除。
 *
 * 安装账本是 asset 引用计数的权威来源之一：因为「添加能力」单独安装的 asset 只进
 * agent lock、不入 capability_set_assets，服务端只能靠 agent 推送的状态对账得知。
 *
 * 外键为 ON：硬删除一律「先子后父」（asset_files / capability_set_assets → assets）。
 */
import { db } from "../db/index.js";
import { removeSearchIndex } from "./search-indexer.js";
import { removeAiInfoIndex } from "./ai-info-indexer.js";

/**
 * asset 的引用计数，分两类来源（分开存、合并显示）：
 *  - capabilitySetRefs：被多少个能力集（在库或留存）组合引用（capability_set_assets）。
 *  - installRefs：被多少个项目通过本地控制台安装引用（project_installed_assets）。
 * total = 两者之和；> 0 即「使用中」。
 */
export interface AssetRefs {
  capabilitySetRefs: number;
  installRefs: number;
  total: number;
}

export function assetRefs(assetId: string): AssetRefs {
  const w = db.prepare(
    "SELECT COUNT(DISTINCT capability_set_id) AS c FROM capability_set_assets WHERE asset_id = ?",
  ).get(assetId) as { c: number };
  const i = db.prepare(
    "SELECT COUNT(DISTINCT project_id) AS c FROM project_installed_assets WHERE asset_id = ?",
  ).get(assetId) as { c: number };
  return { capabilitySetRefs: w.c, installRefs: i.c, total: w.c + i.c };
}

/** asset 是否仍被任一能力集或任一项目安装引用。 */
export function assetInUse(assetId: string): boolean {
  return assetRefs(assetId).total > 0;
}

/** 硬删除 asset 及其文件与关联（调用方需自行保证不再被引用）。 */
function hardDeleteAsset(assetId: string): void {
  // 派生搜索索引行（vec/fts）无外键级联，需手动清理；asset_embeddings 由 FK CASCADE 清。
  removeSearchIndex(assetId);
  // 能力信息生成队列行（asset_ai_info 有 FK CASCADE，软删时需手动清；硬删由 CASCADE 兜底）
  removeAiInfoIndex(assetId);
  db.prepare("DELETE FROM asset_files WHERE asset_id = ?").run(assetId);
  db.prepare("DELETE FROM capability_set_assets WHERE asset_id = ?").run(assetId); // 兜底清理悬挂关联
  db.prepare("DELETE FROM assets WHERE id = ?").run(assetId);
}

/**
 * 留存 GC：asset 已从库移除（deleted_at 已设）且无任何引用时硬删除。
 * 非软删 / 仍被引用 / 空值都跳过。
 */
export function maybeGcRetiredAsset(assetId: string | null | undefined): void {
  if (!assetId) return;
  const a = db.prepare("SELECT id, deleted_at FROM assets WHERE id = ?").get(assetId) as
    | { id: string; deleted_at: string | null }
    | undefined;
  if (!a || !a.deleted_at) return; // 未软删 = 仍在库中，不回收
  if (assetInUse(assetId)) return; // 仍被引用，保留
  hardDeleteAsset(assetId);
}

/** 删除 asset 的统一入口：使用中 → 软删留存；未使用 → 硬删。返回 'retained' | 'deleted'。 */
export function deleteOrRetainAsset(assetId: string): "retained" | "deleted" {
  // 软删/硬删均物理清理派生搜索索引（派生数据可重建；软删资产不应出现在搜索结果）
  removeSearchIndex(assetId);
  removeAiInfoIndex(assetId);
  if (assetInUse(assetId)) {
    const now = new Date().toISOString();
    db.prepare("UPDATE assets SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, assetId);
    return "retained";
  }
  hardDeleteAsset(assetId);
  return "deleted";
}

/**
 * 把某项目的安装账本对账成 agent 当前真实安装的 asset 集合（installedAssetIds）。
 * 在 ws gateway 收到 LocalProjectState 时调用（lock 全消失/legacy/drift → 传空集）。
 * 对账后，对「本次失去安装引用」的 asset 触发留存 GC。
 */
export function reconcileInstalledAssets(projectId: string, installedAssetIds: string[]): void {
  // 仅保留服务端确实存在的 asset，避免 legacy/未知 id 触发外键错误
  const known = new Set<string>();
  if (installedAssetIds.length > 0) {
    const ph = installedAssetIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id FROM assets WHERE id IN (${ph})`).all(...installedAssetIds) as { id: string }[];
    for (const r of rows) known.add(r.id);
  }

  const existing = db.prepare("SELECT asset_id FROM project_installed_assets WHERE project_id = ?")
    .all(projectId) as { asset_id: string }[];
  const oldSet = new Set(existing.map((r) => r.asset_id));

  const now = new Date().toISOString();
  const insert = db.prepare("INSERT OR IGNORE INTO project_installed_assets (project_id, asset_id, installed_at) VALUES (?, ?, ?)");
  for (const id of known) if (!oldSet.has(id)) insert.run(projectId, id, now);

  const del = db.prepare("DELETE FROM project_installed_assets WHERE project_id = ? AND asset_id = ?");
  const removed: string[] = [];
  for (const id of oldSet) {
    if (!known.has(id)) {
      del.run(projectId, id);
      removed.push(id);
    }
  }
  for (const id of removed) maybeGcRetiredAsset(id);
}
