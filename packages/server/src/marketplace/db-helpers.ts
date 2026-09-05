import { db } from "../db/index.js";
import type { AssetType, MarketplaceSource, MarketplaceSyncLog } from "@maolinc/cc-loom-shared";

function rowToSource(row: any): MarketplaceSource {
  let assetTypesFilter: AssetType[] | null = null;
  if (typeof row.asset_types_filter === "string" && row.asset_types_filter) {
    try {
      const parsed = JSON.parse(row.asset_types_filter);
      if (Array.isArray(parsed)) assetTypesFilter = parsed as AssetType[];
    } catch { /* malformed JSON → treat as all */ }
  }
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parent_id,
    repoUrl: row.repo_url,
    displayName: row.display_name,
    description: row.description,
    addedBy: row.added_by,
    originAuthor: row.origin_author,
    ref: row.ref,
    enabled: row.enabled === 1,
    syncIntervalMinutes: row.sync_interval_minutes,
    lastSyncStatus: row.last_sync_status,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    lastCommitSha: row.last_commit_sha,
    localPath: row.local_path,
    assetTypesFilter,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const sourceQueries = {
  findById(id: string): MarketplaceSource | null {
    const row = db.prepare("SELECT * FROM marketplace_sources WHERE id = ?").get(id) as any;
    return row ? rowToSource(row) : null;
  },
  findByUrl(repoUrl: string): MarketplaceSource | null {
    const row = db.prepare("SELECT * FROM marketplace_sources WHERE repo_url = ?").get(repoUrl) as any;
    return row ? rowToSource(row) : null;
  },
  list(): MarketplaceSource[] {
    const rows = db.prepare("SELECT * FROM marketplace_sources ORDER BY created_at ASC").all() as any[];
    return rows.map(rowToSource);
  },
  listEnabled(): MarketplaceSource[] {
    const rows = db.prepare("SELECT * FROM marketplace_sources WHERE enabled = 1 ORDER BY created_at ASC").all() as any[];
    return rows.map(rowToSource);
  },
  insert(s: Omit<MarketplaceSource, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string }): void {
    db.prepare(`
      INSERT INTO marketplace_sources (
        id, kind, parent_id, repo_url, display_name, description, added_by, origin_author,
        ref, enabled, sync_interval_minutes, last_sync_status, last_sync_at, last_error,
        last_commit_sha, local_path, asset_types_filter, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      s.id, s.kind, s.parentId, s.repoUrl, s.displayName, s.description, s.addedBy, s.originAuthor,
      s.ref, s.enabled ? 1 : 0, s.syncIntervalMinutes, s.lastSyncStatus, s.lastSyncAt, s.lastError,
      s.lastCommitSha, s.localPath, s.assetTypesFilter == null ? null : JSON.stringify(s.assetTypesFilter),
      s.createdAt, s.updatedAt,
    );
  },
  setSyncStatus(id: string, status: "running" | "success" | "failed", error: string | null, lastCommitSha: string | null): void {
    db.prepare(`
      UPDATE marketplace_sources
      SET last_sync_status = ?, last_error = ?, last_commit_sha = COALESCE(?, last_commit_sha), last_sync_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, error, lastCommitSha, new Date().toISOString(), new Date().toISOString(), id);
  },
  upgradeKind(id: string, newKind: string, parentId: string): void {
    db.prepare(`UPDATE marketplace_sources SET kind = ?, parent_id = ?, updated_at = ? WHERE id = ?`).run(
      newKind, parentId, new Date().toISOString(), id,
    );
  },
  setEnabled(id: string, enabled: boolean): void {
    db.prepare(`UPDATE marketplace_sources SET enabled = ?, updated_at = ? WHERE id = ?`).run(
      enabled ? 1 : 0, new Date().toISOString(), id,
    );
  },
  delete(id: string): void {
    // assets.source_id has ON DELETE CASCADE, so deleting the source cascades
    // to its assets. But several tables reference assets(id) WITHOUT cascade:
    //   - workspace_assets.asset_id        (asset may be pinned to a non-source workspace)
    //   - project_installed_assets.asset_id
    //   - project_disabled_assets.asset_id
    // Likewise workspace_assets.workspace_id has no cascade, and the source's
    // own workspaces get cascade-deleted. Clean up every referencing row first,
    // then let CASCADE handle assets / workspaces / sync_logs / child sources.
    // Wrap in a transaction so we don't leave half-deleted state.
    const txn = db.transaction((sourceId: string) => {
      db.prepare(`
        DELETE FROM project_disabled_assets
        WHERE asset_id IN (SELECT id FROM assets WHERE source_id = ?)
      `).run(sourceId);
      db.prepare(`
        DELETE FROM project_installed_assets
        WHERE asset_id IN (SELECT id FROM assets WHERE source_id = ?)
      `).run(sourceId);
      // workspace_assets rows holding a source asset (incl. ones pinned to
      // non-source workspaces) — must go before assets are cascade-deleted.
      db.prepare(`
        DELETE FROM workspace_assets
        WHERE asset_id IN (SELECT id FROM assets WHERE source_id = ?)
      `).run(sourceId);
      // workspace_assets rows inside the source's own workspaces (assets that
      // were pinned into a source workspace but don't belong to the source) —
      // must go before those workspaces are cascade-deleted.
      db.prepare(`
        DELETE FROM workspace_assets
        WHERE workspace_id IN (SELECT id FROM workspaces WHERE source_id = ?)
      `).run(sourceId);
      db.prepare("DELETE FROM marketplace_sources WHERE id = ?").run(sourceId);
    });
    txn(id);
  },
  detachAssets(id: string, replacementAuthor: string): void {
    db.prepare(`UPDATE assets SET source_id = NULL, source_path = NULL, source_origin_author = NULL, author = ?, updated_at = ? WHERE source_id = ?`).run(
      replacementAuthor, new Date().toISOString(), id,
    );
    db.prepare(`UPDATE workspaces SET source_id = NULL, source_plugin = NULL, updated_at = ? WHERE source_id = ?`).run(
      new Date().toISOString(), id,
    );
  },
  countAssets(id: string): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM assets WHERE source_id = ? AND deleted_at IS NULL").get(id) as any).c;
  },
  countWorkspaces(id: string): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM workspaces WHERE source_id = ?").get(id) as any).c;
  },
};

export const logQueries = {
  insert(log: MarketplaceSyncLog): void {
    db.prepare(`
      INSERT INTO marketplace_sync_logs (id, source_id, trigger, status, added, updated, removed, duration_ms, error, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(log.id, log.sourceId, log.trigger, log.status, log.added, log.updated, log.removed, log.durationMs, log.error, log.startedAt);
  },
  recent(sourceId: string, limit = 50): MarketplaceSyncLog[] {
    const rows = db.prepare("SELECT * FROM marketplace_sync_logs WHERE source_id = ? ORDER BY started_at DESC LIMIT ?").all(sourceId, limit) as any[];
    return rows.map((r) => ({
      id: r.id, sourceId: r.source_id, trigger: r.trigger, status: r.status,
      added: r.added, updated: r.updated, removed: r.removed,
      durationMs: r.duration_ms, error: r.error, startedAt: r.started_at,
    }));
  },
};

export const settingsQueries = {
  get(key: string): string | null {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as any;
    return row?.value ?? null;
  },
  set(key: string, value: string): void {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  },
};
