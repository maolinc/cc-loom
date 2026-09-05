/**
 * 凭据使用记录的 reconcile-end 钩子（ADR-0003 决策 8）。
 *
 * 每次 reconcile 成功后由 outbox-worker 调用。语义：
 *  - 对本项目当前安装的 asset（以 project_installed_assets 账本为准），按其 asset_auth_bindings
 *    里的 path 绑定 insert-or-ignore（INSERT OR IGNORE，超集，保证轮换不漏项目）。
 *  - 删除本项目下「已不再安装的 asset」的使用行（移除时清理，避免长期积累孤儿）。
 *
 * 仅记录 path 绑定的使用；env 绑定的使用由 credential_distributions axis=env 体现（设备维度）。
 *
 * 设计：单钩子点，覆盖能力集级安装/卸载 + 能力级 enable/disable 两个流程（都收敛到 reconcile）。
 * 偏差窗口 = 「权威变更 → 下次 reconcile」，与磁盘 .mcp.json 陈旧窗口重合。
 */
import { db } from "../db/index.js";
import { generateId } from "./crypto.js";

/**
 * 刷新一个项目的凭据使用记录。reconcile 成功后调用。
 * 账本以 project_installed_assets 为准（reconcile 成功时刚被重写）。
 */
export function refreshCredentialUsages(projectId: string): void {
  const project = db.prepare("SELECT user_id FROM projects WHERE id = ?").get(projectId) as
    | { user_id: string }
    | undefined;
  if (!project) return;
  const userId = project.user_id;
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    // 1. 本项目当前安装的 asset × 其 path 绑定 → insert-or-ignore（超集）
    const rows = db.prepare(`
      SELECT pia.asset_id AS asset_id, b.credential_name AS credential_name, b.path AS path
        FROM project_installed_assets pia
        JOIN asset_auth_bindings b ON b.asset_id = pia.asset_id
       WHERE pia.project_id = ? AND b.kind = 'path' AND b.path IS NOT NULL
    `).all(projectId) as { asset_id: string; credential_name: string; path: string }[];

    const ins = db.prepare(
      `INSERT OR IGNORE INTO credential_usages (id, user_id, credential_name, project_id, asset_id, path, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(generateId(), userId, r.credential_name, projectId, r.asset_id, r.path, now);
    }

    // 2. 删除本项目下「已不再安装的 asset」的使用行（移除时清理）
    db.prepare(`
      DELETE FROM credential_usages
       WHERE project_id = ?
         AND asset_id NOT IN (SELECT asset_id FROM project_installed_assets WHERE project_id = ?)
    `).run(projectId, projectId);
  });
  tx();
}
