import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname, relative, dirname, sep, resolve } from "node:path";
import type { TargetTool, ImportedAsset, ProviderResult, AssetType, AssetMetadata } from "@maolinc/cc-loom-shared";
import { TARGET_TOOLS, HOOK_EVENTS } from "@maolinc/cc-loom-shared";
import type { SourceProvider } from "./types.js";
import { extractMetadata } from "../extract-metadata.js";
import { parseFrontmatter, type Frontmatter } from "../../lib/frontmatter.js";

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdc", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml",
  ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".css", ".scss", ".less", ".html", ".htm",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".env", ".gitignore", ".dockerignore", ".editorconfig",
  ".csv", ".tsv", ".log", ".sql", ".graphql", ".vue", ".svelte", ".svg",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
]);

async function readFileContent(absPath: string): Promise<string> {
  const ext = extname(absPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext)) {
    // SVG is text-based; other images read as base64 for inline display
    if (ext === ".svg") return await readFile(absPath, "utf8");
    if (IMAGE_EXTENSIONS.has(ext)) {
      const buf = await readFile(absPath);
      const b64 = buf.toString("base64");
      const mime = ext === ".jpg" ? "jpeg" : ext.slice(1);
      return `data:image/${mime};base64,${b64}`;
    }
    return await readFile(absPath, "utf8");
  }
  // Unknown extension: try UTF-8, fall back to base64
  try {
    const buf = await readFile(absPath);
    // Quick check: if the buffer contains null bytes, treat as binary
    if (buf.includes(0)) return buf.toString("base64");
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function inferTools(_relPath: string): TargetTool[] {
  return [...TARGET_TOOLS];
}

async function walkFiles(dir: string, root: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await walkFiles(full, root);
      out.push(...nested);
    } else if (e.isFile()) {
      out.push(relative(root, full));
    }
  }
  return out;
}

async function extractAssetDir(
  root: string,
  relDir: string,
  type: AssetType,
): Promise<ImportedAsset[]> {
  const abs = join(root, relDir);
  if (!existsSync(abs)) return [];
  const allFiles = await walkFiles(abs, root);

  // Strip relDir prefix to get paths relative to the asset type directory
  const prefix = relDir + "/";
  const relFiles = allFiles
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));

  if (relFiles.length === 0) return [];

  // Group by top-level segment: top-level files keyed by full path;
  // files under a subdirectory all belong to that directory.
  const groups = new Map<string, string[]>();
  for (const rel of relFiles) {
    const topLevel = rel.split("/")[0]!;
    const isFile = !rel.includes("/");
    const key = isFile ? rel : topLevel;
    const list = groups.get(key) || [];
    list.push(rel);
    groups.set(key, list);
  }

  const out: ImportedAsset[] = [];
  for (const [groupKey, groupFiles] of groups) {
    // Primary file for metadata: SKILL.md > README.md > first .md > first file
    const mdFiles = groupFiles.filter((f) => {
      const ext = extname(f).toLowerCase();
      return ext === ".md" || ext === ".mdc";
    });
    const primaryIdx = mdFiles.findIndex((f) =>
      basename(f).toLowerCase() === "skill.md"
    );
    const primary = primaryIdx >= 0 ? mdFiles[primaryIdx]!
      : (mdFiles.length > 0 ? mdFiles[0]! : groupFiles[0]!);

    // Extract metadata from primary file (frontmatter only for markdown)
    const primaryExt = extname(primary).toLowerCase();
    let fm: Frontmatter = {};
    if (primaryExt === ".md" || primaryExt === ".mdc") {
      const content = await readFileContent(join(root, relDir, primary));
      ({ fm } = parseFrontmatter(content));
    }

    // Name from frontmatter, or the directory name for directory groups
    // (any file nested under `<groupKey>/`), or the filename for flat files.
    const isDirGroup = groupFiles.some((f) => f.includes("/"));
    const name = fm.name ?? (isDirGroup ? groupKey : basename(primary, extname(primary)));

    // Collect all files with content
    const allAssetFiles: { path: string; content: string }[] = [];
    for (const f of groupFiles) {
      const fc = await readFileContent(join(root, relDir, f));
      // Display path: for multi-file groups, keep path relative to group root
      const displayPath = groupFiles.length > 1 && f.startsWith(groupKey + "/")
        ? f.slice(groupKey.length + 1)
        : basename(f);
      allAssetFiles.push({ path: displayPath, content: fc });
    }

    let files = allAssetFiles;
    let sourcePath = `${relDir}/${groupKey}`;

    // 领域规则：合法 skill 必须符合规范，否则不是 skill、直接跳过。规范有两种形态：
    //   1. 目录式：`skills/<name>/` 内含根级 SKILL.md（可附带其它文件）。
    //   2. 松散 markdown：`skills/<name>.md`（顶层单 .md/.mdc 文件）—— 规范化为目录式，
    //      唯一文件改名 SKILL.md、sourcePath 去扩展名。
    // 其它情况（如 `skills/llms.txt`、`skills/icon.png`、或缺 SKILL.md 的目录，以及
    // `skills/<cat>/<name>/SKILL.md` 这类深层嵌套——默认扫描只认一层）都不是合法
    // skill，不能被伪造成 skill 导入。注意：必须用原始 relPath 判定 SKILL.md 是否为
    // group 的直接子文件；displayPath 对单文件 group 会折叠成 basename，会把
    // `skills/deprecated/old/SKILL.md` 误判成根级 SKILL.md。
    if (type === "skill") {
      const isFlatGroup = groupFiles.length === 1 && !groupFiles[0]!.includes("/");
      const flatExt = isFlatGroup ? extname(groupFiles[0]!).toLowerCase() : "";
      const isFlatMarkdown = flatExt === ".md" || flatExt === ".mdc";
      const hasRootSkillMd = groupFiles.some(
        (f) => f.toLowerCase() === `${groupKey}/skill.md`,
      );
      if (isFlatGroup && isFlatMarkdown) {
        files = [{ path: "SKILL.md", content: allAssetFiles[0]!.content }];
        sourcePath = `${relDir}/${basename(groupKey, extname(groupKey))}`;
      } else if (!hasRootSkillMd) {
        continue;
      }
    }

    const draft: ImportedAsset = {
      sourcePath,
      name,
      type,
      description: fm.description ?? "",
      files,
      compatibleTools: inferTools(join(relDir, primary)),
      version: "1.0.0",
      tags: fm.tags ?? [],
      originAuthor: null,
      metadata: {},
    };
    out.push({ ...draft, metadata: extractMetadata(draft) });
  }
  return out;
}

async function extractStandardHooks(root: string): Promise<ImportedAsset[]> {
  const hooksRoot = join(root, "hooks");
  if (!existsSync(hooksRoot)) return [];
  const entries = await readdir(hooksRoot, { withFileTypes: true });
  const out: ImportedAsset[] = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const hookDir = join(hooksRoot, ent.name);
    const manifestPath = join(hookDir, "hook.json");
    if (!existsSync(manifestPath)) continue; // 第三方 hooks/hooks.json（非目录）自动被忽略

    let manifest: any;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch { continue; }

    // 事件集合：新格式 events[]（过滤非法事件名）+ 旧单 event 兼容合并
    const events = [
      ...(Array.isArray(manifest?.events) ? manifest.events : []),
      ...(typeof manifest?.event === "string" ? [manifest.event] : []),
    ].filter((e): e is string => typeof e === "string" && HOOK_EVENT_SET.has(e));
    const uniqueEvents = [...new Set(events)];
    if (uniqueEvents.length === 0) continue;
    if (!Array.isArray(manifest.hooks) || manifest.hooks.length === 0) continue;
    if (!manifest.hooks.every((h: any) => typeof h?.type === "string")) continue;

    // files = hook 包根下所有文件，路径相对 hook 根目录
    const files: { path: string; content: string }[] = [];
    const walked = await walkFiles(hookDir, hookDir);
    for (const rel of walked) {
      files.push({ path: rel, content: await readFileContent(join(hookDir, rel)) });
    }

    const metadata: AssetMetadata = {
      events: uniqueEvents,
      ...(typeof manifest.matcher === "string" ? { matcher: manifest.matcher } : {}),
      hooks: manifest.hooks,
    };

    out.push({
      sourcePath: `hooks/${ent.name}`,
      name: ent.name,
      type: "hook",
      description: typeof manifest.description === "string" ? manifest.description : "",
      files,
      compatibleTools: ["claudecode", "codebuddy", "codex"],
      version: "1.0.0",
      tags: [],
      originAuthor: null,
      metadata,
    });
  }
  return out;
}

const HOOK_EVENT_SET = new Set<string>(HOOK_EVENTS);

export async function extractMcpFile(root: string, relPath: string): Promise<ImportedAsset[]> {
  const normalized = relPath.replace(/^\.\//, "").replace(/\\/g, "/");
  const abs = join(root, normalized);
  if (!existsSync(abs)) return [];
  const raw = await readFile(abs, "utf8");
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const servers = parsed.mcpServers ?? parsed.servers ?? parsed;
  return parseMcpServers(servers, normalized);
}

async function statOrNull(p: string) {
  try { return await stat(p); } catch { return null; }
}

/**
 * Extract a flat (single-file) skill from a `.md`/`.mdc` file, normalizing it
 * to a `SKILL.md` entry — mirrors the flat-skill branch of `extractAssetDir`.
 */
async function extractFlatSkillFile(root: string, relPath: string): Promise<ImportedAsset[]> {
  const abs = join(root, relPath);
  const content = await readFileContent(abs);
  const { fm } = parseFrontmatter(content);
  const name = fm.name ?? basename(relPath, extname(relPath));

  const draft: ImportedAsset = {
    sourcePath: relPath.replace(/\.(md|mdc)$/i, ""),
    name,
    type: "skill",
    description: fm.description ?? "",
    files: [{ path: "SKILL.md", content }],
    compatibleTools: inferTools(relPath),
    version: "1.0.0",
    tags: fm.tags ?? [],
    originAuthor: null,
    metadata: {},
  };
  return [{ ...draft, metadata: extractMetadata(draft) }];
}

/**
 * Extract a single directory skill. The directory must contain a root-level
 * `SKILL.md`; otherwise return empty so the caller can fall back to treating
 * it as a container of skills. Files are kept relative to the skill dir,
 * matching the convention `extractAssetDir` uses for a one-level skill group.
 */
async function extractSingleSkillDir(root: string, relDir: string): Promise<ImportedAsset[]> {
  const abs = join(root, relDir);
  if (!existsSync(abs)) return [];
  const filesRel = await walkFiles(abs, abs);
  if (filesRel.length === 0) return [];

  const skillMd = filesRel.find((f) => f.toLowerCase() === "skill.md");
  if (!skillMd) return [];

  const content = await readFileContent(join(abs, skillMd));
  const { fm } = parseFrontmatter(content);
  const name = fm.name ?? basename(relDir);

  const allAssetFiles: { path: string; content: string }[] = [];
  for (const f of filesRel) {
    allAssetFiles.push({ path: f, content: await readFileContent(join(abs, f)) });
  }

  const draft: ImportedAsset = {
    sourcePath: relDir,
    name,
    type: "skill",
    description: fm.description ?? "",
    files: allAssetFiles,
    compatibleTools: inferTools(join(relDir, skillMd)),
    version: "1.0.0",
    tags: fm.tags ?? [],
    originAuthor: null,
    metadata: {},
  };
  return [{ ...draft, metadata: extractMetadata(draft) }];
}

/**
 * Extract skill(s) from a single manifest-declared path.
 *
 * Plugin manifests list skill paths explicitly (e.g.
 * `"./skills/engineering/ask-matt"`). Each entry is one of:
 *   - A markdown file (`.md`/`.mdc`) → a flat single-file skill.
 *   - A directory with a root-level `SKILL.md` → a single directory skill.
 *   - A directory without a root-level `SKILL.md` (e.g. `./skills`) → a
 *     container of skills; fall back to the standard scan so each one-level
 *     child is extracted as its own skill.
 *
 * `relPath` is resolved against `root`; a path escaping `root` is rejected so
 * a malicious manifest can't read outside the plugin directory.
 */
export async function extractSkillPath(root: string, relPath: string): Promise<ImportedAsset[]> {
  const normalized = relPath.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  if (!normalized) return [];

  const abs = resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + sep)) return [];

  const st = await statOrNull(abs);
  if (!st) return [];

  if (st.isFile()) {
    const ext = extname(abs).toLowerCase();
    if (ext !== ".md" && ext !== ".mdc") return [];
    return extractFlatSkillFile(root, normalized);
  }
  if (!st.isDirectory()) return [];

  const single = await extractSingleSkillDir(root, normalized);
  if (single.length > 0) return single;
  return extractAssetDir(root, normalized, "skill");
}

/**
 * Extract a single markdown file as a command/agent/rule asset. Mirrors how
 * `extractAssetDir` renders a flat top-level `.md` group (frontmatter for
 * name/description, file kept as its basename), so declared single-file paths
 * produce assets indistinguishable from those found by the default scan.
 */
async function extractSingleMarkdownAsset(
  root: string,
  relPath: string,
  type: AssetType,
): Promise<ImportedAsset[]> {
  const abs = join(root, relPath);
  const content = await readFileContent(abs);
  const { fm } = parseFrontmatter(content);
  const name = fm.name ?? basename(relPath, extname(relPath));

  const draft: ImportedAsset = {
    sourcePath: relPath,
    name,
    type,
    description: fm.description ?? "",
    files: [{ path: basename(relPath), content }],
    compatibleTools: inferTools(relPath),
    version: "1.0.0",
    tags: fm.tags ?? [],
    originAuthor: null,
    metadata: {},
  };
  return [{ ...draft, metadata: extractMetadata(draft) }];
}

/**
 * Extract asset(s) from a single manifest-declared path. Dispatches by type:
 *   - `skill`   : flat `.md` → single skill; dir with root `SKILL.md` → single
 *                 skill; dir without → container scan (see `extractSkillPath`).
 *   - `command` / `agent` / `rule` : `.md` file → single asset; directory →
 *                 container scan via `extractAssetDir`.
 *
 * `relPath` is resolved against `root` with an escape guard.
 */
export async function extractDeclaredAssetPath(
  root: string,
  relPath: string,
  type: AssetType,
): Promise<ImportedAsset[]> {
  const normalized = relPath.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  if (!normalized) return [];

  const abs = resolve(root, normalized);
  if (abs !== root && !abs.startsWith(root + sep)) return [];

  if (type === "skill") return extractSkillPath(root, normalized);

  const st = await statOrNull(abs);
  if (!st) return [];
  if (st.isFile()) return extractSingleMarkdownAsset(root, normalized, type);
  if (st.isDirectory()) return extractAssetDir(root, normalized, type);
  return [];
}

/**
 * Parse a hooks registry object — the official Claude Code `hooks.json` shape —
 * into one Loom hook asset per (event, entry). Accepts both the file form
 * `{hooks: {<Event>: [{matcher?, hooks: [...]}]}}` and the inline manifest form
 * `{<Event>: [...]}` (no `hooks` wrapper); see
 * https://code.claude.com/docs/zh-CN/plugins-reference#component-path-fields.
 *
 * Each result maps onto Loom's per-bundle `HookMetadata` model
 * ({event, matcher?, hooks}). `sourceLabel` prefixes `sourcePath` so callers
 * can dedupe (e.g. `hooks/hooks.json#PostToolUse.0` vs `plugin.json#hooks.…`).
 */
function parseHooksRegistry(obj: unknown, sourceLabel: string): ImportedAsset[] {
  if (typeof obj !== "object" || obj === null) return [];
  const raw = obj as Record<string, unknown>;
  // File form wraps the event map under `hooks`; inline manifest form is the
  // event map itself. Honor both.
  const eventMap =
    raw.hooks && typeof raw.hooks === "object" && !Array.isArray(raw.hooks)
      ? (raw.hooks as Record<string, unknown>)
      : raw;

  const out: ImportedAsset[] = [];
  for (const [event, entries] of Object.entries(eventMap)) {
    if (!HOOK_EVENT_SET.has(event)) continue;
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, i) => {
      if (typeof entry !== "object" || entry === null) return;
      const e = entry as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(e.hooks) || e.hooks.length === 0) return;
      if (!e.hooks.every((h) => typeof (h as any)?.type === "string")) return;
      const matcher = typeof e.matcher === "string" ? e.matcher : undefined;
      const name = entries.length === 1 ? event : `${event}-${i + 1}`;
      const metadata: AssetMetadata = {
        event,
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: e.hooks as any,
      };
      out.push({
        sourcePath: `${sourceLabel}#${event}.${i}`,
        name,
        type: "hook",
        description: "",
        // Official hooks.json is a single shared file with no per-hook script
        // bundle;附属 scripts live elsewhere (referenced via
        // ${CLAUDE_PLUGIN_ROOT}) and are not part of the hook asset.
        files: [],
        compatibleTools: ["claudecode", "codebuddy", "codex"],
        version: "1.0.0",
        tags: [],
        originAuthor: null,
        metadata,
      });
    });
  }
  return out;
}

/** Read and parse an official `hooks.json` file into hook assets. */
export async function extractHooksFile(root: string, relPath: string): Promise<ImportedAsset[]> {
  const normalized = relPath.replace(/^\.\//, "").replace(/\\/g, "/");
  const abs = join(root, normalized);
  if (!existsSync(abs)) return [];
  let parsed: any;
  try { parsed = JSON.parse(await readFile(abs, "utf8")); } catch { return []; }
  return parseHooksRegistry(parsed, normalized);
}

/** Parse an inline manifest `hooks` object into hook assets. */
export function extractHooksInline(obj: unknown, sourceLabel: string): ImportedAsset[] {
  return parseHooksRegistry(obj, sourceLabel);
}

/**
 * Parse an MCP servers map `{<name>: {command|url, ...}}` into one MCP asset
 * per server. Shared by the file reader and the inline manifest form.
 */
function parseMcpServers(servers: unknown, sourceLabel: string): ImportedAsset[] {
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
  const out: ImportedAsset[] = [];
  for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof def !== "object" || def === null) continue;
    const draft: ImportedAsset = {
      sourcePath: `${sourceLabel}#${name}`,
      name,
      type: "mcp",
      description: (def as any).description ?? "",
      files: [{ path: `${name}.json`, content: JSON.stringify(def, null, 2) }],
      compatibleTools: inferTools(sourceLabel),
      version: "1.0.0",
      tags: [],
      originAuthor: null,
      metadata: {},
    };
    out.push({ ...draft, metadata: extractMetadata(draft) });
  }
  return out;
}

/** Parse an inline manifest `mcpServers` object into MCP assets. */
export function extractMcpInline(servers: unknown, sourceLabel: string): ImportedAsset[] {
  return parseMcpServers(servers, sourceLabel);
}

/**
 * Extract a root-level `SKILL.md` as a single skill — the official
 * single-skill-plugin layout (plugin root has `SKILL.md`, no `skills/`
 * subdir, no `skills` manifest field). Only the `SKILL.md` file is bundled;
 * sibling root files are not part of the skill. Name comes from frontmatter,
 * falling back to the plugin directory basename per the spec.
 */
export async function extractRootSkill(root: string, fallbackName: string): Promise<ImportedAsset[]> {
  const abs = join(root, "SKILL.md");
  if (!existsSync(abs)) return [];
  const content = await readFileContent(abs);
  const { fm } = parseFrontmatter(content);
  const dirBase = basename(root);
  const name = fm.name ?? (dirBase || fallbackName);
  const draft: ImportedAsset = {
    sourcePath: "SKILL.md",
    name,
    type: "skill",
    description: fm.description ?? "",
    files: [{ path: "SKILL.md", content }],
    compatibleTools: inferTools("SKILL.md"),
    version: "1.0.0",
    tags: fm.tags ?? [],
    originAuthor: null,
    metadata: {},
  };
  return [{ ...draft, metadata: extractMetadata(draft) }];
}

export const genericGitProvider: SourceProvider = {
  kind: "generic-git",
  async parse(localPath: string): Promise<ProviderResult> {
    const assets: ImportedAsset[] = [];

    assets.push(...(await extractAssetDir(localPath, "skills", "skill")));
    assets.push(...(await extractAssetDir(localPath, "rules", "rule")));
    assets.push(...(await extractAssetDir(localPath, "agents", "agent")));
    assets.push(...(await extractAssetDir(localPath, "commands", "command")));
    assets.push(...(await extractStandardHooks(localPath)));
    // Official Claude Code hook default location: a single `hooks/hooks.json`
    // (event-grouped), distinct from the Loom-native `hooks/<name>/hook.json`
    // directory bundles scanned above.
    assets.push(...(await extractHooksFile(localPath, "hooks/hooks.json")));

    for (const f of [".mcp.json", "mcp.json"]) {
      if (await statOrNull(join(localPath, f))) {
        assets.push(...(await extractMcpFile(localPath, f)));
        break;
      }
    }

    return {
      displayName: "",
      description: "",
      originAuthor: null,
      assets,
      plugins: [],
      childSources: [],
    };
  },
};
