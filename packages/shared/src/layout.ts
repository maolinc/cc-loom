import type { AssetType } from "./constants.js";

/**
 * Decide whether an asset's files should be installed/displayed as a wrapped
 * directory (`<typeDir>/<asset.name>/<file.path>`) or as a flat file
 * (`<typeDir>/<file.path>` or `<typeDir>/<slugify(name)>.ext`).
 *
 * Type-level rules (override everything else):
 *   - `skill` is **always** a directory. A skill's minimal unit is
 *     `skills/<name>/SKILL.md`; a loose `skills/<name>.md` is not a skill, just
 *     a file. So skills never use the flat layout, regardless of sourcePath or
 *     file count. (SKILL.md presence is enforced at creation / extraction.)
 *   - `hook` is always a directory — every hook installs under
 *     `<targetDir>/hooks/<name>/<file>`, mirrored by `BaseAdapter`'s hook branch.
 *   - `mcp` entries are aggregated into a single `mcp.json`, so the dir/flat
 *     distinction does not apply.
 *
 * For the remaining single-file types (rule / command / agent) the layout is
 * derived from the asset's `sourcePath`:
 *   - `rules/no-console.md`         → has `.md` extension → flat
 *   - `commands/review`            → no extension on the last segment → dir
 *
 * For locally-created assets (no `sourcePath`), fall back to the historical
 * heuristic of "multi-file means dir, single-file means flat" to preserve the
 * existing UI behaviour for user-built assets.
 */
export function isAssetDirLayout(asset: {
  type: AssetType;
  sourcePath?: string | null;
  files: { path: string }[];
}): boolean {
  if (asset.type === "skill") return true;
  if (asset.type === "hook") return true;
  if (asset.type === "mcp") return false;

  if (asset.sourcePath) {
    const last = asset.sourcePath.split("/").pop() ?? "";
    // Treat the segment as a file iff it has a recognizable extension at the
    // end. Anything else (no dot, or trailing slash) is treated as a directory.
    return !/\.[A-Za-z0-9]+$/.test(last);
  }

  return asset.files.length > 1;
}
