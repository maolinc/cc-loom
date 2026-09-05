/**
 * download-archive 渲染规则单测。
 *
 * 不变量：
 *  - 单能力预览结构 = DetailPanel activeFileFullPath：dir 型 `<typeDir>/<name>/<file.path>`，
 *    平铺型 `<typeDir>/<file.path>`，mcp 无 typeDir 直接 `<file.path>`。
 *  - skill / hook 恒为目录型（即使单文件也包 name）。
 *  - 能力集预览结构包含全部成员资产，不聚合、不重组。
 *  - 厂商结构走 adapter.generate：不兼容类型进 skipped，兼容的产出 `<targetDir>/...`。
 *  - zipEntries 产出可被 fflate unzipSync 还原，文件路径与内容一致。
 */
import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import type { Manifest, ManifestAssetEntry, AssetType, TargetTool } from "@maolinc/cc-loom-shared";
import {
  buildAssetPreviewEntries,
  buildCapabilitySetPreviewEntries,
  buildCapabilitySetVendorEntries,
  zipEntries,
  downloadFilename,
} from "../lib/download-archive.js";

function asset(
  partial: Partial<ManifestAssetEntry> & Pick<ManifestAssetEntry, "name" | "type" | "files">,
): ManifestAssetEntry {
  return {
    assetId: partial.name,
    version: "1.0.0",
    compatibleTools: partial.compatibleTools ?? ["claudecode"],
    metadata: partial.metadata ?? ({} as ManifestAssetEntry["metadata"]),
    ...partial,
  };
}

function manifestOf(assets: ManifestAssetEntry[], tools: TargetTool[] = ["claudecode"]): Manifest {
  return { capabilitySetId: "ws", capabilitySetName: "ws", version: "1", targetTools: tools, assets };
}

function paths(entries: { path: string }[]): string[] {
  return entries.map((e) => e.path).sort();
}

describe("buildAssetPreviewEntries — 各类型预览结构", () => {
  it("skill 恒为目录型：skills/<name>/<file.path>，多文件全保留", () => {
    const entries = buildAssetPreviewEntries({
      type: "skill",
      name: "brainstorming",
      files: [
        { path: "SKILL.md", content: "# x" },
        { path: "reference.md", content: "ref" },
      ],
    });
    expect(paths(entries)).toEqual(["skills/brainstorming/SKILL.md", "skills/brainstorming/reference.md"]);
  });

  it("hook 恒为目录型：hooks/<name>/<file.path>，hook.json 原样不拆", () => {
    const entries = buildAssetPreviewEntries({
      type: "hook",
      name: "lint-check",
      files: [
        { path: "hook.json", content: "{}" },
        { path: "run.sh", content: "#!/bin/sh" },
      ],
    });
    expect(paths(entries)).toEqual(["hooks/lint-check/hook.json", "hooks/lint-check/run.sh"]);
  });

  it("mcp 无 typeDir：直接 <file.path>", () => {
    const entries = buildAssetPreviewEntries({
      type: "mcp",
      name: "fs",
      files: [{ path: "config.json", content: "{}" }],
    });
    expect(paths(entries)).toEqual(["config.json"]);
  });

  it("rule 平铺型（sourcePath 末段有扩展名）：rules/<file.path>", () => {
    const entries = buildAssetPreviewEntries({
      type: "rule",
      name: "no-console",
      sourcePath: "rules/no-console.md",
      files: [{ path: "no-console.md", content: "# x" }],
    });
    expect(paths(entries)).toEqual(["rules/no-console.md"]);
  });

  it("rule 目录型（sourcePath 末段无扩展名）：rules/<name>/<file.path>", () => {
    const entries = buildAssetPreviewEntries({
      type: "rule",
      name: "team-standards",
      sourcePath: "rules/team-standards",
      files: [{ path: "index.md", content: "# x" }, { path: "extra.md", content: "y" }],
    });
    expect(paths(entries)).toEqual(["rules/team-standards/extra.md", "rules/team-standards/index.md"]);
  });

  it("command 目录型：commands/<name>/<file.path>", () => {
    const entries = buildAssetPreviewEntries({
      type: "command",
      name: "review",
      sourcePath: "commands/review",
      files: [{ path: "review.md", content: "# x" }],
    });
    expect(paths(entries)).toEqual(["commands/review/review.md"]);
  });

  it("agent 平铺型：agents/<file.path>", () => {
    const entries = buildAssetPreviewEntries({
      type: "agent",
      name: "code-reviewer",
      sourcePath: "agents/code-reviewer.md",
      files: [{ path: "code-reviewer.md", content: "# x" }],
    });
    expect(paths(entries)).toEqual(["agents/code-reviewer.md"]);
  });

  it("base64 文件解码为二进制字节", () => {
    const entries = buildAssetPreviewEntries({
      type: "skill",
      name: "with-binary",
      files: [{ path: "icon.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), encoding: "base64" }],
    });
    expect(entries[0]!.data).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe("buildAssetPreviewEntries — 单能力下载 (typeDir: false)", () => {
  it("skill：不带 skills/ 前缀，直接 <name>/<file.path>", () => {
    const entries = buildAssetPreviewEntries(
      {
        type: "skill",
        name: "brainstorming",
        files: [{ path: "SKILL.md", content: "# x" }, { path: "ref.md", content: "y" }],
      },
      { typeDir: false },
    );
    expect(paths(entries)).toEqual(["brainstorming/SKILL.md", "brainstorming/ref.md"]);
  });

  it("hook：不带 hooks/ 前缀，直接 <name>/<file.path>", () => {
    const entries = buildAssetPreviewEntries(
      {
        type: "hook",
        name: "lint-check",
        files: [{ path: "hook.json", content: "{}" }, { path: "run.sh", content: "#!/bin/sh" }],
      },
      { typeDir: false },
    );
    expect(paths(entries)).toEqual(["lint-check/hook.json", "lint-check/run.sh"]);
  });

  it("mcp：直接 <file.path>（本就无 typeDir）", () => {
    const entries = buildAssetPreviewEntries(
      { type: "mcp", name: "fs", files: [{ path: "config.json", content: "{}" }] },
      { typeDir: false },
    );
    expect(paths(entries)).toEqual(["config.json"]);
  });

  it("rule 平铺型：直接 <file.path>，不带 rules/", () => {
    const entries = buildAssetPreviewEntries(
      { type: "rule", name: "no-console", sourcePath: "rules/no-console.md", files: [{ path: "no-console.md", content: "# x" }] },
      { typeDir: false },
    );
    expect(paths(entries)).toEqual(["no-console.md"]);
  });

  it("rule 目录型：直接 <name>/<file.path>，不带 rules/", () => {
    const entries = buildAssetPreviewEntries(
      { type: "rule", name: "team-standards", sourcePath: "rules/team-standards", files: [{ path: "index.md", content: "# x" }] },
      { typeDir: false },
    );
    expect(paths(entries)).toEqual(["team-standards/index.md"]);
  });
});

describe("buildCapabilitySetPreviewEntries — 能力集无厂商结构", () => {
  it("包含全部成员资产，按各自类型铺放，不聚合 mcp", () => {
    const entries = buildCapabilitySetPreviewEntries([
      asset({ name: "s1", type: "skill", files: [{ path: "SKILL.md", content: "# s1" }] }),
      asset({ name: "m1", type: "mcp", files: [{ path: "config.json", content: "{}" }] }),
      asset({ name: "r1", type: "rule", sourcePath: "rules/r1.md", files: [{ path: "r1.md", content: "# r1" }] }),
    ]);
    expect(paths(entries)).toEqual([
      "config.json",
      "rules/r1.md",
      "skills/s1/SKILL.md",
    ]);
  });
});

describe("buildCapabilitySetVendorEntries — 能力集厂商结构", () => {
  it("走 adapter.generate：claudecode 完整安装路径，agent 兼容", () => {
    const m = manifestOf([
      asset({
        name: "reviewer",
        type: "agent",
        compatibleTools: ["claudecode"],
        sourcePath: "agents/reviewer.md",
        files: [{ path: "reviewer.md", content: "# x" }],
      }),
    ], ["claudecode"]);
    const { entries, skipped } = buildCapabilitySetVendorEntries(m, ["claudecode"]);
    expect(paths(entries)).toEqual([".claude/agents/reviewer.md"]);
    expect(skipped).toEqual([]);
  });

  it("cursor 支持 agent → 落盘 .cursor/agents/<name>.md", () => {
    const m = manifestOf([
      asset({
        name: "reviewer",
        type: "agent",
        compatibleTools: ["cursor"],
        sourcePath: "agents/reviewer.md",
        files: [{ path: "reviewer.md", content: "# x" }],
      }),
    ], ["cursor"]);
    const { entries, skipped } = buildCapabilitySetVendorEntries(m, ["cursor"]);
    expect(paths(entries)).toEqual([".cursor/agents/reviewer.md"]);
    expect(skipped).toEqual([]);
  });

  it("codex 支持 agent → 转写为 .codex/agents/<name>.toml", () => {
    const m = manifestOf([
      asset({
        name: "reviewer",
        type: "agent",
        description: "PR reviewer.",
        compatibleTools: ["codex"],
        sourcePath: "agents/reviewer.md",
        files: [{ path: "reviewer.md", content: "# reviewer\n\nReview code." }],
      }),
    ], ["codex"]);
    const { entries, skipped } = buildCapabilitySetVendorEntries(m, ["codex"]);
    expect(paths(entries)).toEqual([".codex/agents/reviewer.toml"]);
    expect(skipped).toEqual([]);
    const toml = entries[0]!.data.toString("utf8");
    expect(toml).toContain('name = "reviewer"');
    expect(toml).toContain('description = "PR reviewer."');
    expect(toml).toContain('developer_instructions = """');
    expect(toml).toContain("Review code.");
  });

  it("多厂商并排：各自 targetDir 前缀天然隔离", () => {
    const m = manifestOf([
      asset({
        name: "s1",
        type: "skill",
        compatibleTools: ["cursor", "claudecode"],
        files: [{ path: "SKILL.md", content: "# s1" }],
      }),
    ], ["cursor", "claudecode"]);
    const { entries } = buildCapabilitySetVendorEntries(m, ["cursor", "claudecode"]);
    expect(paths(entries)).toEqual([".claude/skills/s1/SKILL.md", ".cursor/skills/s1/SKILL.md"]);
  });
});

describe("zipEntries — 产出可还原", () => {
  it("zip → unzipSync 还原全部文件路径与内容", () => {
    const entries = [
      { path: "skills/s1/SKILL.md", data: Buffer.from("# s1\n") },
      { path: "rules/r1.md", data: Buffer.from("# r1\n") },
    ];
    const zip = zipEntries(entries);
    // zip magic bytes
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    const restored = unzipSync(new Uint8Array(zip));
    expect(Object.keys(restored).sort()).toEqual(["rules/r1.md", "skills/s1/SKILL.md"]);
    expect(Buffer.from(restored["skills/s1/SKILL.md"]!).toString("utf8")).toBe("# s1\n");
  });

  it("prefix 非空时，所有路径前加 <prefix>/（能力集名顶层目录）", () => {
    const entries = [
      { path: "skills/s1/SKILL.md", data: Buffer.from("# s1\n") },
      { path: ".cursor/mcp.json", data: Buffer.from("{}") },
    ];
    const zip = zipEntries(entries, "我的能力集");
    const restored = unzipSync(new Uint8Array(zip));
    expect(Object.keys(restored).sort()).toEqual([
      "我的能力集/.cursor/mcp.json",
      "我的能力集/skills/s1/SKILL.md",
    ]);
  });
});

describe("downloadFilename", () => {
  it("中文/空格/大写 → 小写 kebab + .zip", () => {
    expect(downloadFilename("Code Review 工作流")).toBe("code-review.zip");
  });
  it("纯特殊字符回退 loom.zip", () => {
    expect(downloadFilename("///")).toBe("loom.zip");
  });
});
