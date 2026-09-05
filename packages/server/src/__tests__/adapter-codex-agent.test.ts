import { describe, it, expect } from "vitest";
import { CodexAdapter } from "@maolinc/cc-loom-adapter";
import type { Manifest, ManifestAssetEntry } from "@maolinc/cc-loom-shared";

function agentAsset(
  partial: Partial<ManifestAssetEntry> & Pick<ManifestAssetEntry, "name" | "files">,
): ManifestAssetEntry {
  return {
    assetId: partial.name,
    version: "1.0.0",
    type: "agent",
    compatibleTools: ["codex"],
    metadata: {},
    ...partial,
  };
}

function manifestOf(assets: ManifestAssetEntry[]): Manifest {
  return {
    capabilitySetId: "ws",
    capabilitySetName: "ws",
    version: "1",
    targetTools: ["codex"],
    assets,
  };
}

/** 解析 TOML 多行串的最小本地校验：用 Node 把 `developer_instructions` 体取回。 */
function extractDeveloperInstructions(toml: string): string {
  const m = toml.match(/developer_instructions = """\n([\s\S]*?)\n"""/);
  if (!m) throw new Error("developer_instructions 多行串未找到");
  // 还原基本串转义：\" → "，\\ → \
  return m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

describe("CodexAdapter — agent → TOML 转写", () => {
  it("落盘到 .codex/agents/<slug>.toml，含 name/description/developer_instructions", () => {
    const out = new CodexAdapter().generate(
      manifestOf([
        agentAsset({
          name: "reviewer",
          description: "PR reviewer.",
          files: [{ path: "reviewer.md", content: "# reviewer\n\nReview code." }],
        }),
      ]),
    );
    expect(out.skipped).toEqual([]);
    const f = out.files[0]!;
    expect(f.path).toBe(".codex/agents/reviewer.toml");
    expect(f.content).toContain('name = "reviewer"');
    expect(f.content).toContain('description = "PR reviewer."');
    expect(f.content).toContain('developer_instructions = """');
    expect(extractDeveloperInstructions(f.content)).toBe("# reviewer\n\nReview code.");
  });

  it("name 做 slugify：含空格/大写 → 小写连字符，且与文件名一致", () => {
    const out = new CodexAdapter().generate(
      manifestOf([
        agentAsset({
          name: "Code Reviewer",
          description: "x",
          files: [{ path: "a.md", content: "body" }],
        }),
      ]),
    );
    const f = out.files[0]!;
    expect(f.path).toBe(".codex/agents/code-reviewer.toml");
    expect(f.content).toContain('name = "code-reviewer"');
  });

  it("description 缺省时用 asset.name 兜底（Codex description 必填）", () => {
    const out = new CodexAdapter().generate(
      manifestOf([
        agentAsset({
          name: "scanner",
          files: [{ path: "a.md", content: "body" }],
        }),
      ]),
    );
    expect(out.files[0]!.content).toContain('description = "scanner"');
  });

  it("developer_instructions 含双引号与反斜杠：转义后可无损还原", () => {
    const body = 'Use `\\d+` and "quoted" text.\nLine two with """ triple.';
    const out = new CodexAdapter().generate(
      manifestOf([
        agentAsset({
          name: "edge",
          description: "d",
          files: [{ path: "a.md", content: body }],
        }),
      ]),
    );
    const f = out.files[0]!;
    // 多行串体内不会出现未转义的 """ 终结符
    expect(f.content.indexOf('"""')).toBeLessThan(f.content.lastIndexOf('"""'));
    expect(extractDeveloperInstructions(f.content)).toBe(body);
  });

  it("多文件正文按空行拼接为 developer_instructions", () => {
    const out = new CodexAdapter().generate(
      manifestOf([
        agentAsset({
          name: "multi",
          description: "d",
          files: [
            { path: "a.md", content: "part one" },
            { path: "b.md", content: "part two" },
          ],
        }),
      ]),
    );
    expect(extractDeveloperInstructions(out.files[0]!.content)).toBe("part one\n\npart two");
  });

  it("skill/rule 仍走默认渲染，不受 agent 覆写影响", () => {
    const out = new CodexAdapter().generate(
      manifestOf([
        agentAsset({ name: "a1", description: "d", files: [{ path: "a.md", content: "x" }] }),
        {
          assetId: "r1",
          name: "no-console",
          type: "rule",
          version: "1.0.0",
          compatibleTools: ["codex"],
          metadata: { globs: [] },
          files: [{ path: "no-console.md", content: "no console" }],
        },
      ]),
    );
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toEqual([".codex/agents/a1.toml", ".codex/rules/no-console.md"]);
  });

  it("generateForAsset（capabilities 增量路径）与 generate 产出一致", () => {
    const asset = agentAsset({
      name: "reviewer",
      description: "PR reviewer.",
      files: [{ path: "reviewer.md", content: "Review code." }],
    });
    const full = new CodexAdapter().generate(manifestOf([asset])).files[0]!;
    const single = new CodexAdapter().generateForAsset(asset)[0]!;
    expect(single.path).toBe(full.path);
    expect(single.content).toBe(full.content);
  });

  it("passthrough（外部 adopt 的 TOML）原样写出，不做转写", () => {
    const adopted: ManifestAssetEntry = {
      assetId: "ext",
      name: "ext",
      type: "agent",
      version: "1.0.0",
      compatibleTools: ["codex"],
      metadata: { passthrough: true } as ManifestAssetEntry["metadata"],
      files: [{ path: ".codex/agents/ext.toml", content: 'name = "ext"\n' }],
    };
    const out = new CodexAdapter().generateForAsset(adopted);
    expect(out).toEqual([
      { path: ".codex/agents/ext.toml", content: 'name = "ext"\n' },
    ]);
  });
});
