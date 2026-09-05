import { describe, it, expect } from "vitest";
import {
  ClaudeCodeAdapter,
  CodeBuddyAdapter,
  CodexAdapter,
  CursorAdapter,
} from "@maolinc/cc-loom-adapter";
import type { Manifest, ManifestAssetEntry } from "@maolinc/cc-loom-shared";

function hookAsset(
  name: string,
  metadata: ManifestAssetEntry["metadata"],
  files: { path: string; content: string }[],
): ManifestAssetEntry {
  return {
    assetId: name,
    name,
    type: "hook",
    version: "1.0.0",
    files,
    compatibleTools: ["claudecode", "codebuddy", "codex"],
    metadata,
  };
}

function manifest(assets: ManifestAssetEntry[]): Manifest {
  return {
    workspaceId: "ws1",
    workspaceName: "ws1",
    version: "1",
    targetTools: ["claudecode", "codebuddy", "codex", "cursor"],
    assets,
  };
}

const SAMPLE_HOOK = hookAsset(
  "auto-format",
  {
    event: "PostToolUse",
    matcher: "Write|Edit",
    hooks: [
      { type: "command", command: "format.sh", timeout: 30 },
      { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/keep.sh" }, // 已有占位符不应被改写
      { type: "command", command: "/abs/lint" }, // 绝对路径不应被改写
      { type: "http", url: "https://example.com/hook" }, // 非 command 类型字段透传
    ],
  },
  [
    { path: "hook.json", content: "{}" },
    { path: "format.sh", content: "echo fmt" },
    { path: "lib/common.sh", content: "log() { echo $*; }" },
  ],
);

const SAMPLE_HOOK_2 = hookAsset(
  "git-hint",
  {
    event: "UserPromptSubmit",
    hooks: [{ type: "command", command: "hint.sh" }],
  },
  [
    { path: "hook.json", content: "{}" },
    { path: "hint.sh", content: "echo hi" },
  ],
);

describe("Hook output per adapter", () => {
  describe("ClaudeCodeAdapter", () => {
    const out = new ClaudeCodeAdapter().generate(manifest([SAMPLE_HOOK, SAMPLE_HOOK_2]));

    it("emits hooks into .claude/settings.json (not hooks/hooks.json, which only works inside plugins)", () => {
      const paths = out.files.map((f) => f.path);
      expect(paths).toContain(".claude/settings.json");
      expect(paths).not.toContain(".claude/hooks/hooks.json");
      const f = out.files.find((x) => x.path === ".claude/settings.json");
      expect(f).toBeDefined();
      expect(f!.mergeStrategy).toBe("settings-with-hooks");
      const data = JSON.parse(f!.content);
      expect(Object.keys(data.hooks).sort()).toEqual(["PostToolUse", "UserPromptSubmit"]);
    });

    it("places asset files under hooks/<name>/ without merge strategy", () => {
      const paths = out.files.map((f) => f.path);
      expect(paths).toContain(".claude/hooks/auto-format/format.sh");
      expect(paths).toContain(".claude/hooks/auto-format/lib/common.sh");
      expect(paths).toContain(".claude/hooks/git-hint/hint.sh");
      expect(paths).not.toContain(".claude/hooks/auto-format/hook.json");
      // 资产文件没有 mergeStrategy（直接覆盖即可）
      const formatFile = out.files.find((f) => f.path === ".claude/hooks/auto-format/format.sh")!;
      expect(formatFile.mergeStrategy).toBeUndefined();
    });

    it("rewrites only relative command paths; preserves placeholders/absolute/http", () => {
      const f = out.files.find((x) => x.path === ".claude/settings.json")!;
      const post = JSON.parse(f.content).hooks.PostToolUse[0];
      expect(post.matcher).toBe("Write|Edit");
      expect(post.hooks[0]).toEqual({
        type: "command",
        command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/auto-format/format.sh",
        timeout: 30,
      });
      expect(post.hooks[1].command).toBe("${CLAUDE_PLUGIN_ROOT}/keep.sh");
      expect(post.hooks[2].command).toBe("/abs/lint");
      expect(post.hooks[3]).toEqual({ type: "http", url: "https://example.com/hook" });
    });
  });

  describe("CodeBuddyAdapter", () => {
    const out = new CodeBuddyAdapter().generate(manifest([SAMPLE_HOOK]));

    it("emits hooks into settings.json instead of hooks/hooks.json", () => {
      const paths = out.files.map((f) => f.path);
      expect(paths).toContain(".codebuddy/settings.json");
      expect(paths).not.toContain(".codebuddy/hooks/hooks.json");
    });

    it("settings.json content has hooks field with same registry shape", () => {
      const f = out.files.find((x) => x.path === ".codebuddy/settings.json")!;
      expect(f.mergeStrategy).toBe("settings-with-hooks");
      const data = JSON.parse(f.content);
      expect(data.hooks.PostToolUse).toBeDefined();
      expect(data.hooks.PostToolUse[0].matcher).toBe("Write|Edit");
    });

    it("still copies asset files under hooks/<name>/", () => {
      const paths = out.files.map((f) => f.path);
      expect(paths).toContain(".codebuddy/hooks/auto-format/format.sh");
      expect(paths).toContain(".codebuddy/hooks/auto-format/lib/common.sh");
    });

    it("relative command rewritten to use .codebuddy targetDir", () => {
      const f = out.files.find((x) => x.path === ".codebuddy/settings.json")!;
      const cmd = JSON.parse(f.content).hooks.PostToolUse[0].hooks[0].command;
      expect(cmd).toBe("${CLAUDE_PROJECT_DIR}/.codebuddy/hooks/auto-format/format.sh");
    });
  });

  describe("CodexAdapter", () => {
    const out = new CodexAdapter().generate(manifest([SAMPLE_HOOK]));

    it("emits hooks.json at top of .codex/, not nested under hooks/", () => {
      const paths = out.files.map((f) => f.path);
      expect(paths).toContain(".codex/hooks.json");
      expect(paths).not.toContain(".codex/hooks/hooks.json");
      const f = out.files.find((x) => x.path === ".codex/hooks.json")!;
      expect(f.mergeStrategy).toBe("hooks-registry");
    });

    it("still copies asset files under hooks/<name>/", () => {
      const paths = out.files.map((f) => f.path);
      expect(paths).toContain(".codex/hooks/auto-format/format.sh");
    });

    it("does not emit command/agent assets (unsupported by Codex)", () => {
      const m = manifest([
        SAMPLE_HOOK,
        {
          assetId: "cmd1",
          name: "lint",
          type: "command",
          version: "1",
          files: [{ path: "lint.md", content: "# lint" }],
          compatibleTools: ["codex", "claudecode"],
          metadata: { trigger: "/lint" },
        },
      ]);
      const codexOut = new CodexAdapter().generate(m);
      expect(codexOut.skipped.map((s) => s.name)).toContain("lint");
    });
  });

  describe("CursorAdapter", () => {
    // SAMPLE_HOOK / SAMPLE_HOOK_2 的 compatibleTools 不含 cursor，这里构造 cursor 兼容版本。
    function cursorHook(asset: ManifestAssetEntry): ManifestAssetEntry {
      return { ...asset, compatibleTools: ["cursor"] };
    }

    it("emits .cursor/hooks.json with version:1 and camelCase event names", () => {
      const out = new CursorAdapter().generate(manifest([cursorHook(SAMPLE_HOOK)]));
      const f = out.files.find((x) => x.path === ".cursor/hooks.json");
      expect(f).toBeDefined();
      expect(f!.mergeStrategy).toBe("hooks-registry");
      const data = JSON.parse(f!.content);
      expect(data.version).toBe(1);
      // PostToolUse → postToolUse
      expect(Object.keys(data.hooks)).toEqual(["postToolUse"]);
      expect(data.hooks.postToolUse[0].matcher).toBe("Write|Edit");
    });

    it("places asset files under .cursor/hooks/<name>/ without merge strategy", () => {
      const out = new CursorAdapter().generate(manifest([cursorHook(SAMPLE_HOOK)]));
      const paths = out.files.map((f) => f.path);
      expect(paths).toContain(".cursor/hooks/auto-format/format.sh");
      expect(paths).toContain(".cursor/hooks/auto-format/lib/common.sh");
      expect(paths).not.toContain(".cursor/hooks/auto-format/hook.json");
      const formatFile = out.files.find((f) => f.path === ".cursor/hooks/auto-format/format.sh")!;
      expect(formatFile.mergeStrategy).toBeUndefined();
    });

    it("rewrites relative command paths to project-relative .cursor/hooks/<name>/", () => {
      const out = new CursorAdapter().generate(manifest([cursorHook(SAMPLE_HOOK)]));
      const f = out.files.find((x) => x.path === ".cursor/hooks.json")!;
      const post = JSON.parse(f.content).hooks.postToolUse[0];
      expect(post.hooks[0]).toEqual({
        type: "command",
        command: ".cursor/hooks/auto-format/format.sh",
        timeout: 30,
      });
      // 占位符 / 绝对路径 / 非 command 类型原样透传
      expect(post.hooks[1].command).toBe("${CLAUDE_PLUGIN_ROOT}/keep.sh");
      expect(post.hooks[2].command).toBe("/abs/lint");
      expect(post.hooks[3]).toEqual({ type: "http", url: "https://example.com/hook" });
    });

    it("maps UserPromptSubmit → beforeSubmitPrompt", () => {
      const out = new CursorAdapter().generate(manifest([cursorHook(SAMPLE_HOOK_2)]));
      const f = out.files.find((x) => x.path === ".cursor/hooks.json")!;
      const data = JSON.parse(f.content);
      expect(Object.keys(data.hooks)).toEqual(["beforeSubmitPrompt"]);
    });

    it("skips hook assets whose event has no Cursor equivalent", () => {
      const unmappable = cursorHook(
        hookAsset(
          "post-compact",
          { event: "PostCompact", hooks: [{ type: "command", command: "pc.sh" }] },
          [
            { path: "hook.json", content: "{}" },
            { path: "pc.sh", content: "echo pc" },
          ],
        ),
      );
      const out = new CursorAdapter().generate(manifest([unmappable]));
      expect(out.skipped.map((s) => s.name)).toContain("post-compact");
      const paths = out.files.map((f) => f.path);
      expect(paths).not.toContain(".cursor/hooks.json");
      expect(paths.every((p) => !p.startsWith(".cursor/hooks/"))).toBe(true);
    });

    it("generateForAsset returns no accessory files for unmappable event", () => {
      const unmappable = cursorHook(
        hookAsset(
          "post-compact",
          { event: "PostCompact", hooks: [{ type: "command", command: "pc.sh" }] },
          [
            { path: "hook.json", content: "{}" },
            { path: "pc.sh", content: "echo pc" },
          ],
        ),
      );
      const files = new CursorAdapter().generateForAsset(unmappable);
      expect(files).toEqual([]);
    });
  });

  describe("multi-event hooks", () => {
    const MULTI_HOOK = hookAsset(
      "notify",
      {
        events: ["PostToolUse", "Notification"],
        matcher: "",
        hooks: [{ type: "command", command: "notify.sh" }],
      },
      [
        { path: "hook.json", content: "{}" },
        { path: "notify.sh", content: "echo n" },
      ],
    );

    it("registers the same matcherEntry under every selected event (claudecode)", () => {
      const out = new ClaudeCodeAdapter().generate(manifest([MULTI_HOOK]));
      const f = out.files.find((x) => x.path === ".claude/settings.json")!;
      const data = JSON.parse(f.content);
      expect(Object.keys(data.hooks).sort()).toEqual(["Notification", "PostToolUse"]);
      for (const ev of ["PostToolUse", "Notification"]) {
        const entry = data.hooks[ev][0];
        expect(entry.hooks[0].command).toBe("${CLAUDE_PROJECT_DIR}/.claude/hooks/notify/notify.sh");
      }
      // 附属脚本仍只落一份（hooks/<name>/）
      const scriptFiles = out.files.filter((x) => x.path === ".claude/hooks/notify/notify.sh");
      expect(scriptFiles).toHaveLength(1);
    });

    it("legacy single `event` still registers (backward compat)", () => {
      const legacy = hookAsset(
        "legacy",
        { event: "Stop", hooks: [{ type: "command", command: "s.sh" }] },
        [{ path: "s.sh", content: "echo s" }],
      );
      const out = new ClaudeCodeAdapter().generate(manifest([legacy]));
      const data = JSON.parse(out.files.find((x) => x.path === ".claude/settings.json")!.content);
      expect(Object.keys(data.hooks)).toEqual(["Stop"]);
    });

    it("cursor: only mappable events registered; all-unmappable → asset skipped", () => {
      const cursorMulti = { ...MULTI_HOOK, compatibleTools: ["cursor"] as ("cursor")[] };
      const out = new CursorAdapter().generate(manifest([cursorMulti]));
      const f = out.files.find((x) => x.path === ".cursor/hooks.json")!;
      const data = JSON.parse(f.content);
      // PostToolUse → postToolUse 可映射；Notification 无 cursor 对应 → 不注册
      expect(Object.keys(data.hooks)).toEqual(["postToolUse"]);

      const allUnmappable = {
        ...hookAsset(
          "cc-only",
          { events: ["Notification", "WorktreeCreate"], hooks: [{ type: "command", command: "x.sh" }] },
          [{ path: "x.sh", content: "echo x" }],
        ),
        compatibleTools: ["cursor"] as ("cursor")[],
      };
      const out2 = new CursorAdapter().generate(manifest([allUnmappable]));
      expect(out2.skipped.map((s) => s.name)).toContain("cc-only");
    });

    it("passthrough registrations: verbatim per-event entries, no command rewrite", () => {
      const foreign = hookAsset(
        "wecom-notification",
        {
          events: ["Notification", "Stop"],
          passthrough: true,
          hooks: [{ type: "command", command: "bash wecom-notification.sh" }],
          registrations: [
            {
              event: "Notification",
              entry: { matcher: "", hooks: [{ type: "command", command: "bash .claude/hooks/wecom-notification.sh" }], description: "企微通知" },
            },
            {
              event: "Stop",
              entry: { hooks: [{ type: "command", command: "bash .claude/hooks/wecom-notification.sh" }] },
            },
          ],
        },
        [{ path: ".claude/hooks/wecom-notification.sh", content: "echo n" }],
      );
      const out = new ClaudeCodeAdapter().generate(manifest([foreign]));
      const data = JSON.parse(out.files.find((x) => x.path === ".claude/settings.json")!.content);
      // 注册项逐字保留：命令不加占位符前缀、description 不丢
      expect(data.hooks.Notification[0]).toEqual({
        matcher: "",
        hooks: [{ type: "command", command: "bash .claude/hooks/wecom-notification.sh" }],
        description: "企微通知",
      });
      expect(data.hooks.Stop[0]).toEqual({
        hooks: [{ type: "command", command: "bash .claude/hooks/wecom-notification.sh" }],
      });
      // 附属脚本按 passthrough 精确路径落盘（不搬进 hooks/<name>/ 目录）
      expect(out.files.map((x) => x.path)).toContain(".claude/hooks/wecom-notification.sh");
      expect(out.files.some((x) => x.path.startsWith(".claude/hooks/wecom-notification/"))).toBe(false);
    });
  });
});
