import pRetry from "p-retry";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { generateId } from "../lib/crypto.js";
import { dataDir } from "../db/index.js";
import { sourceQueries, logQueries, settingsQueries } from "./db-helpers.js";
import { runImport } from "./pipeline.js";
import { assertPublicRepoHost, normalizeRepoUrl } from "./url-normalize.js";
import type { AssetType, MarketplaceSource, MarketplaceSourceWithCounts, MarketplaceSyncLog } from "@maolinc/cc-loom-shared";
import { normalizeAssetTypesFilter } from "@maolinc/cc-loom-shared";

const MARKETPLACES_ROOT = join(dataDir, "marketplaces");

interface AddInput {
  repoUrl: string;
  ref: string | null;
  addedBy: string;
  /** 仅导入这些能力类型；缺省/全部 = 导入所有类型 */
  assetTypes?: AssetType[] | null;
  /** for tests: override real clone */
  cloneOrFetchOverride?: (repoUrl: string, localPath: string, ref: string | null) => Promise<string>;
}

type AddResult =
  | { kind: "ok"; source: MarketplaceSource }
  | { kind: "conflict"; existing: MarketplaceSource }
  | { kind: "invalid"; error: string };

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(fn, {
    retries: 3,
    factor: 4,
    minTimeout: 30_000,
    maxTimeout: 8 * 60_000,
  });
}

export const marketplaceService = {
  async add(input: AddInput): Promise<AddResult> {
    let url: string;
    try {
      url = normalizeRepoUrl(input.repoUrl);
      await assertPublicRepoHost(url);
    } catch (e) {
      return { kind: "invalid", error: (e as Error).message };
    }

    const existing = sourceQueries.findByUrl(url);
    if (existing) return { kind: "conflict", existing };

    const id = generateId();
    const localPath = join(MARKETPLACES_ROOT, id);
    const now = new Date().toISOString();

    const source: MarketplaceSource = {
      id, kind: "generic-git", parentId: null,
      repoUrl: url, displayName: url.split("/").slice(-2).join("/"), description: "",
      addedBy: input.addedBy, originAuthor: null, ref: input.ref ?? null, enabled: true,
      syncIntervalMinutes: null, lastSyncStatus: null, lastSyncAt: null,
      lastError: null, lastCommitSha: null, localPath,
      assetTypesFilter: normalizeAssetTypesFilter(input.assetTypes),
      createdAt: now, updatedAt: now,
    };
    sourceQueries.insert(source);

    // Trigger initial import (with retries on real git failures)
    await withRetry(async () => {
      const result = await runImport({
        sourceId: id,
        trigger: "add",
        cloneOrFetch: input.cloneOrFetchOverride,
      });
      if (result.status === "failed") {
        throw new Error(result.error ?? "import failed");
      }
    }).catch(() => { /* status already recorded as failed in runImport */ });

    return { kind: "ok", source: sourceQueries.findById(id)! };
  },

  async remove(id: string, opts: { keepAssets: boolean }): Promise<void> {
    const source = sourceQueries.findById(id);
    if (!source) return;
    if (opts.keepAssets) {
      const replacement = `imported from ${source.displayName}`;
      sourceQueries.detachAssets(id, replacement);
    }
    sourceQueries.delete(id);
    try { rmSync(source.localPath, { recursive: true, force: true }); } catch {/* ignore */}
  },

  list(): MarketplaceSourceWithCounts[] {
    return sourceQueries.list().map((s) => ({
      ...s,
      assetCount: sourceQueries.countAssets(s.id),
      workspaceCount: sourceQueries.countWorkspaces(s.id),
    }));
  },

  get(id: string): MarketplaceSourceWithCounts | null {
    const s = sourceQueries.findById(id);
    if (!s) return null;
    return { ...s, assetCount: sourceQueries.countAssets(id), workspaceCount: sourceQueries.countWorkspaces(id) };
  },

  async refresh(id: string): Promise<{ status: "success" | "failed"; error: string | null }> {
    const result = await withRetry(async () => {
      const r = await runImport({ sourceId: id, trigger: "manual", force: true });
      if (r.status === "failed") throw new Error(r.error ?? "refresh failed");
      return r;
    }).catch((err) => ({ status: "failed" as const, error: (err as Error).message }));
    return { status: result.status, error: result.status === "failed" ? (result as any).error : null };
  },

  logs(id: string, limit?: number): MarketplaceSyncLog[] {
    return logQueries.recent(id, limit);
  },

  setEnabled(id: string, enabled: boolean): void {
    sourceQueries.setEnabled(id, enabled);
  },

  getPollIntervalMinutes(): number {
    const v = settingsQueries.get("marketplace.poll_interval_minutes");
    return v ? parseInt(v, 10) : 360;
  },

  setPollIntervalMinutes(value: number): void {
    settingsQueries.set("marketplace.poll_interval_minutes", String(value));
  },
};
