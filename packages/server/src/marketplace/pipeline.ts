import { db } from "../db/index.js";
import { generateId } from "../lib/crypto.js";
import { syncAssetContentToProjects } from "../lib/auto-sync.js";
import { sourceQueries, logQueries } from "./db-helpers.js";
import { deleteOrRetainAsset, maybeGcRetiredAsset } from "../lib/asset-gc.js";
import { workspaceRefCount } from "../lib/workspace-gc.js";
import { enqueue as enqueueSearchIndex, removeSearchIndex } from "../lib/search-indexer.js";
import { enqueue as enqueueAiInfo, removeAiInfoIndex } from "../lib/ai-info-indexer.js";
import { pickProvider } from "./providers/registry.js";
import { gitClone, gitFetch, gitHeadSha, GitRunnerError } from "./git-runner.js";
import { normalizeRepoUrl } from "./url-normalize.js";
import type { AssetType, ImportedAsset, ImportedPlugin, MarketplaceSyncLog, ProviderResult, SyncTrigger, TargetTool } from "@maolinc/cc-loom-shared";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ImportInput {
  sourceId: string;
  trigger: SyncTrigger;
  /** override for tests; default uses real git */
  cloneOrFetch?: (repoUrl: string, localPath: string, ref: string | null) => Promise<string>;
  /**
   * When true, re-parse the local clone even if the commit SHA hasn't changed.
   * Used by manual refresh so changes to provider/extraction logic take effect
   * without waiting for a new upstream commit. Scheduled syncs leave this
   * false so unchanged repos don't burn CPU re-parsing every poll.
   */
  force?: boolean;
}

export interface ImportResult {
  status: "success" | "failed";
  added: number;
  updated: number;
  removed: number;
  error: string | null;
  durationMs: number;
}

async function defaultCloneOrFetch(repoUrl: string, localPath: string, ref: string | null): Promise<string> {
  if (!existsSync(localPath)) {
    await gitClone(repoUrl, localPath, ref ?? undefined);
  } else {
    await gitFetch(localPath, ref ?? undefined);
  }
  return await gitHeadSha(localPath);
}

/**
 * Test-only override. When set, every `runImport` that doesn't pass an explicit
 * `cloneOrFetch` will use this instead of the real git subprocess. Production
 * code never sets this; tests use it to drive HTTP-level e2e flows without
 * spawning git.
 */
let cloneOrFetchOverride: typeof defaultCloneOrFetch | null = null;
export function __setCloneOrFetchOverride(fn: typeof defaultCloneOrFetch | null): void {
  cloneOrFetchOverride = fn;
}

interface DbAssetRow {
  id: string;
  source_path: string | null;
  name: string;
  type: string;
  description: string;
  tags: string;
  compatible_tools: string;
  version: string;
  source_origin_author: string | null;
  metadata: string;
  deleted_at: string | null;
}

function fetchExistingAssets(sourceId: string): Map<string, DbAssetRow> {
  const rows = db
    .prepare("SELECT * FROM assets WHERE source_id = ?")
    .all(sourceId) as DbAssetRow[];
  const map = new Map<string, DbAssetRow>();
  for (const r of rows) {
    if (r.source_path) map.set(r.source_path, r);
  }
  return map;
}

function diffAndUpsertAssets(
  sourceId: string,
  originAuthor: string | null,
  imported: ImportedAsset[],
  sourceUrl: string,
): { added: number; updated: number; removed: number; idsByPath: Map<string, string> } {
  const existing = fetchExistingAssets(sourceId);
  const idsByPath = new Map<string, string>();
  let added = 0, updated = 0;
  const seen = new Set<string>();

  const insert = db.prepare(`
    INSERT INTO assets (
      id, name, source_url, type, description, author, tags, compatible_tools,
      visibility, version, source_id, source_path, source_origin_author, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, ?, ?, ?)
  `);
  // 更新时不覆盖 description / tags：保留用户自定义的别名（alias 不在 SQL 中）、描述与标签。
  const update = db.prepare(`
    UPDATE assets SET name = ?, type = ?, compatible_tools = ?,
      version = ?, source_origin_author = ?, metadata = ?, updated_at = ?
    WHERE id = ?
  `);

  const insertFile = db.prepare(`
    INSERT INTO asset_files (id, asset_id, path, content, size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertFiles = (assetId: string, files: { path: string; content: string }[]) => {
    db.prepare("DELETE FROM asset_files WHERE asset_id = ?").run(assetId);
    for (const f of files) {
      insertFile.run(generateId(), assetId, f.path, f.content, f.content.length, now, now);
    }
  };

  const now = new Date().toISOString();
  for (const a of imported) {
    seen.add(a.sourcePath);
    const author = a.originAuthor ?? originAuthor ?? "marketplace";
    const tagsJson = JSON.stringify(a.tags);
    const toolsJson = JSON.stringify(a.compatibleTools);
    const metadataJson = JSON.stringify(a.metadata);
    const existingRow = existing.get(a.sourcePath);
    if (!existingRow) {
      const id = generateId();
      insert.run(
        id, a.name, sourceUrl, a.type, a.description, author, tagsJson, toolsJson,
        a.version, sourceId, a.sourcePath, a.originAuthor, metadataJson, now, now,
      );
      upsertFiles(id, a.files);
      added++;
      idsByPath.set(a.sourcePath, id);
      // 语义搜索：新增能力入队索引
      enqueueSearchIndex(id, "new");
      // 能力信息生成：新增能力入队（源仓库可能留空描述/标签，worker 补缺口）
      enqueueAiInfo(id, "new");
    } else {
      const changed =
        existingRow.name !== a.name ||
        existingRow.type !== a.type ||
        existingRow.description !== a.description ||
        existingRow.version !== a.version ||
        existingRow.tags !== tagsJson ||
        existingRow.compatible_tools !== toolsJson ||
        existingRow.metadata !== metadataJson ||
        existingRow.deleted_at !== null;
      if (changed) {
        // 更新时不覆盖 description / tags：保留用户自定义的描述与标签。
        // alias 不在 UPDATE SQL 中，同样保留。
        update.run(
          a.name, a.type, toolsJson,
          a.version, a.originAuthor, metadataJson, now, existingRow.id,
        );
        updated++;
        // 语义搜索：编辑后按 content_hash 变化重排（name 变会触发；description/tags 保留不动）
        enqueueSearchIndex(existingRow.id, "auto");
        // 能力信息生成：导入更新后重扫空缺（源未提供的字段由 worker 补）
        enqueueAiInfo(existingRow.id, "auto");
      }
      // Always refresh files on import (content may have changed even if metadata hasn't)
      upsertFiles(existingRow.id, a.files);
      idsByPath.set(a.sourcePath, existingRow.id);
    }
  }

  let removed = 0;
  const softDelete = db.prepare("UPDATE assets SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL");
  for (const [path, row] of existing) {
    if (!seen.has(path)) {
      const info = softDelete.run(now, now, row.id);
      if (info.changes > 0) {
        removed++;
        // 语义搜索：软删能力清理派生索引（不再出现在搜索结果）
        removeSearchIndex(row.id);
        removeAiInfoIndex(row.id);
      }
    }
  }

  return { added, updated, removed, idsByPath };
}

function upsertPlugins(
  sourceId: string,
  plugins: ImportedPlugin[],
  assetIdsByPath: Map<string, string>,
  addedBy: string,
): void {
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT id, source_plugin FROM workspaces WHERE source_id = ?").all(sourceId) as { id: string; source_plugin: string }[];
  const existingByName = new Map(existing.map((r) => [r.source_plugin, r.id]));
  const seenPlugins = new Set<string>();

  // Need user_id to satisfy NOT NULL. We use a synthetic user owned by addedBy email lookup.
  const userRow = db.prepare("SELECT id FROM users WHERE email = ?").get(addedBy) as { id: string } | undefined;
  const userId = userRow?.id ?? null;

  for (const p of plugins) {
    seenPlugins.add(p.pluginName);
    const allTools = collectTools(p.assets);

    let workspaceId: string;
    if (existingByName.has(p.pluginName)) {
      workspaceId = existingByName.get(p.pluginName)!;
      db.prepare(`UPDATE workspaces SET name = ?, description = ?, target_tools = ?, version = ?, updated_at = ? WHERE id = ?`).run(
        p.pluginName, p.description, JSON.stringify(allTools), p.version, now, workspaceId,
      );
    } else {
      // 同名拦截：若用户已有同名工作空间（来自其他来源或手动创建），跳过此 plugin。
      // 唯一索引 idx_workspaces_user_name 保证 (user_id, name) 在未软删行中唯一。
      if (userId) {
        const nameConflict = db.prepare(
          "SELECT id FROM workspaces WHERE user_id = ? AND name = ? AND deleted_at IS NULL",
        ).get(userId, p.pluginName);
        if (nameConflict) {
          continue;
        }
      }
      workspaceId = generateId();
      db.prepare(`
        INSERT INTO workspaces (id, user_id, name, description, target_tools, visibility, version, source_id, source_plugin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, ?)
      `).run(workspaceId, userId, p.pluginName, p.description, JSON.stringify(allTools), p.version, sourceId, p.pluginName, now, now);
    }

    // Refresh workspace_assets to match plugin's current assets
    db.prepare("DELETE FROM workspace_assets WHERE workspace_id = ?").run(workspaceId);
    for (const a of p.assets) {
      const assetId = assetIdsByPath.get(a.sourcePath);
      if (!assetId) continue;
      db.prepare("INSERT INTO workspace_assets (id, workspace_id, asset_id) VALUES (?, ?, ?)").run(generateId(), workspaceId, assetId);
    }
  }

  // Remove workspaces whose plugin disappeared. If a local project still references
  // the workspace, retain it as soft-deleted instead of violating FK semantics.
  for (const r of existing) {
    if (!seenPlugins.has(r.source_plugin)) {
      if (workspaceRefCount(r.id) > 0) {
        db.prepare("UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, r.id);
        continue;
      }
      const assetIds = (db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?").all(r.id) as { asset_id: string }[]).map((x) => x.asset_id);
      db.prepare("DELETE FROM workspace_assets WHERE workspace_id = ?").run(r.id);
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(r.id);
      for (const assetId of assetIds) maybeGcRetiredAsset(assetId);
    }
  }
}

function collectTools(assets: ImportedAsset[]): TargetTool[] {
  const set = new Set<TargetTool>();
  for (const a of assets) for (const t of a.compatibleTools) set.add(t);
  return Array.from(set);
}

/**
 * 按数据源的 `assetTypesFilter` 过滤 provider 解析结果。`null` = 全部类型；
 * 否则仅保留列出的类型，并丢弃过滤后无 asset 的 plugin（避免空工作空间）。
 * childSources 不受影响（它们是待注册的子源，不是 asset）。
 */
function applyAssetTypeFilter(result: ProviderResult, filter: AssetType[] | null): ProviderResult {
  if (filter === null) return result;
  const allowed = new Set<AssetType>(filter);
  const assets = result.assets.filter((a) => allowed.has(a.type));
  const plugins = result.plugins
    .map((p) => ({ ...p, assets: p.assets.filter((a) => allowed.has(a.type)) }))
    .filter((p) => p.assets.length > 0);
  return { ...result, assets, plugins };
}

async function ensureChildSources(
  parentId: string,
  parentLocalRoot: string,
  result: ProviderResult,
  addedBy: string,
  assetTypesFilter: AssetType[] | null,
): Promise<void> {
  if (result.childSources.length === 0) return;

  const now = new Date().toISOString();
  for (const child of result.childSources) {
    const url = normalizeRepoUrl(child.repoUrl);
    const existing = sourceQueries.findByUrl(url);
    if (existing) {
      // Upgrade kind & parent if it was a manual generic-git entry
      if (existing.kind === "generic-git" && existing.parentId === null) {
        sourceQueries.upgradeKind(existing.id, "claude-code-plugin", parentId);
      }
      continue;
    }
    const childId = generateId();
    sourceQueries.insert({
      id: childId, kind: "claude-code-plugin", parentId,
      repoUrl: url, displayName: child.displayName, description: "",
      addedBy, originAuthor: null, ref: child.ref, enabled: true,
      syncIntervalMinutes: null, lastSyncStatus: null, lastSyncAt: null,
      lastError: null, lastCommitSha: null,
      localPath: join(parentLocalRoot, "_plugins", child.displayName),
      assetTypesFilter,
      createdAt: now, updatedAt: now,
    });
  }
}

export async function runImport(input: ImportInput): Promise<ImportResult> {
  const start = Date.now();
  const source = sourceQueries.findById(input.sourceId);
  if (!source) {
    return { status: "failed", added: 0, updated: 0, removed: 0, error: "Source not found", durationMs: 0 };
  }

  sourceQueries.setSyncStatus(source.id, "running", null, null);
  const cloneOrFetch = input.cloneOrFetch ?? cloneOrFetchOverride ?? defaultCloneOrFetch;

  try {
    const sha = await cloneOrFetch(source.repoUrl, source.localPath, source.ref);

    let added = 0, updated = 0, removed = 0;
    let touchedAssetIds: string[] = [];

    if (sha === source.lastCommitSha && !input.force) {
      // No-op import: SHA unchanged and caller didn't request a forced re-parse.
    } else {
      const provider = pickProvider(source.localPath);
      const result = applyAssetTypeFilter(
        await provider.parse(source.localPath, { repoUrl: source.repoUrl }),
        source.assetTypesFilter,
      );

      const tx = db.transaction(() => {
        const diff = diffAndUpsertAssets(source.id, result.originAuthor, result.assets, source.repoUrl);
        added = diff.added; updated = diff.updated; removed = diff.removed;
        touchedAssetIds = [...diff.idsByPath.values()];

        if (result.plugins.length > 0) {
          upsertPlugins(source.id, result.plugins, diff.idsByPath, source.addedBy);
        }
      });
      tx();

      // 数据源导入同样触发自动同步：把刷新后的文件内容推到安装了对应 asset 的 auto 项目。
      // 新增（added）的 asset 尚未被任何项目安装，syncAssetContentToProjects 内部查询为空，自然 no-op。
      // 事务提交后调用，确保 worker 读到的是最新内容。
      for (const assetId of touchedAssetIds) {
        syncAssetContentToProjects(assetId);
      }

      // childSources are written outside the asset transaction to keep their lifecycle independent
      await ensureChildSources(source.id, source.localPath, result, source.addedBy, source.assetTypesFilter);
    }

    sourceQueries.setSyncStatus(source.id, "success", null, sha);
    const log: MarketplaceSyncLog = {
      id: generateId(), sourceId: source.id, trigger: input.trigger, status: "success",
      added, updated, removed, durationMs: Date.now() - start, error: null,
      startedAt: new Date(start).toISOString(),
    };
    logQueries.insert(log);
    return { status: "success", added, updated, removed, error: null, durationMs: log.durationMs };
  } catch (err) {
    const message = err instanceof GitRunnerError ? `${err.message} ${err.stderr}`.trim() : (err as Error).message;
    sourceQueries.setSyncStatus(source.id, "failed", message, null);
    const log: MarketplaceSyncLog = {
      id: generateId(), sourceId: source.id, trigger: input.trigger, status: "failed",
      added: 0, updated: 0, removed: 0, durationMs: Date.now() - start, error: message,
      startedAt: new Date(start).toISOString(),
    };
    logQueries.insert(log);
    return { status: "failed", added: 0, updated: 0, removed: 0, error: message, durationMs: log.durationMs };
  }
}
