import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type { AssetType, ImportedAsset, ImportedPlugin, ProviderResult } from "@maolinc/cc-loom-shared";
import type { ProviderParseContext, SourceProvider } from "./types.js";
import { normalizeRepoUrl } from "../url-normalize.js";
import {
  genericGitProvider,
  extractDeclaredAssetPath,
  extractHooksFile,
  extractHooksInline,
  extractMcpFile,
  extractMcpInline,
  extractRootSkill,
} from "./generic-git.js";

/**
 * A plugin entry inside a marketplace.json can declare its source in several
 * forms we observe in real-world repos:
 *   1. Object url form  : { "source": "url", "url": "https://github.com/..." }
 *   2. Object git form  : { "source": "git", "url": "..." }
 *   3. String relative  : "./"   or   "./plugins/foo"
 *   4. Object relative  : { "source": "./plugins/foo" }   (rare but seen)
 *
 * Forms 3 and 4 mean the plugin lives inside this same repository — we should
 * extract it in-place rather than emit a child source.
 */
type PluginSource =
  | string
  | { source?: string; url?: string; ref?: string };

interface MarketplaceJson {
  name: string;
  description?: string;
  owner?: { name?: string; email?: string };
  metadata?: { description?: string; version?: string };
  plugins?: Array<{
    name: string;
    source?: PluginSource;
    description?: string;
    version?: string;
    author?: { name?: string; email?: string };
  }>;
}

/**
 * `plugin.json` shape per the official Claude Code plugin manifest
 * (https://www.schemastore.org/claude-code-plugin-manifest.json). All
 * component path fields are top-level — there is no `components` wrapper in
 * the official schema. `skills`/`commands`/`agents` are string|string[];
 * `hooks`/`mcpServers` are string|array|object (path / list of paths /
 * inline config).
 */
interface PluginJson {
  name: string;
  version?: string;
  description?: string;
  skills?: string | string[];
  commands?: unknown;
  agents?: string | string[];
  hooks?: unknown;
  mcpServers?: unknown;
}

async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

/** Classify a plugin's `source` declaration into one of three modes. */
function classifySource(src: PluginSource | undefined): { kind: "url"; url: string; ref: string | null } | { kind: "local"; relPath: string } | { kind: "unsupported" } {
  if (!src) return { kind: "unsupported" };

  // String form
  if (typeof src === "string") {
    const trimmed = src.trim();
    if (!trimmed) return { kind: "unsupported" };
    // Treat absolute paths as unsupported — plugin sources are always relative
    // to the marketplace repo or a remote URL.
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("git@")) {
      return { kind: "url", url: trimmed, ref: null };
    }
    return { kind: "local", relPath: trimmed };
  }

  // Object form
  if (typeof src.source === "string" && (src.source === "url" || src.source === "git")) {
    if (!src.url) return { kind: "unsupported" };
    return { kind: "url", url: src.url, ref: src.ref ?? null };
  }
  // Object with relative path written in `source`
  if (typeof src.source === "string" && (src.source.startsWith("./") || src.source.startsWith("../") || src.source === ".")) {
    return { kind: "local", relPath: src.source };
  }
  return { kind: "unsupported" };
}

function isCurrentSource(
  sourceUrl: string,
  context: ProviderParseContext | undefined,
): boolean {
  if (!context?.repoUrl) return false;
  return normalizeRepoUrl(sourceUrl) === normalizeRepoUrl(context.repoUrl);
}

async function parseMarketplace(
  localPath: string,
  manifest: MarketplaceJson,
  context?: ProviderParseContext,
): Promise<ProviderResult> {
  const childSources: ProviderResult["childSources"] = [];
  const assets: ImportedAsset[] = [];
  const plugins: ImportedPlugin[] = [];

  for (const p of manifest.plugins ?? []) {
    const cls = classifySource(p.source);
    if (cls.kind === "url") {
      if (isCurrentSource(cls.url, context)) {
        const sub = await extractLocalPlugin(
          localPath,
          {
            name: p.name,
            version: p.version,
            description: p.description,
            originAuthor: p.author?.name ?? manifest.owner?.name ?? null,
          },
          true,
        );
        assets.push(...sub.assets);
        plugins.push(...sub.plugins);
        continue;
      }
      childSources.push({ repoUrl: cls.url, displayName: p.name, ref: cls.ref });
      continue;
    }
    if (cls.kind === "local") {
      // Resolve local plugin directory relative to the marketplace root, with
      // a guard so a malicious manifest can't escape `localPath`.
      const target = isAbsolute(cls.relPath)
        ? cls.relPath
        : resolve(localPath, cls.relPath);
      const within = target === localPath || target.startsWith(localPath + "/");
      if (!within) continue;

      // Extract assets from the local plugin directory in-place. We pass the
      // marketplace plugin entry's metadata (name/version/description/author)
      // so the resulting Workspace is named after the plugin even if the
      // sub-dir lacks its own plugin.json. `isMarketplaceRoot` flags entries
      // whose source resolves to the marketplace root (self-pointing repos),
      // which changes the `skills` add→replace semantics per the spec.
      const sub = await extractLocalPlugin(
        target,
        {
          name: p.name,
          version: p.version,
          description: p.description,
          originAuthor: p.author?.name ?? manifest.owner?.name ?? null,
        },
        target === localPath,
      );
      assets.push(...sub.assets);
      plugins.push(...sub.plugins);
    }
    // unsupported: ignore silently
  }

  return {
    displayName: manifest.name,
    description: manifest.description ?? manifest.metadata?.description ?? "",
    originAuthor: manifest.owner?.name ?? null,
    assets,
    plugins,
    childSources,
  };
}

interface PluginMeta {
  name: string;
  version?: string;
  description?: string;
  originAuthor?: string | null;
}

/** Normalize a `string | string[]` path declaration to a deduped string[]. */
function toStringArray(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of arr) {
    if (typeof p !== "string") continue;
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * `commands` can be string | string[] | object. The object form maps command
 * name → `{ source?, content?, description?, ... }`; each `source` is a path to
 * a `.md` file and the key becomes the slash-command name.
 */
interface CommandDecl { path?: string; name?: string }

function collectCommandDecls(manifest: PluginJson | null): CommandDecl[] {
  if (!manifest || manifest.commands == null) return [];
  const c = manifest.commands;
  if (typeof c === "string") return [{ path: c }];
  if (Array.isArray(c)) {
    return c.filter((p): p is string => typeof p === "string").map((p) => ({ path: p }));
  }
  if (typeof c === "object") {
    const out: CommandDecl[] = [];
    for (const [name, val] of Object.entries(c as Record<string, unknown>)) {
      if (val && typeof val === "object" && typeof (val as any).source === "string") {
        out.push({ path: (val as any).source, name });
      }
    }
    return out;
  }
  return [];
}

/** Parse a manifest `hooks` field (string|array|object) into hook assets. */
async function extractManifestHooks(dir: string, field: unknown): Promise<ImportedAsset[]> {
  if (field == null) return [];
  const out: ImportedAsset[] = [];
  const items = Array.isArray(field) ? field : [field];
  for (const item of items) {
    if (typeof item === "string") {
      out.push(...(await extractHooksFile(dir, item)));
    } else if (item && typeof item === "object") {
      out.push(...extractHooksInline(item, "plugin.json#hooks"));
    }
  }
  return out;
}

/** Parse a manifest `mcpServers` field (string|array|object) into MCP assets. */
async function extractManifestMcp(dir: string, field: unknown): Promise<ImportedAsset[]> {
  if (field == null) return [];
  const out: ImportedAsset[] = [];
  const items = Array.isArray(field) ? field : [field];
  for (const item of items) {
    if (typeof item === "string") {
      // MCPB URL or remote config — not bundled locally; skip.
      if (/^https?:\/\//i.test(item) || item.startsWith("git@")) continue;
      out.push(...(await extractMcpFile(dir, item)));
    } else if (item && typeof item === "object") {
      out.push(...extractMcpInline(item, "plugin.json#mcpServers"));
    }
  }
  return out;
}

/**
 * Extract a plugin from a local directory. Honors the official Claude Code
 * plugin.json manifest
 * (https://code.claude.com/docs/zh-CN/plugins-reference#path-behavior-rules):
 *   - `skills`    : ADD to the default `skills/` scan. Exception: when the
 *                   plugin is a marketplace entry whose `source` resolves to
 *                   the marketplace root (`isMarketplaceRoot`), declared
 *                   subdirs REPLACE the default scan.
 *   - `commands`/`agents` : REPLACE the default scan when declared.
 *   - `hooks`/`mcpServers` : MERGE — default file + manifest declaration(s).
 *   - Root `SKILL.md` with no `skills/` subdir and no `skills` field is loaded
 *     as a single skill (official v2.1.142+ auto single-skill-plugin).
 * Defaults (skills/, commands/, agents/, hooks/hooks.json, hooks/<name>/,
 * .mcp.json) come from `genericGitProvider.parse`. Dedupe is by `sourcePath`.
 */
async function extractLocalPlugin(
  dir: string,
  fallback: PluginMeta,
  isMarketplaceRoot = false,
): Promise<{ assets: ImportedAsset[]; plugins: ImportedPlugin[] }> {
  const pluginManifestPath = join(dir, ".claude-plugin", "plugin.json");
  let meta: PluginMeta = fallback;
  let ownManifest: PluginJson | null = null;
  if (existsSync(pluginManifestPath)) {
    ownManifest = await readJson<PluginJson>(pluginManifestPath);
    meta = {
      name: ownManifest.name ?? fallback.name,
      version: ownManifest.version ?? fallback.version,
      description: ownManifest.description ?? fallback.description,
      originAuthor: fallback.originAuthor,
    };
  }

  const generic = await genericGitProvider.parse(dir);
  let assets: ImportedAsset[] = generic.assets;
  const seen = new Set(assets.map((a) => a.sourcePath));
  const addUnique = (newOnes: ImportedAsset[]) => {
    for (const a of newOnes) {
      if (seen.has(a.sourcePath)) continue;
      seen.add(a.sourcePath);
      assets.push(a);
    }
  };

  // skills — ADD to default (default skills/ scan already ran in `generic`).
  // Marketplace-root exception: when the plugin IS the marketplace root and
  // declares specific skill subdirs, those REPLACE the default skills/ scan
  // (https://code.claude.com/docs/zh-CN/plugin-marketplaces#advanced-plugin-entries).
  const declaredSkills = toStringArray(ownManifest?.skills);
  const hasSkillsDir = existsSync(join(dir, "skills"));
  if (isMarketplaceRoot && declaredSkills.length > 0) {
    assets = assets.filter((a) => a.type !== "skill");
    seen.clear();
    assets.forEach((a) => seen.add(a.sourcePath));
    for (const p of declaredSkills) {
      addUnique(await extractDeclaredAssetPath(dir, p, "skill"));
    }
  } else {
    for (const p of declaredSkills) {
      addUnique(await extractDeclaredAssetPath(dir, p, "skill"));
    }
  }

  // Root SKILL.md single-skill plugin (official v2.1.142+): a plugin with a
  // root SKILL.md, no skills/ subdir, and no skills manifest field auto-loads
  // as one skill. Only applies when nothing else produced a skill.
  if (
    declaredSkills.length === 0 &&
    !hasSkillsDir &&
    existsSync(join(dir, "SKILL.md")) &&
    !assets.some((a) => a.type === "skill")
  ) {
    addUnique(await extractRootSkill(dir, fallback.name));
  }

  // commands — REPLACE default when declared.
  const commandDecls = collectCommandDecls(ownManifest);
  if (commandDecls.length > 0) {
    assets = assets.filter((a) => a.type !== "command");
    seen.clear();
    assets.forEach((a) => seen.add(a.sourcePath));
    for (const decl of commandDecls) {
      if (!decl.path) continue;
      const produced = await extractDeclaredAssetPath(dir, decl.path, "command");
      addUnique(decl.name ? produced.map((a) => ({ ...a, name: decl.name! })) : produced);
    }
  }

  // agents — REPLACE default when declared.
  const agentPaths = toStringArray(ownManifest?.agents);
  if (agentPaths.length > 0) {
    assets = assets.filter((a) => a.type !== "agent");
    seen.clear();
    assets.forEach((a) => seen.add(a.sourcePath));
    for (const p of agentPaths) addUnique(await extractDeclaredAssetPath(dir, p, "agent"));
  }

  // hooks — MERGE (default hooks/hooks.json + Loom-native hooks/<name>/ from
  // `generic` already included; add manifest path/inline declarations).
  addUnique(await extractManifestHooks(dir, ownManifest?.hooks));

  // mcpServers — MERGE (default .mcp.json from `generic` already included;
  // add manifest path/inline declarations).
  addUnique(await extractManifestMcp(dir, ownManifest?.mcpServers));

  assets = assets.map((a) => ({
    ...a,
    version: meta.version ?? a.version,
    originAuthor: meta.originAuthor ?? a.originAuthor,
  }));

  const plugin: ImportedPlugin = {
    pluginName: meta.name,
    description: meta.description ?? "",
    version: meta.version ?? "1.0.0",
    assets,
  };

  return { assets, plugins: [plugin] };
}

async function parsePlugin(localPath: string, manifest: PluginJson): Promise<ProviderResult> {
  const sub = await extractLocalPlugin(localPath, {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    originAuthor: null,
  });
  return {
    displayName: manifest.name,
    description: manifest.description ?? "",
    originAuthor: null,
    assets: sub.assets,
    plugins: sub.plugins,
    childSources: [],
  };
}

export const claudeCodePluginProvider: SourceProvider = {
  kind: "claude-code-plugin",
  async parse(localPath: string, context?: ProviderParseContext): Promise<ProviderResult> {
    const marketplaceFile = join(localPath, ".claude-plugin", "marketplace.json");
    const pluginFile = join(localPath, ".claude-plugin", "plugin.json");

    if (existsSync(marketplaceFile)) {
      const manifest = await readJson<MarketplaceJson>(marketplaceFile);
      return parseMarketplace(localPath, manifest, context);
    }

    if (existsSync(pluginFile)) {
      const manifest = await readJson<PluginJson>(pluginFile);
      return parsePlugin(localPath, manifest);
    }

    throw new Error(`Directory is not a Claude Code marketplace or plugin: ${localPath}`);
  },
};
