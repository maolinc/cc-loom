/**
 * 厂商目录解析器 —— 读取本地 `.cursor/` / `.codebuddy/` / `.codex/` / `.claude/`
 * 目录，将其中的能力文件解析为 `ImportedAsset[]`，供 `loom push` 发送给 Server。
 *
 * 解析逻辑参照 `packages/server/src/marketplace/providers/generic-git.ts`，
 * 但适配 CLI 上下文：
 * - `compatibleTools` 固定为推送的厂商（内容来自该厂商目录）。
 * - ClaudeCode 的 MCP 在项目根 `.mcp.json`，而非 `.claude/mcp.json`。
 * - 二进制文件使用 `encoding: "base64"`，而非 data URI。
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname, relative, sep } from "node:path";
import type {
  TargetTool,
  ImportedAsset,
  AssetType,
  AssetMetadata,
  AssetFileInput,
} from "@maolinc/cc-loom-shared";
import { HOOK_EVENTS } from "@maolinc/cc-loom-shared";

// ---- frontmatter 解析（与 generic-git.ts 一致）----

interface Frontmatter {
  description?: string;
  tags?: string[];
  name?: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const fm: Frontmatter = {};
  const body = m[2] ?? "";
  const lines = (m[1] ?? "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const idx = line.indexOf(":");
    if (idx === -1 || /^\s/.test(line)) { i++; continue; }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value === "|" || value === ">") {
      const folded = value === ">";
      i++;
      const collected: string[] = [];
      while (i < lines.length && /^\s/.test(lines[i]!)) {
        collected.push(lines[i]!.replace(/^\s+/, ""));
        i++;
      }
      (fm as any)[key] = folded ? collected.join(" ") : collected.join("\n");
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      const arr = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      (fm as any)[key] = arr;
    } else {
      value = value.replace(/^["']|["']$/g, "");
      (fm as any)[key] = value;
    }
    i++;
  }
  return { fm, body };
}

// ---- 文件读取 ----

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdc", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml",
  ".js", ".ts", ".jsx", ".tsx", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".css", ".scss", ".less", ".html", ".htm",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
  ".env", ".gitignore", ".dockerignore", ".editorconfig",
  ".csv", ".tsv", ".log", ".sql", ".graphql", ".vue", ".svelte", ".svg",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".gz", ".tar", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
]);

async function readFileContent(absPath: string): Promise<{ content: string; encoding?: "base64" }> {
  const ext = extname(absPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return { content: await readFile(absPath, "utf8") };
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    const buf = await readFile(absPath);
    return { content: buf.toString("base64"), encoding: "base64" };
  }
  // Unknown: try UTF-8, fall back to base64 if null bytes present
  try {
    const buf = await readFile(absPath);
    if (buf.includes(0)) {
      return { content: buf.toString("base64"), encoding: "base64" };
    }
    return { content: buf.toString("utf8") };
  } catch {
    return { content: "" };
  }
}

// ---- 目录遍历 ----

/** Windows 上 path.relative 返回 "\\" 分隔路径；下游 extractAssetDir 的 "/" 前缀/split 判断
 * 全部假设 POSIX 分隔符，这里统一转换，否则 Windows 上一个资产都解析不出来。 */
function toPosixRel(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

async function walkFiles(dir: string, root: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkFiles(full, root)));
    } else if (e.isFile()) {
      out.push(toPosixRel(relative(root, full)));
    }
  }
  return out;
}

// ---- metadata 提取（与 server/marketplace/extract-metadata.ts 一致）----

function readGlobs(content: string): string[] {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return [];
  for (const line of (m[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== "globs") continue;
    const value = line.slice(idx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      return value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
  }
  return [];
}

function extractMetadata(asset: ImportedAsset): AssetMetadata {
  const primary = asset.files[0]?.content ?? "";
  try {
    switch (asset.type) {
      case "skill":
      case "agent":
        return {};
      case "rule":
        return { globs: readGlobs(primary) };
      case "mcp":
        return mcpMetadata(primary);
      case "hook":
        return asset.metadata;
      case "command":
        return { trigger: `/${asset.name}` };
      default:
        return {};
    }
  } catch {
    switch (asset.type) {
      case "rule": return { globs: [] };
      case "mcp": return { transport: "stdio" };
      case "hook": return { event: "", hooks: [] };
      case "command": return { trigger: `/${asset.name}` };
      default: return {};
    }
  }
}

function mcpMetadata(content: string): AssetMetadata {
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { return { transport: "stdio" }; }
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.url === "string") {
      const transport = parsed.type === "sse" ? "sse" : "http";
      return { transport, url: parsed.url };
    }
    if (typeof parsed.command === "string") {
      const args = Array.isArray(parsed.args) ? parsed.args : [];
      const cmd = [parsed.command, ...args].join(" ").trim();
      return { transport: "stdio", command: cmd };
    }
  }
  return { transport: "stdio" };
}

// ---- 类型目录解析 ----

async function extractAssetDir(
  root: string,
  relDir: string,
  type: AssetType,
  compatibleTools: TargetTool[],
): Promise<ImportedAsset[]> {
  const abs = join(root, relDir);
  if (!existsSync(abs)) return [];
  const allFiles = await walkFiles(abs, root);

  const prefix = relDir + "/";
  const relFiles = allFiles.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
  if (relFiles.length === 0) return [];

  // Group by top-level segment
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
    const mdFiles = groupFiles.filter((f) => {
      const ext = extname(f).toLowerCase();
      return ext === ".md" || ext === ".mdc";
    });
    const primaryIdx = mdFiles.findIndex((f) => basename(f).toLowerCase() === "skill.md");
    const primary = primaryIdx >= 0 ? mdFiles[primaryIdx]! : (mdFiles.length > 0 ? mdFiles[0]! : groupFiles[0]!);

    const primaryExt = extname(primary).toLowerCase();
    let fm: Frontmatter = {};
    if (primaryExt === ".md" || primaryExt === ".mdc") {
      const { content } = await readFileContent(join(root, relDir, primary));
      ({ fm } = parseFrontmatter(content));
    }

    const name = fm.name ?? (
      groupFiles.some((f) => f.includes("/"))
        ? groupKey
        : basename(primary, extname(primary))
    );

    const allAssetFiles: AssetFileInput[] = [];
    for (const f of groupFiles) {
      const { content, encoding } = await readFileContent(join(root, relDir, f));
      const displayPath = groupFiles.length > 1 && f.startsWith(groupKey + "/")
        ? f.slice(groupKey.length + 1)
        : basename(f);
      allAssetFiles.push({ path: displayPath, content, ...(encoding ? { encoding } : {}) });
    }

    let files = allAssetFiles;
    let sourcePath = `${relDir}/${groupKey}`;

    // 合法 skill 必须符合规范，否则跳过：目录式（含根级 SKILL.md）或松散 markdown
    // （skills/<name>.md，规范化为 SKILL.md）。非 markdown 的松散文件（如 llms.txt）、
    // 缺 SKILL.md 的目录、以及 `skills/<cat>/<name>/SKILL.md` 这类深层嵌套（默认扫描
    // 只认一层）都不是 skill，不能被伪造导入。用原始 relPath 判定 SKILL.md 是否为
    // group 的直接子文件，避免 displayPath 对单文件 group 折叠成 basename 造成的误判。
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
      compatibleTools,
      version: "1.0.0",
      tags: fm.tags ?? [],
      originAuthor: null,
      metadata: {},
    };
    out.push({ ...draft, metadata: extractMetadata(draft) });
  }
  return out;
}

// ---- hooks 解析 ----

const HOOK_EVENT_SET = new Set<string>(HOOK_EVENTS);

async function extractStandardHooks(
  root: string,
  compatibleTools: TargetTool[],
): Promise<ImportedAsset[]> {
  const hooksRoot = join(root, "hooks");
  if (!existsSync(hooksRoot)) return [];
  const entries = await readdir(hooksRoot, { withFileTypes: true });
  const out: ImportedAsset[] = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const hookDir = join(hooksRoot, ent.name);
    const manifestPath = join(hookDir, "hook.json");
    if (!existsSync(manifestPath)) continue;

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

    const files: AssetFileInput[] = [];
    const walked = await walkFiles(hookDir, hookDir);
    for (const rel of walked) {
      const { content, encoding } = await readFileContent(join(hookDir, rel));
      files.push({ path: rel, content, ...(encoding ? { encoding } : {}) });
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
      compatibleTools,
      version: "1.0.0",
      tags: [],
      originAuthor: null,
      metadata,
    });
  }
  return out;
}

// ---- MCP 解析 ----

async function extractMcp(
  absPath: string,
  relPath: string,
  compatibleTools: TargetTool[],
): Promise<ImportedAsset[]> {
  if (!existsSync(absPath)) return [];
  const raw = await readFile(absPath, "utf8");
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const servers = parsed.mcpServers ?? parsed.servers ?? parsed;
  if (typeof servers !== "object" || servers === null) return [];

  const out: ImportedAsset[] = [];
  const normalizedRel = relPath.split("\\").join("/");
  for (const [name, def] of Object.entries(servers)) {
    if (typeof def !== "object" || def === null) continue;
    const draft: ImportedAsset = {
      sourcePath: `${normalizedRel}#${name}`,
      name,
      type: "mcp",
      description: (def as any).description ?? "",
      files: [{ path: `${name}.json`, content: JSON.stringify(def, null, 2) }],
      compatibleTools,
      version: "1.0.0",
      tags: [],
      originAuthor: null,
      metadata: {},
    };
    out.push({ ...draft, metadata: extractMetadata(draft) });
  }
  return out;
}

// ---- 主入口 ----

/**
 * 解析厂商目录，返回其中的能力资产列表。
 *
 * @param vendorPath  厂商目录绝对路径（如 `/project/.claude`）
 * @param tool        厂商标识（决定 compatibleTools 和 MCP 文件位置）
 * @param projectRoot 项目根目录（ClaudeCode 的 .mcp.json 在项目根）
 */
export async function parseVendorDir(
  vendorPath: string,
  tool: TargetTool,
  projectRoot: string,
): Promise<ImportedAsset[]> {
  const compatibleTools: TargetTool[] = [tool];
  const assets: ImportedAsset[] = [];

  assets.push(...(await extractAssetDir(vendorPath, "skills", "skill", compatibleTools)));
  assets.push(...(await extractAssetDir(vendorPath, "rules", "rule", compatibleTools)));
  assets.push(...(await extractAssetDir(vendorPath, "agents", "agent", compatibleTools)));
  assets.push(...(await extractAssetDir(vendorPath, "commands", "command", compatibleTools)));
  assets.push(...(await extractStandardHooks(vendorPath, compatibleTools)));

  // MCP: claudecode 在项目根 .mcp.json；其他厂商在 vendor/mcp.json
  if (tool === "claudecode") {
    const rootMcp = join(projectRoot, ".mcp.json");
    if (existsSync(rootMcp)) {
      assets.push(...(await extractMcp(rootMcp, ".mcp.json", compatibleTools)));
    }
  } else {
    const vendorMcp = join(vendorPath, "mcp.json");
    if (existsSync(vendorMcp)) {
      assets.push(...(await extractMcp(vendorMcp, "mcp.json", compatibleTools)));
    }
  }

  return assets;
}
