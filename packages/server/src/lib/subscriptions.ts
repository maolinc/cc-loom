/**
 * 能力集订阅（ADR-0006）的服务端数据访问助手。
 *
 * - `project_subscriptions.capability_set_id = ''` 为隐式订阅哨兵（SQLite PK 中 NULL 不判重），
 *   对应 shared `CapabilitySetSubscription.capabilitySetId = null`。
 * - 所有读写订阅表的入口收口在本模块，路由 / reconcile / auto-sync 不裸写 SQL 字面量。
 */
import type { SyncPolicy, TargetTool, CapabilitySetSubscription } from "@maolinc/cc-loom-shared";
import { TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import { db } from "../db/index.js";

/** 隐式订阅（「单独添加的能力」组）的 DB 哨兵值。 */
export const IMPLICIT_CAPABILITY_SET_ID = "";

export interface SubscriptionRow {
  project_id: string;
  capability_set_id: string;
  sync_policy: string;
  target_tools: string | null;
  installed_at: string;
}

export function loadSubscriptionRows(projectId: string): SubscriptionRow[] {
  return db
    .prepare("SELECT * FROM project_subscriptions WHERE project_id = ? ORDER BY installed_at ASC")
    .all(projectId) as SubscriptionRow[];
}

/** 确保隐式订阅行存在（注册项目 / 添加单能力 / 安装能力集前调用）。 */
export function ensureImplicitSubscription(projectId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO project_subscriptions (project_id, capability_set_id, sync_policy, target_tools, installed_at) VALUES (?, '', 'auto', NULL, ?)",
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

/** 订阅行 → wire/lock 形态。显式订阅的名称和 retained 由调用方富化。 */
export function rowToSubscription(
  row: SubscriptionRow,
  extra?: { capabilitySetName?: string | null; retained?: boolean },
): CapabilitySetSubscription {
  const implicit = row.capability_set_id === IMPLICIT_CAPABILITY_SET_ID;
  return {
    capabilitySetId: implicit ? null : row.capability_set_id,
    capabilitySetName: implicit ? null : (extra?.capabilitySetName ?? null),
    syncPolicy: (row.sync_policy === "locked" ? "locked" : "auto") as SyncPolicy,
    targetTools: row.target_tools ? (JSON.parse(row.target_tools) as TargetTool[]) : null,
    installedAt: row.installed_at,
    ...(extra?.retained ? { retained: true } : {}),
  };
}

/** 订阅排除集（撞车裁决「跳过」）：返回 Set<assetId>。 */
export function loadExcludes(projectId: string, capabilitySetId: string): Set<string> {
  const rows = db
    .prepare("SELECT asset_id FROM project_subscription_excludes WHERE project_id = ? AND capability_set_id = ?")
    .all(projectId, capabilitySetId) as { asset_id: string }[];
  return new Set(rows.map((r) => r.asset_id));
}

/**
 * 项目的订阅列表（API 响应形态，含能力集名称 / retained 富化）。
 * 含隐式订阅行（capabilitySetId=null）；UI 决定是否渲染「单独添加的能力」组。
 */
export function listProjectSubscriptions(projectId: string): CapabilitySetSubscription[] {
  const rows = db.prepare(`
    SELECT s.*, w.name AS capability_set_name, w.deleted_at AS capability_set_deleted_at
    FROM project_subscriptions s
    LEFT JOIN capability_sets w ON w.id = s.capability_set_id
    WHERE s.project_id = ?
    ORDER BY s.installed_at ASC
  `).all(projectId) as (SubscriptionRow & { capability_set_name: string | null; capability_set_deleted_at: string | null })[];
  return rows.map((r) =>
    rowToSubscription(r, {
      capabilitySetName: r.capability_set_name,
      retained: !!r.capability_set_deleted_at,
    }),
  );
}

/** 批量版：一次查多个项目的订阅（项目列表接口防 N+1）。 */
export function listSubscriptionsByProjects(projectIds: string[]): Map<string, CapabilitySetSubscription[]> {
  const out = new Map<string, CapabilitySetSubscription[]>();
  if (projectIds.length === 0) return out;
  const rows = db.prepare(`
    SELECT s.*, w.name AS capability_set_name, w.deleted_at AS capability_set_deleted_at
    FROM project_subscriptions s
    LEFT JOIN capability_sets w ON w.id = s.capability_set_id
    WHERE s.project_id IN (${projectIds.map(() => "?").join(",")})
    ORDER BY s.installed_at ASC
  `).all(...projectIds) as (SubscriptionRow & { capability_set_name: string | null; capability_set_deleted_at: string | null })[];
  for (const r of rows) {
    const arr = out.get(r.project_id) ?? [];
    arr.push(rowToSubscription(r, {
      capabilitySetName: r.capability_set_name,
      retained: !!r.capability_set_deleted_at,
    }));
    out.set(r.project_id, arr);
  }
  return out;
}
