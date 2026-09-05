import { describe, it, expect } from "vitest";
import { extractMetadata } from "../extract-metadata.js";
import type { ImportedAsset } from "@maolinc/cc-loom-shared";

function asset(partial: Partial<ImportedAsset>): ImportedAsset {
  return {
    sourcePath: "x",
    name: "x",
    type: "skill",
    description: "",
    files: [],
    compatibleTools: [],
    version: "1.0.0",
    tags: [],
    originAuthor: null,
    metadata: {},
    ...partial,
  };
}

function withContent(content: string): Partial<ImportedAsset> {
  return { files: [{ path: "test.md", content }] };
}

describe("extractMetadata", () => {
  it("skill returns empty object", () => {
    expect(extractMetadata(asset({ type: "skill" }))).toEqual({});
  });

  it("agent returns empty object", () => {
    expect(extractMetadata(asset({ type: "agent" }))).toEqual({});
  });

  it("rule extracts globs from frontmatter", () => {
    const content = "---\nglobs: [\"**/*.tsx\", \"**/*.css\"]\n---\nbody";
    expect(extractMetadata(asset({ type: "rule", ...withContent(content) }))).toEqual({
      globs: ["**/*.tsx", "**/*.css"],
    });
  });

  it("rule without frontmatter returns empty globs", () => {
    expect(extractMetadata(asset({ type: "rule", ...withContent("no fm") }))).toEqual({
      globs: [],
    });
  });

  it("rule with frontmatter but no globs returns empty globs", () => {
    const content = "---\ndescription: foo\n---\nbody";
    expect(extractMetadata(asset({ type: "rule", ...withContent(content) }))).toEqual({
      globs: [],
    });
  });

  it("mcp stdio: extracts transport + command from JSON", () => {
    const content = JSON.stringify({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    });
    expect(extractMetadata(asset({ type: "mcp", ...withContent(content) }))).toEqual({
      transport: "stdio",
      command: "npx -y @modelcontextprotocol/server-filesystem",
    });
  });

  it("mcp stdio: command without args", () => {
    const content = JSON.stringify({ command: "node server.js" });
    expect(extractMetadata(asset({ type: "mcp", ...withContent(content) }))).toEqual({
      transport: "stdio",
      command: "node server.js",
    });
  });

  it("mcp sse: extracts url + sse transport when type='sse'", () => {
    const content = JSON.stringify({ type: "sse", url: "https://x.example/sse" });
    expect(extractMetadata(asset({ type: "mcp", ...withContent(content) }))).toEqual({
      transport: "sse",
      url: "https://x.example/sse",
    });
  });

  it("mcp http: extracts url + http transport by default", () => {
    const content = JSON.stringify({ url: "https://x.example/mcp" });
    expect(extractMetadata(asset({ type: "mcp", ...withContent(content) }))).toEqual({
      transport: "http",
      url: "https://x.example/mcp",
    });
  });

  it("mcp invalid JSON falls back to stdio with no command", () => {
    expect(extractMetadata(asset({ type: "mcp", ...withContent("not json") }))).toEqual({
      transport: "stdio",
    });
  });

  it("hook passes through provider-supplied metadata unchanged", () => {
    const md = {
      event: "PreToolUse",
      matcher: "Bash",
      hooks: [{ type: "command", command: "audit.sh", timeout: 10 }],
    };
    const a = asset({ type: "hook", metadata: md });
    expect(extractMetadata(a)).toEqual(md);
  });

  it("hook without matcher is preserved verbatim", () => {
    const md = {
      event: "UserPromptSubmit",
      hooks: [{ type: "command", command: "hint.sh" }],
    };
    const a = asset({ type: "hook", metadata: md });
    expect(extractMetadata(a)).toEqual(md);
  });

  it("command derives trigger from name", () => {
    expect(extractMetadata(asset({ type: "command", name: "lint" }))).toEqual({
      trigger: "/lint",
    });
  });

  it("command with name containing slash keeps slash form", () => {
    expect(extractMetadata(asset({ type: "command", name: "fix-bug" }))).toEqual({
      trigger: "/fix-bug",
    });
  });
});
