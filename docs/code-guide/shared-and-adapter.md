# Shared 契约与 Adapter 引擎

> 事实来源：`packages/shared/src/*`、`packages/adapter/src/*`。修改公共类型、校验、目标工具、能力类型、落盘路径时必须先读这些文件。

## `@maolinc/cc-loom-shared`

入口：`packages/shared/src/index.ts`，统一导出：

- `constants.ts`
- `types.ts`
- `schemas.ts`
- `layout.ts`

### 常量

`packages/shared/src/constants.ts` 是下列值的公共来源：

| 常量 | 当前值/含义 |
|------|-------------|
| `DEFAULT_SERVER_PORT` | `47474` |
| `DEFAULT_WEB_DEV_PORT` | `47475` |
| `DEFAULT_ENDPOINT` | `http://localhost:47474` |
| `ASSET_TYPES` | `skill`、`rule`、`mcp`、`hook`、`command`、`agent` |
| `TARGET_TOOLS` | `cursor`、`codebuddy`、`codex`、`claudecode` |
| `TARGET_DIRS` | `cursor → .cursor`、`codebuddy → .codebuddy`、`codex → .codex`、`claudecode → .claude` |
| `SYNC_POLICIES` | `auto`、`locked` |
| `SOURCE_KINDS` | `claude-code-marketplace`、`claude-code-plugin`、`generic-git` |
| `HOOK_EVENTS` | Claude Code hooks 事件集合 |

`ADAPTER_SUPPORT` 是前端/CLI 展示用的静态支持矩阵；真实生成逻辑仍以 `packages/adapter/src/*` 的 adapter 实例为准。修改 adapter 支持类型时必须同步检查 `ADAPTER_SUPPORT`。

### 类型

`packages/shared/src/types.ts` 定义跨端契约，重要类型：

- 用户/认证：`User`、`UserSession`、`CliToken`、`Device`。
- 设备工具配置：`ToolConfigProfile`、`CodexToolConfig`、`ClaudeCodeToolConfig`、`ToolConfigDistribution`、`WsToolConfigApplyPayload`。
- 能力：`Asset`、`AssetFile`、`AssetCreateInput`、`AssetUpdateInput`、`AssetMetadata`。
- 能力集：`CapabilitySet`、`CapabilitySetAsset`、`CapabilitySetCreateInput`、`CapabilitySetUpdateInput`。
- 安装：`Manifest`、`ManifestAssetEntry`、`InstallPlan`、`DiffEntry`、`InstallResult`、`InstallConflict`（同名撞车裁决）。
- 订阅：`CapabilitySetSubscription`（ADR-0006 多能力集订阅；`capabilitySetId=null` 为隐式订阅）。
- 本地镜像：`Project`、`LocalProjectState`、`VendorMirror`、`LocalFileNode`、`AssetCapability`。
- Lock：`LockFile`、`LockAssetEntry`、`LockVendorState`、`LockAggregateEntry`。
- Marketplace：`MarketplaceSource`、`MarketplaceSyncLog`、`ImportedAsset`、`ImportedPlugin`。

注意：`AssetMetadata` 在 TypeScript 结构上不是严格 discriminated union，消费方应按 `asset.type` 在运行时 narrow。创建/更新时的强校验在 schema 层做。

skill 调用统计相关字段：`Asset.invocationCount`（市场总数）、`AssetCapability.invocationCount`（本地控制台单项），`SkillUsageReport`（Agent→Server 增量上报体）。adapter 不参与统计（tracker hook 由 CLI 侧注入，见 `cli-agent-flows.md`）。

### Zod 校验

`packages/shared/src/schemas.ts` 是 API 入参校验的公共来源：

- `assetCreateSchema` / `assetUpdateSchema`
- `capabilitySetCreateSchema` / `capabilitySetUpdateSchema`
- `projectRegisterSchema`
- `installRequestSchema`
- `assetSearchSchema` / `capabilitySetSearchSchema`
- `marketplaceCreateSchema` / `marketplaceDeleteQuerySchema`
- `settingsUpdateSchema`

关键领域规则：

- `skill` 必须包含位于技能目录根的 `SKILL.md`，由 `skillFilesHaveEntry()` / `refineSkillEntry()` 校验。
- metadata 会按 `Asset.type` 强校验：
  - `rule`: `{ globs: string[] }`
  - `mcp`: `{ transport, command?, url? }`
  - `hook`: `{ events?, event?, matcher?, hooks[] }`——`events[]` 为新多事件契约（一个 hook 可注册多个事件，安装时全部注册、关闭时从所有事件移除）；`event` 为旧单事件字段，读取一律走 `hookEventsOf()` 归一。adopt 的 foreign hook 另有 `passthrough` + `registrations`（逐事件原样注册项）。
  - `command`: `{ trigger }`
  - `skill` / `agent`: 空对象。

### 布局判定

`packages/shared/src/layout.ts` 的 `isAssetDirLayout()` 决定 asset 是目录型还是平铺型：

- `skill` 永远目录型。
- `hook` 永远目录型。
- `mcp` 不适用目录/平铺，聚合到 mcp 配置。
- 其他类型优先看 `sourcePath` 最后一段是否像文件名；本地创建且无 `sourcePath` 时，多文件为目录型、单文件为平铺型。

Server 构建 `ManifestAssetEntry` 时必须透传 `sourcePath`，否则 marketplace 来源的目录型资产可能被误判为平铺型。

### Asset 身份命名规则

能力的 `(type, name)` 是落盘身份，决定安装路径（如 `skills/<name>/SKILL.md`）。name 的推导优先级：

| 类型 | name 来源 | 回退 |
|------|----------|------|
| `skill` | SKILL.md frontmatter `name:` | skill 目录名 |
| `rule` / `command` / `agent` | frontmatter `name:` | 文件名（去扩展名） |
| `mcp` | mcp.json 中 server key | — |
| `hook` | hook 目录名 | — |

**为什么 skill 用 frontmatter `name` 而非文件夹名**：Claude Code 等工具注册 skill 时读的是 SKILL.md frontmatter 的 `name` 字段，文件夹只是物理容器。adapter（`base.ts:renderAssetFiles`）安装时**原样写出文件内容**，不改写 frontmatter。若两个 skill 文件夹不同但 frontmatter `name` 相同，安装后工具仍视为同一个——Loom 不会改写 frontmatter 来消除冲突。

因此：
- `vendor-reader.ts`（push）与 `generic-git.ts`（marketplace 导入）共用 `fm.name ?? 文件夹名` 优先级，保证同一 skill 无论来源如何身份一致。
- push 路由在 upsert 前检测批次内同名 `(type, name)`，冲突返回 409。
- 已安装/被引用的 asset 禁止改 `name`（`routes/assets.ts` 拦截），因为改 name 会改变落盘路径，导致本地出现重复或丢失。

## `@maolinc/cc-loom-adapter`

入口：`packages/adapter/src/index.ts`。主要模块：

| 文件 | 职责 |
|------|------|
| `base.ts` | `BaseAdapter`，普通文件渲染、MCP 聚合、Hook 注册表聚合、hook 命令路径改写 |
| `cursor.ts` | Cursor 适配，支持 `skill/rule/mcp/command` |
| `codebuddy.ts` | CodeBuddy 适配，支持全 6 类，hook 写入 `.codebuddy/settings.json` |
| `codex.ts` | Codex 适配，支持 `skill/rule/mcp/hook/agent`，hook 写入 `.codex/hooks.json`，agent 转写为 `.codex/agents/<name>.toml` |
| `claudecode.ts` | Claude Code 适配，支持全 6 类，MCP 写项目根 `.mcp.json` |
| `registry.ts` | adapter 实例注册，提供 `getAdapter()` / `getAdapters()` / `listAdapters()` |
| `merge.ts` | 合并策略：hooks、settings hooks、mcpServers |
| `install-key.ts` | 落盘身份判重坐标，用于 能力集 冲突检测 |
| `diff.ts` | diff 相关工具 |

### Adapter 输出规则

普通类型（`skill/rule/command/agent`）由 `BaseAdapter.renderAssetFiles()` 写入：

- 目录型：`<targetDir>/<typeDir>/<asset.name>/<file.path>`
- 平铺型：`<targetDir>/<typeDir>/<slugified-asset-name>.md`（单文件）或保留文件 basename（多文件）

`agent` 的厂商例外：Codex 子代理是单文件 TOML（`<targetDir>/agents/<slug>.toml`），`CodexAdapter.renderAssetFiles()` 覆写为格式转换——`name` ← slugify(asset.name)、`description` ← asset.description、`developer_instructions` ← 文件正文拼接，序列化为 TOML 基本多行字符串。其余厂商沿用默认 Markdown 渲染。

`mcp`：

- 聚合成 `{ mcpServers: { ... } }`。
- 默认写 `<targetDir>/mcp.json`。
- Claude Code 覆写为项目根 `.mcp.json`。
- 合并策略：`mcp-servers`，同名 server incoming 覆盖 existing，未提及的 existing 保留。

`hook`：

- `hook.json` 里的注册项聚合到厂商配置。
- 附属文件写到 `<targetDir>/hooks/<asset.name>/<file>`，但跳过 `hook.json`。
- Claude Code 写 `<targetDir>/settings.json` 顶层 `hooks` 字段，策略 `settings-with-hooks`（项目级 hook 只从 settings.json 加载；`hooks/hooks.json` 仅 plugin 包内有效，独立项目不读取）。
- CodeBuddy 写 `<targetDir>/settings.json`，策略 `settings-with-hooks`。
- Codex 写 `<targetDir>/hooks.json`，策略 `hooks-registry`。

### 合并策略

`packages/adapter/src/merge.ts`：

- `hooks-registry`：合并 `{ hooks: { event: matcherEntries[] } }`，同一 event + matcher 追加 hooks 数组。
- `settings-with-hooks`：settings 顶层浅合并，`hooks` 字段按 hooks registry 深合并。
- `mcp-servers`：合并 `mcpServers`，incoming 同名覆盖 existing。

CLI installer 在 `merge` 操作中调用 `mergeContent()`，不要在 server 端直接读写用户项目文件。

### 落盘身份冲突

`packages/adapter/src/install-key.ts` 定义 `computeInstallKey()`：

- 判重维度包含 `tool`，不同目标工具互不冲突。
- `skill/rule/command/agent`：`(tool, type, normalize(name))`。
- `mcp`：按 server key 判重，wrapped content 可产生多个 key。
- `hook`：只按附属目录名判重，`(tool, hook-dir, normalize(name))`。

Server 在 能力集 创建/更新、隐式 能力集 / 单项能力加入时用它拦截会互相覆盖的能力组合。
