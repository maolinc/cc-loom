import type { AssetType, ManifestAssetEntry, TargetTool } from "@maolinc/cc-loom-shared";
import { BaseAdapter } from "./base.js";
import type { AdapterFile } from "./types.js";

/**
 * Claude Code 适配：
 * - hooks 写到 `<targetDir>/settings.json` 顶层的 `hooks` 字段（策略 `settings-with-hooks`）。
 *   官方 https://code.claude.com/docs/en/hooks 明确：项目级 hook 只从 `settings.json` /
 *   `settings.local.json` 的顶层 `hooks` 字段加载；`<targetDir>/hooks/hooks.json` 仅在
 *   **plugin 包内部**生效，独立项目不被 Claude Code 读取。Loom 装的是独立项目能力，故必须走
 *   settings.json。附属脚本仍落 `<targetDir>/hooks/<name>/`（仅文件位置，与注册表读取无关）。
 * - MCP 配置 **必须** 写到项目根 `.mcp.json`，不是 `.claude/mcp.json`：
 *   https://code.claude.com/docs/en/debug-your-config 明确说明 Claude Code
 *   不会从 `.claude/` 内或 `settings.json` 的 mcpServers 字段加载 MCP 服务。
 */
export class ClaudeCodeAdapter extends BaseAdapter {
  tool: TargetTool = "claudecode";
  targetDir = ".claude";
  // Claude Code 全 6 类支持
  supportedTypes: readonly AssetType[] = ["skill", "rule", "mcp", "hook", "command", "agent"];

  protected override mcpConfigPath(): string {
    return ".mcp.json";
  }

  /**
   * Claude Code 项目级 hook 注册表嵌 `.claude/settings.json` 的 `hooks` 字段
   * （不是 `hooks/hooks.json`——后者仅 plugin 包内有效，独立项目不被读取）。
   */
  override hooksAggregatePath(): string | null {
    return this.supportedTypes.includes("hook") ? `${this.targetDir}/settings.json` : null;
  }

  /**
   * 落盘为 settings.json（策略 `settings-with-hooks`），与 CodeBuddy 一致：
   * 顶层字段浅合并保留用户既有 settings，hooks 子字段按 (event, matcher) 追加。
   */
  protected override emitHookRegistry(
    hooks: ManifestAssetEntry[],
    files: AdapterFile[],
  ): void {
    const registry = this.buildHookRegistry(hooks);
    const path = this.hooksAggregatePath();
    if (!path) return;
    files.push({
      path,
      content: JSON.stringify({ hooks: registry }, null, 2),
      mergeStrategy: "settings-with-hooks",
    });
  }
}
