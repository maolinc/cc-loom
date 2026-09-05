/**
 * 下载打包：把能力 / 能力集渲染成 zip 条目，再由路由层用 fflate 压成 zip。
 *
 * 两种渲染模式：
 *  - 预览结构（无厂商）：与 DetailPanel 的 `activeFileFullPath` 一致——
 *    `<typeDir>/<name>/<file.path>`（目录型）或 `<typeDir>/<file.path>`（平铺型）。
 *    asset_files 原样铺放，不聚合 mcp、不重组 hook，保证「完整体，不多不少」。
 *  - 厂商结构：走 adapter.generate，产出 `<targetDir>/...` 完整安装包；
 *    不兼容该厂商的类型由 adapter 跳过（决策点 A，UI 侧提示）。
 *
 * 不写入任何描述性文件，避免「多余东西」。
 */
import { zipSync } from "fflate";
import { ASSET_TYPE_DIRS, isAssetDirLayout } from "@maolinc/cc-loom-shared";
import type { AssetType, TargetTool, Manifest, ManifestAssetEntry } from "@maolinc/cc-loom-shared";
import { getAdapters } from "@maolinc/cc-loom-adapter";

export interface ZipEntry {
  path: string;
  data: Buffer;
}

/** 单个文件的字节数据：base64 → 解码，文本 → UTF-8。 */
function fileData(content: string, encoding?: string | null): Buffer {
  return encoding === "base64"
    ? Buffer.from(content, "base64")
    : Buffer.from(content, "utf8");
}

/**
 * 单能力预览结构条目。规则与 DetailPanel `activeFileFullPath` 对齐：
 *   typeDir = ASSET_TYPE_DIRS[type]（mcp 为 ""）
 *   wrap    = isAssetDirLayout(asset)（skill/hook 恒 true；rule/command/agent 看 sourcePath）
 *   path    = wrap ? <typeDir>/<name>/<file.path> : <typeDir>/<file.path>
 *
 * `options.typeDir`（默认 true）控制是否带顶层能力类型目录：
 *  - 能力集下载传 true（多能力按类型隔离）。
 *  - 单能力下载传 false——zip 就是「能力本身」：目录型 `<name>/<file.path>`，
 *    平铺型直接 `<file.path>`，不加 `skills/` / `rules/` 等类型前缀。
 */
export function buildAssetPreviewEntries(
  asset: {
    type: AssetType;
    name: string;
    sourcePath?: string | null;
    files: { path: string; content: string; encoding?: string | null }[];
  },
  options: { typeDir?: boolean } = {},
): ZipEntry[] {
  const includeTypeDir = options.typeDir ?? true;
  const typeDir = includeTypeDir ? (ASSET_TYPE_DIRS[asset.type] ?? "") : "";
  const wrap = isAssetDirLayout(asset);
  return asset.files.map((f) => {
    const parts: string[] = [];
    if (typeDir) parts.push(typeDir);
    if (wrap) parts.push(asset.name);
    parts.push(f.path);
    return { path: parts.join("/"), data: fileData(f.content, f.encoding) };
  });
}

/** 能力集预览结构：每个成员资产按 buildAssetPreviewEntries 铺放（带类型目录），全部包含。 */
export function buildCapabilitySetPreviewEntries(assets: ManifestAssetEntry[]): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const a of assets) out.push(...buildAssetPreviewEntries(a));
  return out;
}

/**
 * 能力集厂商结构：走 adapter.generate，合并各厂商输出（各自带 targetDir 前缀，
 * 天然隔离）。返回条目与被跳过的资产（不兼容类型），供 UI 提示。
 */
export function buildCapabilitySetVendorEntries(
  manifest: Manifest,
  tools: TargetTool[],
): { entries: ZipEntry[]; skipped: { assetName: string; type: AssetType; tool: TargetTool }[] } {
  const entries: ZipEntry[] = [];
  const skipped: { assetName: string; type: AssetType; tool: TargetTool }[] = [];
  for (const adapter of getAdapters(tools)) {
    const out = adapter.generate(manifest);
    for (const f of out.files) {
      entries.push({ path: f.path, data: fileData(f.content, (f as { encoding?: string }).encoding) });
    }
    for (const s of out.skipped) {
      skipped.push({ assetName: s.name, type: s.type, tool: adapter.tool });
    }
  }
  return { entries, skipped };
}

/**
 * 把条目压成 zip Buffer。同名路径后者覆盖前者（聚合 mcp 多厂商时会合并到各自 targetDir，不冲突）。
 * `prefix` 非空时，每个条目路径前加 `<prefix>/`——能力集下载用它把所有文件包到 `<能力集名>/` 顶层目录下。
 */
export function zipEntries(entries: ZipEntry[], prefix?: string): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) {
    const path = prefix ? `${prefix}/${e.path}` : e.path;
    files[path] = new Uint8Array(e.data);
  }
  return Buffer.from(zipSync(files));
}

/** 生成下载文件名：<slug>.zip，避免中文 / 空格 / 路径分隔符。 */
export function downloadFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "loom"}.zip`;
}
