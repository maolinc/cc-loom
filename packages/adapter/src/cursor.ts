import type { AssetType, ManifestAssetEntry, ReconcileAggregateEntry, TargetTool } from "@maolinc/cc-loom-shared";
import { BaseAdapter } from "./base.js";
import type { AdapterFile } from "./types.js";

/**
 * Cursor 事件名映射：Claude Code 风格 PascalCase → Cursor camelCase。
 * 来源：https://cursor.com/cn/docs/hooks — Cursor 的事件集合与 Claude Code 不完全重叠，
 * 仅映射两者都有对应的事件；未列出的事件（如 Setup / PostCompact / Notification 等）
 * mapHookEvent 返回 null → 含该事件的 hook 资产整个跳过（不落附属文件、不进注册表）。
 *
 * 注意 UserPromptSubmit → beforeSubmitPrompt：Cursor 的 beforeSubmitPrompt 事件即
 * "用户提交 prompt"时机，与 Claude Code 的 UserPromptSubmit 对齐（Cursor 文档中该事件
 * 的 matcher 字段亦写作 "UserPromptSubmit"）。
 */
const CURSOR_HOOK_EVENTS: Record<string, string> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "beforeSubmitPrompt",
  Stop: "stop",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PostToolUseFailure: "postToolUseFailure",
  PreCompact: "preCompact",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
};

/**
 * Cursor 适配：
 * - hook 注册写到 `<targetDir>/hooks.json`（顶层文件，非 hooks/ 子目录下），
 *   外层包装为 `{ version: 1, hooks: { ... } }`，与官方
 *   https://cursor.com/cn/docs/hooks 一致。
 * - hook 事件名需从 Claude Code PascalCase 映射为 Cursor camelCase（事件集不完全重叠）。
 * - hook 命令路径用项目相对路径（`.cursor/hooks/<name>/<cmd>`），不用
 *   `${CLAUDE_PROJECT_DIR}` 占位符（那是 Claude Code 专属）。
 * - Agent（子代理）写到 `.cursor/agents/<name>.md`，与官方
 *   https://cursor.com/cn/docs/subagents 一致；沿用 BaseAdapter 默认渲染。
 */
export class CursorAdapter extends BaseAdapter {
  tool: TargetTool = "cursor";
  targetDir = ".cursor";
  supportedTypes: readonly AssetType[] = ["skill", "rule", "mcp", "command", "hook", "agent"];

  override hooksAggregatePath(): string | null {
    return `${this.targetDir}/hooks.json`;
  }

  override mapHookEvent(event: string): string | null {
    return CURSOR_HOOK_EVENTS[event] ?? null;
  }

  protected override emitHookRegistry(
    hooks: ManifestAssetEntry[],
    files: AdapterFile[],
  ): void {
    const registry = this.buildHookRegistry(hooks);
    files.push({
      path: this.hooksAggregatePath()!,
      content: JSON.stringify({ version: 1, hooks: registry }, null, 2),
      mergeStrategy: "hooks-registry",
    });
  }

  /**
   * Cursor hook 命令用项目相对路径（`.cursor/hooks/<name>/<cmd>`），不是 Claude Code 的
   * `${CLAUDE_PROJECT_DIR}` 占位符。占位符 / 绝对路径 / ~ 开头原样保留。
   */
  protected override rewriteHookEntry(
    name: string,
    entry: { type: string; [k: string]: unknown },
  ): { type: string; [k: string]: unknown } {
    if (entry.type !== "command" || typeof entry.command !== "string") return entry;
    const cmd = entry.command;
    if (cmd.startsWith("/") || cmd.startsWith("~") || cmd.startsWith("$")) return entry;
    // 去掉前导 ./ 避免拼出 `.cursor/hooks/<name>/./x.sh` 这样的冗余路径。
    const rel = cmd.replace(/^\.\//, "");
    return {
      ...entry,
      command: `${this.targetDir}/hooks/${name}/${rel}`,
    };
  }

  /**
   * v2 reconcile 落盘时，确保 hooks.json 含 `version: 1`（schema 版本号，非用户数据）。
   * base.mergeAggregate 从 existing 起步，existing 为空（首次安装）时不会自带 version，
   * 此处补上；existing 已有则尊重 existing 的值。
   */
  override mergeAggregate(
    type: "mcp" | "hook",
    path: string,
    entries: ReconcileAggregateEntry[],
    ownedKeys: string[],
    existingJson: string | null,
  ): string | null {
    const out = super.mergeAggregate(type, path, entries, ownedKeys, existingJson);
    if (type !== "hook" || out === null) return out;
    const obj = JSON.parse(out) as Record<string, unknown>;
    if (obj.version === undefined) obj.version = 1;
    return JSON.stringify(obj, null, 2);
  }
}
