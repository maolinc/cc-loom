/**
 * 空间订阅（ADR-0006）的服务端数据访问助手。
 *
 * - `project_subscriptions.workspace_id = ''` 为隐式订阅哨兵（SQLite PK 中 NULL 不判重），
 *   对应 shared `WorkspaceSubscription.workspaceId = null`。
 * - 所有读写订阅表的入口收口在本模块，路由 / reconcile / auto-sync 不裸写 SQL 字面量。
 */
import type { SyncPolicy, TargetTool, WorkspaceSubscription } from "@maolinc/cc-loom-shared";
import { TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import { db } from "../db/index.js";

/** 隐式订阅（「单独添加的能力」组）的 DB 哨兵值。 */
export const IMPLICIT_WORKSPACE_ID = "";

export interface SubscriptionRow {
  project_id: string;
  workspace_id: string;
  sync_policy: string;
  target_tools: string | null;
  installed_at: string;
}

export function loadSubscriptionRows(projectId: string): SubscriptionRow[] {
  return db
    .prepare("SELECT * FROM project_subscriptions WHERE project_id = ? ORDER BY installed_at ASC")
    .all(projectId) as SubscriptionRow[];
}

/** 确保隐式订阅行存在（注册项目 / 添加单能力 / 安装空间前调用）。 */
export function ensureImplicitSubscription(projectId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO project_subscriptions (project_id, workspace_id, sync_policy, target_tools, installed_at) VALUES (?, '', 'auto', NULL, ?)",
  ).run(projectId, new Date().toISOString());
}

/** 项目「有效工具集合」：default → detected → 全量（隐式订阅跟随此集合）。 */
export function projectEffectiveTools(p: { default_targets: string; detected_targets: string }): TargetTool[] {
  const def = JSON.parse(p.default_targets || "[]") as TargetTool[];
  if (def.length > 0) return def;
  const det = JSON.parse(p.detected_targets || "[]") as TargetTool[];
  if (det.length > 0) return det;
  return [...TARGET_TOOLS];
}

/** 订阅行 → wire/lock 形态。显式订阅的 wsName/retained 由调用方富化。 */
export function rowToSubscription(
  row: SubscriptionRow,
  extra?: { workspaceName?: string | null; retained?: boolean },
): WorkspaceSubscription {
  const implicit = row.workspace_id === IMPLICIT_WORKSPACE_ID;
  return {
    workspaceId: implicit ? null : row.workspace_id,
    workspaceName: implicit ? null : (extra?.workspaceName ?? null),
    syncPolicy: (row.sync_policy === "locked" ? "locked" : "auto") as SyncPolicy,
    targetTools: row.target_tools ? (JSON.parse(row.target_tools) as TargetTool[]) : null,
    installedAt: row.installed_at,
    ...(extra?.retained ? { retained: true } : {}),
  };
}

/** 订阅排除集（撞车裁决「跳过」）：返回 Set<assetId>。 */
export function loadExcludes(projectId: string, workspaceId: string): Set<string> {
  const rows = db
    .prepare("SELECT asset_id FROM project_subscription_excludes WHERE project_id = ? AND workspace_id = ?")
    .all(projectId, workspaceId) as { asset_id: string }[];
  return new Set(rows.map((r) => r.asset_id));
}

/**
 * 项目的订阅列表（API 响应形态，含工作空间名称 / retained 富化）。
 * 含隐式订阅行（workspaceId=null）；UI 决定是否渲染「单独添加的能力」组。
 */
export function listProjectSubscriptions(projectId: string): WorkspaceSubscription[] {
  const rows = db.prepare(`
    SELECT s.*, w.name AS ws_name, w.deleted_at AS ws_deleted_at
    FROM project_subscriptions s
    LEFT JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.project_id = ?
    ORDER BY s.installed_at ASC
  `).all(projectId) as (SubscriptionRow & { ws_name: string | null; ws_deleted_at: string | null })[];
  return rows.map((r) =>
    rowToSubscription(r, {
      workspaceName: r.ws_name,
      retained: !!r.ws_deleted_at,
    }),
  );
}

/** 批量版：一次查多个项目的订阅（项目列表接口防 N+1）。 */
export function listSubscriptionsByProjects(projectIds: string[]): Map<string, WorkspaceSubscription[]> {
  const out = new Map<string, WorkspaceSubscription[]>();
  if (projectIds.length === 0) return out;
  const rows = db.prepare(`
    SELECT s.*, w.name AS ws_name, w.deleted_at AS ws_deleted_at
    FROM project_subscriptions s
    LEFT JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.project_id IN (${projectIds.map(() => "?").join(",")})
    ORDER BY s.installed_at ASC
  `).all(...projectIds) as (SubscriptionRow & { ws_name: string | null; ws_deleted_at: string | null })[];
  for (const r of rows) {
    const arr = out.get(r.project_id) ?? [];
    arr.push(rowToSubscription(r, { workspaceName: r.ws_name, retained: !!r.ws_deleted_at }));
    out.set(r.project_id, arr);
  }
  return out;
}
