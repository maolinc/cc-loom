import { describe, it, expect } from "vitest";
import {
  mergeContent,
  mergeHooksRegistry,
  mergeSettingsWithHooks,
} from "@maolinc/cc-loom-adapter";
import { CursorAdapter, AggregateParseError } from "@maolinc/cc-loom-adapter";

describe("mergeHooksRegistry", () => {
  it("returns incoming verbatim when existing is empty", () => {
    const incoming = JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "x.sh" }] }] },
    });
    const out = JSON.parse(mergeHooksRegistry("", incoming));
    expect(out).toEqual({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "x.sh" }] }] },
    });
  });

  it("returns existing verbatim when incoming has no hooks", () => {
    const existing = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "y.sh" }] }] } });
    const out = mergeHooksRegistry(existing, "{}");
    expect(JSON.parse(out)).toEqual(JSON.parse(existing));
  });

  it("appends a new event without touching existing events", () => {
    const existing = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }] },
    });
    const incoming = JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt.sh" }] }] },
    });
    const out = JSON.parse(mergeHooksRegistry(existing, incoming));
    expect(Object.keys(out.hooks).sort()).toEqual(["PostToolUse", "PreToolUse"]);
    expect(out.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] },
    ]);
    expect(out.hooks.PostToolUse).toEqual([
      { matcher: "Edit", hooks: [{ type: "command", command: "fmt.sh" }] },
    ]);
  });

  it("appends new matcher entry within same event", () => {
    const existing = JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "a.sh" }] }] },
    });
    const incoming = JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "b.sh" }] }] },
    });
    const out = JSON.parse(mergeHooksRegistry(existing, incoming));
    expect(out.hooks.PostToolUse).toHaveLength(2);
    expect(out.hooks.PostToolUse[0].matcher).toBe("Write");
    expect(out.hooks.PostToolUse[1].matcher).toBe("Edit");
  });

  it("concatenates hooks[] when (event, matcher) collides", () => {
    const existing = JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "a.sh" }] }] },
    });
    const incoming = JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "b.sh" }] }] },
    });
    const out = JSON.parse(mergeHooksRegistry(existing, incoming));
    expect(out.hooks.PostToolUse).toHaveLength(1);
    expect(out.hooks.PostToolUse[0].hooks).toEqual([
      { type: "command", command: "a.sh" },
      { type: "command", command: "b.sh" },
    ]);
  });

  it("treats missing matcher as a distinct catch-all bucket", () => {
    const existing = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "a.sh" }] }] },
    });
    const incoming = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "b.sh" }] }] },
    });
    const out = JSON.parse(mergeHooksRegistry(existing, incoming));
    // both have undefined matcher → collide → concat hooks[]
    expect(out.hooks.Stop).toHaveLength(1);
    expect(out.hooks.Stop[0].hooks).toHaveLength(2);
  });

  it("preserves non-hooks top-level fields from existing", () => {
    const existing = JSON.stringify({
      version: "1.0",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "a.sh" }] }] },
    });
    const incoming = JSON.stringify({
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "b.sh" }] }] },
    });
    const out = JSON.parse(mergeHooksRegistry(existing, incoming));
    expect(out.version).toBe("1.0");
  });

  it("carries over version from incoming when existing has none (Cursor fresh install)", () => {
    const incoming = JSON.stringify({
      version: 1,
      hooks: { postToolUse: [{ hooks: [{ type: "command", command: "b.sh" }] }] },
    });
    const out = JSON.parse(mergeHooksRegistry("", incoming));
    expect(out.version).toBe(1);
    expect(out.hooks.postToolUse).toBeDefined();
  });

  it("treats invalid JSON existing as empty (incoming wins)", () => {
    const incoming = JSON.stringify({ hooks: { Stop: [] } });
    const out = mergeHooksRegistry("not json", incoming);
    expect(JSON.parse(out)).toEqual({ hooks: { Stop: [] } });
  });
});

describe("mergeSettingsWithHooks", () => {
  it("shallow-merges top-level fields, preserves user fields not in incoming", () => {
    const existing = JSON.stringify({ theme: "dark", apiKey: "abc" });
    const incoming = JSON.stringify({
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "fmt.sh" }] }] },
    });
    const out = JSON.parse(mergeSettingsWithHooks(existing, incoming));
    expect(out.theme).toBe("dark");
    expect(out.apiKey).toBe("abc");
    expect(out.hooks.PostToolUse).toBeDefined();
  });

  it("incoming top-level fields override existing same-keyed fields", () => {
    const existing = JSON.stringify({ theme: "dark" });
    const incoming = JSON.stringify({ theme: "light" });
    const out = JSON.parse(mergeSettingsWithHooks(existing, incoming));
    expect(out.theme).toBe("light");
  });

  it("hooks subfield uses hooks-registry merge semantics (event-level append)", () => {
    const existing = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }] },
    });
    const incoming = JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt.sh" }] }] },
    });
    const out = JSON.parse(mergeSettingsWithHooks(existing, incoming));
    expect(Object.keys(out.hooks).sort()).toEqual(["PostToolUse", "PreToolUse"]);
  });

  it("preserves existing hooks when incoming has no hooks field", () => {
    const existing = JSON.stringify({
      theme: "dark",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "a.sh" }] }] },
    });
    const incoming = JSON.stringify({ apiKey: "xyz" });
    const out = JSON.parse(mergeSettingsWithHooks(existing, incoming));
    expect(out.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "a.sh" }] }] });
    expect(out.apiKey).toBe("xyz");
  });
});

describe("mergeContent dispatch", () => {
  it("dispatches to mergeHooksRegistry", () => {
    const existing = JSON.stringify({ hooks: {} });
    const incoming = JSON.stringify({ hooks: { Stop: [] } });
    const a = mergeContent("hooks-registry", existing, incoming);
    const b = mergeHooksRegistry(existing, incoming);
    expect(JSON.parse(a)).toEqual(JSON.parse(b));
  });

  it("dispatches to mergeSettingsWithHooks", () => {
    const existing = JSON.stringify({ theme: "dark" });
    const incoming = JSON.stringify({ hooks: { Stop: [] } });
    const a = mergeContent("settings-with-hooks", existing, incoming);
    const b = mergeSettingsWithHooks(existing, incoming);
    expect(JSON.parse(a)).toEqual(JSON.parse(b));
  });
});

describe("诊断：mergeAggregate 对非法/非 JSON existing 的处理", () => {
  const ad = new CursorAdapter();

  // 修复策略：existing 非 strict JSON（JSONC 注释 / 损坏 / 顶层非对象）时 parseJsonObject
  // 抛 AggregateParseError，绝不返回 {} 覆写。CLI 捕获后不写盘、文件原样保留。
  it("existing 为 JSONC（含注释）→ 抛 AggregateParseError，不覆写 foreign", () => {
    const existing = `{
  // 我自己的注释
  "mcpServers": { "other": { "command": "foreign" } }
}`;
    expect(() => ad.mergeAggregate("mcp", ".cursor/mcp.json",
      [{ key: "x", value: { command: "npx-x" } }], ["x"], existing),
    ).toThrowError(AggregateParseError);
  });

  it("existing 顶层为数组 → 抛 AggregateParseError（不覆写）", () => {
    expect(() => ad.mergeAggregate("mcp", ".cursor/mcp.json",
      [{ key: "x", value: { command: "npx-x" } }], ["x"], `["not", "an", "object"]`),
    ).toThrowError(AggregateParseError);
  });

  it("existing 为空/空白 → 仍正常从空起步（不抛错）", () => {
    const out = ad.mergeAggregate("mcp", ".cursor/mcp.json",
      [{ key: "x", value: { command: "npx-x" } }], ["x"], "   ");
    const parsed = JSON.parse(out!);
    expect(parsed.mcpServers?.x).toEqual({ command: "npx-x" });
  });
});
