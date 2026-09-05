/**
 * 项目删除（purge）服务端清理逻辑。
 *
 * 两条删除路径共用：
 *  - DELETE /api/projects/:id（CLI `loom unregister`）：CLI 本机直接清 `~/.loom`，
 *    服务端硬删项目行 + 关联表；在线 agent 时 best-effort 下发 project:purge RPC
 *    让 daemon 立即停 watcher（释放项目目录监听句柄），否则要等 30s reconcile。
 *  - POST /api/projects/:id/purge（Web 控制台）：在线时 RPC 让 agent 清本地后硬删；
 *    离线时软删，待 agent 重连由 compensateDeviceOnConnect 补发 RPC 后硬删。
 *
 * 关联表（project_capabilities / project_disabled_assets / project_installed_assets）
 * 对 projects(id) 无 CASCADE，必须在删 projects 行之前清掉。adopt 产物（adopted=1）
 * 仅本项目引用时连带 asset_files（CASCADE）硬删，避免遗留孤立私有 asset。
 */
import { db } from "../db/index.js";
import { maybeGcRetiredWorkspace } from "./workspace-gc.js";

/**
 * 清理项目在服务端 DB 的关联行 + 仅本项目引用的 adopt 产物。
 * 不删 projects 行本身——由调用方决定硬删还是软删。
 */
export function purgeProjectDbRows(projectId: string): void {
  const adoptedAssets = db.prepare(`
    SELECT a.id AS id FROM assets a
    JOIN project_capabilities pc ON pc.asset_id = a.id
    WHERE pc.project_id = ? AND a.adopted = 1
  `).all(projectId) as { id: string }[];

  db.transaction(() => {
    db.prepare("DELETE FROM project_capabilities WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_disabled_assets WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_installed_assets WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_subscriptions WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM project_subscription_excludes WHERE project_id = ?").run(projectId);
    for (const a of adoptedAssets) {
      const stillReferenced = !!db
        .prepare("SELECT 1 FROM workspace_assets WHERE asset_id = ?")
        .get(a.id)
        || !!db
          .prepare("SELECT 1 FROM project_installed_assets WHERE asset_id = ?")
          .get(a.id);
      if (!stillReferenced) {
        db.prepare("DELETE FROM assets WHERE id = ?").run(a.id);
      }
    }
  })();
}

/**
 * 硬删项目行：先清关联表（purgeProjectDbRows），再 DELETE projects 行 + GC 留存空间。
 * 返回是否确实删了一行（项目不存在时返回 false，调用方可据此判断）。
 */
export function hardDeleteProject(projectId: string): boolean {
  const row = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as
    | { id: string }
    | undefined;
  if (!row) return false;
  const subscribed = db.prepare(
    "SELECT workspace_id FROM project_subscriptions WHERE project_id = ? AND workspace_id != ''",
  ).all(projectId) as { workspace_id: string }[];
  purgeProjectDbRows(projectId);
  db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  for (const s of subscribed) maybeGcRetiredWorkspace(s.workspace_id);
  return true;
}
