/**
 * L3 外部能力 adopt — 修复「toggle 外部 MCP 报 FK 500」的核心回归。
 *
 * 不变量：
 *  - 项目磁盘上预先存在的 `.mcp.json`（用户手写，含 foreign server）可被本地控制台管理。
 *  - toggle off `external:mcp:pencil`：adopt → 该 server 从 `.mcp.json` 移除（移隔离区），
 *    **同文件内其它 foreign server（other）原样保留**（merge-preserving，不整文件重算）。
 *  - toggle on：pencil 恢复，other 仍在。
 *  - remove（adopt 后）：pencil 永久移除，other 保留。
 *  - 全程不报 FK 约束错误（旧 bug：project_disabled_assets.asset_id REFERENCES assets(id)，
 *    external:* 不在 assets 表 → SQLITE_CONSTRAINT_FOREIGNKEY）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  startServer,
  stopServer,
  type ServerHandle,
  startAgent,
  stopAgent,
  type AgentHandle,
  makeProject,
  cleanupProject,
  ApiClient,
} from "@maolinc/cc-loom-testkit";

function readMcpServers(root: string): Record<string, unknown> {
  const raw = readFileSync(join(root, ".mcp.json"), "utf-8");
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  return parsed.mcpServers ?? {};
}

/** 容错读 settings.json：聚合为空时 reconcile 会整文件删除（产品设计，不留空壳），按 {} 处理。 */
function readSettings(root: string): any {
  const p = join(root, ".claude/settings.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8"));
}

describe("L3 external-adopt: 本地外部 MCP 能力 toggle / remove（merge-preserving）", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  beforeEach(() => {
    agent = null;
    projectRoot = null;
  });

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  async function setup(): Promise<void> {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("adopt@example.com");
    const token = await api.getCliToken();

    projectRoot = makeProject("empty");
    // 预置：用户手写的 .mcp.json，含 pencil（将被管理）+ other（应保留的 foreign）
    writeFileSync(
      join(projectRoot, ".mcp.json"),
      JSON.stringify(
        { mcpServers: { pencil: { command: "npx-pencil" }, other: { command: "npx-other" } } },
        null,
        2,
      ),
    );

    agent = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot,
      isOnline: async () => {
        const devices = await api.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });
  }

  it("toggle off 外部 mcp：pencil 移除、other 保留；toggle on：pencil 恢复", async () => {
    await setup();

    // toggle OFF pencil（external → adopt + disable）
    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:mcp:pencil",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: "pencil", type: "mcp", files: [".mcp.json"] },
    });
    expect(off.adoptedAssetId).toBeTruthy();

    let servers = readMcpServers(projectRoot!);
    expect(Object.keys(servers).sort()).toEqual(["other"]);
    // 隔离区应保留 pencil 副本（先禁用、后启用无需重发渲染结果）
    // （mcp 无 per-asset 文件，副本语义弱化；这里只断言聚合文件状态）

    // toggle ON pencil → 恢复，other 仍在
    await api.toggleCapability(agent!.projectId, {
      assetId: off.adoptedAssetId!,
      tool: "claudecode",
      enabled: true,
    });
    servers = readMcpServers(projectRoot!);
    expect(Object.keys(servers).sort()).toEqual(["other", "pencil"]);
  });

  it("adopt 的外部能力不进入能力市场列表（/api/assets 过滤 adopted）", async () => {
    await setup();
    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:mcp:pencil",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: "pencil", type: "mcp", files: [".mcp.json"] },
    });
    expect(off.adoptedAssetId).toBeTruthy();
    // adopt 产物仅用于本地控制台/reconcile，不应出现在能力市场（含「个人」筛选）
    const listed = await api.listAssets();
    expect(listed.map((a) => a.id)).not.toContain(off.adoptedAssetId);
    // 但按 id 直查仍可访问（本地控制台详情/预览依赖）
    const direct = await api.getAsset(off.adoptedAssetId!);
    expect(direct.id).toBe(off.adoptedAssetId);
  });

  it("remove 已 adopt 的外部 mcp：pencil 永久移除、other 保留", async () => {
    await setup();

    // 先 adopt + disable，再 remove
    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:mcp:pencil",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: "pencil", type: "mcp", files: [".mcp.json"] },
    });
    await api.removeCapability(agent!.projectId, { assetId: off.adoptedAssetId!, tool: "claudecode" });

    const servers = readMcpServers(projectRoot!);
    expect(Object.keys(servers)).toEqual(["other"]);
  });

  it("toggle off 不报 FK 约束错误（旧 bug 回归）", async () => {
    await setup();
    // 旧实现：INSERT project_disabled_assets(asset_id='external:mcp:pencil') → FK 失败 500。
    // 现应正常返回（adopt 后 asset_id 为真实 asset 行）。
    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:mcp:pencil",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: "pencil", type: "mcp", files: [".mcp.json"] },
    });
    expect(off.adoptedAssetId).toBeTruthy();
    expect(off.filesWritten).toBeDefined();
  });

  it("remove 从未 toggle 过的外部 mcp：pencil 直接删除、other 保留（note 3 直接删除）", async () => {
    await setup();
    // 不先 toggle，直接 remove —— 旧实现：adopt+remove 同请求，pencil 从未入 lock/账本，
    // reconcile 无法删其 key。现 adopt 写 project_installed_assets → removed 渲染 → key 删除。
    await api.removeCapability(agent!.projectId, {
      assetId: "external:mcp:pencil",
      tool: "claudecode",
      externalAsset: { name: "pencil", type: "mcp", files: [".mcp.json"] },
    });
    const servers = readMcpServers(projectRoot!);
    expect(Object.keys(servers)).toEqual(["other"]);
  });

  it("无 capabilitySet 项目：磁盘外部 skill 在 /state 标记 external + files 完整，前端派生 payload 可 toggle off", async () => {
    await setup();
    // 无 capabilitySet：手写一个外部 skill 目录
    mkdirSync(join(projectRoot!, ".claude/skills/scout"), { recursive: true });
    writeFileSync(join(projectRoot!, ".claude/skills/scout/SKILL.md"), "# scout");

    // 强制重扫读最新镜像
    const state = await api.scanState(agent!.projectId);
    const cap = state.capabilities?.find((c) => c.assetId === "external:skill:scout");
    expect(cap).toBeTruthy();
    // 契约：无 capabilitySet 的磁盘能力必须标记 external，且 files 完整——前端据此派生 adopt 信息
    expect(cap!.external).toBe(true);
    expect(cap!.vendors.claudecode?.files ?? []).toContain(".claude/skills/scout/SKILL.md");

    // 模拟前端「按 assetId 前缀决定 adopt」派生 externalAsset（而非依赖可能被乐观更新翻掉的 cap.external）
    const files = cap!.vendors.claudecode!.files;
    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:skill:scout",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: cap!.name, type: cap!.type, files },
    });
    expect(off.adoptedAssetId).toBeTruthy();
    // 落盘：整个 skill 目录被清（最小完整单元），SKILL.md 移入隔离区
    expect(existsSync(join(projectRoot!, ".claude/skills/scout/SKILL.md"))).toBe(false);
    expect(existsSync(join(projectRoot!, ".claude/skills/scout"))).toBe(false);

    // 重扫后镜像：scout 应作为「已 adopt 且关闭」的受管能力出现，enabled=false（开关为关），
    // 且不得因残留空目录被重新识别成 external-enabled（开关回弹为开）。
    const after = await api.scanState(agent!.projectId);
    const adopted = after.capabilities?.find((c) => c.type === "skill" && c.name === "scout");
    expect(adopted).toBeTruthy();
    expect(adopted!.assetId).toBe(off.adoptedAssetId);
    expect(adopted!.external ?? false).toBe(false);
    expect(adopted!.vendors.claudecode?.enabled).toBe(false);
    // 不应再有 external:skill:scout 幽灵行
    expect(after.capabilities?.some((c) => c.assetId === "external:skill:scout")).toBe(false);
  });

  it("skill 外部能力（passthrough，多文件目录）：toggle off 文件移隔离区、on 恢复、原名原扩展", async () => {
    await setup();
    // 预置外部 skill 目录（用户手写）
    mkdirSync(join(projectRoot!, ".claude/skills/pencil"), { recursive: true });
    writeFileSync(join(projectRoot!, ".claude/skills/pencil/SKILL.md"), "# pencil");
    writeFileSync(join(projectRoot!, ".claude/skills/pencil/helper.md"), "helper");

    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:skill:pencil",
      tool: "claudecode",
      enabled: false,
      externalAsset: {
        name: "pencil", type: "skill",
        files: [".claude/skills/pencil/SKILL.md", ".claude/skills/pencil/helper.md"],
      },
    });
    expect(off.adoptedAssetId).toBeTruthy();
    // toggle off：两个文件都从 vendor 目录移除（移隔离区）
    expect(existsSync(join(projectRoot!, ".claude/skills/pencil/SKILL.md"))).toBe(false);
    expect(existsSync(join(projectRoot!, ".claude/skills/pencil/helper.md"))).toBe(false);
    // 「能力最小完整单元」：整个 skill 目录应被清掉，不留空壳（回归：禁用只删文件不删空目录）
    expect(existsSync(join(projectRoot!, ".claude/skills/pencil"))).toBe(false);

    // toggle on：原路径、原文件名恢复
    await api.toggleCapability(agent!.projectId, {
      assetId: off.adoptedAssetId!, tool: "claudecode", enabled: true,
    });
    expect(existsSync(join(projectRoot!, ".claude/skills/pencil/SKILL.md"))).toBe(true);
    expect(existsSync(join(projectRoot!, ".claude/skills/pencil/helper.md"))).toBe(true);
    expect(readFileSync(join(projectRoot!, ".claude/skills/pencil/SKILL.md"), "utf-8")).toBe("# pencil");
  });

  it("rule 外部能力（passthrough 扁平文件 .mdc）：toggle round-trip 保留原扩展名", async () => {
    await setup();
    mkdirSync(join(projectRoot!, ".claude/rules"), { recursive: true });
    writeFileSync(join(projectRoot!, ".claude/rules/my-rule.mdc"), "rule body");

    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:rule:my-rule",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: "my-rule", type: "rule", files: [".claude/rules/my-rule.mdc"] },
    });
    expect(off.adoptedAssetId).toBeTruthy();
    expect(existsSync(join(projectRoot!, ".claude/rules/my-rule.mdc"))).toBe(false);

    await api.toggleCapability(agent!.projectId, {
      assetId: off.adoptedAssetId!, tool: "claudecode", enabled: true,
    });
    // 关键：passthrough 必须写回 .mdc（adapter flat-layout 会改成 .md —— 回归点）
    expect(existsSync(join(projectRoot!, ".claude/rules/my-rule.mdc"))).toBe(true);
    expect(readFileSync(join(projectRoot!, ".claude/rules/my-rule.mdc"), "utf-8")).toBe("rule body");
  });

  it("hook 外部能力：从聚合反向重建元数据，toggle off 删注册项 + 移脚本、foreign 保留", async () => {
    await setup();
    mkdirSync(join(projectRoot!, ".claude/hooks/cc-hook"), { recursive: true });
    writeFileSync(join(projectRoot!, ".claude/hooks/cc-hook/cc-hook.sh"), "#!/bin/sh\necho hi");
    // 聚合 settings.json：cc-hook（将管理）+ foreign-hook（应保留的 foreign）。
    // Claude Code 项目级 hook 注册表在 .claude/settings.json 顶层 hooks 字段（非 hooks/hooks.json）。
    writeFileSync(
      join(projectRoot!, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/cc-hook/cc-hook.sh" }] },
            { matcher: "Edit", hooks: [{ type: "command", command: "/usr/bin/foreign-hook.sh" }] },
          ],
        },
      }, null, 2),
    );

    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:hook:cc-hook",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: "cc-hook", type: "hook", files: [".claude/hooks/cc-hook/cc-hook.sh"] },
    });
    expect(off.adoptedAssetId).toBeTruthy();
    // cc-hook 脚本移隔离区
    expect(existsSync(join(projectRoot!, ".claude/hooks/cc-hook/cc-hook.sh"))).toBe(false);
    // 聚合：cc-hook 注册项删除，foreign-hook 保留
    const agg = JSON.parse(readFileSync(join(projectRoot!, ".claude/settings.json"), "utf-8")) as any;
    const cmds = agg.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain("/usr/bin/foreign-hook.sh");
    expect(cmds.some((c: string) => c.includes("cc-hook"))).toBe(false);

    // toggle on：cc-hook 注册项 + 脚本恢复
    await api.toggleCapability(agent!.projectId, {
      assetId: off.adoptedAssetId!, tool: "claudecode", enabled: true,
    });
    expect(existsSync(join(projectRoot!, ".claude/hooks/cc-hook/cc-hook.sh"))).toBe(true);
    const agg2 = JSON.parse(readFileSync(join(projectRoot!, ".claude/settings.json"), "utf-8")) as any;
    const cmds2 = agg2.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds2.some((c: string) => c.includes("cc-hook"))).toBe(true);
    expect(cmds2).toContain("/usr/bin/foreign-hook.sh");
  });

  it("hook 外部能力（扁平脚本 + bash -c 包装命令）：adopt 成功、toggle round-trip 注册项逐字节保留", async () => {
    await setup();
    // 真实用户场景回归：脚本是扁平文件 hooks/<name>.sh（非 hooks/<name>/ 目录），
    // 注册命令是 bash -c 包装（引用 $CWD/.agent/ 路径）。旧实现按 `hooks/<name>/` 目录形态
    // 匹配注册项 → 「Adopt 失败: 聚合 .claude/settings.json 未找到 hook 的注册项」。
    mkdirSync(join(projectRoot!, ".claude/hooks"), { recursive: true });
    writeFileSync(join(projectRoot!, ".claude/hooks/wecom-notification.sh"), "#!/bin/sh\necho notify");
    const wrapperCmd =
      'bash -c \'INPUT=$(cat); CWD=$(echo "$INPUT" | jq -r ".cwd // empty"); [ -n "$CWD" ] && echo "$INPUT" | bash "$CWD/.agent/hooks/wecom-notification.sh" || true\'';
    writeFileSync(
      join(projectRoot!, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          Notification: [
            { matcher: "", hooks: [{ type: "command", command: wrapperCmd }], description: "企微通知" },
          ],
          Stop: [
            { matcher: "", hooks: [{ type: "command", command: "/usr/bin/foreign-stop.sh" }] },
          ],
        },
      }, null, 2),
    );

    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:hook:wecom-notification",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: "wecom-notification", type: "hook", files: [".claude/hooks/wecom-notification.sh"] },
    });
    expect(off.adoptedAssetId).toBeTruthy();
    // 注册项删除（Notification 事件整个清空）、foreign Stop 保留、脚本移隔离区
    let agg = JSON.parse(readFileSync(join(projectRoot!, ".claude/settings.json"), "utf-8")) as any;
    expect(agg.hooks.Notification ?? []).toEqual([]);
    expect(agg.hooks.Stop[0].hooks[0].command).toBe("/usr/bin/foreign-stop.sh");
    expect(existsSync(join(projectRoot!, ".claude/hooks/wecom-notification.sh"))).toBe(false);

    // toggle on：注册项逐字节恢复（包装命令不被拆改）、matcher/description 保留、
    // 脚本回到原扁平路径（不得变成 hooks/<name>/ 目录形态）
    await api.toggleCapability(agent!.projectId, {
      assetId: off.adoptedAssetId!, tool: "claudecode", enabled: true,
    });
    agg = JSON.parse(readFileSync(join(projectRoot!, ".claude/settings.json"), "utf-8")) as any;
    const entry = agg.hooks.Notification[0];
    expect(entry.hooks[0].command).toBe(wrapperCmd);
    expect(entry.matcher).toBe("");
    expect(entry.description).toBe("企微通知");
    expect(agg.hooks.Stop[0].hooks[0].command).toBe("/usr/bin/foreign-stop.sh");
    expect(existsSync(join(projectRoot!, ".claude/hooks/wecom-notification.sh"))).toBe(true);
    expect(existsSync(join(projectRoot!, ".claude/hooks/wecom-notification"))).toBe(false);
  });

  it("hook 外部能力（同一脚本注册多个事件）：state 标注事件集、toggle off 从所有事件移除、on 逐事件恢复", async () => {
    await setup();
    // 一个脚本被多个事件复用（用户核心场景）：扁平脚本 + 两事件注册
    mkdirSync(join(projectRoot!, ".claude/hooks"), { recursive: true });
    writeFileSync(join(projectRoot!, ".claude/hooks/wecom-notify.sh"), "#!/bin/sh\necho notify");
    writeFileSync(
      join(projectRoot!, ".claude/settings.json"),
      JSON.stringify({
        hooks: {
          Notification: [
            { matcher: "", hooks: [{ type: "command", command: "bash .claude/hooks/wecom-notify.sh" }] },
          ],
          Stop: [
            { matcher: "", hooks: [{ type: "command", command: "bash .claude/hooks/wecom-notify.sh" }], description: "停止时也通知" },
          ],
        },
      }, null, 2),
    );

    // state：scanner 从聚合注册表反查事件（厂商格 + server 能力级 union）
    const state = await api.scanState(agent!.projectId);
    const cap = state.capabilities?.find((c) => c.assetId === "external:hook:wecom-notify");
    expect(cap).toBeTruthy();
    expect(cap!.vendors.claudecode?.hookEvents?.sort()).toEqual(["Notification", "Stop"]);
    expect(cap!.hookEvents?.sort()).toEqual(["Notification", "Stop"]);

    const off = await api.toggleCapability(agent!.projectId, {
      assetId: "external:hook:wecom-notify",
      tool: "claudecode",
      enabled: false,
      externalAsset: { name: "wecom-notify", type: "hook", files: [".claude/hooks/wecom-notify.sh"] },
    });
    expect(off.adoptedAssetId).toBeTruthy();
    // 关键不变量：从所有涉及事件中移除（两个事件都不再有该脚本；聚合全空时文件被删）
    let agg = readSettings(projectRoot!);
    expect(agg.hooks?.Notification ?? []).toEqual([]);
    expect(agg.hooks?.Stop ?? []).toEqual([]);
    expect(existsSync(join(projectRoot!, ".claude/hooks/wecom-notify.sh"))).toBe(false);

    // toggle on：两个事件的注册项逐字恢复（Stop 的 description 不丢）
    await api.toggleCapability(agent!.projectId, {
      assetId: off.adoptedAssetId!, tool: "claudecode", enabled: true,
    });
    agg = JSON.parse(readFileSync(join(projectRoot!, ".claude/settings.json"), "utf-8")) as any;
    expect(agg.hooks.Notification[0].hooks[0].command).toBe("bash .claude/hooks/wecom-notify.sh");
    expect(agg.hooks.Stop[0].hooks[0].command).toBe("bash .claude/hooks/wecom-notify.sh");
    expect(agg.hooks.Stop[0].description).toBe("停止时也通知");
    expect(existsSync(join(projectRoot!, ".claude/hooks/wecom-notify.sh"))).toBe(true);
  });

  it("受管 hook（创建时选多个事件）：安装全部注册、toggle off 从所有事件移除、on 全部恢复", async () => {
    await setup();
    // 创建多事件 hook 资产（创建表单多选事件的契约）
    const asset = await api.createAsset({
      name: "multi-notify",
      type: "hook",
      description: "multi event hook",
      tags: [],
      files: [
        { path: "hook.json", content: "{}" },
        { path: "notify.sh", content: "echo n" },
      ],
      compatibleTools: ["claudecode"],
      visibility: "private",
      metadata: {
        events: ["PreToolUse", "Stop"],
        matcher: "*",
        hooks: [{ type: "command", command: "notify.sh" }],
      },
    });

    // 安装：所选事件全部默认注册
    await api.addCapability(agent!.projectId, [asset.id]);
    let agg = JSON.parse(readFileSync(join(projectRoot!, ".claude/settings.json"), "utf-8")) as any;
    for (const ev of ["PreToolUse", "Stop"]) {
      const cmds = agg.hooks[ev].flatMap((e: any) => e.hooks.map((h: any) => h.command));
      expect(cmds).toContain("${CLAUDE_PROJECT_DIR}/.claude/hooks/multi-notify/notify.sh");
    }
    expect(existsSync(join(projectRoot!, ".claude/hooks/multi-notify/notify.sh"))).toBe(true);

    // state：受管行能力级 hookEvents 来自 asset metadata（声明口径）
    const state = await api.scanState(agent!.projectId);
    const cap = state.capabilities?.find((c) => c.type === "hook" && c.name === "multi-notify");
    expect(cap?.hookEvents?.sort()).toEqual(["PreToolUse", "Stop"]);

    // toggle off：从所有事件移除（脚本入隔离区）
    await api.toggleCapability(agent!.projectId, {
      assetId: asset.id, tool: "claudecode", enabled: false,
    });
    agg = readSettings(projectRoot!);
    expect(agg.hooks?.PreToolUse ?? []).toEqual([]);
    expect(agg.hooks?.Stop ?? []).toEqual([]);

    // toggle on：全部事件恢复
    await api.toggleCapability(agent!.projectId, {
      assetId: asset.id, tool: "claudecode", enabled: true,
    });
    agg = JSON.parse(readFileSync(join(projectRoot!, ".claude/settings.json"), "utf-8")) as any;
    for (const ev of ["PreToolUse", "Stop"]) {
      const cmds = agg.hooks[ev].flatMap((e: any) => e.hooks.map((h: any) => h.command));
      expect(cmds).toContain("${CLAUDE_PROJECT_DIR}/.claude/hooks/multi-notify/notify.sh");
    }
  });
});
