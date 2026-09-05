import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodePluginProvider } from "../../providers/claude-code-plugin.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MARKETPLACE = join(__dirname, "../fixtures/cc-marketplace");
const PLUGIN = join(__dirname, "../fixtures/cc-plugin");
const SELF = join(__dirname, "../fixtures/cc-self-marketplace");
const SELF_URL = join(__dirname, "../fixtures/cc-self-url-marketplace");
const MULTI_LOCAL = join(__dirname, "../fixtures/cc-multi-local");
const NESTED = join(__dirname, "../fixtures/cc-nested-skills");
const OFFICIAL = join(__dirname, "../fixtures/cc-official-plugin");
const ROOT_SKILL = join(__dirname, "../fixtures/cc-root-skill");
const MARKETPLACE_ROOT_SKILLS = join(__dirname, "../fixtures/cc-marketplace-root-skills");

describe("claudeCodePluginProvider", () => {
  it("identifies kind 'claude-code-plugin'", () => {
    expect(claudeCodePluginProvider.kind).toBe("claude-code-plugin");
  });

  describe("marketplace mode", () => {
    it("returns marketplace metadata", async () => {
      const result = await claudeCodePluginProvider.parse(MARKETPLACE);
      expect(result.displayName).toBe("test-marketplace");
      expect(result.originAuthor).toBe("Test Org");
      expect(result.description).toBe("A test marketplace");
    });

    it("returns childSources for each listed plugin", async () => {
      const result = await claudeCodePluginProvider.parse(MARKETPLACE);
      expect(result.childSources).toHaveLength(2);
      expect(result.childSources[0]).toEqual({
        repoUrl: "https://github.com/example/alpha.git",
        displayName: "alpha-plugin",
        ref: null,
      });
      expect(result.childSources[1]).toEqual({
        repoUrl: "https://github.com/example/beta.git",
        displayName: "beta-plugin",
        ref: "dev",
      });
    });

    it("does not extract assets or plugins itself", async () => {
      const result = await claudeCodePluginProvider.parse(MARKETPLACE);
      expect(result.assets).toHaveLength(0);
      expect(result.plugins).toHaveLength(0);
    });
  });

  describe("plugin mode", () => {
    it("returns plugin metadata", async () => {
      const result = await claudeCodePluginProvider.parse(PLUGIN);
      expect(result.displayName).toBe("example-plugin");
      expect(result.description).toBe("An example plugin");
    });

    it("extracts skills and mcps (manifest paths dedupe with default scan)", async () => {
      const result = await claudeCodePluginProvider.parse(PLUGIN);
      const types = result.assets.map((a) => a.type).sort();
      // `skills: ["./skills"]` adds to the default skills/ scan (deduped);
      // `mcpServers: "./.mcp.json"` merges with the default .mcp.json scan.
      expect(types).toEqual(["mcp", "skill"]);
    });

    it("returns one ImportedPlugin containing all assets", async () => {
      const result = await claudeCodePluginProvider.parse(PLUGIN);
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]!.pluginName).toBe("example-plugin");
      expect(result.plugins[0]!.version).toBe("1.2.3");
      expect(result.plugins[0]!.assets).toHaveLength(2);
    });

    it("returns no childSources in plugin mode", async () => {
      const result = await claudeCodePluginProvider.parse(PLUGIN);
      expect(result.childSources).toHaveLength(0);
    });
  });

  it("throws on directory that has neither marketplace.json nor plugin.json", async () => {
    const empty = join(__dirname, "../fixtures/empty-repo");
    await expect(claudeCodePluginProvider.parse(empty)).rejects.toThrow(/not a Claude Code/);
  });

  describe("marketplace with local 'source: ./' (self-pointing repo)", () => {
    it("extracts assets in-place rather than emitting childSources", async () => {
      const result = await claudeCodePluginProvider.parse(SELF);
      expect(result.assets.length).toBeGreaterThan(0);
      expect(result.plugins).toHaveLength(1);
      expect(result.childSources).toHaveLength(0);
    });

    it("produces a Workspace named after the marketplace plugin entry", async () => {
      const result = await claudeCodePluginProvider.parse(SELF);
      expect(result.plugins[0]!.pluginName).toBe("selfplugin");
      expect(result.plugins[0]!.version).toBe("9.9.9");
    });

    it("propagates plugin-entry author into asset originAuthor", async () => {
      const result = await claudeCodePluginProvider.parse(SELF);
      const a = result.assets[0]!;
      expect(a.originAuthor).toBe("Self Author");
    });
  });

  describe("marketplace with a URL pointing to itself", () => {
    it("extracts the root plugin instead of dropping the duplicate child source", async () => {
      const result = await claudeCodePluginProvider.parse(SELF_URL, {
        repoUrl: "https://github.com/alibaba-flyai/flyai-skill",
      });

      expect(result.assets.map((asset) => `${asset.type}:${asset.name}`)).toEqual(["skill:flyai"]);
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]!.pluginName).toBe("flyai");
      expect(result.childSources).toHaveLength(0);
    });
  });

  describe("marketplace with multiple local sibling plugins", () => {
    it("extracts each local plugin in-place", async () => {
      const result = await claudeCodePluginProvider.parse(MULTI_LOCAL);
      expect(result.plugins).toHaveLength(2);
      const names = result.plugins.map((p) => p.pluginName).sort();
      expect(names).toEqual(["alpha", "beta"]);
      // Each plugin contributed at least one asset to the flat assets list
      expect(result.assets.length).toBeGreaterThanOrEqual(2);
    });

    it("emits no childSources for fully-local marketplace", async () => {
      const result = await claudeCodePluginProvider.parse(MULTI_LOCAL);
      expect(result.childSources).toHaveLength(0);
    });
  });

  // Regression: mattpocock/skills declares skills as a top-level `skills`
  // array of nested directories (skills/<category>/<name>/SKILL.md). The
  // generic scan groups by the first segment under skills/ and rejects every
  // group (no root-level SKILL.md per group), yielding 0 skills. The manifest
  // must be honored instead.
  describe("plugin mode with manifest-declared nested skills", () => {
    it("extracts exactly the skills declared in the top-level `skills` array", async () => {
      const result = await claudeCodePluginProvider.parse(NESTED);
      const skills = result.assets.filter((a) => a.type === "skill");
      const names = skills.map((s) => s.name).sort();
      expect(names).toEqual(["ask-matt", "grill-me"]);
    });

    it("ignores undeclared siblings (deprecated/, category README.md)", async () => {
      const result = await claudeCodePluginProvider.parse(NESTED);
      const names = result.assets.map((a) => a.name);
      expect(names).not.toContain("old");
      expect(names).not.toContain("README");
      expect(names).not.toContain("engineering");
      expect(names).not.toContain("productivity");
      expect(names).not.toContain("deprecated");
    });

    it("keeps all files of a multi-file skill, relative to the skill dir", async () => {
      const result = await claudeCodePluginProvider.parse(NESTED);
      const grill = result.assets.find((a) => a.name === "grill-me")!;
      expect(grill.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "examples/demo.md"]);
      expect(grill.sourcePath).toBe("skills/productivity/grill-me");
    });

    it("names the plugin and bundles assets under one ImportedPlugin", async () => {
      const result = await claudeCodePluginProvider.parse(NESTED);
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]!.pluginName).toBe("nested-skills-plugin");
      expect(result.plugins[0]!.assets).toHaveLength(2);
    });
  });

  // Official plugin.json alignment
  // (https://code.claude.com/docs/zh-CN/plugins-reference#component-path-fields):
  // every component field is top-level (no `components` wrapper), and each
  // field's shape (string|array|object) and add/replace/merge semantics must
  // match the spec.
  describe("plugin mode with official manifest fields", () => {
    it("skills: adds declared directory and flat .md skills alongside the default scan", async () => {
      const result = await claudeCodePluginProvider.parse(OFFICIAL);
      const skills = result.assets.filter((a) => a.type === "skill").map((a) => a.name).sort();
      expect(skills).toEqual(["alpha", "beta"]);
    });

    it("commands: object form maps key → command name and replaces default commands/", async () => {
      const result = await claudeCodePluginProvider.parse(OFFICIAL);
      const cmds = result.assets.filter((a) => a.type === "command");
      expect(cmds).toHaveLength(1);
      expect(cmds[0]!.name).toBe("deploy");
      expect((cmds[0]!.metadata as { trigger: string }).trigger).toBe("/deploy");
    });

    it("agents: declared .md replaces default agents/", async () => {
      const result = await claudeCodePluginProvider.parse(OFFICIAL);
      const agents = result.assets.filter((a) => a.type === "agent");
      expect(agents).toHaveLength(1);
      expect(agents[0]!.name).toBe("reviewer");
    });

    it("hooks: inline object form produces one asset per (event, entry), named with index when >1", async () => {
      const result = await claudeCodePluginProvider.parse(OFFICIAL);
      const hooks = result.assets.filter((a) => a.type === "hook");
      const byName = new Map(hooks.map((h) => [h.name, h]));
      // PostToolUse has a single entry → bare event name.
      const ptu = byName.get("PostToolUse")!;
      expect(ptu).toBeDefined();
      expect((ptu.metadata as any).matcher).toBe("Write|Edit");
      // SessionStart has two entries → `${event}-${i}`.
      expect(byName.get("SessionStart-1")).toBeDefined();
      expect(byName.get("SessionStart-2")).toBeDefined();
    });

    it("mcpServers: inline object form produces one MCP asset per server", async () => {
      const result = await claudeCodePluginProvider.parse(OFFICIAL);
      const mcps = result.assets.filter((a) => a.type === "mcp");
      expect(mcps).toHaveLength(1);
      expect(mcps[0]!.name).toBe("inline-server");
      expect((mcps[0]!.metadata as { transport: string }).transport).toBe("stdio");
    });

    it("bundles everything under one plugin with declared metadata", async () => {
      const result = await claudeCodePluginProvider.parse(OFFICIAL);
      expect(result.plugins[0]!.pluginName).toBe("official-plugin");
      expect(result.plugins[0]!.version).toBe("2.0.0");
      // 2 skills + 1 command + 1 agent + 3 hooks + 1 mcp = 8
      expect(result.plugins[0]!.assets).toHaveLength(8);
    });
  });

  // Official v2.1.142+: a plugin with a root SKILL.md, no skills/ subdir, and
  // no skills manifest field auto-loads as a single skill.
  describe("plugin mode with a root SKILL.md (single-skill plugin)", () => {
    it("loads the root SKILL.md as one skill named from frontmatter", async () => {
      const result = await claudeCodePluginProvider.parse(ROOT_SKILL);
      const skills = result.assets.filter((a) => a.type === "skill");
      expect(skills).toHaveLength(1);
      expect(skills[0]!.name).toBe("my-root-skill");
      expect(skills[0]!.sourcePath).toBe("SKILL.md");
      expect(skills[0]!.files.map((f) => f.path)).toEqual(["SKILL.md"]);
      expect(skills[0]!.description).toBe("A root-level single skill");
    });
  });

  // Official marketplace-root exception: for a marketplace entry whose source
  // resolves to the marketplace root, declared `skills` subdirs REPLACE the
  // default skills/ scan (instead of adding to it).
  describe("marketplace-root plugin with declared skills", () => {
    it("replaces the default skills/ scan — undeclared skills are excluded", async () => {
      const result = await claudeCodePluginProvider.parse(MARKETPLACE_ROOT_SKILLS);
      const skills = result.assets.filter((a) => a.type === "skill").map((a) => a.name);
      // `skills/declared/foo` is declared → imported; `skills/other/SKILL.md`
      // is found by the default scan but excluded by the replace exception.
      expect(skills).toEqual(["foo"]);
      expect(skills).not.toContain("other");
    });

    it("is named after the marketplace plugin entry", async () => {
      const result = await claudeCodePluginProvider.parse(MARKETPLACE_ROOT_SKILLS);
      expect(result.plugins[0]!.pluginName).toBe("rootplugin");
    });
  });
});
