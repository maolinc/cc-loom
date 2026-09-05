import { describe, it, expect } from "vitest";
import {
  buildFieldTexts,
  computeContentHash,
  expandTags,
  mergeDescription,
  extractFrontmatterDescription,
  type AssetIndexData,
} from "../lib/search-field-text.js";

function mk(over: Partial<AssetIndexData>): AssetIndexData {
  return {
    id: "a1",
    name: "name",
    alias: null,
    tagsJson: "[]",
    description: "",
    type: "skill",
    deletedAt: null,
    files: [],
    ...over,
  };
}

describe("name 字段构造", () => {
  it("alias 为空时只取 name", () => {
    expect(buildFieldTexts(mk({ name: "code_review", alias: null })).name).toBe("code_review");
  });
  it("alias 非空时 name + ' ' + alias", () => {
    expect(buildFieldTexts(mk({ name: "code_review", alias: "代码审查" })).name).toBe("code_review 代码审查");
  });
  it("折叠内部空白", () => {
    expect(buildFieldTexts(mk({ name: "  a   b ", alias: null })).name).toBe("a b");
  });
});

describe("tags 字段构造", () => {
  it("expandTags：JSON 数组展开为空格分隔", () => {
    expect(expandTags('["前端","React","测试"]')).toBe("前端 React 测试");
  });
  it("expandTags：空数组", () => {
    expect(expandTags("[]")).toBe("");
  });
  it("expandTags：非法 JSON 回退 trim", () => {
    expect(expandTags("not json")).toBe("not json");
  });
  it("buildFieldTexts：tags 来自 tagsJson", () => {
    expect(buildFieldTexts(mk({ tagsJson: '["x","y"]' })).tags).toBe("x y");
  });
});

describe("description 合并去重", () => {
  it("两侧均空 → 空串", () => {
    expect(mergeDescription("", "")).toBe("");
  });
  it("仅手填有值 → 用手填", () => {
    expect(mergeDescription("手填描述", "")).toBe("手填描述");
  });
  it("仅 frontmatter 有值 → 用 frontmatter", () => {
    expect(mergeDescription("", "fm描述")).toBe("fm描述");
  });
  it("两侧大小写敏感精确相等 → 只用一个", () => {
    expect(mergeDescription("审查代码", "审查代码")).toBe("审查代码");
  });
  it("两侧均有值且不等 → 手填 + \\n + frontmatter", () => {
    expect(mergeDescription("手填", "fm")).toBe("手填\nfm");
  });
  it("折叠内部空白后再比较", () => {
    // 折叠后相等 → 只用一个
    expect(mergeDescription("审查  代码", "审查 代码")).toBe("审查 代码");
  });
});

describe("frontmatter description 抽取", () => {
  const skillMd = (desc: string) => `---
name: my-skill
description: ${desc}
---

# Skill body`;

  it("skill：从 SKILL.md 抽 description", () => {
    const data = mk({
      type: "skill",
      files: [{ path: "SKILL.md", content: skillMd("技能描述") }],
    });
    expect(extractFrontmatterDescription(data)).toBe("技能描述");
  });
  it("skill：深层路径以 /SKILL.md 结尾也抽取", () => {
    const data = mk({
      type: "skill",
      files: [{ path: "sub/SKILL.md", content: skillMd("深层技能") }],
    });
    expect(extractFrontmatterDescription(data)).toBe("深层技能");
  });
  it("agent：从主 .md 抽 description（README 优先）", () => {
    const data = mk({
      type: "agent",
      files: [
        { path: "other.md", content: skillMd("其它") },
        { path: "README.md", content: skillMd("README描述") },
      ],
    });
    expect(extractFrontmatterDescription(data)).toBe("README描述");
  });
  it("command：从第一个 .md 抽（无 README）", () => {
    const data = mk({
      type: "command",
      files: [{ path: "cmd.md", content: skillMd("命令描述") }],
    });
    expect(extractFrontmatterDescription(data)).toBe("命令描述");
  });
  it("rule/mcp/hook：不抽取（返回空）", () => {
    for (const type of ["rule", "mcp", "hook"] as const) {
      const data = mk({ type, files: [{ path: "x.md", content: skillMd("不应被抽取") }] });
      expect(extractFrontmatterDescription(data)).toBe("");
    }
  });
  it("无 frontmatter 的 .md → 空串", () => {
    const data = mk({ type: "skill", files: [{ path: "SKILL.md", content: "# no fm" }] });
    expect(extractFrontmatterDescription(data)).toBe("");
  });
  it("block scalar description: | 多行", () => {
    const content = `---
description: |
  第一行
  第二行
---
body`;
    const data = mk({ type: "skill", files: [{ path: "SKILL.md", content }] });
    expect(extractFrontmatterDescription(data)).toBe("第一行\n第二行");
  });
});

describe("description 字段在 buildFieldTexts 中合并", () => {
  it("手填与 frontmatter 不等 → 拼接", () => {
    const data = mk({
      type: "skill",
      description: "手填描述",
      files: [{ path: "SKILL.md", content: "---\ndescription: fm描述\n---\nbody" }],
    });
    expect(buildFieldTexts(data).description).toBe("手填描述\nfm描述");
  });
  it("手填与 frontmatter 相等 → 用一个", () => {
    const data = mk({
      type: "skill",
      description: "相同描述",
      files: [{ path: "SKILL.md", content: "---\ndescription: 相同描述\n---\nbody" }],
    });
    expect(buildFieldTexts(data).description).toBe("相同描述");
  });
  it("均空 → description 字段为空串（该 asset 仅 name/tags 两行）", () => {
    const data = mk({ type: "rule", description: "", files: [] });
    expect(buildFieldTexts(data).description).toBe("");
  });
});

describe("content_hash 变化判定", () => {
  it("name 变化 → hash 变", () => {
    const base = buildFieldTexts(mk({ name: "a", alias: null }));
    const changed = buildFieldTexts(mk({ name: "b", alias: null }));
    expect(computeContentHash(base)).not.toBe(computeContentHash(changed));
  });
  it("alias 变化 → hash 变", () => {
    const a = buildFieldTexts(mk({ alias: "甲" }));
    const b = buildFieldTexts(mk({ alias: "乙" }));
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
  it("tags 变化 → hash 变", () => {
    const a = buildFieldTexts(mk({ tagsJson: '["x"]' }));
    const b = buildFieldTexts(mk({ tagsJson: '["y"]' }));
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
  it("手填 description 变化 → hash 变", () => {
    const a = buildFieldTexts(mk({ description: "d1" }));
    const b = buildFieldTexts(mk({ description: "d2" }));
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
  it("frontmatter description 变化 → hash 变", () => {
    const a = buildFieldTexts(mk({ type: "skill", files: [{ path: "SKILL.md", content: "---\ndescription: x\n---\nb" }] }));
    const b = buildFieldTexts(mk({ type: "skill", files: [{ path: "SKILL.md", content: "---\ndescription: y\n---\nb" }] }));
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });
  it("正文 body 变化 → hash 不变（不触发重算）", () => {
    const a = buildFieldTexts(mk({ type: "skill", description: "d", files: [{ path: "SKILL.md", content: "---\ndescription: d\n---\nbody A" }] }));
    const b = buildFieldTexts(mk({ type: "skill", description: "d", files: [{ path: "SKILL.md", content: "---\ndescription: d\n---\nbody B" }] }));
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });
  it("相同输入 → 相同 hash", () => {
    const a = buildFieldTexts(mk({ name: "a", tagsJson: '["t"]', description: "d" }));
    const b = buildFieldTexts(mk({ name: "a", tagsJson: '["t"]', description: "d" }));
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });
});
