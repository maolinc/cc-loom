import { createHash } from "node:crypto";
import type { AssetType } from "@maolinc/cc-loom-shared";
import { db } from "../db/index.js";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * 语义搜索字段文本构造（docs/sqlite-vec-search-design.md §2.3）。
 *
 * 三字段向量化（name / tags / description），正文不参与。description 为手填
 * assets.description 与文档 frontmatter description（仅 skill/agent/command）合并去重。
 * content_hash 仅随 name/alias/tags/手填description/frontmatter description 变化而变，
 * 正文 body 变化不触发重算。
 *
 * 纯函数 + 一个 DB 读取入口（loadAssetIndexData）；search-indexer 通过它构造文本与 hash。
 */

export interface AssetIndexData {
  id: string;
  name: string;
  alias: string | null;
  /** tags JSON 数组字符串（assets.tags 列原样）。 */
  tagsJson: string;
  /** 手填 description（assets.description）。 */
  description: string;
  type: AssetType;
  deletedAt: string | null;
  files: { path: string; content: string }[];
}

export interface FieldTexts {
  name: string;
  tags: string;
  description: string;
}

/** 读取能力索引所需数据（asset 行 + 文件 path/content）。asset 不存在返回 null。 */
export function loadAssetIndexData(assetId: string): AssetIndexData | null {
  const row = db.prepare(
    "SELECT id, name, alias, tags, description, type, deleted_at FROM assets WHERE id = ?",
  ).get(assetId) as
    | { id: string; name: string; alias: string | null; tags: string; description: string; type: AssetType; deleted_at: string | null }
    | undefined;
  if (!row) return null;
  const files = db.prepare(
    "SELECT path, content FROM asset_files WHERE asset_id = ?",
  ).all(assetId) as { path: string; content: string }[];
  return {
    id: row.id,
    name: row.name,
    alias: row.alias,
    tagsJson: row.tags,
    description: row.description ?? "",
    type: row.type,
    deletedAt: row.deleted_at,
    files,
  };
}

/** trim + 折叠内部连续空白为单空格。 */
function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** tags JSON 数组 → 空格分隔串（解析失败则原样 trim）。 */
export function expandTags(tagsJson: string): string {
  try {
    const arr = JSON.parse(tagsJson) as unknown;
    if (Array.isArray(arr)) {
      return arr.map((t) => String(t).trim()).filter(Boolean).join(" ");
    }
  } catch { /* fall through */ }
  return normalizeWhitespace(tagsJson);
}

/**
 * 从 skill/agent/command 的主 .md 文件抽取 frontmatter description。
 * - skill：SKILL.md（path === "SKILL.md" 或以 "/SKILL.md" 结尾）
 * - agent/command：主 .md（README.md 优先，否则第一个 .md）
 * - rule/mcp/hook：不抽取（返回空串）
 */
export function extractFrontmatterDescription(data: AssetIndexData): string {
  if (data.type !== "skill" && data.type !== "agent" && data.type !== "command") {
    return "";
  }
  const mdFiles = data.files.filter((f) => {
    const p = f.path.toLowerCase();
    return p.endsWith(".md") || p.endsWith(".mdc");
  });
  let primary: string | undefined;
  if (data.type === "skill") {
    primary = mdFiles.find((f) => {
      const p = f.path;
      return p === "SKILL.md" || p.endsWith("/SKILL.md");
    })?.content;
  }
  if (primary === undefined) {
    // agent/command 主 .md；README.md 优先，否则第一个 .md
    const readme = mdFiles.find((f) => {
      const base = f.path.split("/").pop() ?? f.path;
      return base.toLowerCase() === "readme.md";
    });
    primary = (readme ?? mdFiles[0])?.content;
  }
  if (primary === undefined) return "";
  const { fm } = parseFrontmatter(primary);
  return typeof fm.description === "string" ? fm.description : "";
}

/**
 * 合并手填 description 与 frontmatter description（§2.3）。
 * - 两侧 trim + 折叠空白
 * - 大小写敏感精确相等 → 只用一个
 * - 两者均有值且不等 → 手填 + "\n" + frontmatter
 * - 仅一者有值 → 用该值
 * - 均空 → 空串
 */
export function mergeDescription(manual: string, frontmatter: string): string {
  const a = normalizeWhitespace(manual);
  const b = normalizeWhitespace(frontmatter);
  if (!a && !b) return "";
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  return `${a}\n${b}`;
}

/** 构造三字段文本（name 含 alias 拼接）。 */
export function buildFieldTexts(data: AssetIndexData): FieldTexts {
  const name = normalizeWhitespace(
    data.alias ? `${data.name} ${data.alias}` : data.name,
  );
  const tags = expandTags(data.tagsJson);
  const frontmatterDesc = extractFrontmatterDescription(data);
  const description = mergeDescription(data.description, frontmatterDesc);
  return { name, tags, description };
}

/**
 * content_hash：name+alias+tags+手填description+frontmatter description 的指纹。
 * 以归一化后的三字段文本为输入（等价于上述 5 项），保证只有语义变化才变 hash。
 * 用于判断是否需重算向量（§5.3/§5.5 写回复检）。
 */
export function computeContentHash(texts: FieldTexts): string {
  return createHash("sha256")
    .update(`${texts.name}\0${texts.tags}\0${texts.description}`)
    .digest("hex");
}
