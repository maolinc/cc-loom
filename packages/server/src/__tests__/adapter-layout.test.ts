/**
 * Path-resolution rules for asset → install paths. The single source of truth
 * is `isAssetDirLayout(asset)`; both the adapter and the web UI consume it.
 *
 * Domain rules this guards against:
 *   1. A skill is ALWAYS a directory (`skills/<name>/SKILL.md`). It must never
 *      be flattened/renamed to `skills/<name>.md` — a loose `skills/x.md` is
 *      just a file, not a skill.
 *   2. A flat single-file type (rule / command / agent) is renamed to
 *      `<typeDir>/<slugify(name)>.md` so multiple flat assets don't clobber.
 */
import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "@maolinc/cc-loom-adapter";
import { isAssetDirLayout } from "@maolinc/cc-loom-shared";
import type { Manifest, ManifestAssetEntry } from "@maolinc/cc-loom-shared";

function asset(partial: Partial<ManifestAssetEntry> & Pick<ManifestAssetEntry, "name" | "type" | "files">): ManifestAssetEntry {
  return {
    assetId: partial.name,
    version: "1.0.0",
    compatibleTools: ["claudecode"],
    metadata: {} as ManifestAssetEntry["metadata"],
    ...partial,
  };
}

function manifestOf(assets: ManifestAssetEntry[]): Manifest {
  return {
    workspaceId: "ws",
    workspaceName: "ws",
    version: "1",
    targetTools: ["claudecode"],
    assets,
  };
}

describe("isAssetDirLayout", () => {
  it("returns true for hook regardless of sourcePath / file count", () => {
    expect(isAssetDirLayout({ type: "hook", files: [{ path: "hook.json" }] })).toBe(true);
    expect(isAssetDirLayout({ type: "hook", sourcePath: "anything.md", files: [] })).toBe(true);
  });

  it("returns false for mcp", () => {
    expect(isAssetDirLayout({ type: "mcp", files: [{ path: "x.json" }] })).toBe(false);
  });

  it("skill is ALWAYS directory layout (sourcePath / file count irrelevant)", () => {
    expect(isAssetDirLayout({ type: "skill", sourcePath: "skills/foo", files: [{ path: "SKILL.md" }] })).toBe(true);
    // even with an extensioned sourcePath or a single file, a skill is a dir
    expect(isAssetDirLayout({ type: "skill", sourcePath: "skills/coding-style.md", files: [{ path: "SKILL.md" }] })).toBe(true);
    expect(isAssetDirLayout({ type: "skill", sourcePath: null, files: [{ path: "SKILL.md" }] })).toBe(true);
  });

  it("treats sourcePath without trailing extension as directory layout (rule/command/agent)", () => {
    expect(isAssetDirLayout({
      type: "command",
      sourcePath: "commands/review",
      files: [{ path: "review.md" }],
    })).toBe(true);
  });

  it("treats sourcePath with trailing extension as flat layout (rule/command/agent)", () => {
    expect(isAssetDirLayout({
      type: "rule",
      sourcePath: "rules/no-console.md",
      files: [{ path: "no-console.md" }],
    })).toBe(false);
  });

  it("falls back to file-count when sourcePath is missing (locally-built single-file type)", () => {
    expect(isAssetDirLayout({
      type: "rule",
      sourcePath: null,
      files: [{ path: "a.md" }],
    })).toBe(false);
    expect(isAssetDirLayout({
      type: "rule",
      sourcePath: null,
      files: [{ path: "a.md" }, { path: "b.md" }],
    })).toBe(true);
  });
});

describe("BaseAdapter install paths", () => {
  it("installs a single-file skill under <name>/SKILL.md (never flat)", () => {
    const out = new ClaudeCodeAdapter().generate(manifestOf([
      asset({
        name: "requesting-code-review",
        type: "skill",
        sourcePath: "skills/requesting-code-review",
        files: [{ path: "SKILL.md", content: "# review" }],
      }),
    ]));
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain(".claude/skills/requesting-code-review/SKILL.md");
    expect(paths).not.toContain(".claude/skills/requesting-code-review.md");
  });

  it("preserves nested paths for multi-file skill", () => {
    const out = new ClaudeCodeAdapter().generate(manifestOf([
      asset({
        name: "brainstorming",
        type: "skill",
        sourcePath: "skills/brainstorming",
        files: [
          { path: "SKILL.md", content: "x" },
          { path: "examples/session.md", content: "y" },
        ],
      }),
    ]));
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      ".claude/skills/brainstorming/SKILL.md",
      ".claude/skills/brainstorming/examples/session.md",
    ]);
  });

  it("skill with a locally-built single file (no sourcePath) still installs as <name>/SKILL.md", () => {
    const out = new ClaudeCodeAdapter().generate(manifestOf([
      asset({
        name: "my-skill",
        type: "skill",
        sourcePath: null,
        files: [{ path: "SKILL.md", content: "x" }],
      }),
    ]));
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain(".claude/skills/my-skill/SKILL.md");
    expect(paths).not.toContain(".claude/skills/my-skill.md");
  });

  it("renames a flat single-file type (command) to <slugify(name)>.md", () => {
    const out = new ClaudeCodeAdapter().generate(manifestOf([
      asset({
        name: "Code Review",
        type: "command",
        sourcePath: "commands/code-review.md",
        files: [{ path: "code-review.md", content: "x" }],
        metadata: { trigger: "/code-review" } as ManifestAssetEntry["metadata"],
      }),
    ]));
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain(".claude/commands/code-review.md");
  });

  it("local single-file rule without sourcePath stays flat (legacy behaviour)", () => {
    const out = new ClaudeCodeAdapter().generate(manifestOf([
      asset({
        name: "my-rule",
        type: "rule",
        sourcePath: null,
        files: [{ path: "anything.md", content: "x" }],
        metadata: { globs: [] } as ManifestAssetEntry["metadata"],
      }),
    ]));
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain(".claude/rules/my-rule.md");
  });
});
