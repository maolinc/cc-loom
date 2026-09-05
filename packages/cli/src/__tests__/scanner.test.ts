/**
 * `scanProjectState` 是 web 端"本地镜像"的真值入口。这组测试把几个真实事故
 * 场景固化下来：
 *
 *  1. 目录式资产（dir-layout）扫描出来必须保留 `<typeDir>/<name>/` 嵌套，
 *     不能被错误地展平成"<name>" 这一个文件节点。
 *  2. 平铺资产（flat）正常呈现为 typeDir 直下的文件。
 *  3. ClaudeCode 的项目根 `.mcp.json` 必须被合并到 claudecode 树顶部，
 *     否则用户在镜像里完全看不到这个文件。
 *  4. drift 自动修复：lock 中所有文件全部不在磁盘上时，scan 主动删 lock 并把
 *     `installedWorkspaceId` 设为 null（avoid 假装"已安装"的鬼态）。
 *  5. 部分缺失只计 `missingCount`，不动 lock（保留下次手动重装的可能）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import type { AssetType, LocalFileNode, LocalProjectState, TargetTool } from "@maolinc/cc-loom-shared";
import type { LocalProjectRecord } from "../lib/projects.js";
import { scanProjectState } from "../lib/scanner.js";
import { writeLock, readLock, removeLock } from "../lib/locks.js";
import { ensureLoomDirs } from "../lib/paths.js";

function makeProject(root: string, id = "p-test"): LocalProjectRecord {
  return {
    id,
    deviceId: "d",
    userId: "u",
    projectName: "test",
    normalizedPath: root,
    registeredAt: new Date().toISOString(),
    detectedTargets: [],
    defaultTargets: [],
    subscriptions: [],
    status: "online",
    endpoint: "http://localhost:0",
  };
}

describe("scanProjectState", () => {
  let root: string;

  beforeEach(() => {
    ensureLoomDirs();
    root = mkdtempSync(join(tmpdir(), "loom-scanner-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // 测试间清理可能残留的 lock
    try { removeLock("p-test"); } catch { /* ignore */ }
  });

  it("dir-layout 资产保留 <name>/ 嵌套，flat 资产仍是 typeDir 直下文件", () => {
    // dir-layout: skills/skill-scout/SKILL.md
    mkdirSync(join(root, ".cursor/skills/skill-scout"), { recursive: true });
    writeFileSync(join(root, ".cursor/skills/skill-scout/SKILL.md"), "# scout");
    // flat: skills/accessibility.md
    writeFileSync(join(root, ".cursor/skills/accessibility.md"), "# flat");
    // 多文件 dir-layout: rules/typescript/{coding-style,patterns}.md
    mkdirSync(join(root, ".cursor/rules/typescript"), { recursive: true });
    writeFileSync(join(root, ".cursor/rules/typescript/coding-style.md"), "x");
    writeFileSync(join(root, ".cursor/rules/typescript/patterns.md"), "y");

    const state = scanProjectState(makeProject(root));
    const cursor = state.vendors.cursor;
    expect(cursor.exists).toBe(true);

    // 顶层应有 rules + skills
    const tops = cursor.tree.map((n) => n.name).sort();
    expect(tops).toEqual(["rules", "skills"]);

    const skills = cursor.tree.find((n) => n.name === "skills");
    expect(skills?.type).toBe("dir");
    const skillChildren = (skills?.children ?? []).map((n) => ({ name: n.name, type: n.type }));
    // skill-scout 必须是 dir，不能扁平化
    expect(skillChildren).toContainEqual({ name: "skill-scout", type: "dir" });
    expect(skillChildren).toContainEqual({ name: "accessibility.md", type: "file" });

    const scout = skills!.children!.find((n) => n.name === "skill-scout");
    expect(scout?.children?.[0]?.path).toBe(".cursor/skills/skill-scout/SKILL.md");

    const rules = cursor.tree.find((n) => n.name === "rules");
    const ts = rules?.children?.find((n) => n.name === "typescript");
    expect(ts?.type).toBe("dir");
    expect((ts?.children ?? []).map((n) => n.name).sort()).toEqual(["coding-style.md", "patterns.md"]);
  });

  it("项目下没有任何厂商目录 → 4 个 vendor 全部 exists=false", () => {
    const state = scanProjectState(makeProject(root));
    for (const tool of ["cursor", "codebuddy", "codex", "claudecode"] as const) {
      expect(state.vendors[tool].exists).toBe(false);
      expect(state.vendors[tool].tree).toEqual([]);
      expect(state.vendors[tool].managedCount).toBe(0);
      expect(state.vendors[tool].externalCount).toBe(0);
    }
    expect(state.installedWorkspaceIds).toEqual([]);
    expect(state.driftCleared).toBe(false);
  });

  it("项目根 .mcp.json 被合并到 claudecode 树顶部", () => {
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/foo.md"), "x");
    writeFileSync(join(root, ".mcp.json"), '{"mcpServers":{}}');

    const state = scanProjectState(makeProject(root));
    const cc = state.vendors.claudecode;
    expect(cc.exists).toBe(true);

    // .mcp.json 应当作为 claudecode 树顶部第一个节点（unshift）
    expect(cc.tree[0]?.name).toBe(".mcp.json");
    expect(cc.tree[0]?.path).toBe(".mcp.json");
    expect(cc.tree[0]?.type).toBe("file");
    // 不在 lock 里 → managed=false，计入外部数
    expect(cc.tree[0]?.managed).toBe(false);
    expect(cc.externalCount).toBeGreaterThanOrEqual(1);
  });

  it("项目根 .mcp.json 在 lock 中 → 计入 claudecode managed 计数", () => {
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/foo.md"), "x");
    writeFileSync(join(root, ".mcp.json"), '{"mcpServers":{}}');
    writeLock("p-test", {
      subscriptions: [{ workspaceId: "ws1", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
      version: "1",
      assets: { __plan__: { version: "1", files: [".claude/skills/foo.md", ".mcp.json"] } },
    });

    const state = scanProjectState(makeProject(root));
    const cc = state.vendors.claudecode;
    expect(state.installedWorkspaceIds).toEqual(["ws1"]);
    expect(state.driftCleared).toBe(false);
    // foo.md 和 .mcp.json 都应是 managed
    expect(cc.tree[0]?.name).toBe(".mcp.json");
    expect(cc.tree[0]?.managed).toBe(true);
    expect(cc.managedCount).toBe(2);
    expect(cc.missingCount).toBe(0);
  });

  it("lock 文件全部缺失 → 自动清空 lock (driftCleared=true)", () => {
    // 不创建任何 vendor 目录，但写一个引用不存在文件的 lock
    writeLock("p-test", {
      subscriptions: [{ workspaceId: "ws-bogus", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
      version: "1",
      assets: { __plan__: { version: "1", files: [".cursor/skills/nope.md", ".claude/agents/x.md"] } },
    });
    expect(readLock("p-test")).not.toBeNull();

    const state = scanProjectState(makeProject(root));
    expect(state.driftCleared).toBe(true);
    expect(state.installedWorkspaceIds).toEqual([]);
    // lock 应被自动删除
    expect(readLock("p-test")).toBeNull();
  });

  it("lock 部分文件缺失 → missingCount > 0，但 lock 不动", () => {
    mkdirSync(join(root, ".cursor/skills"), { recursive: true });
    // 只写 foo.md，bar.md 缺失
    writeFileSync(join(root, ".cursor/skills/foo.md"), "x");
    writeLock("p-test", {
      subscriptions: [{ workspaceId: "ws-partial", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
      version: "1",
      assets: { __plan__: { version: "1", files: [".cursor/skills/foo.md", ".cursor/skills/bar.md"] } },
    });

    const state = scanProjectState(makeProject(root));
    // 有部分命中 → 不触发 drift 自动清空
    expect(state.driftCleared).toBe(false);
    expect(state.installedWorkspaceIds).toEqual(["ws-partial"]);
    // lock 仍在
    expect(readLock("p-test")).not.toBeNull();
    // 计数：managed 1, missing 1
    expect(state.vendors.cursor.managedCount).toBe(1);
    expect(state.vendors.cursor.missingCount).toBe(1);
  });

  it("受管 MCP 被 disable 后，磁盘残留同名 server 不重复成外部能力", () => {
    // 复现：本地镜像里同名 MCP 出现两行（受管 disabled + 外部）。
    // 受管 pencil（disabled）→ 聚合未登记 lock.aggregates；磁盘 .mcp.json 仍有 pencil。
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { pencil: { command: "npx-pencil" } } }, null, 2),
    );
    writeLock("p-test", {
      subscriptions: [{ workspaceId: "ws", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
      version: "1",
      lockFormat: "2",
      assets: {
        "asset-pencil": {
          version: "1.0.0",
          files: [],
          name: "pencil",
          type: "mcp",
          vendors: { claudecode: { enabled: false, files: [] } },
        },
      },
    });

    const state = scanProjectState(makeProject(root));
    const pencils = (state.capabilities ?? []).filter(
      (c) => c.type === "mcp" && c.name === "pencil",
    );
    // 只应有一行（受管 disabled），不再额外出现 external 行
    expect(pencils).toHaveLength(1);
    expect(pencils[0]?.external).not.toBe(true);
    expect(pencils[0]?.assetId).toBe("asset-pencil");
  });

  it("受管 wrapped MCP（资产名 ≠ 内层 server key）不重复成外部能力", () => {
    // 复现：安装 tapd 资产，资产名 = tapd_mcp，但内容是 wrapped
    // {mcpServers:{tapd_mcp_http:{...}}}，内层 server key = tapd_mcp_http。
    // adapter 正确按内层 key 落盘 .mcp.json，lock 按资产名登记；
    // buildV2Lock 在 aggregate 上持久化 serverKeys（真实 key → assetId）。
    // 若 scanner 不消费 serverKeys、退回用 entry.name 当 server key，会与磁盘
    // 真实 key 错配，能力视图出现两行：tapd_mcp（受管）+ tapd_mcp_http（外部）。
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { tapd_mcp_http: { type: "http", url: "x" } } }, null, 2),
    );
    writeLock("p-test", {
      subscriptions: [{ workspaceId: "ws", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
      version: "1",
      lockFormat: "2",
      assets: {
        "asset-tapd": {
          version: "1.0.0",
          files: [],
          name: "tapd_mcp",
          type: "mcp",
          vendors: { claudecode: { enabled: true, files: [] } },
        },
      },
      aggregates: {
        claudecode: [
          {
            file: ".mcp.json",
            contributingAssetIds: ["asset-tapd"],
            serverKeys: { tapd_mcp_http: "asset-tapd" },
          },
        ],
      },
    });

    const state = scanProjectState(makeProject(root));
    const mcps = (state.capabilities ?? []).filter((c) => c.type === "mcp");
    // 只应有一行受管 MCP，不额外出现按 server key 命名的外部行
    expect(mcps).toHaveLength(1);
    expect(mcps[0]?.assetId).toBe("asset-tapd");
    expect(mcps[0]?.external).not.toBe(true);
    // 该 server 子节点应被标 managed（有 assetId），不再被判为外部
    const cc = state.vendors.claudecode;
    const mcpNode = cc.tree.find((n) => n.name === ".mcp.json");
    const serverChild = (mcpNode?.children ?? []).find((n) => n.name === "tapd_mcp_http");
    expect(serverChild?.assetId).toBe("asset-tapd");
    expect(serverChild?.managed).toBe(true);
    expect(cc.externalCount).toBe(0);
  });

  it("旧 lock（无 serverKeys）单资产 wrapped MCP 也归一，无需 re-sync", () => {
    // 复现用户真实磁盘状态：lock 是修复前写入的旧格式——aggregate 无 serverKeys，
    // 只有 contributingAssetIds。资产名 tapd_mcp ≠ 内层 server key tapd_mcp_http。
    // 升级到修复版后不应要求用户先 re-sync 才恢复正确显示。
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { tapd_mcp_http: { type: "http", url: "x" } } }, null, 2),
    );
    writeLock("p-test", {
      subscriptions: [{ workspaceId: "ws", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
      version: "1",
      lockFormat: "2",
      assets: {
        "asset-tapd": {
          version: "1.0.0",
          files: [],
          name: "tapd_mcp",
          type: "mcp",
          vendors: { claudecode: { enabled: true, files: [] } },
        },
      },
      // 旧格式：无 serverKeys 字段
      aggregates: {
        claudecode: [{ file: ".mcp.json", contributingAssetIds: ["asset-tapd"] }],
      },
    });

    const state = scanProjectState(makeProject(root));
    const mcps = (state.capabilities ?? []).filter((c) => c.type === "mcp");
    expect(mcps).toHaveLength(1);
    expect(mcps[0]?.assetId).toBe("asset-tapd");
    expect(state.vendors.claudecode.externalCount).toBe(0);
  });

  it("符号链接条目被忽略，不进入 tree（防绕过）", () => {
    mkdirSync(join(root, ".cursor/skills"), { recursive: true });
    writeFileSync(join(root, ".cursor/skills/real.md"), "ok");
    // 制造一个指向 /etc/passwd 的符号链接
    try {
      symlinkSync("/etc/passwd", join(root, ".cursor/skills/escape.md"));
    } catch {
      // 没权限/不支持 symlink 时跳过断言
      return;
    }

    const state = scanProjectState(makeProject(root));
    const skills = state.vendors.cursor.tree.find((n) => n.name === "skills");
    const names = (skills?.children ?? []).map((n) => n.name);
    expect(names).toContain("real.md");
    expect(names).not.toContain("escape.md");
  });
});

describe("scanProjectState — sourcePath 标记", () => {
  // 这组覆盖 lock 中文件路径与磁盘文件的对账逻辑，与 install plan 的
  // sourcePath 透传配套：plan 决定文件落在 dir-layout 还是 flat-layout 路径，
  // scanner 决定这些路径是否被识别为 managed。
  let root: string;

  beforeEach(() => {
    ensureLoomDirs();
    root = mkdtempSync(join(tmpdir(), "loom-scanner-source-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    try { removeLock("p-test"); } catch { /* ignore */ }
  });

  it("dir-layout 文件出现在 lock 时 managed=true，与 flat 路径互不干扰", () => {
    mkdirSync(join(root, ".cursor/skills/skill-scout"), { recursive: true });
    writeFileSync(join(root, ".cursor/skills/skill-scout/SKILL.md"), "x");
    writeFileSync(join(root, ".cursor/skills/extra.md"), "y"); // 外部文件

    writeLock("p-test", {
      subscriptions: [{ workspaceId: "ws", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
      version: "1",
      assets: { __plan__: { version: "1", files: [".cursor/skills/skill-scout/SKILL.md"] } },
    });

    const state = scanProjectState(makeProject(root));
    const skills = state.vendors.cursor.tree.find((n) => n.name === "skills");
    const scout = skills?.children?.find((n) => n.name === "skill-scout");
    const skillFile = scout?.children?.find((n) => n.name === "SKILL.md");
    const extra = skills?.children?.find((n) => n.name === "extra.md");

    expect(skillFile?.managed).toBe(true);
    expect(extra?.managed).toBe(false);
    expect(state.vendors.cursor.managedCount).toBe(1);
    expect(state.vendors.cursor.externalCount).toBe(1);
  });

  it("README 文档文件不构成外部能力单元（hooks/README.md 不是 hook）", () => {
    // 回归：能力类型目录下「每个顶层文件 = 1 单元」的规则曾把 hooks/README.md
    // 识别成名为 README 的 hook 能力。README（任意扩展名/大小写）是文档，应跳过。
    mkdirSync(join(root, ".claude/hooks"), { recursive: true });
    writeFileSync(join(root, ".claude/hooks/README.md"), "# hooks 说明");
    writeFileSync(join(root, ".claude/hooks/notify.sh"), "echo hi");
    writeFileSync(
      join(root, ".claude/settings.json"),
      JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: "command", command: "bash .claude/hooks/notify.sh" }] }] } }),
    );
    mkdirSync(join(root, ".claude/skills"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/readme.txt"), "说明");
    writeFileSync(join(root, ".claude/skills/scout.md"), "x");

    const state = scanProjectState(makeProject(root));
    const caps = state.capabilities ?? [];
    // 只有真实能力：已注册 hook notify + skill scout；README/readme 不产生能力行
    expect(caps.map((c) => `${c.type}:${c.name}`).sort()).toEqual(["hook:notify", "skill:scout"]);
    expect(state.vendors.claudecode.externalCount).toBe(2);
    // README.md 仍作为普通文件出现在厂商树里（磁盘事实），只是不标注为能力
    const hooksDir = state.vendors.claudecode.tree.find((n) => n.name === "hooks");
    const readmeNode = hooksDir?.children?.find((n) => n.name === "README.md");
    expect(readmeNode).toBeTruthy();
    expect(readmeNode?.assetId).toBeUndefined();
  });

  it("hooks/ 下未注册的脚本不是 hook 能力（hook 以注册为准）", () => {
    // 语义：skill/rule/command/agent 入目录即被工具加载；hook 脚本必须在
    // settings.json/hooks.json 注册才会触发。未注册脚本只是普通文件——
    // 不显示为「开关为开」的能力（且 adopt 会因找不到注册项而失败）。
    mkdirSync(join(root, ".claude/hooks"), { recursive: true });
    writeFileSync(join(root, ".claude/hooks/stray.sh"), "echo stray");
    writeFileSync(join(root, ".claude/hooks/registered.sh"), "echo ok");
    writeFileSync(
      join(root, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "bash .claude/hooks/registered.sh" }] }],
          Stop: [{ hooks: [{ type: "command", command: "bash .claude/hooks/registered.sh" }] }],
        },
      }),
    );

    const state = scanProjectState(makeProject(root));
    const caps = state.capabilities ?? [];
    // 只有已注册的 registered；stray.sh 不产生能力行
    expect(caps.map((c) => `${c.type}:${c.name}`)).toEqual(["hook:registered"]);
    // 注册事件标注：两个事件都反查到
    expect(caps[0]?.vendors.claudecode?.hookEvents?.sort()).toEqual(["PreToolUse", "Stop"]);
    // stray.sh 在厂商树里仍是普通文件（无 assetId 标注）
    const hooksDir = state.vendors.claudecode.tree.find((n) => n.name === "hooks");
    const stray = hooksDir?.children?.find((n) => n.name === "stray.sh");
    expect(stray).toBeTruthy();
    expect(stray?.assetId).toBeUndefined();
    expect(state.vendors.claudecode.externalCount).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 两视图一致性不变量：能力视图（state.capabilities）与厂商视图
// （state.vendors[tool].tree + managedAssetCount/externalCount）必须共用同一份
// 真值，差异只在 UI 分组。这组测试锁定跨视图不变量，防「两路各算」回潮。
// ────────────────────────────────────────────────────────────────────────
function findNodeByAssetId(nodes: LocalFileNode[], assetId: string): LocalFileNode | undefined {
  for (const n of nodes) {
    if (n.assetId === assetId) return n;
    if (n.children) {
      const f = findNodeByAssetId(n.children, assetId);
      if (f) return f;
    }
  }
  return undefined;
}

/**
 * 断言两视图一致。仅对 v2 lock（非 legacy/非 drift）断言计数不变量——
 * legacy lock 无 per-asset 结构，能力视图本就不含受管行（UI 提示重新安装）。
 */
function assertViewConsistency(state: LocalProjectState) {
  const caps = state.capabilities ?? [];
  // 不变量 1：无重复 (type, name) 行
  const keys = caps.map((c) => `${c.type}:${c.name}`);
  expect(new Set(keys).size).toBe(caps.length);

  for (const tool of TARGET_TOOLS) {
    const vm = state.vendors[tool];
    if (!vm.exists) continue;
    const rowsWithTool = caps.filter((c) => c.vendors[tool]);
    const extRows = rowsWithTool.filter((c) => c.vendors[tool]!.external).length;
    const managedRows = rowsWithTool.length - extRows;
    // 不变量 2：externalCount === 该 tool 的外部能力行数
    expect(vm.externalCount).toBe(extRows);
    // 不变量 3：managedAssetCount === 该 tool 的受管能力行数
    expect(vm.managedAssetCount).toBe(managedRows);
    // 不变量 4：CountIndicator total（managedAssetCount+externalCount）=== 该 tool 能力行数
    expect(vm.managedAssetCount + vm.externalCount).toBe(rowsWithTool.length);
  }

  // 不变量 5：每条受管能力的 vendors[tool].enabled 与厂商树对应节点 enabled 一致
  // （mcp 对应 mcp-server 虚拟子节点；非 mcp 对应文件节点 / disabled 占位）
  for (const cap of caps) {
    for (const toolStr of Object.keys(cap.vendors)) {
      const tool = toolStr as TargetTool;
      const cv = cap.vendors[tool]!;
      if (cv.external) continue; // 外部格：树节点恒 enabled=true，不参与开关不变量
      const vm = state.vendors[tool];
      if (!vm?.exists) continue;
      const node = findNodeByAssetId(vm.tree, cap.assetId);
      expect(node).toBeDefined();
      expect(node!.enabled).toBe(cv.enabled);
    }
  }
}

describe("scanProjectState — 两视图一致性不变量", () => {
  let root: string;

  beforeEach(() => {
    ensureLoomDirs();
    root = mkdtempSync(join(tmpdir(), "loom-scanner-consistency-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    try { removeLock("p-consistency"); } catch { /* ignore */ }
  });

  function proj(): LocalProjectRecord {
    return {
      id: "p-consistency", deviceId: "d", userId: "u", projectName: "c",
      normalizedPath: root, registeredAt: new Date().toISOString(),
      detectedTargets: [], defaultTargets: [], subscriptions: [],
      status: "online", endpoint: "http://localhost:0",
    };
  }

  it("混合场景：受管 skill(enabled/disabled) + 受管 wrapped MCP + 外部 skill + 外部 MCP", () => {
    // 受管 skill alpha（cursor + claudecode，enabled）
    mkdirSync(join(root, ".cursor/skills/alpha"), { recursive: true });
    writeFileSync(join(root, ".cursor/skills/alpha/SKILL.md"), "alpha");
    mkdirSync(join(root, ".claude/skills/alpha"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/alpha/SKILL.md"), "alpha");
    // 受管 skill beta（cursor，disabled → 不在磁盘，占位）
    // 受管 wrapped MCP tapd_mcp（claudecode，server key tapd_mcp_http，enabled）
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { tapd_mcp_http: { type: "http", url: "x" } } }, null, 2),
    );
    // 外部 skill scout（cursor 磁盘，不在 lock）
    mkdirSync(join(root, ".cursor/skills/scout"), { recursive: true });
    writeFileSync(join(root, ".cursor/skills/scout/SKILL.md"), "scout");
    // 外部 MCP foreign（cursor mcp.json，不在 lock）
    writeFileSync(
      join(root, ".cursor/mcp.json"),
      JSON.stringify({ mcpServers: { foreign: { command: "x" } } }, null, 2),
    );

    writeLock("p-consistency", {
      subscriptions: [{ workspaceId: "ws", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }],
      version: "1",
      lockFormat: "2",
      assets: {
        "asset-alpha": {
          version: "1.0.0", files: [
            ".cursor/skills/alpha/SKILL.md", ".claude/skills/alpha/SKILL.md",
          ], name: "alpha", type: "skill",
          vendors: {
            cursor: { enabled: true, files: [".cursor/skills/alpha/SKILL.md"] },
            claudecode: { enabled: true, files: [".claude/skills/alpha/SKILL.md"] },
          },
        },
        "asset-beta": {
          version: "1.0.0", files: [], name: "beta", type: "skill",
          vendors: { cursor: { enabled: false, files: [".cursor/skills/beta/SKILL.md"] } },
        },
        "asset-tapd": {
          version: "1.0.0", files: [], name: "tapd_mcp", type: "mcp",
          vendors: { claudecode: { enabled: true, files: [] } },
        },
      },
      aggregates: {
        claudecode: [{
          file: ".mcp.json", contributingAssetIds: ["asset-tapd"],
          serverKeys: { tapd_mcp_http: "asset-tapd" },
        }],
      },
    });

    const state = scanProjectState(proj());
    assertViewConsistency(state);

    // 额外定点：wrapped MCP 只有一行受管，外部 MCP 是独立一行（不同 server key）
    const mcps = (state.capabilities ?? []).filter((c) => c.type === "mcp");
    expect(mcps.map((c) => c.name).sort()).toEqual(["foreign", "tapd_mcp"]);
    const tapd = mcps.find((c) => c.assetId === "asset-tapd")!;
    expect(tapd.external).not.toBe(true);
    // 受管 MCP 行带 mcp.json 路径（修复历史 presentCount=0）
    expect(tapd.vendors.claudecode?.files).toEqual([".mcp.json"]);
    expect(tapd.vendors.claudecode?.presentCount).toBe(1);
    // 外部 MCP 行同样带 mcp.json 路径
    const foreign = mcps.find((c) => c.name === "foreign")!;
    expect(foreign.vendors.cursor?.files).toEqual([".cursor/mcp.json"]);
    expect(foreign.external).toBe(true);
  });

  it("多 wrapped MCP 跨厂商：各自 server key 归属正确，不串行", () => {
    // 两个 wrapped MCP 资产，server key 各不同，跨 cursor + claudecode
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { svc_a: { command: "a" }, svc_b: { command: "b" } } }, null, 2),
    );
    writeFileSync(
      join(root, ".cursor/mcp.json"),
      JSON.stringify({ mcpServers: { svc_a: { command: "a" }, svc_b: { command: "b" } } }, null, 2),
    );
    writeLock("p-consistency", {
      subscriptions: [{ workspaceId: "ws", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }], version: "1", lockFormat: "2",
      assets: {
        "asset-a": {
          version: "1.0.0", files: [], name: "mcp_a", type: "mcp",
          vendors: {
            cursor: { enabled: true, files: [] },
            claudecode: { enabled: true, files: [] },
          },
        },
        "asset-b": {
          version: "1.0.0", files: [], name: "mcp_b", type: "mcp",
          vendors: {
            cursor: { enabled: true, files: [] },
            claudecode: { enabled: true, files: [] },
          },
        },
      },
      aggregates: {
        cursor: [{
          file: ".cursor/mcp.json", contributingAssetIds: ["asset-a", "asset-b"],
          serverKeys: { svc_a: "asset-a", svc_b: "asset-b" },
        }],
        claudecode: [{
          file: ".mcp.json", contributingAssetIds: ["asset-a", "asset-b"],
          serverKeys: { svc_a: "asset-a", svc_b: "asset-b" },
        }],
      },
    });

    const state = scanProjectState(proj());
    assertViewConsistency(state);

    // 两行受管 MCP，分别归属正确（server key ↔ assetId）
    const mcps = (state.capabilities ?? []).filter((c) => c.type === "mcp");
    expect(mcps).toHaveLength(2);
    for (const tool of ["cursor", "claudecode"] as const) {
      const vm = state.vendors[tool];
      const mcpFile = tool === "claudecode" ? ".mcp.json" : ".cursor/mcp.json";
      const mcpNode = vm.tree.find((n) => n.path === mcpFile);
      const children = mcpNode?.children ?? [];
      const svcA = children.find((c) => c.name === "svc_a");
      const svcB = children.find((c) => c.name === "svc_b");
      expect(svcA?.assetId).toBe("asset-a");
      expect(svcB?.assetId).toBe("asset-b");
      expect(svcA?.managed).toBe(true);
      expect(svcB?.managed).toBe(true);
    }
  });

  it("disabled 受管能力：厂商树占位节点 enabled=false，能力行开关一致", () => {
    mkdirSync(join(root, ".cursor/rules"), { recursive: true });
    // 受管 rule no-console（disabled，不在磁盘 → 占位）
    writeLock("p-consistency", {
      subscriptions: [{ workspaceId: "ws", syncPolicy: "auto" as const, targetTools: null, installedAt: "2026-01-01T00:00:00Z" }], version: "1", lockFormat: "2",
      assets: {
        "asset-rule": {
          version: "1.0.0", files: [], name: "no-console", type: "rule",
          vendors: { cursor: { enabled: false, files: [".cursor/rules/no-console.mdc"] } },
        },
      },
    });
    const state = scanProjectState(proj());
    assertViewConsistency(state);
    const cap = state.capabilities!.find((c) => c.assetId === "asset-rule")!;
    expect(cap.vendors.cursor?.enabled).toBe(false);
    const node = findNodeByAssetId(state.vendors.cursor.tree, "asset-rule");
    expect(node?.virtual).toBe("disabled-asset");
    expect(node?.enabled).toBe(false);
  });
});
