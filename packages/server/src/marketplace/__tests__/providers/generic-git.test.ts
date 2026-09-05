import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { genericGitProvider } from "../../providers/generic-git.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = join(__dirname, "../fixtures/generic-skills");
const EMPTY = join(__dirname, "../fixtures/empty-repo");

describe("genericGitProvider", () => {
  it("identifies kind 'generic-git'", () => {
    expect(genericGitProvider.kind).toBe("generic-git");
  });

  it("returns empty result for repo with no recognized files", async () => {
    const result = await genericGitProvider.parse(EMPTY);
    expect(result.assets).toHaveLength(0);
    expect(result.plugins).toHaveLength(0);
  });

  it("normalizes a loose skills/*.md into a <name>/SKILL.md directory skill", async () => {
    const result = await genericGitProvider.parse(FIXTURE);
    // 领域规则：loose 的 skills/coding-style.md 被规范化为目录式 skill，
    // sourcePath 去扩展名、唯一文件改名为 SKILL.md。
    const skill = result.assets.find((a) => a.sourcePath === "skills/coding-style");
    expect(skill).toBeDefined();
    expect(skill!.type).toBe("skill");
    expect(skill!.name).toBe("coding-style");
    expect(skill!.description).toBe("General coding style guide");
    expect(skill!.tags).toEqual(["style", "lint"]);
    expect(skill!.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    // 绝不应保留扩展名形态
    expect(result.assets.find((a) => a.sourcePath === "skills/coding-style.md")).toBeUndefined();
  });

  it("ignores a loose non-markdown file under skills/ (e.g. llms.txt) — not a skill", async () => {
    const result = await genericGitProvider.parse(FIXTURE);
    // skills/llms.txt 不符合 skill 规范，绝不能被伪造成 skills/llms/SKILL.md
    expect(result.assets.find((a) => a.sourcePath === "skills/llms")).toBeUndefined();
    expect(result.assets.find((a) => a.name === "llms")).toBeUndefined();
    expect(
      result.assets.find((a) => a.type === "skill" && a.sourcePath === "skills/llms.txt"),
    ).toBeUndefined();
  });

  it("includes all files in a multi-file skill directory", async () => {
    const result = await genericGitProvider.parse(FIXTURE);
    const skill = result.assets.find((a) => a.sourcePath === "skills/brainstorming");
    expect(skill).toBeDefined();
    expect(skill!.type).toBe("skill");
    expect(skill!.name).toBe("Brainstorming");
    expect(skill!.description).toBe("Structured brainstorming sessions with multi-turn refinement.");
    expect(skill!.tags).toEqual(["thinking", "creative"]);

    const filePaths = skill!.files.map((f) => f.path).sort();
    expect(filePaths).toContain("SKILL.md");
    expect(filePaths).toContain("setup.sh");
  });

  it("groups deeply nested files into the same asset", async () => {
    const result = await genericGitProvider.parse(FIXTURE);
    const skill = result.assets.find((a) => a.sourcePath === "skills/brainstorming");
    expect(skill).toBeDefined();

    const filePaths = skill!.files.map((f) => f.path).sort();
    expect(filePaths).toContain("examples/session.md");

    // There should NOT be a separate asset for the nested examples directory
    const nested = result.assets.find((a) =>
      a.sourcePath === "skills/brainstorming/examples"
    );
    expect(nested).toBeUndefined();
  });

  it("extracts rule from rules/*.md with globs metadata", async () => {
    const result = await genericGitProvider.parse(FIXTURE);
    const rule = result.assets.find((a) => a.sourcePath === "rules/no-console.md");
    expect(rule).toBeDefined();
    expect(rule!.type).toBe("rule");
    expect(rule!.name).toBe("no-console");
    expect(rule!.description).toBe("Disallow console.log in production code");
    expect(rule!.tags).toEqual(["lint", "quality"]);
    expect((rule!.metadata as { globs: string[] }).globs).toEqual([
      "src/**/*.ts",
      "src/**/*.tsx",
    ]);
  });

  it("extracts each hooks/{name}/ directory with hook.json as a Hook asset", async () => {
    const result = await genericGitProvider.parse(FIXTURE);
    const hooks = result.assets.filter((a) => a.type === "hook");
    expect(hooks).toHaveLength(2);
    const names = hooks.map((h) => h.name).sort();
    expect(names).toEqual(["auto-format", "git-hint"]);

    const af = hooks.find((h) => h.name === "auto-format")!;
    const md = af.metadata as { events: string[]; matcher?: string; hooks: any[] };
    expect(md.events).toEqual(["PostToolUse"]);
    expect(md.matcher).toBe("Write|Edit");
    expect(md.hooks).toEqual([
      { type: "command", command: "format.sh", timeout: 30 },
    ]);
    expect(af.compatibleTools.sort()).toEqual(["claudecode", "codebuddy", "codex"]);
    const paths = af.files.map((f) => f.path).sort();
    expect(paths).toEqual(["format.sh", "hook.json", "lib/common.sh"]);

    const gh = hooks.find((h) => h.name === "git-hint")!;
    const ghMd = gh.metadata as { events: string[]; matcher?: string; hooks: any[] };
    expect(ghMd.events).toEqual(["UserPromptSubmit"]);
    expect(ghMd.matcher).toBeUndefined();
    expect(gh.files.map((f) => f.path).sort()).toEqual(["hint.sh", "hook.json"]);
  });

  it("extracts each MCP server entry as a separate MCP asset", async () => {
    const result = await genericGitProvider.parse(FIXTURE);
    const mcps = result.assets.filter((a) => a.type === "mcp");
    expect(mcps).toHaveLength(2);
    expect(mcps.map((m) => m.name).sort()).toEqual(["filesystem", "github"]);
  });

  it("does not generate plugins or childSources", async () => {
    const result = await genericGitProvider.parse(FIXTURE);
    expect(result.plugins).toHaveLength(0);
    expect(result.childSources).toHaveLength(0);
  });

  it("parses YAML block-scalar frontmatter (description: | with multi-line body)", async () => {
    const dir = join(__dirname, "../fixtures/yaml-multiline");
    const result = await genericGitProvider.parse(dir);
    const m = result.assets.find((a) => a.sourcePath === "skills/m");
    expect(m).toBeDefined();
    expect(m!.description).toBe("Line one of description.\nLine two with more detail.");
    expect(m!.tags).toEqual(["yaml", "multiline"]);
  });
});
