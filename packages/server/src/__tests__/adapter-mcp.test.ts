import { describe, it, expect } from "vitest";
import {
  ClaudeCodeAdapter,
  CodeBuddyAdapter,
  CodexAdapter,
  CursorAdapter,
  mergeMcpServers,
} from "@maolinc/cc-loom-adapter";
import type { Manifest, ManifestAssetEntry } from "@maolinc/cc-loom-shared";

function mcpAsset(name: string, content: string): ManifestAssetEntry {
  return {
    assetId: name,
    name,
    type: "mcp",
    version: "1.0.0",
    files: [{ path: `${name}.json`, content }],
    compatibleTools: ["cursor", "claudecode", "codebuddy", "codex"],
    metadata: {},
  };
}

function manifest(assets: ManifestAssetEntry[]): Manifest {
  return {
    workspaceId: "ws1",
    workspaceName: "ws1",
    version: "1",
    targetTools: ["cursor", "claudecode", "codebuddy", "codex"],
    assets,
  };
}

describe("MCP output shape", () => {
  // marketplace 的 generic-git provider 把每个 mcpServers[name] 抽成单 asset，content 是裸 def
  const SINGLE = mcpAsset(
    "filesystem",
    JSON.stringify({ command: "npx", args: ["@modelcontextprotocol/server-filesystem", "/tmp"] }),
  );
  // 用户上传：标准包装
  const WRAPPED = mcpAsset(
    "github",
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      },
    }),
  );

  it("Cursor writes <targetDir>/mcp.json wrapped in mcpServers", () => {
    const out = new CursorAdapter().generate(manifest([SINGLE, WRAPPED]));
    const f = out.files.find((x) => x.path === ".cursor/mcp.json")!;
    expect(f).toBeDefined();
    expect(f.mergeStrategy).toBe("mcp-servers");
    const data = JSON.parse(f.content);
    expect(Object.keys(data)).toEqual(["mcpServers"]);
    expect(Object.keys(data.mcpServers).sort()).toEqual(["filesystem", "github"]);
    expect(data.mcpServers.filesystem.command).toBe("npx");
    expect(data.mcpServers.github.args).toContain("-y");
  });

  it("ClaudeCode writes .mcp.json at project root, NOT inside .claude/", () => {
    const out = new ClaudeCodeAdapter().generate(manifest([SINGLE, WRAPPED]));
    expect(out.files.some((f) => f.path === ".claude/mcp.json")).toBe(false);
    const f = out.files.find((x) => x.path === ".mcp.json")!;
    expect(f).toBeDefined();
    expect(f.mergeStrategy).toBe("mcp-servers");
    const data = JSON.parse(f.content);
    expect(Object.keys(data.mcpServers).sort()).toEqual(["filesystem", "github"]);
  });

  it("CodeBuddy writes .codebuddy/mcp.json", () => {
    const out = new CodeBuddyAdapter().generate(manifest([SINGLE]));
    const f = out.files.find((x) => x.path === ".codebuddy/mcp.json")!;
    expect(f.mergeStrategy).toBe("mcp-servers");
    expect(JSON.parse(f.content).mcpServers.filesystem).toBeDefined();
  });

  it("Codex writes .codex/mcp.json", () => {
    const out = new CodexAdapter().generate(manifest([SINGLE]));
    const f = out.files.find((x) => x.path === ".codex/mcp.json")!;
    expect(f.mergeStrategy).toBe("mcp-servers");
  });

  it("two single-form MCP assets do not collide (each keyed by asset.name)", () => {
    const a = mcpAsset("filesystem", JSON.stringify({ command: "npx", args: ["fs"] }));
    const b = mcpAsset("github", JSON.stringify({ command: "npx", args: ["gh"] }));
    const out = new CursorAdapter().generate(manifest([a, b]));
    const data = JSON.parse(out.files.find((f) => f.path === ".cursor/mcp.json")!.content);
    expect(data.mcpServers.filesystem.args).toEqual(["fs"]);
    expect(data.mcpServers.github.args).toEqual(["gh"]);
  });

  it("invalid JSON content falls back to raw string under asset name (debuggable)", () => {
    const broken = mcpAsset("weird", "not valid json {{{");
    const out = new CursorAdapter().generate(manifest([broken]));
    const data = JSON.parse(out.files.find((f) => f.path === ".cursor/mcp.json")!.content);
    expect(data.mcpServers.weird).toBe("not valid json {{{");
  });
});

describe("mergeMcpServers", () => {
  it("preserves user-only servers and updates same-name servers from incoming", () => {
    const existing = JSON.stringify({
      mcpServers: {
        "user-private": { command: "node", args: ["my.js"] },
        "filesystem": { command: "old" },
      },
    });
    const incoming = JSON.stringify({
      mcpServers: {
        "filesystem": { command: "npx", args: ["@modelcontextprotocol/server-filesystem", "/tmp"] },
      },
    });
    const merged = JSON.parse(mergeMcpServers(existing, incoming));
    expect(merged.mcpServers["user-private"]).toEqual({ command: "node", args: ["my.js"] });
    expect(merged.mcpServers.filesystem.command).toBe("npx");
  });

  it("empty existing yields incoming verbatim", () => {
    const incoming = JSON.stringify({ mcpServers: { x: { command: "x" } } });
    const merged = JSON.parse(mergeMcpServers("", incoming));
    expect(merged.mcpServers.x.command).toBe("x");
  });

  it("invalid existing JSON treated as empty", () => {
    const incoming = JSON.stringify({ mcpServers: { x: { command: "x" } } });
    const merged = JSON.parse(mergeMcpServers("not json", incoming));
    expect(merged.mcpServers.x.command).toBe("x");
  });

  it("tolerates legacy un-wrapped existing (top-level server dict)", () => {
    const existing = JSON.stringify({ filesystem: { command: "old" } });
    const incoming = JSON.stringify({ mcpServers: { github: { command: "new" } } });
    const merged = JSON.parse(mergeMcpServers(existing, incoming));
    // un-wrapped existing 提取后等价于 mcpServers={filesystem:{...}}，与 github 合并
    expect(merged.mcpServers.filesystem).toEqual({ command: "old" });
    expect(merged.mcpServers.github).toEqual({ command: "new" });
  });

  it("preserves non-mcpServers top-level fields in existing", () => {
    const existing = JSON.stringify({ mcpServers: { a: { command: "a" } }, foo: "bar" });
    const incoming = JSON.stringify({ mcpServers: { b: { command: "b" } } });
    const merged = JSON.parse(mergeMcpServers(existing, incoming));
    expect(merged.foo).toBe("bar");
    expect(Object.keys(merged.mcpServers).sort()).toEqual(["a", "b"]);
  });
});
