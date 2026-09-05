import type { AssetType, ManifestAssetEntry, TargetTool } from "@maolinc/cc-loom-shared";
import { BaseAdapter } from "./base.js";
import type { AdapterFile } from "./types.js";

/**
 * CodeBuddy 适配：hook 注册嵌入 `<targetDir>/settings.json` 的 `hooks` 字段
 * （CodeBuddy CLI 项目级 hooks 入口是 settings.json，不是独立 hooks.json）。
 *
 * 注意：当前实现写完整 settings.json（仅含 hooks 字段）。如果项目已有 settings.json，
 * install 端会标记为 modify 冲突——合并语义留待 install 链路扩展。
 */
export class CodeBuddyAdapter extends BaseAdapter {
  tool: TargetTool = "codebuddy";
  targetDir = ".codebuddy";
  // CodeBuddy 全 6 类支持
  supportedTypes: readonly AssetType[] = ["skill", "rule", "mcp", "hook", "command", "agent"];

  override hooksAggregatePath(): string | null {
    return `${this.targetDir}/settings.json`;
  }

  protected override emitHookRegistry(
    hooks: ManifestAssetEntry[],
    files: AdapterFile[],
  ): void {
    const registry = this.buildHookRegistry(hooks);
    files.push({
      path: this.hooksAggregatePath()!,
      content: JSON.stringify({ hooks: registry }, null, 2),
      mergeStrategy: "settings-with-hooks",
    });
  }
}
