import type { InstallKey, InstallKeyAsset } from "@maolinc/cc-loom-adapter";
import { computeInstallKey, installKeyToString } from "@maolinc/cc-loom-adapter";
import type { TargetTool } from "@maolinc/cc-loom-shared";
import { db } from "../db/index.js";

/**
 * 一处落盘身份载体被多个 Asset 抢占的冲突。详见
 * docs/asset-uniqueness-design.md §5/§6。
 *
 * 同一 `(tool, scope, identity)` 被两个及以上不同 Asset 命中即冲突 ——
 * 它们落到同一物理位置必然互相覆盖，必须在“加入能力集”那一刻二选一。
 */
export interface InstallKeyConflict {
  tool: TargetTool;
  scope: InstallKey["scope"];
  /** 撞键的身份串（归一化后的 name 或 mcp serverKey）。 */
  identity: string;
  /** 抢占这一身份载体的所有 Asset id。 */
  assetIds: string[];
  /** 与 assetIds 同序的 Asset 名称，供前端展示二选一。 */
  assetNames: string[];
}

interface AssetRow {
  id: string;
  name: string;
  type: InstallKeyAsset["type"];
  compatible_tools: string;
}

/**
 * 对一组 Asset 计算落盘身份载体冲突。
 *
 * 按 `(capabilitySet, tool)` 分厂商各算一遍：对每个 Asset 的每个 compatibleTool
 * 调 `computeInstallKey`，撞键即冲突。不支持的类型 / 不兼容的 tool 自动跳过
 * （`computeInstallKey` 返回 null）。hook 仅在附属脚本目录 `hooks/<name>/`
 * 同名时才算冲突（其 InstallKey scope 为 "hook-dir"）。
 *
 * 只读 DB，不做任何写入；调用方据返回结果决定是否拦截。
 */
export function detectInstallKeyConflicts(assetIds: string[]): InstallKeyConflict[] {
  const uniqueIds = [...new Set(assetIds)];
  if (uniqueIds.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT id, name, type, compatible_tools FROM assets
       WHERE id IN (${uniqueIds.map(() => "?").join(",")}) AND deleted_at IS NULL`,
    )
    .all(...uniqueIds) as AssetRow[];

  const seen = new Map<string, { assetId: string; assetName: string; key: InstallKey }>();
  const conflicts = new Map<string, InstallKeyConflict>();

  for (const row of rows) {
    const compatibleTools = JSON.parse(row.compatible_tools || "[]") as TargetTool[];
    // 仅 mcp 需要文件内容来提取 serverKey；其余类型只看 type/name。
    const files =
      row.type === "mcp"
        ? (db
            .prepare("SELECT path, content FROM asset_files WHERE asset_id = ? ORDER BY path")
            .all(row.id) as { path: string; content: string }[])
        : [];

    const asset: InstallKeyAsset = { type: row.type, name: row.name, compatibleTools, files };

    for (const tool of compatibleTools) {
      const keys = computeInstallKey(asset, tool);
      if (!keys) continue;
      for (const key of keys) {
        const ks = installKeyToString(key);
        const prev = seen.get(ks);
        if (!prev) {
          seen.set(ks, { assetId: row.id, assetName: row.name, key });
          continue;
        }
        if (prev.assetId === row.id) continue; // 同一 Asset 自身不冲突
        const existing = conflicts.get(ks);
        if (existing) {
          if (!existing.assetIds.includes(row.id)) {
            existing.assetIds.push(row.id);
            existing.assetNames.push(row.name);
          }
        } else {
          conflicts.set(ks, {
            tool: key.tool,
            scope: key.scope,
            identity: key.identity,
            assetIds: [prev.assetId, row.id],
            assetNames: [prev.assetName, row.name],
          });
        }
      }
    }
  }

  return [...conflicts.values()];
}
