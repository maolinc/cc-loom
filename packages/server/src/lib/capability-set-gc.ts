/**
 * 能力集「留存（retained）」生命周期 —— 引用计数 + GC。
 *
 * 模型（产品决策）：
 *   - 能力集是「库定义」，可编辑、可从库移除。
 *   - 一条 `project_subscriptions` 显式订阅即一次「安装引用」（每项目可多个，ADR-0006）。
 *   - 从库删除能力集时：若仍被活跃项目引用 → 软删（deleted_at），从库隐藏但
 *     仍服务已安装项目（即「留存」态）；无引用 → 直接硬删除。
 *   - 任何「失去引用」的路径（卸载订阅 / drift 自动清空 / 项目注销）都要调用
 *     `maybeGcRetiredCapabilitySet(旧 capabilitySetId)`：当其已软删且引用归零时硬删除。
 *
 * 内容共享、零拷贝：留存的就是原能力集那一行与同一批 asset，不复制。
 * 硬删除只清 capabilitySet 行与 capability_set_assets 关联，不动 assets 库（asset 独立存在）。
 */
import { db } from "../db/index.js";
import { maybeGcRetiredAsset } from "./asset-gc.js";

/** 某能力集当前的安装引用数（仅计活跃项目的显式订阅）。 */
export function capabilitySetRefCount(capabilitySetId: string): number {
  const r = db.prepare(
    `SELECT COUNT(*) AS c FROM project_subscriptions s
     JOIN projects p ON p.id = s.project_id
     WHERE s.capability_set_id = ? AND p.status != 'unregistered'`,
  ).get(capabilitySetId) as { c: number };
  return r.c;
}

/**
 * 留存 GC：能力集已从库移除（deleted_at 已设）且无活跃项目引用时硬删除。
 * 传入「失去引用」的旧 capabilitySetId；非软删 / 仍被引用 / 空值都直接跳过。
 */
export function maybeGcRetiredCapabilitySet(capabilitySetId: string | null | undefined): void {
  if (!capabilitySetId) return;
  const capabilitySet = db.prepare("SELECT id, deleted_at FROM capability_sets WHERE id = ?").get(capabilitySetId) as
    | { id: string; deleted_at: string | null }
    | undefined;
  if (!capabilitySet || !capabilitySet.deleted_at) return; // 未软删 = 仍在库中，不回收
  if (capabilitySetRefCount(capabilitySetId) > 0) return; // 仍被引用，保留
  // 收集其组合的 asset，硬删后逐个尝试 asset 级 GC（它们刚失去这条能力集引用）。
  const assetIds = (db.prepare("SELECT asset_id FROM capability_set_assets WHERE capability_set_id = ?")
    .all(capabilitySetId) as { asset_id: string }[]).map((r) => r.asset_id);
  db.prepare("DELETE FROM capability_set_assets WHERE capability_set_id = ?").run(capabilitySetId);
  db.prepare("DELETE FROM capability_sets WHERE id = ?").run(capabilitySetId);
  for (const id of assetIds) maybeGcRetiredAsset(id);
}
