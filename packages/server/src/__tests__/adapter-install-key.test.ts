import { describe, it, expect } from "vitest";
import {
  computeInstallKey,
  installKeyToString,
  normalizeAssetName,
} from "@maolinc/cc-loom-adapter";
import type { InstallKeyAsset } from "@maolinc/cc-loom-adapter";
import type { TargetTool } from "@maolinc/cc-loom-shared";

function asset(partial: Partial<InstallKeyAsset> & Pick<InstallKeyAsset, "type">): InstallKeyAsset {
  return {
    name: "demo",
    compatibleTools: ["cursor", "codebuddy", "claudecode", "codex"],
    files: [],
    ...partial,
  };
}

describe("normalizeAssetName", () => {
  it("lowercases, trims and collapses whitespace", () => {
    expect(normalizeAssetName("  My  Skill ")).toBe("my skill");
  });

  it("folds path separators to avoid directory escape", () => {
    expect(normalizeAssetName("foo/bar")).toBe("foo-bar");
    expect(normalizeAssetName("a\\\\b")).toBe("a-b");
  });
});

describe("computeInstallKey — participation gate", () => {
  it("returns null when tool does not support the type (codex + command)", () => {
    expect(computeInstallKey(asset({ type: "command", name: "x" }), "codex")).toBeNull();
  });

  it("codex supports agent → keys by (codex, agent, normalized name)", () => {
    const keys = computeInstallKey(asset({ type: "agent", name: "Reviewer" }), "codex");
    expect(keys).toEqual([{ tool: "codex", scope: "agent", identity: "reviewer" }]);
  });

  it("returns null when asset is not compatible with the tool", () => {
    const a = asset({ type: "skill", name: "x", compatibleTools: ["codex"] });
    expect(computeInstallKey(a, "cursor")).toBeNull();
  });
});

describe("computeInstallKey — file-shaped types", () => {
  it("keys skill/rule/command/agent by (tool, type, normalized name)", () => {
    const keys = computeInstallKey(asset({ type: "skill", name: "My Skill" }), "cursor");
    expect(keys).toEqual([{ tool: "cursor", scope: "skill", identity: "my skill" }]);
  });

  it("cursor supports agent → keys by (cursor, agent, normalized name)", () => {
    const keys = computeInstallKey(asset({ type: "agent", name: "Reviewer" }), "cursor");
    expect(keys).toEqual([{ tool: "cursor", scope: "agent", identity: "reviewer" }]);
  });

  it("same name under different tools does NOT collide (tool is first dimension)", () => {
    const a = asset({ type: "skill", name: "same", compatibleTools: ["cursor"] });
    const b = asset({ type: "skill", name: "same", compatibleTools: ["codex"] });
    const ka = computeInstallKey(a, "cursor")!.map(installKeyToString);
    const kb = computeInstallKey(b, "codex")!.map(installKeyToString);
    expect(ka).not.toEqual(kb);
  });
});

describe("computeInstallKey — mcp", () => {
  it("single-form mcp keys by asset.name", () => {
    const a = asset({
      type: "mcp",
      name: "filesystem",
      files: [{ path: "fs.json", content: JSON.stringify({ command: "npx", args: ["fs"] }) }],
    });
    expect(computeInstallKey(a, "cursor")).toEqual([
      { tool: "cursor", scope: "mcp", identity: "filesystem" },
    ]);
  });

  it("wrapped-form mcp yields one key per inner serverKey (not asset.name)", () => {
    const a = asset({
      type: "mcp",
      name: "bundle",
      files: [
        {
          path: "mcp.json",
          content: JSON.stringify({
            mcpServers: {
              github: { command: "npx" },
              jira: { command: "npx" },
            },
          }),
        },
      ],
    });
    const ids = computeInstallKey(a, "claudecode")!.map((k) => k.identity).sort();
    expect(ids).toEqual(["github", "jira"]);
  });
});

describe("computeInstallKey — hook", () => {
  it("keys hook by hook-dir scope (only attached-script dir collides)", () => {
    const a = asset({ type: "hook", name: "Auto Format" });
    expect(computeInstallKey(a, "codebuddy")).toEqual([
      { tool: "codebuddy", scope: "hook-dir", identity: "auto format" },
    ]);
  });

  it("hook participates on cursor too (now supported)", () => {
    const a = asset({ type: "hook", name: "h" });
    expect(computeInstallKey(a, "cursor")).toEqual([
      { tool: "cursor", scope: "hook-dir", identity: "h" },
    ]);
  });
});

describe("installKeyToString", () => {
  it("is stable and tool/scope/identity separated", () => {
    const tool: TargetTool = "cursor";
    const s = installKeyToString({ tool, scope: "skill", identity: "x" });
    expect(s).toContain("cursor");
    expect(s).toContain("skill");
    expect(s).toContain("x");
  });
});
