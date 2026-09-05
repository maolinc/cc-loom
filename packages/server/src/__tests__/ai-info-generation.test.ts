import { describe, it, expect } from "vitest";
import {
  parseGeneratedInfo,
  buildFileContext,
  selectFilesForAi,
  buildInfoPrompt,
  AI_INFO_SYSTEM_PROMPT,
  chatCompletionsUrl,
} from "../lib/ai-info-generation.js";

// L1：纯函数验证。不生成 name；tags 去重/上限 5；auth 绑定解析；文件上下文截断；
// skill 选 SKILL.md；chat 端点拼接。

describe("parseGeneratedInfo", () => {
  it("解析正常 JSON（不含 name 字段）", () => {
    const r = parseGeneratedInfo('```json\n{"alias":"别名","tags":["a","b"],"description":"描述","auth":{"bindings":[{"credentialName":"X","kind":"env","envKey":"X"}]}}\n```');
    expect(r).not.toBeNull();
    expect(r!.alias).toBe("别名");
    expect(r!.tags).toEqual(["a", "b"]);
    expect(r!.description).toBe("描述");
    expect(r!.auth?.bindings).toHaveLength(1);
    expect(r!.auth?.bindings[0]).toMatchObject({ credentialName: "X", kind: "env", envKey: "X" });
  });

  it("name 字段被忽略（即使返回也不采纳）", () => {
    const r = parseGeneratedInfo('{"name":"should_be_ignored","alias":"别名","tags":["a"],"description":"描述"}');
    expect(r).not.toBeNull();
    expect(r!.name).toBeUndefined();
  });

  it("tags 去重并截断到 5", () => {
    const r = parseGeneratedInfo('{"alias":"x","tags":["a","a","b","c","d","e","f"],"description":"d"}');
    expect(r!.tags).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("非 JSON / 缺少必要字段 → null", () => {
    expect(parseGeneratedInfo("not json")).toBeNull();
    expect(parseGeneratedInfo('{"alias":"","tags":[],"description":""}')).toBeNull();
  });

  it("无需鉴权：auth.bindings 为空 → 无 auth", () => {
    const r = parseGeneratedInfo('{"alias":"x","tags":["a"],"description":"d","auth":{"bindings":[]}}');
    expect(r!.auth).toBeUndefined();
  });

  it("过滤非法 kind 的绑定", () => {
    const r = parseGeneratedInfo('{"alias":"x","tags":["a"],"description":"d","auth":{"bindings":[{"credentialName":"A","kind":"env","envKey":"A"},{"credentialName":"B","kind":"bad"}]}}');
    expect(r!.auth?.bindings).toHaveLength(1);
    expect(r!.auth?.bindings[0]!.credentialName).toBe("A");
  });
});

describe("buildFileContext", () => {
  it("无文件 → 占位串", () => {
    expect(buildFileContext([])).toBe("（未提供文件内容）");
  });

  it("最多 10 文件、总计 8000 字符截断", () => {
    // 15 个 500 字符文件：10 个文件 × 500 = 5000 < 8000，故 10 个全进、余 5 被文件数上限截
    const files = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.md`, content: "x".repeat(500) }));
    const ctx = buildFileContext(files);
    const headers = ctx.match(/--- f\d+\.md ---/g) ?? [];
    expect(headers.length).toBe(10);
    expect(ctx.length).toBeLessThan(8_000);
  });

  it("单文件超 2000 字符则该文件被截断到 2000", () => {
    const ctx = buildFileContext([{ path: "big.md", content: "y".repeat(5_000) }]);
    // 头 + 2000 内容
    expect(ctx).toContain("--- big.md ---");
    expect(ctx.match(/y/g)!.length).toBe(2_000);
  });
});

describe("selectFilesForAi", () => {
  it("skill 类型只选 SKILL.md", () => {
    const files = [
      { path: "SKILL.md", content: "entry" },
      { path: "scripts/x.sh", content: "x" },
    ];
    const sel = selectFilesForAi({ type: "skill", files });
    expect(sel).toHaveLength(1);
    expect(sel[0]!.path).toBe("SKILL.md");
  });

  it("skill 无 SKILL.md 时退回全部文件", () => {
    const files = [{ path: "README.md", content: "r" }];
    const sel = selectFilesForAi({ type: "skill", files });
    expect(sel).toHaveLength(1);
  });

  it("非 skill 类型用全部文件", () => {
    const files = [{ path: "a.md", content: "a" }, { path: "b.md", content: "b" }];
    expect(selectFilesForAi({ type: "rule", files })).toHaveLength(2);
  });
});

describe("AI_INFO_SYSTEM_PROMPT", () => {
  it("含不变规则：禁止生成/输出 name，标签粒度与主标签约束", () => {
    const s = AI_INFO_SYSTEM_PROMPT;
    // 规则一禁止生成/补全/修改 name，输出要求禁止输出 name
    expect(s).toContain("不得生成、补全或修改 name");
    expect(s).toContain("不得输出 name");
    // 标签粒度与主标签约束仍在
    expect(s).toContain("少于 15 个字符");
    expect(s).toContain("主标签");
    // 禁止把能力类型名用作标签（已在类型分类中体现，作标签属于重复）
    expect(s).toContain("能力类型名");
    expect(s).toContain(
      "能力类型名，如 skill、rule、mcp、hook、command、agent",
    );
    // 推荐示例不再包含类型名 MCP
    expect(s).not.toContain("代码审查、MCP、知识库");
    // 旧 prompt 的「name 是稳定标识…必须简短可读」正向生成指令已移除
    expect(s).not.toContain("必须简短可读");
  });
});

describe("buildInfoPrompt", () => {
  it("只含动态输入数据，不变规则已移至 system 消息", () => {
    const p = buildInfoPrompt({
      type: "skill", name: "n", alias: "a", description: "d", tags: ["t"], files: [],
    });
    expect(p).toContain("能力类型：Skill (skill)");
    expect(p).toContain("已有名称：n");
    expect(p).toContain("已有别名：a");
    expect(p).toContain("已有描述：d");
    expect(p).toContain("文件内容摘要：");
    // 不变规则不在 user 消息里
    expect(p).not.toContain("不得生成、补全或修改 name");
    expect(p).not.toContain("主标签");
  });
});

describe("chatCompletionsUrl", () => {
  it("已带后缀不重复；未带则补全；去尾斜杠", () => {
    expect(chatCompletionsUrl("https://x/v1")).toBe("https://x/v1/chat/completions");
    expect(chatCompletionsUrl("https://x/v1/chat/completions")).toBe("https://x/v1/chat/completions");
    expect(chatCompletionsUrl("https://x/v1/")).toBe("https://x/v1/chat/completions");
  });
});
