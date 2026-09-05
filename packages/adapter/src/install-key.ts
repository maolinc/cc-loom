import type { AssetType, TargetTool } from "@maolinc/cc-loom-shared";
import { getAdapter } from "./registry.js";
import { mcpServerKeysOf } from "./base.js";

/**
 * 工作空间唯一性的“落盘身份载体”坐标。详见
 * docs/asset-uniqueness-design.md §4/§5。
 *
 * - `tool`：唯一性永远分厂商各算一遍（不同 targetDir 天然不互撞）。
 * - `scope`：身份维度。文件型用 asset.type；mcp 用 "mcp"（按 serverKey）；
 *   hook 用 "hook-dir"（仅附属脚本目录 hooks/<name>/ 同名才冲突）。
 * - `identity`：该维度下的身份串（归一化后的 name 或 mcp serverKey）。
 */
export interface InstallKey {
  tool: TargetTool;
  scope: AssetType | "hook-dir";
  identity: string;
}

/** 唯一性判重所需的最小 asset 形态（ManifestAssetEntry 天然满足）。 */
export interface InstallKeyAsset {
  type: AssetType;
  name: string;
  compatibleTools: TargetTool[];
  files: { path: string; content: string }[];
}

/**
 * name 归一化：路径安全 + 大小写归一化，**不做激进 slug**（保留可读性）。
 *
 * 目的是让 "MySkill"/"myskill"/" my skill " 这类在大小写不敏感文件系统上
 * 会落到同一文件夹的名字判为同一身份；同时把路径分隔符折叠掉，避免目录逃逸。
 */
export function normalizeAssetName(name: string): string {
  return name
    .trim()
    .replace(/[/\\]+/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** InstallKey → 可比较/可作 Map key 的字符串。 */
export function installKeyToString(key: InstallKey): string {
  return `${key.tool}\u0000${key.scope}\u0000${key.identity}`;
}

/**
 * 统一分派：算出 asset 在某个 tool 下占用的所有落盘身份载体坐标。
 *
 * 返回 `null` 表示该 asset **不参与** 这个 tool 的唯一性判定：
 *   - tool 不支持该 asset.type（被 adapter `skipped`，根本不落盘）；
 *   - asset 不兼容该 tool。
 *
 * 否则返回一个或多个 InstallKey：
 *   - skill/rule/command/agent：单 key `(tool, type, normalize(name))`；
 *   - mcp：可能多 key —— wrapped content 含多个 server 时每个 serverKey 一个；
 *   - hook：单 key `(tool, "hook-dir", normalize(name))`，仅附属脚本目录同名才撞。
 */
export function computeInstallKey(
  asset: InstallKeyAsset,
  tool: TargetTool,
): InstallKey[] | null {
  const adapter = getAdapter(tool);
  if (!adapter) return null;
  if (!adapter.supportedTypes.includes(asset.type)) return null;
  if (!asset.compatibleTools.includes(tool)) return null;

  switch (asset.type) {
    case "skill":
    case "rule":
    case "command":
    case "agent":
      return [{ tool, scope: asset.type, identity: normalizeAssetName(asset.name) }];
    case "mcp":
      return mcpServerKeysOf({ name: asset.name, files: asset.files }).map(
        (serverKey) => ({ tool, scope: "mcp" as const, identity: serverKey }),
      );
    case "hook":
      return [{ tool, scope: "hook-dir", identity: normalizeAssetName(asset.name) }];
  }
}
