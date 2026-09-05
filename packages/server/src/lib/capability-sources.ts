/**
 * 本地控制台能力的「来源订阅」标注（ADR-0006）。
 *
 * 为 state.capabilities 的每个受管能力补 `sources`：该能力被项目的哪些订阅引用
 * （显式订阅 → { workspaceId, name }；隐式订阅/单独添加 → { workspaceId: null }）。
 * 共享能力（多个来源）在 UI 上显示多个徽标，toggle/remove 时给「同时被空间 X 引用」
 * 轻提示。外部能力（external:*）无来源，不标注。
 * 在 GET /state 与 POST /scan 返回前调用（原地填充，幂等）。
 */
import type { LocalProjectState } from "@maolinc/cc-loom-shared";
import { db } from "../db/index.js";

export function enrichCapabilitySources(state: LocalProjectState): void {
  const caps = state.capabilities;
  if (!caps || caps.length === 0) return;

  // 项目的显式订阅（含留存）→ 工作空间名
  const subs = db.prepare(`
    SELECT s.workspace_id AS ws, w.name AS name
    FROM project_subscriptions s
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.project_id = ? AND s.workspace_id != ''
  `).all(state.projectId) as { ws: string; name: string }[];
  const hasCapabilities = !!db.prepare(
    "SELECT 1 FROM project_capabilities WHERE project_id = ? LIMIT 1",
  ).get(state.projectId);
  if (subs.length === 0 && !hasCapabilities) return;

  const wsName = new Map(subs.map((s) => [s.ws, s.name]));
  const memberStmt = db.prepare(
    "SELECT 1 FROM workspace_assets WHERE workspace_id = ? AND asset_id = ?",
  );
  const capStmt = db.prepare(
    "SELECT 1 FROM project_capabilities WHERE project_id = ? AND asset_id = ?",
  );

  for (const cap of caps) {
    const assetIds = new Set<string>();
    if (!cap.assetId.startsWith("external:")) assetIds.add(cap.assetId);
    for (const v of Object.values(cap.vendors)) {
      if (v?.assetId && !v.assetId.startsWith("external:")) assetIds.add(v.assetId);
    }
    if (assetIds.size === 0) continue;

    const sources: { workspaceId: string | null; name: string }[] = [];
    for (const [ws, name] of wsName) {
      for (const id of assetIds) {
        if (memberStmt.get(ws, id)) {
          sources.push({ workspaceId: ws, name });
          break;
        }
      }
    }
    for (const id of assetIds) {
      if (capStmt.get(state.projectId, id)) {
        sources.push({ workspaceId: null, name: "单独添加" });
        break;
      }
    }
    if (sources.length > 0) cap.sources = sources;
  }
}
