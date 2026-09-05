/**
 * `vendor-reader.ts` 单元测试 —— 验证厂商目录解析逻辑。
 *
 * 覆盖：
 * - skills（目录式 + 平铺）
 * - rules / commands / agents
 * - hooks（带 hook.json）
 * - MCP（vendor 内 mcp.json + ClaudeCode 根 .mcp.json）
 * - 空目录
 * - compatibleTools 固定为推送厂商
 * - 二进制文件 base64 编码
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVendorDir } from "../lib/vendor-reader.js";

describe("parseVendorDir", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loom-vr-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("解析目录式 skill（skills/<name>/SKILL.md）", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "skills", "my-skill"), { recursive: true });
    writeFileSync(join(claudeDir, "skills", "my-skill", "SKILL.md"), "# My Skill\n\ncontent");
    writeFileSync(join(claudeDir, "skills", "my-skill", "extra.md"), "extra file");

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(1);
    const skill = assets[0]!;
    expect(skill.type).toBe("skill");
    expect(skill.name).toBe("my-skill");
    expect(skill.sourcePath).toBe("skills/my-skill");
    expect(skill.files).toHaveLength(2);
    expect(skill.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "extra.md"]);
    expect(skill.compatibleTools).toEqual(["claudecode"]);
    expect(skill.metadata).toEqual({});
  });

  it("解析平铺 skill（skills/<name>.md → 规范化为 SKILL.md）", async () => {
    const cursorDir = join(root, ".cursor");
    mkdirSync(join(cursorDir, "skills"), { recursive: true });
    writeFileSync(join(cursorDir, "skills", "flat-skill.md"), "# Flat Skill");

    const assets = await parseVendorDir(cursorDir, "cursor", root);
    expect(assets).toHaveLength(1);
    const skill = assets[0]!;
    expect(skill.name).toBe("flat-skill");
    expect(skill.sourcePath).toBe("skills/flat-skill");
    expect(skill.files).toHaveLength(1);
    expect(skill.files[0]!.path).toBe("SKILL.md");
    expect(skill.files[0]!.content).toBe("# Flat Skill");
  });

  it("忽略 skills/ 下的非规范文件（如 llms.txt）—— 不是 skill", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "skills"), { recursive: true });
    // 非 markdown 的松散文件，不符合 skill 规范
    writeFileSync(join(claudeDir, "skills", "llms.txt"), "not a skill");
    // 缺 SKILL.md 的目录，也不符合规范
    mkdirSync(join(claudeDir, "skills", "broken"), { recursive: true });
    writeFileSync(join(claudeDir, "skills", "broken", "notes.txt"), "no SKILL.md here");

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(0);
  });

  it("解析 rule（含 frontmatter globs）", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "rules"), { recursive: true });
    writeFileSync(
      join(claudeDir, "rules", "ts-rule.md"),
      "---\nglobs: [\"*.ts\", \"*.tsx\"]\ndescription: TS rules\n---\nbe strict",
    );

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(1);
    const rule = assets[0]!;
    expect(rule.type).toBe("rule");
    expect(rule.name).toBe("ts-rule");
    expect(rule.description).toBe("TS rules");
    expect(rule.metadata).toEqual({ globs: ["*.ts", "*.tsx"] });
  });

  it("解析 command（metadata.trigger 自动设为 /<name>）", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "commands"), { recursive: true });
    writeFileSync(join(claudeDir, "commands", "lint.md"), "run lint");

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(1);
    const cmd = assets[0]!;
    expect(cmd.type).toBe("command");
    expect(cmd.name).toBe("lint");
    expect(cmd.metadata).toEqual({ trigger: "/lint" });
  });

  it("解析 agent", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "agents"), { recursive: true });
    writeFileSync(join(claudeDir, "agents", "reviewer.md"), "You are a reviewer");

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.type).toBe("agent");
    expect(assets[0]!.name).toBe("reviewer");
    expect(assets[0]!.metadata).toEqual({});
  });

  it("解析 hook（带 hook.json）", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "hooks", "my-hook"), { recursive: true });
    writeFileSync(
      join(claudeDir, "hooks", "my-hook", "hook.json"),
      JSON.stringify({
        event: "PreToolUse",
        matcher: "*",
        hooks: [{ type: "command", command: "echo hi" }],
      }),
    );
    writeFileSync(join(claudeDir, "hooks", "my-hook", "script.sh"), "echo hi");

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(1);
    const hook = assets[0]!;
    expect(hook.type).toBe("hook");
    expect(hook.name).toBe("my-hook");
    expect(hook.sourcePath).toBe("hooks/my-hook");
    expect(hook.metadata).toEqual({
      events: ["PreToolUse"],
      matcher: "*",
      hooks: [{ type: "command", command: "echo hi" }],
    });
    expect(hook.files).toHaveLength(2);
  });

  it("解析 hook（hook.json 多事件 events[]）", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "hooks", "multi"), { recursive: true });
    writeFileSync(
      join(claudeDir, "hooks", "multi", "hook.json"),
      JSON.stringify({
        events: ["PreToolUse", "Notification", "InvalidEvent"],
        hooks: [{ type: "command", command: "echo hi" }],
      }),
    );

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(1);
    // 非法事件名被过滤，合法事件全部保留
    expect(assets[0]!.metadata).toEqual({
      events: ["PreToolUse", "Notification"],
      hooks: [{ type: "command", command: "echo hi" }],
    });
  });

  it("跳过无效 hook（缺 hook.json 或无效 event）", async () => {
    const claudeDir = join(root, ".claude");
    // 无 hook.json 的目录
    mkdirSync(join(claudeDir, "hooks", "no-manifest"), { recursive: true });
    writeFileSync(join(claudeDir, "hooks", "no-manifest", "script.sh"), "echo");
    // 无效 event
    mkdirSync(join(claudeDir, "hooks", "bad-event"), { recursive: true });
    writeFileSync(
      join(claudeDir, "hooks", "bad-event", "hook.json"),
      JSON.stringify({ event: "InvalidEvent", hooks: [{ type: "command" }] }),
    );

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(0);
  });

  it("解析 vendor 内 mcp.json（非 claudecode）", async () => {
    const cursorDir = join(root, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "fs-server": { command: "npx", args: ["-y", "@mcp/fs"] },
          "http-server": { url: "https://example.com/sse", type: "sse" },
        },
      }),
    );

    const assets = await parseVendorDir(cursorDir, "cursor", root);
    expect(assets).toHaveLength(2);
    const names = assets.map((a) => a.name).sort();
    expect(names).toEqual(["fs-server", "http-server"]);

    const fsServer = assets.find((a) => a.name === "fs-server")!;
    expect(fsServer.type).toBe("mcp");
    expect(fsServer.metadata).toEqual({ transport: "stdio", command: "npx -y @mcp/fs" });

    const httpServer = assets.find((a) => a.name === "http-server")!;
    expect(httpServer.metadata).toEqual({ transport: "sse", url: "https://example.com/sse" });
  });

  it("ClaudeCode 从项目根 .mcp.json 解析 MCP", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    // 项目根的 .mcp.json
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { "root-mcp": { command: "node", args: ["server.js"] } } }),
    );

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    const mcp = assets.find((a) => a.type === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp!.name).toBe("root-mcp");
    expect(mcp!.sourcePath).toBe(".mcp.json#root-mcp");
  });

  it("空厂商目录返回空数组", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "random"), { recursive: true });
    writeFileSync(join(claudeDir, "random", "notes.md"), "not a recognized type");

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(0);
  });

  it("compatibleTools 固定为推送厂商", async () => {
    const codebuddyDir = join(root, ".codebuddy");
    mkdirSync(join(codebuddyDir, "skills", "test-skill"), { recursive: true });
    writeFileSync(join(codebuddyDir, "skills", "test-skill", "SKILL.md"), "# test");

    const assets = await parseVendorDir(codebuddyDir, "codebuddy", root);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.compatibleTools).toEqual(["codebuddy"]);
  });

  it("二进制文件使用 base64 编码", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "skills", "img-skill"), { recursive: true });
    writeFileSync(join(claudeDir, "skills", "img-skill", "SKILL.md"), "# skill with image");
    // 写入一个 PNG 文件（以 0x89 PNG header 开头）
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(claudeDir, "skills", "img-skill", "icon.png"), pngHeader);

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    const skill = assets[0]!;
    const icon = skill.files.find((f) => f.path === "icon.png");
    expect(icon).toBeDefined();
    expect(icon!.encoding).toBe("base64");
    // 解码后应为原始 PNG header
    expect(Buffer.from(icon!.content, "base64")).toEqual(pngHeader);
  });

  it("frontmatter 中的 description 和 tags 被提取", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "skills", "fm-skill"), { recursive: true });
    writeFileSync(
      join(claudeDir, "skills", "fm-skill", "SKILL.md"),
      "---\ndescription: A skill with frontmatter\ntags: [\"typescript\", \"testing\"]\n---\nbody",
    );

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    const skill = assets[0]!;
    expect(skill.description).toBe("A skill with frontmatter");
    expect(skill.tags).toEqual(["typescript", "testing"]);
  });

  it("多类型混合解析", async () => {
    const claudeDir = join(root, ".claude");
    mkdirSync(join(claudeDir, "skills", "s1"), { recursive: true });
    writeFileSync(join(claudeDir, "skills", "s1", "SKILL.md"), "# s1");
    mkdirSync(join(claudeDir, "rules"), { recursive: true });
    writeFileSync(join(claudeDir, "rules", "r1.md"), "rule 1");
    mkdirSync(join(claudeDir, "commands"), { recursive: true });
    writeFileSync(join(claudeDir, "commands", "c1.md"), "cmd 1");

    const assets = await parseVendorDir(claudeDir, "claudecode", root);
    expect(assets).toHaveLength(3);
    const types = assets.map((a) => a.type).sort();
    expect(types).toEqual(["command", "rule", "skill"]);
  });
});
