/**
 * 默认网络端口 — 全项目单一来源。
 *
 * 选用 47474/47475（IANA 动态/私有端口段，远离常见占用：
 * 3000 Node、5173 Vite、8080 Tomcat、8000 Django、4000、5000、9000 等）。
 *
 * 运行时可分别通过 PORT (server) 与 vite --port 覆盖。
 */
export const DEFAULT_SERVER_PORT = 47474;
export const DEFAULT_WEB_DEV_PORT = 47475;
export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_ENDPOINT = `http://localhost:${DEFAULT_SERVER_PORT}`;

export const ASSET_TYPES = ["skill", "rule", "mcp", "hook", "command", "agent"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  skill: "Skill",
  rule: "Rule",
  mcp: "MCP",
  hook: "Hook",
  command: "Command",
  agent: "Agent",
};

export const ASSET_TYPE_COLORS: Record<AssetType, { bg: string; text: string }> = {
  skill: { bg: "#E0EDFF", text: "#0062FF" },
  rule: { bg: "#FEF3C7", text: "#D97706" },
  mcp: { bg: "#D1FAE5", text: "#059669" },
  hook: { bg: "#EDE9FE", text: "#7C3AED" },
  command: { bg: "#CFFAFE", text: "#0891B2" },
  agent: { bg: "#FCE7F3", text: "#DB2777" },
};

export const ASSET_TYPE_DIRS: Record<AssetType, string> = {
  skill: "skills",
  rule: "rules",
  mcp: "",
  hook: "hooks",
  command: "commands",
  agent: "agents",
};

/**
 * 规范化能力类型过滤：`null`/`undefined`/空数组/覆盖全部类型 → `null`（= 全部）；
 * 否则返回去重后的子集（按 ASSET_TYPES 顺序）。`null` 语义是"导入全部"，这样
 * 后续新增类型时也会自动包含，且便于持久化（DB 列存 JSON 或 NULL）。
 */
export function normalizeAssetTypesFilter(types: readonly AssetType[] | null | undefined): AssetType[] | null {
  if (!types || types.length === 0) return null;
  const set = new Set(types);
  if (ASSET_TYPES.every((t) => set.has(t))) return null;
  return ASSET_TYPES.filter((t) => set.has(t));
}

export const TARGET_TOOLS = ["claudecode", "codex", "cursor", "codebuddy"] as const;
export type TargetTool = (typeof TARGET_TOOLS)[number];

/** 按 TARGET_TOOLS 顺序排序工具数组（用于前端展示一致性）。 */
export function sortTargetTools(tools: readonly TargetTool[]): TargetTool[] {
  const order = new Map<TargetTool, number>(TARGET_TOOLS.map((t, i) => [t, i]));
  return [...tools].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

export const TARGET_TOOL_LABELS: Record<TargetTool, string> = {
  cursor: "Cursor",
  codebuddy: "CodeBuddy",
  codex: "Codex",
  claudecode: "ClaudeCode",
};

export const TARGET_DIRS: Record<TargetTool, string> = {
  cursor: ".cursor",
  codebuddy: ".codebuddy",
  codex: ".codex",
  claudecode: ".claude",
};

/**
 * (TargetTool, AssetType) 兼容表 — 来源是各 adapter 类的 `supportedTypes`，
 * 在 web/CLI 中用于 UI 提示（矩阵视图的"不支持"单元格、安装计划的"已跳过"行）。
 *
 * 真值仍以 packages/adapter 内的实例 supportedTypes 为准；这里只是供前端拉一个
 * 静态副本，避免把整个 adapter 包打进 web bundle。修改 adapter 时记得同步这里。
 */
export const ADAPTER_SUPPORT: Record<TargetTool, readonly AssetType[]> = {
  cursor: ["skill", "rule", "mcp", "hook", "command", "agent"],
  codebuddy: ["skill", "rule", "mcp", "hook", "command", "agent"],
  codex: ["skill", "rule", "mcp", "hook", "agent"],
  claudecode: ["skill", "rule", "mcp", "hook", "command", "agent"],
};

export const VISIBILITY_OPTIONS = ["public", "private"] as const;
export type Visibility = (typeof VISIBILITY_OPTIONS)[number];

export const SYNC_POLICIES = ["auto", "locked"] as const;
export type SyncPolicy = (typeof SYNC_POLICIES)[number];

/**
 * 鉴权绑定类型（ADR-0003）。一个资产的鉴权声明是绑定列表，每条绑定按 kind 决定
 * 凭据值如何被消费：
 * - env：凭据值推送到设备系统环境变量（envKey 下），走 env:push 通道；分发维度 = 设备。
 * - path：凭据值在 reconcile 渲染时字面替换进 MCP server 定义的指定路径；分发维度 = 项目。
 *
 * 旧 AUTH_METHODS（none/env 单值）已废弃，由空 bindings 列表表示「无鉴权」。
 */
export const AUTH_BINDING_KINDS = ["env", "path"] as const;
export type AuthBindingKind = (typeof AUTH_BINDING_KINDS)[number];

/**
 * 凭据轴（ADR-0004）。凭据创建时即定型，决定其分发维度：
 * - env：分发到设备系统环境变量（targetId = 设备 id）；无项目维度分发。
 * - path：分发到项目 .mcp.json 注入（targetId = 项目 id）；无设备维度分发。
 * 轴在凭据上是不可变的——同一凭据名只服务于一种轴（ADR-0003 共享存储不变，
 * 仅在其上叠加「一凭据一轴」约束）。
 */
export const CREDENTIAL_AXES = ["env", "path"] as const;

export const PROJECT_STATUSES = [
  "registered",
  "online",
  "offline",
  "syncing",
  "dirty",
  "conflicted",
  "error",
  "unregistered",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const DEVICE_STATUSES = ["online", "offline"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const SOURCE_KINDS = ["claude-code-marketplace", "claude-code-plugin", "generic-git"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  "claude-code-marketplace": "Claude Code Marketplace",
  "claude-code-plugin": "Claude Code Plugin",
  "generic-git": "通用 Git 仓库",
};

export const SYNC_STATUSES = ["success", "failed", "running"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const SYNC_TRIGGERS = ["scheduled", "manual", "add"] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DEFAULT_POLL_INTERVAL_MINUTES = 360;
export const POLL_INTERVAL_OPTIONS = [5, 30, 60, 360, 1440] as const;

/**
 * Hook 事件名完整集合（按 Claude Code 官方 hooks 文档：
 * https://code.claude.com/docs/en/hooks）。
 *
 * 用于 hook.json 解析的事件名校验，以及 adapter 端的事件分组。
 */
export const HOOK_EVENTS = [
  // session
  "SessionStart", "Setup", "SessionEnd",
  // per-turn
  "UserPromptSubmit", "UserPromptExpansion", "Stop", "StopFailure",
  // agentic loop
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
  "PermissionRequest", "PermissionDenied",
  // async / observability
  "FileChanged", "CwdChanged", "ConfigChange", "InstructionsLoaded",
  "Notification", "WorktreeCreate", "WorktreeRemove",
  "PreCompact", "PostCompact",
  "SubagentStart", "SubagentStop",
  "TaskCreated", "TaskCompleted", "TeammateIdle",
  "Elicitation", "ElicitationResult",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
