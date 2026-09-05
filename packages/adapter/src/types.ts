import type { AssetType, ManifestAssetEntry, Manifest, ReconcileAggregateEntry, TargetTool } from "@maolinc/cc-loom-shared";

/**
 * 配置型文件的合并策略。Adapter 输出此类文件时标记策略，install 端按策略与现有文件合并。
 *
 * - `hooks-registry`：整文件即 `{ hooks: { event: [...] } }`。按 event 合并 matcher 数组。
 * - `settings-with-hooks`：整文件是 settings.json。顶层字段浅合并，hooks 子字段按 hooks-registry 合并。
 * - `mcp-servers`：整文件即 `{ mcpServers: { <name>: <def>, ... } }`（也容忍纯 `{<name>: <def>}` 形态）。
 *   按 server name 做 key 级合并，incoming 同名 server 覆盖，existing 中未被 incoming 提及的 server 保留。
 *   不再像 add/modify 那样整文件覆盖，避免抹掉用户已配置的其他 MCP 服务。
 */
export type MergeStrategy = "hooks-registry" | "settings-with-hooks" | "mcp-servers";

export interface AdapterFile {
  path: string;
  content: string;
  /** "base64" 表示 content 为二进制内容的 base64，落盘前需解码；缺省为 UTF-8 文本。 */
  encoding?: "base64";
  /** 配置型文件需指定合并策略；省略表示直接覆盖（add/modify 语义）。 */
  mergeStrategy?: MergeStrategy;
}

export interface AdapterOutput {
  files: AdapterFile[];
  targetDir: string;
  /** Assets that were skipped because this adapter doesn't support their type */
  skipped: ManifestAssetEntry[];
}

export interface Adapter {
  tool: TargetTool;
  targetDir: string;
  /** Asset types this adapter natively supports. Others are silently skipped. */
  supportedTypes: readonly AssetType[];
  generate(manifest: Manifest): AdapterOutput;
  /** 单 asset → 该厂商的非聚合文件（capabilities 流程使用）。mcp 返回 []。 */
  generateForAsset(asset: ManifestAssetEntry): AdapterFile[];
  /** 重算 mcp 聚合文件；空集返回 null（调用方据此删文件）。仅 install 预览用。 */
  recomputeMcpAggregate(enabledMcps: ManifestAssetEntry[]): AdapterFile | null;
  /** 重算 hooks 聚合文件；空集返回 null（调用方据此删文件）。仅 install 预览用。 */
  recomputeHooksAggregate(enabledHooks: ManifestAssetEntry[]): AdapterFile | null;
  /**
   * v2 reconcile 专用：把 enabled mcp 资产渲染成 per-key 条目（不含外层文件包装）。
   * 用于 ReconcileAggregate.entries。
   */
  mcpOwnedEntries(enabledMcps: ManifestAssetEntry[]): ReconcileAggregateEntry[];
  /** v2 reconcile：所有受管 mcp 资产（enabled+disabled+removed）的 server key 集合。 */
  mcpOwnedKeys(managedMcps: ManifestAssetEntry[]): string[];
  /** v2 reconcile：把 enabled hook 资产渲染成 per-event 条目。 */
  hooksOwnedEntries(enabledHooks: ManifestAssetEntry[]): ReconcileAggregateEntry[];
  /** v2 reconcile：所有受管 hook 资产名集合（用于识别现有文件中的 owned 条目）。 */
  hooksOwnedNames(managedHooks: ManifestAssetEntry[]): string[];
  /**
   * v2 reconcile 落盘：把 merge-spec 应用到现有文件内容，返回新内容（null=删除文件）。
   * 保留所有 foreign 条目；仅按 ownedKeys 删除 Loom 拥有的旧条目、按 entries 写入 enabled。
   */
  mergeAggregate(
    type: "mcp" | "hook",
    path: string,
    entries: ReconcileAggregateEntry[],
    ownedKeys: string[],
    existingJson: string | null,
  ): string | null;
  /**
   * 本 adapter 的 mcp 聚合文件落盘路径；不支持 mcp 时返回 null。
   * reconcile-plan 用来在聚合为空时仍能告诉 CLI 删除该路径下的旧文件。
   */
  mcpAggregatePath(): string | null;
  /**
   * 本 adapter 的 hooks 聚合文件落盘路径；不支持 hook 时返回 null。
   */
  hooksAggregatePath(): string | null;
}

export type AdapterFactory = () => Adapter;
