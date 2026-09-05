import type { AssetType, ManifestAssetEntry, TargetTool } from "@maolinc/cc-loom-shared";
import { BaseAdapter, slugify } from "./base.js";
import type { AdapterFile } from "./types.js";

/**
 * Codex 适配：
 * - hook 注册写到 `<targetDir>/hooks.json`（顶层文件，不放在 hooks/ 子目录下，
 *   与 Claude Code 略有差异）。
 * - 不支持 command：Codex 的 prompts 属于用户级目录（`~/.codex/prompts/`），
 *   超出项目级安全边界，不分发。
 * - agent（子代理）按官方 https://developers.openai.com/codex/subagents 落到
 *   `<targetDir>/agents/<name>.toml`：单文件 TOML，必填 `name` / `description` /
 *   `developer_instructions`。Loom 的 agent 中间格式是 Markdown 指令正文，这里
 *   把 asset.name → `name`、asset.description → `description`、文件正文拼接为
 *   `developer_instructions`，转写成 TOML 基本多行字符串。
 */
export class CodexAdapter extends BaseAdapter {
  tool: TargetTool = "codex";
  targetDir = ".codex";
  supportedTypes: readonly AssetType[] = ["skill", "rule", "mcp", "hook", "agent"];

  override hooksAggregatePath(): string | null {
    return `${this.targetDir}/hooks.json`;
  }

  protected override emitHookRegistry(
    hooks: ManifestAssetEntry[],
    files: AdapterFile[],
  ): void {
    const registry = this.buildHookRegistry(hooks);
    files.push({
      path: this.hooksAggregatePath()!,
      content: JSON.stringify({ hooks: registry }, null, 2),
      mergeStrategy: "hooks-registry",
    });
  }

  /**
   * Codex agent 需要把 Markdown 指令正文转写成 TOML（`name` / `description` /
   * `developer_instructions`）；其余类型沿用 BaseAdapter 默认渲染。
   * 同时覆盖 `generate()` 与 `generateForAsset()` 两条路径（capabilities 流程
   * 走后者），保证单 asset 增量与全量安装产出一致。passthrough（外部 adopt 的
   * 已是 TOML 文件）在 BaseAdapter.generateForAsset 中先行短路，不会进入此处。
   */
  protected override renderAssetFiles(asset: ManifestAssetEntry): AdapterFile[] {
    if (asset.type === "agent") {
      return [renderCodexAgentToml(this.targetDir, asset)];
    }
    return super.renderAssetFiles(asset);
  }
}

/**
 * 把一个 agent asset 渲染为 `.codex/agents/<slug>.toml`。
 *
 * 字段映射（遵循 https://developers.openai.com/codex/subagents#custom-agent-file-schema）：
 *   - `name` ← slugify(asset.name)：与文件名一致，Codex 按 `name` 字段识别子代理。
 *   - `description` ← asset.description ?? asset.name：Codex 必填，用资产描述兜底。
 *   - `developer_instructions` ← 全部文件正文按 `\n\n` 拼接：Codex 必填，即子代理指令。
 *
 * TOML 序列化：name/description 走基本字符串（`"..."`，转义 `\` 与 `"`）；
 * developer_instructions 走基本多行字符串（`"""..."""`）。先把所有 `\` → `\\`、
 * `"` → `\"`，确保内容里不会出现 `"""` 提前终结多行串。
 */
function renderCodexAgentToml(targetDir: string, asset: ManifestAssetEntry): AdapterFile {
  const name = slugify(asset.name);
  const description = asset.description || asset.name;
  const body = asset.files
    .map((f) => f.content)
    .filter((c) => c && c.length > 0)
    .join("\n\n")
    .trim();
  const lines = [
    `name = ${tomlBasicString(name)}`,
    `description = ${tomlBasicString(description)}`,
    `developer_instructions = ${tomlMultilineString(body)}`,
  ];
  return {
    path: `${targetDir}/agents/${name}.toml`,
    content: lines.join("\n") + "\n",
  };
}

/** TOML 基本字符串（单行）：转义 `\` 与 `"`，包裹在双引号内。 */
function tomlBasicString(s: string): string {
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * TOML 基本多行字符串：`"""\n<body>\n"""`。
 * 转义所有 `\`（→`\\`）和 `"`（→`\"`）后，内容中不可能出现 `"""`，
 * 故多行串不会被提前终结。真实换行原样保留（TOML 多行串允许）。
 */
function tomlMultilineString(s: string): string {
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"""\n${escaped}\n"""`;
}
