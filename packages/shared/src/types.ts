import type {
  AssetType,
  AuthBindingKind,
  DeviceStatus,
  ProjectStatus,
  SourceKind,
  SyncPolicy,
  SyncStatus,
  SyncTrigger,
  TargetTool,
  UserRole,
  Visibility,
} from "./constants.js";

// ============ User ============

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserSession {
  userId: string;
  email: string;
  role: UserRole;
}

// Alias for server-side usage
export type SessionUser = UserSession;

// ============ Capability Auth（ADR-0003：统一绑定列表）============
//
// 资产侧「声明」与用户侧「凭据值」分离：
//  - 资产携带 auth.bindings: AssetAuthBinding[]，描述「需要什么凭据、kind、放在哪里」。
//  - 用户在设置页维护 credentials（凭据名→加密值）+ credential_distributions（显式分发）。
// credentialName 是两者之间的显式链接键。详见 docs/adr/0003-*.md。

/**
 * 单条鉴权绑定。
 * - env：凭据值推送到设备系统环境变量（envKey 下，走 env:push）；分发维度 = 设备。
 * - path：凭据值在 reconcile 渲染时字面替换进 MCP server 定义的 path；分发维度 = 项目。
 *   path 仅对 type:mcp 资产有效。path 相对**未包装的 server 定义**（不含 mcpServers.<key>
 *   前缀），/ 分隔；多 server 包装资产第一段为 server key。
 */
export interface AssetAuthBinding {
  /** 指向用户侧凭据名的显式链接键。同名即同一凭据，可跨资产/项目复用。 */
  credentialName: string;
  kind: AuthBindingKind;
  /** kind=env 时必填：实际写入设备系统环境变量的名（env-var 合法名）。 */
  envKey?: string;
  /** kind=path 时必填：server 定义内的注入路径（/ 分隔，相对未包装 def）。 */
  path?: string;
  /** 可选：获取该凭据的页面地址，展示给用户。 */
  authPageUrl?: string;
}

/** 资产的鉴权声明 = 绑定列表。空数组（或 undefined）= 无鉴权。 */
export interface AssetAuth {
  bindings: AssetAuthBinding[];
}

// ============ CLI Token ============

export interface CliToken {
  id: string;
  userId: string;
  token: string;
  createdAt: string;
}

// ============ Device ============

export interface Device {
  id: string;
  userId: string;
  deviceName: string;
  status: DeviceStatus;
  lastOnlineAt: string;
  createdAt: string;
}

// ============ Asset Metadata (per-type discriminated by Asset.type) ============
//
// 注意：这是名义上按 Asset.type 区分的元数据，但 TypeScript 层面并非
// discriminated union（子接口没有 kind/tag 字段）。SkillMetadata / AgentMetadata
// 都是空对象，结构上等同于其他子接口的可选超集。消费方需要根据 asset.type
// 在运行时手动 narrow（如 `asset.type === "rule" ? asset.metadata as RuleMetadata : ...`）。
// Zod 校验同理：assetMetadataSchema 用 z.union，不绑定 type 字段。

export interface SkillMetadata {}
export interface AgentMetadata {}
export interface RuleMetadata {
  globs: string[];
}
export interface McpMetadata {
  transport: "stdio" | "http" | "sse";
  command?: string; // stdio: 拼好的命令行，如 "npx -y @mcp/server-fs"
  url?: string;     // http/sse: endpoint URL
}
export interface HookMetadata {
  event?: string;                                                      // 旧单事件（兼容读取；新写入一律用 events）
  events?: string[];                                                   // 注册的事件集合（HOOK_EVENTS 子集）——一个 hook 可挂多个事件
  matcher?: string;                                                    // 可选 matcher（"*" / "" / 工具名 / regex），各事件共享
  hooks: Array<{ type: string; [key: string]: unknown }>;              // 单 hook entry 数组，字段透传 Claude Code 官方 schema
  passthrough?: boolean;                                               // adopt 的 foreign hook：注册项逐字保留（registrations），附属文件按 asset_files.path 原样落盘
  registrations?: Array<{ event: string; entry: Record<string, unknown> }>; // passthrough 时逐事件的原样 matcherEntry（含 matcher/description 等全部字段）
}

/** 取 hook 元数据的事件集合：events 优先，回退旧单 event 字段。 */
export function hookEventsOf(md: { event?: string; events?: string[] } | null | undefined): string[] {
  if (!md) return [];
  if (Array.isArray(md.events) && md.events.length > 0) return md.events;
  return typeof md.event === "string" && md.event ? [md.event] : [];
}
export interface CommandMetadata {
  trigger: string; // 如 "/lint"
}

export type AssetMetadata =
  | SkillMetadata
  | AgentMetadata
  | RuleMetadata
  | McpMetadata
  | HookMetadata
  | CommandMetadata;

// ============ Asset File ============

export interface AssetFile {
  id: string;
  assetId: string;
  path: string;
  /**
   * 文件内容。详情接口（GET /api/assets/:id）始终返回；
   * 列表接口（GET /api/assets）为提升性能不返回 content，需通过
   * GET /api/assets/:id/file 按需获取。
   */
  content?: string;
  /**
   * 内容编码。缺省（undefined/null）= 文本（UTF-8），content 即原文；
   * "base64" = 二进制文件，content 为 base64，落盘前需解码。
   */
  encoding?: "base64" | null;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetFileInput {
  path: string;
  content: string;
  /** "base64" 表示 content 是二进制文件的 base64；缺省为 UTF-8 文本。 */
  encoding?: "base64";
}

// ============ Asset ============

export interface Asset {
  id: string;
  name: string;
  alias?: string | null;
  type: AssetType;
  description: string;
  author: string;
  tags: string[];
  files: AssetFile[];
  compatibleTools: TargetTool[];
  visibility: Visibility;
  version: string;
  metadata: AssetMetadata;
  /**
   * 该能力被实际调用的累计次数（仅 skill 类型有意义）。市场展示用，全局累计、只增不减。
   * 由本地 Agent 通过 hook 旁路统计后增量上报；缺省/0 表示尚无调用记录。
   */
  invocationCount?: number;
  /** 鉴权声明：能力运行时需要的环境变量等。缺省视为免鉴权。 */
  auth?: AssetAuth;
  // 来源信息（marketplace 同步而来的 asset 才有；本地创建为 null）
  sourceId?: string | null;
  sourcePath?: string | null;
  sourceOriginAuthor?: string | null;
  sourceDisplayName?: string | null;
  sourceAddedBy?: string | null;
  sourceUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetCreateInput {
  name: string;
  alias?: string;
  sourceUrl?: string;
  type: AssetType;
  description: string;
  tags: string[];
  files: AssetFileInput[];
  compatibleTools: TargetTool[];
  visibility: Visibility;
  metadata?: AssetMetadata;
  auth?: AssetAuth;
}

export interface AssetUpdateInput {
  name?: string;
  alias?: string;
  sourceUrl?: string;
  description?: string;
  tags?: string[];
  files?: AssetFileInput[];
  compatibleTools?: TargetTool[];
  visibility?: Visibility;
  version?: string;
  metadata?: AssetMetadata;
  auth?: AssetAuth;
}

// ============ Workspace ============

export interface WorkspaceAsset {
  assetId: string;
  asset: Asset;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  assets: WorkspaceAsset[];
  targetTools: TargetTool[];
  visibility: Visibility;
  version: string;
  /** 创建者邮箱（本地创建的工作空间的作者）。 */
  author?: string | null;
  sourceId?: string | null;
  sourceDisplayName?: string | null;
  sourceAddedBy?: string | null;
  /** 来源仓库地址（导入的工作空间才有）。 */
  sourceUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceCreateInput {
  name: string;
  description: string;
  targetTools: TargetTool[];
  visibility: Visibility;
}

export interface WorkspaceUpdateInput {
  name?: string;
  description?: string;
  assetIds?: string[];
  targetTools?: TargetTool[];
  visibility?: Visibility;
  version?: string;
}

// ============ Manifest & Lock ============

export interface ManifestAssetEntry {
  assetId: string;
  name: string;
  type: AssetType;
  version: string;
  /**
   * 资产描述。用于需要描述字段的厂商格式转换（如 Codex 子代理 TOML 的
   * `description` 必填项）。由 reconcile / asset-manifest 从 DB 透传；旧路径或
   * 测试夹具可能缺省，消费方应自行兜底。
   */
  description?: string;
  files: AssetFileInput[];
  compatibleTools: TargetTool[];
  metadata: AssetMetadata;
  /**
   * Source path (e.g. "skills/brainstorming"), used by the adapter to decide
   * whether to install as a directory-layout asset. Optional: locally-created
   * assets have no source.
   */
  sourcePath?: string | null;
}

export interface Manifest {
  workspaceId: string;
  workspaceName: string;
  version: string;
  targetTools: TargetTool[];
  assets: ManifestAssetEntry[];
}

// ============ Workspace Subscription（ADR-0006） ============

/**
 * 空间订阅：项目与 Workspace 之间的一条安装关系记录。
 *
 * - 一个项目可同时持有多条订阅，能力叠加生效；同一 asset id 跨订阅共享单例，
 *   按 (能力 × 厂商) 引用计数，最后一个引用者卸载时才撤文件。
 * - `workspaceId = null` 表示隐式订阅：本地控制台「单独添加的能力」组
 *   （对应 project_capabilities），不指向任何 Workspace。
 * - syncPolicy / targetTools 均挂在订阅上，不再挂在项目上。
 */
export interface WorkspaceSubscription {
  /** 订阅的工作空间 id；null = 隐式订阅（project_capabilities 单项能力组）。 */
  workspaceId: string | null;
  /** 展示名（list/detail 接口富化）；隐式订阅为 null，UI 渲染为「单独添加的能力」。 */
  workspaceName?: string | null;
  syncPolicy: SyncPolicy;
  /** 该订阅的落盘厂商集合；null = 跟随项目有效工具集合（隐式订阅）。 */
  targetTools: TargetTool[] | null;
  installedAt: string;
  /** 显式订阅：空间已从库删除，仅因本项目仍在使用而留存。 */
  retained?: boolean;
}

export interface LockAssetEntry {
  version: string;
  files: string[];
  /** 显示名称 — 上游 asset 删除后仍可在 UI 显示。capabilities 流程必填。 */
  name?: string;
  /** Asset 类型 — capabilities 流程必填，决定是否走 aggregate（mcp/hook）路径。 */
  type?: AssetType;
  /**
   * 单 Asset × 单厂商 的开关与文件归属。capabilities 流程必填；
   * 旧 `__plan__` 单 key lock 中此字段不存在，UI 视为 legacy 锁。
   */
  vendors?: Partial<Record<TargetTool, LockVendorState>>;
  /** 上游已删除但本地仍残留映射时的墓碑标记（当前未启用，预留）。 */
  tombstone?: true;
}

/** lock.assets[assetId].vendors[tool] 内的开关 + 文件归属。 */
export interface LockVendorState {
  enabled: boolean;
  /** 仅记 vendor 目录里这个 (asset, tool) 的文件；不含 aggregate（mcp.json / hooks.json）。 */
  files: string[];
  /** 关闭时间戳（ISO），仅 enabled=false 时填。 */
  disabledAt?: string;
}

/**
 * 聚合文件（mcp.json / hooks.json / settings.json）的归属记录。
 * 单文件 path + 当前贡献了 entry 的 assetIds。reconcile 时 server 算出
 * merge-spec（entries + ownedKeys），CLI 据此 read-modify-write 并保留 foreign 条目；
 * contributingAssetIds 为空仅表示「Loom 已无贡献」，foreign 条目仍在则文件保留。
 */
export interface LockAggregateEntry {
  file: string;
  contributingAssetIds: string[];
  /**
   * mcp 聚合专用：server key → 产出该 server 的 assetId。
   *
   * wrapped MCP 资产（content 为 `{mcpServers:{...}}`）的内层 server key 可能与
   * 资产名不同（adapter aggregateMcps 按内层 key 落盘，而 lock.assets 按资产名登记）。
   * scanner 据此把磁盘 mcp.json 的 server 子节点正确归到受管资产；缺失时退回用
   * asset.name 当 server key（single 形态 MCP 仍正确，wrapped 形态会漏）。
   * 仅 mcp 聚合填充；hook 聚合留空。
   */
  serverKeys?: Record<string, string>;
}

export interface LockFile {
  /**
   * 当前生效的空间订阅快照（含隐式订阅；隐式订阅不一定出现——它只影响 policy/targetTools
   * 的默认语义，lock 里只记录显式订阅即可）。reconcile v3 每次整体重写。
   */
  subscriptions: WorkspaceSubscription[];
  version: string;
  assets: Record<string, LockAssetEntry>;
  /** 各厂商的聚合文件登记（mcp.json、hooks.json）。capabilities 流程下使用。 */
  aggregates?: Partial<Record<TargetTool, LockAggregateEntry[]>>;
  /**
   * Lock 文件格式版本。缺省视作 v1（含 v1 per-asset 和更早的 legacy `__plan__`）。
   * v2 reconcile handler 写入时填 "2"；首次从 v1 升级时，从原 lock 中提取
   * 已 disabled 的 (assetId, tool) 集合通过响应回传 server。
   * "3"：多空间订阅（ADR-0006），workspaceId/policy 单值字段被 subscriptions 取代。
   */
  lockFormat?: "2" | "3";
  /** @deprecated v3 起由 subscriptions 取代；仅为读取旧 lock 迁移保留。 */
  workspaceId?: string | null;
  /** @deprecated v3 起由 subscriptions 取代；仅为读取旧 lock 迁移保留。 */
  policy?: SyncPolicy;
}

// ============ Project ============

export interface Project {
  id: string;
  deviceId: string;
  userId: string;
  projectName: string;
  normalizedPath: string;
  registeredAt: string;
  detectedTargets: TargetTool[];
  defaultTargets: TargetTool[];
  /**
   * 项目的空间订阅集合（ADR-0006）。显式订阅（workspaceId 非空）+ 至多一条隐式订阅
   * （workspaceId=null，「单独添加的能力」组）。list/detail 接口恒返回；注册响应等
   * 轻量场景可为空数组。
   */
  subscriptions: WorkspaceSubscription[];
  status: ProjectStatus;
}

export interface ProjectRegisterInput {
  deviceId: string;
  projectName: string;
  normalizedPath: string;
  detectedTargets: TargetTool[];
}

// ============ Install Plan ============

export type DiffOperation = "add" | "remove" | "modify" | "merge";

/** 配置型文件合并策略；与 @maolinc/cc-loom-adapter 的 MergeStrategy 同义。 */
export type DiffMergeStrategy = "hooks-registry" | "settings-with-hooks" | "mcp-servers";

export interface DiffEntry {
  operation: DiffOperation;
  path: string;
  type: AssetType;
  assetName: string;
  content?: string;
  /** "base64" 表示 content 是二进制内容的 base64，agent 落盘前需解码；缺省为 UTF-8 文本。 */
  encoding?: "base64";
  /** operation === "merge" 时必填，表示如何与现存文件合并。 */
  mergeStrategy?: DiffMergeStrategy;
  /**
   * 该 entry 归属的 Asset id（buildPlan / capabilities 原语下发时填）。
   * 旧路径仍可不填（merge 类的聚合文件由调用方在 lock.aggregates 里另记）。
   */
  assetId?: string;
  /** 该 entry 归属的目标厂商；与 assetId 配合用于 lock.assets[id].vendors[tool] 归属。 */
  tool?: TargetTool;
}

/**
 * 安装冲突：待装空间里与项目现有受管能力「同名不同 id」的 asset（落盘路径必然撞车）。
 * 用户在安装流程中逐条裁决（跳过该能力 / 全部跳过 / 取消），execute 携带
 * skipAssetIds（incomingAssetId 集合）完成裁决。
 */
export interface InstallConflict {
  /** 待装空间里撞车的 asset id。 */
  incomingAssetId: string;
  /** 项目中已存在的同名 asset id（被其他订阅或单独添加占用）。 */
  existingAssetId: string;
  name: string;
  type: AssetType;
}

export interface InstallPlan {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  targetTools: TargetTool[];
  policy: SyncPolicy;
  diff: DiffEntry[];
  conflicts: string[];
  /** 结构化撞车清单（可裁决）；与 conflicts 文案互补。 */
  conflictingAssets?: InstallConflict[];
}

export interface InstallResult {
  success: boolean;
  workspaceId: string;
  projectId: string;
  completedAt: string;
  filesWritten: string[];
  errors: string[];
}

// ============ Local Project Mirror ============
//
// agent 端扫描某个已注册项目的本地状态后产出的快照，由 server 缓存、广播到 web。
// 仅描述目录结构与 lock 归属，不携带文件内容（内容按需通过 /files API 拉取）。

export interface LocalFileNode {
  /** 文件/目录名（不含父路径） */
  name: string;
  /** 相对项目根的路径（POSIX 风格），如 ".cursor/skills/react-gen.md" */
  path: string;
  type: "file" | "dir";
  /** 该路径是否在当前 lock 里（仅文件有效；目录恒为 false） */
  managed: boolean;
  /** 仅 file 时填 */
  size?: number;
  /** 仅 dir 时填，已按"先目录后文件、字典序"排好 */
  children?: LocalFileNode[];
  /**
   * 该节点归属的 Asset id（来自 lock.assets）。仅 capabilities 流程会填；
   * legacy lock 下永远为 undefined。UI 据此渲染 toggle / 移除菜单。
   */
  assetId?: string;
  /**
   * 节点对应的 (assetId, tool) 是否处于"开启"状态。
   * - true：文件实际存在于 vendor 目录；
   * - false：文件在 ~/.loom/disabled/... 中，节点为占位（virtual="disabled-asset"）；
   * - undefined：legacy / 外部 / 未管理节点。
   */
  enabled?: boolean;
  /**
   * 虚拟节点类型：
   * - "mcp-server"：mcp.json 内的某个 server 名称（点击 toggle 控制 MCP asset 开关）；
   * - "disabled-asset"：lock 里 enabled=false 的能力，在 vendor 目录虚拟占位。
   */
  virtual?: "mcp-server" | "disabled-asset";
}

export interface VendorMirror {
  tool: TargetTool;
  /** 目录名（来自 TARGET_DIRS），如 ".cursor" */
  dir: string;
  /** 项目根下该目录是否存在 */
  exists: boolean;
  /** 顶层即 dir 本身的子节点（不包一层）；exists=false 时为 [] */
  tree: LocalFileNode[];
  /** 该 vendor 下属 lock 中文件数（实际存在于磁盘上的） */
  managedCount: number;
  /** 该 vendor 下管理的能力（asset）数量，用于「按能力」语义展示 */
  managedAssetCount: number;
  /** 该 vendor 下属磁盘上但不在 lock 里的文件数 */
  externalCount: number;
  /** 该 vendor 下属 lock 中应在但磁盘缺失的文件数（用于"部分缺失"告警） */
  missingCount: number;
}

export interface LocalProjectState {
  projectId: string;
  /** ISO timestamp，agent 完成本次 scan 的时间 */
  scannedAt: string;
  /** 4 个厂商恒在；TargetTool 之外不出现 */
  vendors: Record<TargetTool, VendorMirror>;
  /** 来自 lock，agent 视角下的真值；本地 lock 不存在或已被自动清空时为空数组 */
  installedWorkspaceIds: string[];
  /** 本次 scan 是否触发了"lock 中文件全部缺失 → 自动清 lock"修复 */
  driftCleared: boolean;
  /**
   * 已安装能力的"扁平视图"：从 lock.assets 投影而来。capabilities 流程下使用，
   * UI 用于反查节点 assetId、提供「+ 添加能力」对话框的已选回填、移除时的提示。
   * legacy lock 下为空数组。
   */
  capabilities?: AssetCapability[];
  /** lock 是否为旧版 `__plan__` 单 key 格式。UI 据此提示「重新安装后启用单项能力管理」。 */
  legacyLock?: boolean;
}

/** 已安装能力在 LocalProjectState 中的视图（按「类型 + 名称」合并为一行，跨厂商聚合）。 */
export interface AssetCapability {
  /** 代表性 id：任一厂商受管资产 id；若该能力在所有厂商都未纳管则为 `external:<type>:<name>`。 */
  assetId: string;
  name: string;
  type: AssetType;
  /** 该能力在每个厂商目录下的实际状态（受管或磁盘副本）；只填「本地该厂商目录里存在」的 tool。 */
  vendors: Partial<Record<TargetTool, AssetCapabilityVendor>>;
  /**
   * 本地累计调用次数（仅 skill）。本地控制台展示用；随该项目 lock 走，
   * 移除能力后清零，重装从 0 起。由 hook 旁路统计写入。
   */
  invocationCount?: number;
  /**
   * 内部标记：该能力在所有厂商目录下都未纳入 lock（纯磁盘副本）。
   * 仅用于内部逻辑，UI 不再对用户区分「外部/受管」——所见即所得地展示本地目录内容。
   */
  external?: boolean;
  /**
   * hook 能力声明注册的事件集合（Claude Code 事件词汇）。受管能力由 server 从
   * asset metadata  enrichment 得出（disabled 也能展示）；外部能力由 CLI 从磁盘
   * 聚合注册表扫描得出（各厂商 hookEvents 的并集）。
   */
  hookEvents?: string[];
  /**
   * 来源订阅（server 端富化，控制台「来源空间」徽标）：该能力被哪些订阅引用。
   * 多个 = 共享能力；workspaceId=null 表示「单独添加」（隐式订阅）。
   */
  sources?: { workspaceId: string | null; name: string }[];
}

export interface AssetCapabilityVendor {
  enabled: boolean;
  /** 该 (asset, tool) 在 vendor 目录里的文件路径；关闭时也保留供 UI 显示「关闭前路径」。 */
  files: string[];
  /** vendor 目录中实际存在的文件数（用于检测 missing）。 */
  presentCount: number;
  /**
   * 该厂商下的受管资产 id；toggle/移除该厂商格时用它作为权威 assetId。
   * 同名能力在不同厂商可能是不同的 asset 行（各自 adopt/安装），故 id 落到 vendor 粒度。
   * 磁盘副本（未纳管）时为空。
   */
  assetId?: string;
  /**
   * 该厂商下这份是磁盘副本（未纳入 lock）。true 时 toggle 需先 adopt（内部处理，用户无感知）。
   */
  external?: boolean;
  /**
   * hook 能力在该厂商聚合注册表（settings.json/hooks.json）里实际注册的事件
   * （该厂商原生词汇，如 cursor 的 camelCase）。由 CLI 扫描得出；仅 hook 类型填。
   */
  hookEvents?: string[];
}

// ============ API Types ============

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssetSearchParams {
  query?: string;
  type?: AssetType;
  tags?: string[];
  visibility?: Visibility;
  page?: number;
  pageSize?: number;
}

export interface WorkspaceSearchParams {
  query?: string;
  visibility?: Visibility;
  page?: number;
  pageSize?: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface WsMessage<T = unknown> {
  type: string;
  payload: T;
}

export interface WsInstallRequest {
  projectId: string;
  workspaceId: string;
  targetTools: TargetTool[];
  policy: SyncPolicy;
}

export interface WsInstallResponse {
  requestId: string;
  status: "pending" | "running" | "completed" | "failed";
  plan?: InstallPlan;
  result?: InstallResult;
}

// ============ Wire 协议 v2：reconcile ============
//
// v2 协议下 server→CLI 所有「落盘指令」收口到单一 op `reconcile`。Server 端用
// reconcileProject(projectId) 计算 ReconcilePlan，CLI 端用 handleReconcile(req)
// 应用 plan。文件级 diff（写哪些、删哪些、聚合写什么）由 server 端 adapter 渲染
// 后塞进 plan，CLI 仅负责落盘。详见 docs/refactor/wire-protocol-unification.md。

/**
 * 单个文件级写入：path 是项目根相对的 POSIX 路径，content 为文本内容（encoding=
 * "base64" 时为 base64 编码的二进制）。CLI 直接落盘，不再渲染。
 */
export interface ReconcileFile {
  path: string;
  content: string;
  encoding?: "base64";
}

/**
 * 单个 asset 在每个 vendor 下的落盘单元。`enabled=false` 时该 vendor 下的 files
 * 应放到隔离区（~/.loom/disabled/...），用于"先禁用、后启用"时无需重新发渲染结果。
 */
export interface ReconcileAssetVendor {
  tool: TargetTool;
  enabled: boolean;
  files: ReconcileFile[];
}

export interface ReconcileAsset {
  assetId: string;
  name: string;
  type: AssetType;
  version: string;
  vendors: ReconcileAssetVendor[];
}

/**
 * 聚合文件中 Loom 拥有的单个条目（merge-preserving 写入单位）。
 */
export interface ReconcileAggregateEntry {
  /**
   * 条目键。mcp = server 名（mcpServers dict 的 key）；
   * hook = event 名（hooks registry 的 key，同一 event 可有多条 → entries 多条同 key）。
   */
  key: string;
  /** 该键下 Loom 渲染的值（已序列化的 JSON 值，非字符串）。 */
  value: unknown;
  /**
   * 产出该条目的资产 id（仅 mcp 条目携带；hook 条目无）。wrapped MCP 资产的内层
   * server key 可能与资产名不同，reconcile 注入凭据时须凭 assetId 回溯绑定，而非
   * 用「资产名 === server key」匹配（后者会漏掉 wrapped 资产）。
   */
  assetId?: string;
}

/**
 * 聚合文件（mcp.json / hooks.json / settings.json）的 merge-preserving 落盘指令。
 *
 * CLI 据此对现有文件做 read-modify-write：按 `ownedKeys` 识别并删除 Loom 拥有的旧
 * 条目，写入 `entries`（enabled 资产渲染），**保留所有 foreign 条目**（用户手写 /
 * 其它来源的 server / hook / settings 键）。这取代 v1「整文件重算」，避免抹掉用户
 * 手写配置——是 adopt 外部能力、以及对含 foreign 条目的聚合做 toggle 的前提。
 *
 * - `entries`：本次应设值的 owned 条目（enabled 资产）。
 * - `ownedKeys`：Loom 当前拥有的全部键/名（enabled + disabled + removed）。CLI 据此
 *   识别现有文件中属于 Loom 的条目并删除（disabled / removed 不在 entries 中 → 删除）。
 *   mcp = server 名集合；hook = 受管 hook 资产名集合（按命令路径 `/<targetDir>/hooks/<name>/` 判别）。
 * - `contributingAssetIds`：仍 enabled 的 assetId，用于 CLI lock.aggregates 登记。
 */
export interface ReconcileAggregate {
  tool: TargetTool;
  type: "mcp" | "hook";
  path: string;
  entries: ReconcileAggregateEntry[];
  ownedKeys: string[];
  contributingAssetIds: string[];
}

export interface ReconcilePlan {
  /** 期望已装且 vendor 文件落地的 asset。 */
  enabled: ReconcileAsset[];
  /** 期望已禁用、文件在隔离区的 asset。 */
  disabled: ReconcileAsset[];
  /**
   * 上次 plan 含本次已不在的 asset —— CLI 应删除其所有 vendor 文件（vendors[].files）
   * + 隔离区副本 + 从 lock 删除。带 vendors/files 让 server 直接给出磁盘路径，
   * 不依赖 CLI oldLock（从未入 lock 的外部能力也能被删）。
   */
  removed: ReconcileAsset[];
  /** 聚合文件最终内容。 */
  aggregates: ReconcileAggregate[];
}

/**
 * server→CLI 的 reconcile op 请求体。
 *
 * - `subscriptions`：本次 plan 期望生效的订阅快照（显式 + 隐式），CLI 原样写入 lock；
 *   空数组 = 项目未安装任何空间（清空状态）。
 * - `targetTools`：本项目的有效 tool 集合（全部订阅 targetTools 的并集；
 *   隐式订阅取项目有效工具）；CLI 用于在 plan 之外做兜底清理。
 */
export interface WsReconcileRequest {
  requestId: string;
  projectId: string;
  subscriptions: WorkspaceSubscription[];
  targetTools: TargetTool[];
  plan: ReconcilePlan;
}

/**
 * CLI→server 的 reconcile op 响应数据段（嵌在通用 res payload.data 内）。
 *
 * - `migrationDisabled`：仅在 CLI 首次从 v1 lock 升级到 v2 时填充——把 lock 里
 *   单边持有的 (assetId, tool) disabled 状态上报给 server，server 写入
 *   `project_disabled_assets` 完成 toggle 状态的迁移。
 */
export interface WsReconcileResponseData {
  filesWritten: string[];
  filesRemoved: string[];
  lockWorkspaceIds: string[];
  migrationDisabled?: Array<{ assetId: string; tool: TargetTool }>;
}

/**
 * CLI 在 auth 消息中自报支持的 wire 协议能力。server 端 outbox 入队点据此
 * 选择 v1 或 v2 路径。缺失/false 视为 v1。
 *
 * 字段以 `reconcileV2` 命名而非 `v2`，便于未来再加新协议时按特性各自开关。
 */
export interface AgentCapabilities {
  reconcileV2?: boolean;
  /**
   * 多空间订阅协议（ADR-0006）：reconcile op 携带 subscriptions 数组、lock 写 v3。
   * server 硬门槛：不支持即拒连（产品未上线，不维护旧协议兼容层）。
   */
  subscriptionsV3?: boolean;
  /** 支持设备级 Codex / Claude Code 用户配置档合并下发。 */
  toolConfigProfiles?: boolean;
}

/**
 * Agent → Server 的 skill 调用次数旁路上报。
 * `delta` 是自上次上报以来新增的调用数（增量），Server 累加到 assets.invocation_count。
 * 增量语义保证「本地清零/重装」不影响市场累计。
 */
export interface SkillUsageReport {
  projectId: string;
  items: { assetId: string; delta: number }[];
}

// ============ Config ============

export interface CliConfig {
  endpoint: string;
  token: string;
  deviceId: string;
}

// ============ Marketplace Source ============

export interface MarketplaceSource {
  id: string;
  kind: SourceKind;
  parentId: string | null;
  repoUrl: string;
  displayName: string;
  description: string;
  addedBy: string;
  originAuthor: string | null;
  ref: string | null;
  enabled: boolean;
  syncIntervalMinutes: number | null;
  lastSyncStatus: SyncStatus | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastCommitSha: string | null;
  localPath: string;
  /**
   * 能力类型过滤：`null` = 导入全部类型（默认）；非空数组 = 仅导入列出的类型。
   * 在导入/刷新时作用于 provider 解析出的 assets 与每个 plugin 的 assets。
   * 子数据源继承父源的设置。
   */
  assetTypesFilter: AssetType[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceSourceWithCounts extends MarketplaceSource {
  assetCount: number;
  workspaceCount: number;
}

export interface MarketplaceSyncLog {
  id: string;
  sourceId: string;
  trigger: SyncTrigger;
  status: SyncStatus;
  added: number;
  updated: number;
  removed: number;
  durationMs: number;
  error: string | null;
  startedAt: string;
}

export interface AppSetting {
  key: string;
  value: string;
  updatedAt: string;
}

// ============ AI Generation ============

export interface AiSettings {
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
}

export interface AiSettingsUpdateInput {
  baseUrl: string;
  apiKey?: string;
  model?: string;
}

export interface AssetBasicInfoGenerateRequest {
  type: AssetType;
  name?: string;
  alias?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  files?: Array<{ path: string; content: string }>;
}

export interface GeneratedAssetBasicInfo {
  /** AI 不再生成 name（落盘身份，由作者自填）。保留字段供旧契约，生成结果中缺省。 */
  name?: string;
  alias: string;
  tags: string[];
  description: string;
  /** AI 推断的鉴权声明（绑定列表；mcp 类型可推断 path 绑定）。 */
  auth?: AssetAuth;
}

// ============ Capability Credentials（设置页：凭据值 + 显式分发，ADR-0003）============
//
// 与创建页的 AssetAuth「声明」解耦：用户在设置页独立维护凭据名→加密值，值加密存
// DB，明文永不通过 REST 返回。分发是显式 opt-in（不在配置时自动下发）：
//  - env 绑定 → 推送到设备系统环境变量（env:push），分发维度 = 设备。
//  - path 绑定 → reconcile 渲染时字面替换进项目 .mcp.json，分发维度 = 项目。
//
// 凭据「被用到哪里」由 credential_usages（reconcile-end 钩子维护）驱动展示。

/**
 * 凭据分发维度（ADR-0004：凭据创建时即定型）。env = 推到设备系统环境变量；
 * path = 写进项目 .mcp.json。一个凭据只属于一种轴——禁止跨轴分发（env 凭据
 * 不可分发到项目、path 凭据不可下发到设备）。值须与 constants.CREDENTIAL_AXES 对齐。
 */
export type CredentialAxis = "env" | "path";

export interface Credential {
  id: string;
  userId: string;
  /** 凭据名 = 绑定的 credentialName 链接键。 */
  name: string;
  /**
   * 分发轴（创建时定型，不可变）。env→仅设备维度分发；path→仅项目维度分发。
   * 决定设置页该凭据可见的下发按钮与列表分组。
   */
  axis: CredentialAxis;
  /** 描述（用途说明），展示用。 */
  description?: string;
  /** 是否已配置值（值本身永不返回）。 */
  hasValue: boolean;
  /** 最近一次任意分发时间（本轴），用于 UI 展示。 */
  lastPushedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialInput {
  name: string;
  axis: CredentialAxis;
  value: string;
  description?: string;
}

/** 单条分发记录。 */
export interface CredentialDistribution {
  credentialId: string;
  /** 分发维度：env=设备系统环境变量；path=项目 .mcp.json 注入。 */
  axis: CredentialAxis;
  /** env=设备 id；path=项目 id。 */
  targetId: string;
  /** 展示用：设备名或项目名。 */
  targetName: string;
  pushedAt: string;
}

// ============ Wire 协议：env var 下发/回收 ============
//
// server → agent 的实时指令。仅对在线 agent 下发，不落 outbox（离线设备不处理）。
// payload 携带解密后的明文 value，由 agent 写入设备系统环境变量文件。

/** env:push —— 把一个环境变量写入设备系统环境变量（env 绑定分发路径）。 */
export interface WsEnvPushPayload {
  key: string;
  value: string;
}

/** env:revoke —— 从设备系统环境变量移除一个 key。 */
export interface WsEnvRevokePayload {
  key: string;
}

// ============ Tool Config Profiles（Codex / Claude Code 设备配置）============

export type ToolConfigTool = "codex" | "claudecode";

export interface CodexToolConfig {
  modelProvider: string;
  disableResponseStorage: boolean;
  networkAccess: "enabled" | "disabled";
  windowsWslSetupAcknowledged: boolean;
  baseUrl: string;
  wireApi: "responses";
  requiresOpenaiAuth: boolean;
  goals: boolean;
}

export interface ClaudeCodeToolConfig {
  baseUrl: string;
  defaultFableModel: string;
  defaultFableModelName: string;
  defaultHaikuModel: string;
  defaultHaikuModelName: string;
  defaultOpusModel: string;
  defaultOpusModelName: string;
  defaultSonnetModel: string;
  defaultSonnetModelName: string;
  model: string;
  apiTimeoutMs: string;
  disableNonessentialTraffic: string;
  experimentalAgentTeams: string;
  enableToolSearch: string;
  hasCompletedOnboarding: boolean;
}

interface ToolConfigProfileBase {
  id: string;
  userId: string;
  name: string;
  secretConfigured: boolean;
  lastPushedAt?: string | null;
  deviceCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ToolConfigProfile = ToolConfigProfileBase & (
  | { tool: "codex"; config: CodexToolConfig }
  | { tool: "claudecode"; config: ClaudeCodeToolConfig }
);

export interface ToolConfigDistribution {
  profileId: string;
  tool: ToolConfigTool;
  deviceId: string;
  deviceName: string;
  pushedAt: string;
}

/** Server → Agent 的设备级配置合并指令；secret 不落日志、不经 REST 返回。 */
export type WsToolConfigApplyPayload =
  | { profileName: string; tool: "codex"; config: CodexToolConfig; secret: string }
  | { profileName: string; tool: "claudecode"; config: ClaudeCodeToolConfig; secret: string };

// ============ Imported (in-memory only, not DB) ============

export interface ImportedAsset {
  sourcePath: string;
  name: string;
  type: AssetType;
  description: string;
  files: AssetFileInput[];
  compatibleTools: TargetTool[];
  version: string;
  tags: string[];
  originAuthor: string | null;
  metadata: AssetMetadata;
}

export interface ImportedPlugin {
  pluginName: string;
  description: string;
  version: string;
  assets: ImportedAsset[];
}

export interface ProviderResult {
  displayName: string;
  description: string;
  originAuthor: string | null;
  assets: ImportedAsset[];
  plugins: ImportedPlugin[];
  /** sub-sources to auto-register (e.g. plugin URLs inside a marketplace) */
  childSources: { repoUrl: string; displayName: string; ref: string | null }[];
}

// ============ Push (CLI → Server) ============

/**
 * `loom push` 请求体：CLI 读取本地厂商目录、解析为 ImportedAsset[] 后发送给 Server。
 * Server 按 (author, type, name) upsert asset，按 (user_id, name) upsert workspace。
 */
export interface PushRequest {
  /** 工作空间名称，默认格式 `用户名/项目目录名`，如 `maolinc/aa` */
  name: string;
  visibility: Visibility;
  /** 推送的来源厂商目录 */
  targetTool: TargetTool;
  assets: ImportedAsset[];
}

export interface PushResult {
  workspaceId: string;
  workspaceName: string;
  /** true = 新建工作空间；false = 覆盖已有同名工作空间 */
  created: boolean;
  assetCount: number;
}

// ============ Embedding / 语义搜索 ============

export type EmbeddingProvider = "nvidia" | "openai" | "custom";

export interface EmbeddingWeights {
  name: number;
  tags: number;
  description: number;
}

/** 服务级 embedding 配置（admin 维护，全站共用）。apiKey 明文不返回，仅 apiKeyConfigured。 */
export interface EmbeddingSettings {
  enabled: boolean;
  /** 搜索模式：启用词法路（FTS5 BM25）。与 useSemantic 至少一个为 true。 */
  useLexical: boolean;
  /** 搜索模式：启用语义路（vec KNN，需 enabled 且向量可用）。与 useLexical 至少一个为 true。 */
  useSemantic: boolean;
  provider: EmbeddingProvider;
  baseUrl: string;
  model: string;
  dim: number;
  apiKeyConfigured: boolean;
  passageInputType: string;
  queryInputType: string;
  extraBody: Record<string, unknown>;
  weights: EmbeddingWeights;
  alpha: number;
  /** 语义相似度阈值（cosine similarity）；vec KNN 仅纳入 ≥ 此值者。0=不过滤。 */
  simThreshold: number;
  batchSize: number;
  concurrency: number;
  minIntervalMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
}

export interface EmbeddingSettingsUpdate {
  enabled?: boolean;
  useLexical?: boolean;
  useSemantic?: boolean;
  provider?: EmbeddingProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dim?: number;
  passageInputType?: string;
  queryInputType?: string;
  extraBody?: Record<string, unknown>;
  weights?: EmbeddingWeights;
  alpha?: number;
  simThreshold?: number;
  batchSize?: number;
  concurrency?: number;
  minIntervalMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
}

export interface SearchQueueCounts {
  pending: number;
  processing: number;
  ready: number;
  failed: number;
  total: number;
  /** 全部可见能力数（含未索引——尚未有 asset_embeddings 行的）。 */
  assets: number;
  /** 是否处于模型/维度重建中（期间搜索词法降级）。 */
  rebuilding: boolean;
}

export interface SearchQueueItem {
  assetId: string;
  name: string;
  type: AssetType;
  queuedAt: string;
  attempts: number;
  lastError: string | null;
  processedAt: string | null;
  embedModel: string | null;
}

export interface SearchQueueList {
  items: SearchQueueItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** 单个能力的索引状态（全部能力视图）。unindexed = 尚无 asset_embeddings 行。 */
export type AssetIndexStatus = "ready" | "pending" | "processing" | "failed" | "unindexed";

export interface SearchAssetIndexItem {
  assetId: string;
  name: string;
  type: AssetType;
  status: AssetIndexStatus;
  /** 最近一次成功构建时间（ready 的 processed_at；requeue 后保留，故 pending 仍可见上次成功时间）。 */
  processedAt: string | null;
  embedModel: string | null;
  lastError: string | null;
  /** 该能力向量索引存储大小（字节）= vec 行数 × embed_dim × 4；未索引/降级为 0。 */
  indexSizeBytes: number;
}

export interface SearchAssetIndexList {
  items: SearchAssetIndexItem[];
  page: number;
  pageSize: number;
  total: number;
  /** 全部可见能力的向量索引汇总大小（字节）。 */
  totalSizeBytes: number;
}

export interface SearchRequeueInput {
  assetIds?: string[];
  all?: boolean;
}

// ============ 能力信息生成队列（ADR-0005，镜像向量化骨架，补缺口模型）============
//
// 后台为已落库能力自动补全空缺的 alias/tags/description/auth.bindings。
// 镜像 asset_embeddings 队列表 + worker + 入队 hook + 设置页管理，但写入语义是
// 补缺口（只填空字段，永不重算已有），无 content_hash/field_version/embed_dim。
// 配置服务级（admin，app_settings），与每用户表单按钮配置并存。

export type AiGenProvider = "openai" | "custom";

/** 服务级能力信息生成配置（admin 维护）。apiKey 明文不返回，仅 apiKeyConfigured。 */
export interface AiGenSettings {
  enabled: boolean;
  provider: AiGenProvider;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  /** 打开后 worker 处理时无条件覆盖 alias/tags/description/auth.bindings（含新建首次），
   *  而非补缺口。用于「用更好模型/提示重算全部描述性字段」场景；关闭则只填空字段。 */
  overwrite: boolean;
  /** 队列消费并发数；默认 1 规避接口限频。 */
  concurrency: number;
  /** 两次生成请求间的最小间隔（ms）；RPM 限频时设置。 */
  minIntervalMs: number;
  /** 单条队列项失败最大重试次数（worker 层）。 */
  maxAttempts: number;
  /** 失败重试指数退避基数（next_attempt_at = now + base × 2^attempts）。 */
  backoffBaseMs: number;
}

export interface AiGenSettingsUpdate {
  enabled?: boolean;
  provider?: AiGenProvider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  overwrite?: boolean;
  concurrency?: number;
  minIntervalMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
}

export interface AiInfoQueueCounts {
  pending: number;
  processing: number;
  ready: number;
  failed: number;
  total: number;
  /** 全部可见能力数（含尚未入队的）。 */
  assets: number;
}

export interface AiInfoQueueItem {
  assetId: string;
  name: string;
  type: AssetType;
  queuedAt: string;
  attempts: number;
  lastError: string | null;
  processedAt: string | null;
  genModel: string | null;
}

export interface AiInfoQueueList {
  items: AiInfoQueueItem[];
  page: number;
  pageSize: number;
  total: number;
}

/** 单个能力的生成状态（全部能力视图）。unindexed = 尚无 asset_ai_info 行。 */
export type AiInfoIndexStatus = "ready" | "pending" | "processing" | "failed" | "unindexed";

export interface AiInfoAssetIndexItem {
  assetId: string;
  name: string;
  type: AssetType;
  status: AiInfoIndexStatus;
  /** 最近一次成功生成时间。 */
  processedAt: string | null;
  genModel: string | null;
  lastError: string | null;
  /** 各字段当前是否为空（worker 会补的缺口）。 */
  aliasEmpty: boolean;
  tagsEmpty: boolean;
  descriptionEmpty: boolean;
  /** auth.bindings 是否为空（无绑定行）。 */
  authEmpty: boolean;
}

export interface AiInfoAssetIndexList {
  items: AiInfoAssetIndexItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AiInfoRequeueInput {
  assetIds?: string[];
  all?: boolean;
}
