/**
 * 工作空间「留存（retained）」生命周期 —— 引用计数 + GC。
 *
 * 模型（产品决策）：
 *   - 工作空间是「库定义」，可编辑、可从库移除。
 *   - 一条 `project_subscriptions` 显式订阅即一次「安装引用」（每项目可多个，ADR-0006）。
 *   - 从库删除工作空间时：若仍被活跃项目引用 → 软删（deleted_at），从库隐藏但
 *     仍服务已安装项目（即「留存」态）；无引用 → 直接硬删除。
 *   - 任何「失去引用」的路径（卸载订阅 / drift 自动清空 / 项目注销）都要调用
 *     `maybeGcRetiredWorkspace(旧 workspaceId)`：当其已软删且引用归零时硬删除。
 *
 * 内容共享、零拷贝：留存的就是原工作空间那一行与同一批 asset，不复制。
 * 硬删除只清 workspace 行与 workspace_assets 关联，不动 assets 库（asset 独立存在）。
 */
import { db } from "../db/index.js";
import { maybeGcRetiredAsset } from "./asset-gc.js";

/** 某工作空间当前的安装引用数（仅计活跃项目的显式订阅）。 */
export function workspaceRefCount(workspaceId: string): number {
  const r = db.prepare(
    `SELECT COUNT(*) AS c FROM project_subscriptions s
     JOIN projects p ON p.id = s.project_id
     WHERE s.workspace_id = ? AND p.status != 'unregistered'`,
  ).get(workspaceId) as { c: number };
  return r.c;
}

/**
 * 留存 GC：工作空间已从库移除（deleted_at 已设）且无活跃项目引用时硬删除。
 * 传入「失去引用」的旧 workspaceId；非软删 / 仍被引用 / 空值都直接跳过。
 */
export function maybeGcRetiredWorkspace(workspaceId: string | null | undefined): void {
  if (!workspaceId) return;
  const ws = db.prepare("SELECT id, deleted_at FROM workspaces WHERE id = ?").get(workspaceId) as
    | { id: string; deleted_at: string | null }
    | undefined;
  if (!ws || !ws.deleted_at) return; // 未软删 = 仍在库中，不回收
  if (workspaceRefCount(workspaceId) > 0) return; // 仍被引用，保留
  // 收集其组合的 asset，硬删后逐个尝试 asset 级 GC（它们刚失去这条工作空间引用）。
  const assetIds = (db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?")
    .all(workspaceId) as { asset_id: string }[]).map((r) => r.asset_id);
  db.prepare("DELETE FROM workspace_assets WHERE workspace_id = ?").run(workspaceId);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
  for (const id of assetIds) maybeGcRetiredAsset(id);
}
