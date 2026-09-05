import type { ImportedAsset, AssetMetadata } from "@maolinc/cc-loom-shared";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Minimal frontmatter reader for `key: [...]` array values; mirrors providers/generic-git.ts. */
function readGlobs(content: string): string[] {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return [];
  for (const line of (m[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== "globs") continue;
    const value = line.slice(idx + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      return value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }
  return [];
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

export function extractMetadata(asset: ImportedAsset): AssetMetadata {
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
        // hook 的 metadata 由 provider 直接构造（events / matchers / bundleStrategy 都需要解析时上下文），
        // 这里不再二次推导，原样透传 provider 填好的值。
        return asset.metadata;
      case "command":
        return { trigger: `/${asset.name}` };
      default:
        return {};
    }
  } catch {
    // Defensive: never throw from metadata extraction.
    switch (asset.type) {
      case "rule": return { globs: [] };
      case "mcp": return { transport: "stdio" };
      case "hook": return { event: "", hooks: [] };
      case "command": return { trigger: `/${asset.name}` };
      default: return {};
    }
  }
}
