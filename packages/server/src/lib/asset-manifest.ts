/**
 * 把 DB 中的 asset 投影成 agent 可用的 ManifestAssetEntry（含文件内容与元数据）。
 * 安装 / 能力操作 / 自动同步 多处复用，统一可见性与软删过滤口径。
 */
import type { ManifestAssetEntry } from "@maolinc/cc-loom-shared";
import { db } from "../db/index.js";

/**
 * 按 assetId 列表加载 ManifestAssetEntry，按可见性过滤（public 任意可见，private 仅 author）。
 * @param includeDeleted 是否包含已软删（留存）asset。解析「已安装」集合时应为 true，
 *   否则留存 asset 在 mcp/hook 聚合重算时拿不到内容；新增/全新安装场景保持 false。
 */
export function loadAssetEntries(
  ids: string[],
  userEmail: string,
  includeDeleted = false,
): ManifestAssetEntry[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, name, type, version, description, compatible_tools, metadata, source_path, visibility, author
         FROM assets WHERE id IN (${placeholders})${includeDeleted ? "" : " AND deleted_at IS NULL"}`,
    )
    .all(...ids) as any[];
  const out: ManifestAssetEntry[] = [];
  for (const a of rows) {
    if (a.visibility === "private" && a.author !== userEmail) continue;
    const files = db
      .prepare("SELECT path, content, encoding FROM asset_files WHERE asset_id = ? ORDER BY path")
      .all(a.id) as any[];
    out.push({
      assetId: a.id,
      name: a.name,
      type: a.type,
      version: a.version,
      description: a.description,
      files: files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding ?? undefined })),
      compatibleTools: JSON.parse(a.compatible_tools || "[]"),
      metadata: JSON.parse(a.metadata || "{}"),
      sourcePath: a.source_path ?? null,
    });
  }
  return out;
}
