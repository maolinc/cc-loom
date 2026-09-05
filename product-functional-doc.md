# Loom 产品功能文档

> 本文按当前代码事实更新。代码是唯一事实来源；若本文与源码冲突，以源码为准，并更新本文。
>
> 关键源码入口：`packages/shared/src/*`、`packages/server/src/routes/*`、`packages/server/src/ws/gateway.ts`、`packages/cli/src/*`、`packages/web/src/*`、`packages/adapter/src/*`。

## 1. 产品定位

### 1.1 产品名称与形态

- 产品名：`Loom`
- 形态：`Web 平台 + 本地 CLI/Agent`
- 分发包：
  - Server：`@maolinc/cc-loom-server`（bin：`loom-server`）
  - CLI：`@maolinc/cc-loom`（bin：`loom`）
- 技术形态：TypeScript monorepo，前端为 React + Vite SPA，后端为 Fastify + SQLite，CLI 通过 WebSocket 与 Server 长连接。

### 1.2 产品定义

Loom 是面向 AI 开发工具生态的能力注册、组合、安装与本地镜像平台。

用户在 Web 中管理可复用的 AI 工程能力单元（Asset），把多个 Asset 组合为 CapabilitySet，再安装到本机已注册项目中。实际文件写入由本地 Agent 完成，目标为项目内 AI 工具目录和配置文件。

### 1.3 核心价值

- 统一管理 Skill、Rule、MCP、Hook、Command、Agent 六类能力。
- 通过 CapabilitySet 组合多项能力，一次性安装到项目。
- 通过 Adapter 将统一能力模型转换到 Cursor、CodeBuddy、Codex、Claude Code 等工具目录。
- 通过本地 Agent 建立 Web 到本地项目目录的安全写入链路。
- 通过本地控制台展示真实磁盘镜像、Loom 管理文件和外部文件差异。

## 2. 当前实现范围

### 2.1 已实现的核心对象

| 对象 | 说明 | 主要事实来源 |
|------|------|--------------|
| `User` / `Session` | Web 登录用户与 cookie 会话 | `server/src/routes/auth.ts` |
| `CliToken` | CLI Bearer token，一个用户一条有效 token | `server/src/routes/auth.ts` |
| `Device` | 运行 `loom start` 的本地设备 | `server/src/routes/devices.ts`、`server/src/ws/gateway.ts` |
| `Project` | 通过 `loom register` 注册的本地项目目录 | `server/src/routes/projects.ts`、`cli/src/lib/projects.ts` |
| `Asset` | 最小能力单元，包含多文件内容和 metadata | `shared/src/types.ts`、`server/src/routes/assets.ts` |
| `CapabilitySet` | Asset 组合，可安装到 Project | `shared/src/types.ts`、`server/src/routes/capability-sets.ts` |
| `CapabilitySetSubscription` | 项目与 CapabilitySet 的安装关系（多能力集订阅，ADR-0006），携带 syncPolicy/targetTools | `shared/src/types.ts`、`server/src/lib/subscriptions.ts` |
| `Manifest` | Server 构建安装计划时的统一中间结构 | `shared/src/types.ts`、`server/src/routes/install.ts` |
| `LockFile` | CLI 本地安装账本，记录 managed 文件、能力开关和聚合贡献 | `shared/src/types.ts`、`cli/src/lib/installer.ts` |
| `MarketplaceSource` | 外部 Git 来源，导入 Asset / CapabilitySet | `server/src/marketplace/*` |

### 2.2 支持的 Asset 类型

当前支持六类：

| 类型 | 主要用途 | 必要 metadata / 文件规则 |
|------|----------|--------------------------|
| `skill` | 目录型自然语言能力 | 必须包含根 `SKILL.md` |
| `rule` | AI 行为/代码规范约束 | `metadata.globs: string[]` |
| `mcp` | MCP 服务配置 | `transport: stdio/http/sse`，文件内容为 JSON |
| `hook` | 事件驱动脚本和 hook 注册项 | `event`、`matcher?`、`hooks[]` |
| `command` | 斜杠命令工作流 | `trigger` |
| `agent` | 子代理说明文件 | 无额外 metadata |

校验来源：`packages/shared/src/schemas.ts`。

#### Asset 身份与命名规则

能力的 `(type, name)` 是其落盘身份——同一目标工具下两个同名能力会写到相同路径并互相覆盖。

- `skill` 的 `name` 取自 `SKILL.md` frontmatter 的 `name:` 字段；无 frontmatter name 时回退到 skill 所在的文件夹名。**文件夹只是容器，frontmatter `name` 才是工具级真实身份**（Claude Code 等工具读 frontmatter `name` 注册 skill）。
- `rule` / `command` / `agent` 的 `name` 取自 frontmatter `name`，无则取文件名（去扩展名）。
- `mcp` 的 `name` 取自 `mcp.json` 中 server 条目的 key。
- `hook` 的 `name` 取自 hook 目录名。
- adapter 安装时**原样写文件内容**，不改写 frontmatter。因此两个 frontmatter `name` 相同的 skill 即使放在不同文件夹，安装后工具仍视为同一个——Loom 不会改写它来「修复」冲突。
- `loom push` 和 marketplace Git 导入共用同一套解析逻辑（`generic-git.ts` provider 与 CLI `vendor-reader.ts`），保证同一 skill 无论从哪种来源进入平台，身份一致。
- `loom push` 在 upsert 前检测批次内同名 `(type, name)`，冲突时返回 409 并指出来源路径，避免静默折叠丢失能力。

### 2.3 支持的目标工具

当前目标工具：

| TargetTool | 目标目录 / 文件 |
|------------|-----------------|
| `cursor` | `.cursor/` |
| `codebuddy` | `.codebuddy/` |
| `codex` | `.codex/` |
| `claudecode` | `.claude/`，MCP 例外写项目根 `.mcp.json` |

兼容矩阵以 `packages/adapter/src/*` 和 `packages/shared/src/constants.ts` 的 `ADAPTER_SUPPORT` 为准：

| Asset 类型 | Cursor | CodeBuddy | Codex | ClaudeCode |
|------------|--------|-----------|-------|------------|
| Skill | 支持 | 支持 | 支持 | 支持 |
| Rule | 支持 | 支持 | 支持 | 支持 |
| MCP | 支持 | 支持 | 支持 | 支持 |
| Hook | 支持 | 支持 | 支持 | 支持 |
| Command | 支持 | 支持 | 不支持 | 支持 |
| Agent | 支持 | 支持 | 支持 | 支持 |

不支持的类型在安装计划生成时跳过，不视为整次安装失败。

## 3. 账号、认证与设备

### 3.1 Web 登录

- 登录接口：`POST /api/auth/login`
- 当前登录用户：`GET /api/auth/me`
- 退出登录：`POST /api/auth/logout`
- 修改密码：`POST /api/auth/change-password`
- 会话 cookie：`loom_session`，`httpOnly`，`sameSite=lax`，有效期 7 天；生产环境默认 `secure`。
- 首次启动用 `LOOM_ADMIN_EMAIL` + `LOOM_ADMIN_PASSWORD` 显式创建管理员；代码中无默认凭据，密码要求 6–128 位。
- 登录时若邮箱不存在，会使用本次提交的密码自动创建普通用户；注册上限和白名单仍由管理员控制。
- 密码使用 scrypt 加盐保存；历史 SHA-256 hash 在成功登录后透明迁移。
- 登录接口单独限制为每分钟 10 次，服务全局默认每分钟 240 次请求。

### 3.2 CLI Token

- 获取：`GET /api/auth/cli-token`
- 重新生成：`POST /api/auth/cli-token/regenerate`
- Token 格式：`prsm_...`
- `loom login --endpoint <url> --token <token>` 校验 token 后写入 `~/.loom/config.json`。
- 重新生成 token 后旧 token 失效。

### 3.3 设备绑定

- `loom start` 首次运行时，如果本地 config 没有 `deviceId`，调用 `POST /api/devices/register`。
- Agent WebSocket 认证成功后，Server 将设备置为 online，并把该设备下未注销项目置为 online。
- Agent 断开后，设备和相关项目置为 offline。

### 3.4 环境变量密钥与设备下发

- 能力可在创建/编辑页声明鉴权方式（免鉴权 / 环境变量）；选环境变量时填写环境变量名（如 `GITHUB_TOKEN`）与可选的获取鉴权页面地址。AI 生成基础信息时可一并推断鉴权声明。
- 设置页「环境变量」Tab 由用户独立维护 key→value 密钥对，值 AES-256-GCM 加密存储（主密钥存 `~/.loom/master.key`），REST 永不返回明文。与创建页的鉴权声明解耦。
- 下发：选环境变量 → 选在线设备（可多选、可重复下发即更新）。Server 解密后通过 WS `env:push` 实时下发，Agent 写入设备系统环境变量文件（Linux `~/.bashrc` / macOS `~/.zshrc` / Windows `setx`），并同步设置 Agent 自身 `process.env`。
- 回收：在「按环境变量」或「按设备」视图回收，Agent 从系统环境变量文件移除该 key。
- 仅在线设备可下发/回收；离线设备不处理（不入 outbox）。下发后正在运行的 IDE 需重启才能读到新变量，新开 shell 立即生效。

### 3.5 Codex / Claude Code 工具配置档

- 设置页「AI 工具配置」可维护多套 Codex 与 Claude Code 用户级配置，并显式选择在线设备下发。
- 每套配置档包含一个加密凭据（Codex `OPENAI_API_KEY` / Claude `ANTHROPIC_AUTH_TOKEN`）及用户填写的 Base URL、模型映射、超时和功能开关等字段；REST 永不返回凭据明文。Claude Code 的可选环境变量允许留空，留空项下发时不覆盖设备已有值。
- 下发通过 WS `tool-config:apply` 实时发送给 Agent，仅在线设备处理，不入 outbox。
- Codex 写入 `~/.codex/config.toml` 与 `~/.codex/auth.json`，同一个 Provider 输入同时决定 `model_provider`、provider section 和其 `name`；Claude Code 写入 `~/.claude/settings.json` 与 `~/.claude.json`。
- 文件不存在则创建；存在时只合并本模块负责的键。现有 JSON 无法解析时拒绝覆盖，避免破坏用户配置。
- 每台设备每个工具只记录最近一次成功下发的配置档；重复下发即切换。删除服务端配置档不会删除设备上的现有文件。

## 4. Asset 功能

### 4.1 列表、搜索与详情

- 列表：`GET /api/assets`
- 详情：`GET /api/assets/:id`
- 单文件内容：`GET /api/assets/:id/file?path=...`
- 下载 zip：`GET /api/assets/:id/download`，zip 内为该能力全部 `asset_files` 的铺放——目录型 `<name>/<file.path>`、平铺型直接 `<file.path>`、mcp 直接 `<file.path>`，**不带顶层能力类型目录**（zip 就是「能力本身」）；原样不聚合、不重组，完整体不多不少；可见性与详情接口一致。
- 支持查询参数：`query`、`type`、`tags`、`visibility`、`page`、`pageSize`。
- 未登录用户只能看到 public；登录用户可看到 public 和自己创建的 private。
- Skill 类型卡片展示「累计被调用次数」（全局累计、只增不减；0 不显示）。该计数由本地 Agent 通过工具 `PreToolUse(Skill)` hook 旁路统计后增量上报，仅 skill 类型有意义。

### 4.2 创建与编辑

- 创建：`POST /api/assets`
- 编辑：`PUT /api/assets/:id`
- 删除：`DELETE /api/assets/:id`
- 创建/编辑由 `assetCreateSchema` / `assetUpdateSchema` 校验。
- Asset 文件为多文件模型，存储在 `asset_files` 表。
- `name` 是落盘稳定标识，只能包含英文、数字、`_`、`-`；`alias` 是展示别名，可使用中文，卡片优先显示别名。
- 标签最多 3 个，第一个为主标签，用于后续分类；主标签范围需适中且通常不长于次标签。
- 创建/编辑表单可调用 `POST /api/ai/asset-basic-info`，根据已填写内容、metadata 和文件上下文生成名称、别名、标签、描述并回填页面；只有用户继续点击创建/保存后才写入 Asset。
- 来源于 Marketplace 的 Asset 可由导入人编辑；删除仍受保护。
- Asset 可填写来源地址 `sourceUrl`；导入 Asset 默认使用源仓库地址作为来源地址。
- 已被能力集或本地项目引用的 Asset 不能修改 `name`，避免落盘路径或聚合 key 改变后在本地出现重复能力；这类展示文案调整应修改 `alias`。
- 更新文件、metadata、兼容工具或名称后，会触发 auto 项目的 best-effort 内容同步。

### 4.3 删除与留存

- 删除逻辑由 `server/src/lib/asset-gc.ts` 控制。
- 已被 CapabilitySet 或已安装项目引用的 Asset 可能进入 retained 状态，避免本地安装内容和能力集成员引用断裂。
- Server 通过 `project_installed_assets` 维护安装引用计数，该表由 Agent 上报的本地状态对账。

### 4.4 文件录入

当前 Web 表单支持：

- 手动编辑文件路径和内容。
- 单文件上传。
- Skill / Hook 等目录型能力上传文件夹。
- MCP JSON 模板生成。
- 按类型播种默认模板文件。

## 5. CapabilitySet 功能

### 5.1 列表、搜索与详情

- 列表：`GET /api/capability-sets`
- 详情：`GET /api/capability-sets/:id`
- Manifest：`GET /api/capability-sets/:id/manifest`
- 下载 zip：`GET /api/capability-sets/:id/download`，zip 顶层目录为能力集名，所有文件包在 `<能力集名>/` 下。
  - 无 `tool` 参数（默认）：按预览结构下载，包含全部成员能力，asset_files 原样不聚合、不重组。
  - `?tool=cursor,claudecode`（可多选）：按所选厂商的安装结构下载（`<targetDir>/...`），不兼容该厂商的能力类型被排除，响应头 `X-Loom-Skipped` 标注被排除能力供前端提示；未知 tool 值静默忽略。
  - 不写任何描述文件，保证完整体不多不少。可见性与详情接口一致。
- 支持 `query`、`visibility`、`page`、`pageSize`。
- 未登录只可见 public；登录后可见 public 和自己的 private。

### 5.2 创建、编辑、删除

- 创建：`POST /api/capability-sets`
- 编辑：`PUT /api/capability-sets/:id`
- 删除：`DELETE /api/capability-sets/:id`
- 字段：名称、描述、目标工具、可见性、成员 Asset。
- 同一用户不能创建相同名字的能力集（DB 唯一索引 `idx_capability_sets_user_name`，软删行不参与约束）。创建和改名时冲突返回 409。
- 创建/更新时会检测落盘身份冲突：同一目标工具下如果多个 Asset 会抢占同一身份载体，则返回 409。
- 更新成员后，Server 会对 auto + 在线项目 best-effort 同步成员变化。
- Marketplace 来源 CapabilitySet 可由导入人编辑；删除仍受保护。

### 5.3 隐式订阅（单独添加的能力）

单个 Asset 安装不走独立安装协议，也不创建能力集。`POST /api/projects/:id/capabilities/add`
把 asset 加入 `project_capabilities`（per-project、不扇出），作为项目的**隐式订阅**
（`project_subscriptions.capability_set_id = ''`）参与统一 reconcile。隐式订阅在控制台呈现为
「单独添加的能力」分组，syncPolicy 可独立切换，targetTools 跟随项目有效厂商集合。

## 6. 安装与本地落盘

### 6.1 安装计划（多能力集订阅，ADR-0006）

- 生成计划：`POST /api/install/plan`
- 执行安装：`POST /api/install/execute`
- 请求字段：`projectId`、`capabilitySetId`、`targetTools`、`policy`、`skipAssetIds?`。
- `policy` 支持：`auto`、`locked`，挂在订阅上（每个能力集独立）。
- 语义 = **添加/重装一条订阅**（不再是替换）：一个项目可同时安装多个 CapabilitySet，能力叠加生效。
- 同一 asset id 跨订阅共享单例，按 (能力 × 厂商) 引用计数；卸载订阅
  （`DELETE /api/projects/:id/subscriptions/:capabilitySetId`）时仅最后引用者撤文件。
- 同名不同 id 的能力落盘路径必然撞车：plan 返回结构化 `conflictingAssets`，
  execute 须携带 `skipAssetIds` 完成逐条裁决（跳过 = 仅本次不装，可后续重装补齐），
  未裁决的撞车返回 409。
- Server 负责构建 `Manifest`，调用 adapter 生成 `InstallPlan.diff`。
- Server 不直接写用户项目文件。

### 6.2 Adapter 输出规则

| 类型 | 当前落盘规则 |
|------|--------------|
| Skill | 目录型：`<targetDir>/skills/<asset.name>/SKILL.md` 及附属文件 |
| Rule | 按 `sourcePath` 或本地文件数量决定目录/平铺；常见为 `<targetDir>/rules/<name>.md` |
| MCP | 聚合到一个 mcp 配置文件；ClaudeCode 写项目根 `.mcp.json` |
| Hook | 附属文件写 `<targetDir>/hooks/<asset.name>/...`，注册表写厂商指定配置 |
| Command | `<targetDir>/commands/<name>.md`，Codex 不支持 |
| Agent | `<targetDir>/agents/<name>.md`（Codex 为 `<targetDir>/agents/<name>.toml`） |

Hook 注册表：

- CodeBuddy：`.codebuddy/settings.json`，合并 `hooks` 字段。
- Codex：`.codex/hooks.json`。
- ClaudeCode：`.claude/hooks/hooks.json`。
- Cursor：`.cursor/hooks.json`，外层包装 `{ version:1, hooks:{...} }`；事件名从 Claude Code PascalCase 映射为 Cursor camelCase，无对应事件的 hook 资产跳过。

MCP 配置：

- Cursor：`.cursor/mcp.json`
- CodeBuddy：`.codebuddy/mcp.json`
- Codex：`.codex/mcp.json`
- ClaudeCode：项目根 `.mcp.json`

### 6.3 CLI Agent 执行

Agent 收到 `InstallPlan` 后：

1. 读取旧 lock。
2. 删除旧 lock 中有但新 diff 中没有的 orphan 文件。
3. 对 diff 执行 add / modify / merge / remove。
4. merge 操作调用 `@maolinc/cc-loom-adapter` 的 `mergeContent()`。
5. 写入新的 `~/.loom/locks/<projectId>.json`。
6. 成功时更新本地项目 `lastInstalledAt`。
7. 回传 `InstallResult`。

单文件失败不会中断整次计划，会收集到 `errors`。

### 6.4 Lock 文件

Lock 文件位置：`~/.loom/locks/<projectId>.json`。

当前支持三种形态：

- legacy：`assets.__plan__.files` 保存全部 managed 文件。
- per-asset（v2）：`assets[assetId].vendors[tool]` 保存每个能力在每个工具下的 enabled 状态和文件归属；`aggregates[tool]` 保存 MCP/Hook 聚合文件及贡献者。
- 多订阅（v3，`lockFormat: "3"`，ADR-0006）：`subscriptions[]` 记录生效的能力集订阅快照（取代 v2 的单值 `capabilitySetId`/`policy`），assets/aggregates 结构不变。

本地控制台单项能力开关、添加、移除依赖 per-asset lock。

## 7. CLI 与本地 Agent

### 7.1 当前 CLI 命令

| 命令 | 当前行为 |
|------|----------|
| `loom login` | 校验 token 与 endpoint，写本地 config |
| `loom logout` | 清除本地凭据，不影响服务端 token |
| `loom start` | 启动 Agent；默认后台 daemon；`-f` 前台 Ink TUI |
| `loom stop` | 停止本机后台 Agent |
| `loom status` | 查看连接、设备、项目状态，离线可用 |
| `loom register` | 注册当前项目目录 |
| `loom unregister` | 注销当前项目目录 |
| `loom push` | 推送本地厂商目录到平台，创建或覆盖能力集 |

### 7.2 本地数据位置

| 路径 | 用途 |
|------|------|
| `~/.loom/config.json` | endpoint、token、deviceId |
| `~/.loom/projects/<id>.json` | 本机项目记录 |
| `~/.loom/locks/<projectId>.json` | 安装账本 |
| `~/.loom/logs/agent.log` | 后台 Agent 日志 |
| `~/.loom/disabled/<projectId>/...` | 被关闭能力的隔离副本 |
| `~/.loom/agent.pid` | 后台 Agent pidfile |

### 7.3 项目注册

- 用户必须在目标项目目录执行 `loom register`。
- Loom 不自动扫描所有本地项目，也不允许 Web 任意输入本地路径接管目录。
- 注册时检测目标工具目录，保存为 `detectedTargets` / `defaultTargets`。
- 已注销项目状态为 `unregistered`，默认项目列表隐藏。

### 7.4 本地写入安全边界

- Agent 只能操作已注册项目。
- 文件写入通过 `safe-write.ts` 的路径安全检查。
- 扫描/watch 只关注支持的厂商目录和 ClaudeCode 的根 `.mcp.json`。
- disabled 隔离区放在 `~/.loom/disabled`，不放入项目目录。

## 8. 本地控制台

本地控制台页面路径：`/console`。

当前能力（多能力集订阅，ADR-0006）：

- 展示已注册项目列表、设备、状态、路径、能力集订阅摘要。
- 30 秒轮询项目列表；非活跃 KeepAlive tab 暂停轮询。
- 通过 WebSocket 监听 `web:project:state_changed`，刷新选中项目状态。
- **订阅条**：每条能力集订阅一张卡（名称、留存徽标、auto/locked 切换、目标厂商管理、卸载/编辑/导出），末尾「+ 添加能力集」；隐式订阅呈现为「单独添加的能力」简卡。
- 展示项目本地镜像：按厂商目录视图和按能力矩阵视图（磁盘真值 = 所有订阅的并集）。
- 能力矩阵保持平铺（一行一能力），渲染来源能力集徽标（共享能力显示多个），支持按来源能力集过滤。
- 共享能力（多订阅引用）的 toggle/remove 是项目级操作，UI 给「同时被能力集 X 引用」轻提示。
- 区分 Loom managed 文件、external 文件、missing 文件。
- 支持刷新本地扫描。
- 支持读取文件内容预览。
- 支持按订阅卸载能力集（共享能力按引用计数保留）。
- 支持给项目添加单项能力。
- 支持单项能力 toggle 和 remove。
- 添加能力集时同名不同 id 撞车逐条裁决（跳过该能力 / 全部跳过 / 取消）。
- 展示每个 skill 在本项目的累计调用次数（通过 hook 旁路统计，0 不显示）；移除该能力后计数清零，重装从 0 起。
- lock 中 expected 文件全部消失时，Agent 自动清 lock，Server 同步清空全部显式订阅。

## 9. 同步机制

### 9.1 同步策略

策略挂在**订阅**上（ADR-0006）：安装每个能力集时独立选择，之后可单独切换；
隐式订阅（单独添加的能力）有自己的策略。

| 策略 | 当前行为 |
|------|----------|
| `auto` | Server 在该 CapabilitySet 成员变化或其 Asset 内容变化后，对订阅了它的项目 best-effort 推送更新 |
| `locked` | 该订阅跳过自动同步，除非用户手动重装或切回 auto（其它订阅不受影响） |

### 9.2 自动同步触发

- Asset 内容、metadata、兼容工具、名称变化：同步经 auto 订阅（或 auto 隐式订阅的单独添加）安装了该 Asset 的项目。
- CapabilitySet 成员变化：同步以 auto 订阅该 CapabilitySet 的项目。
- 订阅从 locked 切回 auto：立即重推最新状态。
- Agent 重连：对有任一 auto 订阅（显式，或有能力的隐式）的项目重推；当前保守不补偿离线期间的成员移除。

### 9.3 本地状态上报

Agent 会在启动、watcher 变化、主动 scan、安装/卸载/能力操作后扫描并推送 `LocalProjectState`。

Server ingest 后：

- 缓存项目状态。
- drift 对齐：agent lock 已清空时清空服务端显式订阅（只做「清空」方向，不从 agent 侧新增订阅）。
- 对账 `project_installed_assets`。
- 广播 `web:project:state_changed`。

## 10. Marketplace / 数据来源

当前已实现 Git 来源导入与同步。

### 10.1 Source 管理

以下接口和设置页入口仅管理员可用：

- 列表：`GET /api/marketplaces`
- 添加：`POST /api/marketplaces`
- 删除：`DELETE /api/marketplaces/:id?keepAssets=true|false`
- 手动刷新：`POST /api/marketplaces/:id/refresh`
- 同步日志：`GET /api/marketplaces/:id/logs`
- 同步间隔设置：`GET/PUT /api/settings/marketplace`

远程仓库仅接受无内嵌凭据的 HTTPS；`git@host:path` 输入会规范化为 HTTPS。Server 在 clone/fetch 前解析主机并拒绝任一私网、回环、链路本地或保留地址。

支持的 source kind：

- `claude-code-marketplace`
- `claude-code-plugin`
- `generic-git`

### 10.2 同步行为

- Server clone/fetch Git 仓库到本地 source 目录。
- Provider 解析 Asset 和 plugin CapabilitySet。
- 按 `sourcePath` upsert `assets` / `asset_files`。
- plugin 映射为 public CapabilitySet。
- 写入同步日志，记录 added / updated / removed / duration / error。
- 调度器按 `marketplace.poll_interval_minutes` 定期同步。

### 10.3 AI 生成设置

**每用户配置（编辑页交互式按钮）**：

- AI 配置：`GET/PUT /api/settings/ai`（每用户一份）。
- 配置项：OpenAI 兼容服务的 `baseUrl`、`apiKey`、模型名。
- `GET /api/settings/ai` 不返回 API Key 明文，仅返回是否已配置。
- 能力基础信息生成：`POST /api/ai/asset-basic-info`（编辑页「AI 生成」按钮，同步返回候选回填表单，不直接写库）。
- 生成接口返回候选别名、标签、描述、鉴权声明；**不再生成 name**——name 是落盘身份，由作者自填。
- 生成标签最多 5 个，第一个作为主标签用于后续分类，范围更大；后续标签作为次标签细化技术栈、对象或场景。

**服务级配置 + 后台队列（admin，ADR-0005，镜像向量化）**：

- 服务级配置：`GET/PUT /api/settings/ai-gen`（admin 维护，全站共用，供后台 worker 使用；与每用户配置并存）。
- 配置项：提供商预设（`openai`/`custom`）、`baseUrl`、`apiKey`（加密）、模型名、并发数、最小间隔、最大重试、退避基数。
- 后台队列对已落库能力**补缺口**：worker 只为空字段（alias/tags/description/auth.bindings）调 AI 生成并回填，已有字段永不重算。能力创建/编辑/导入/push 后自动入队；marketplace 导入的能力同样适用。
- 写 alias/tags/description 后触发向量重算（这三字段是向量输入）；auth.bindings 仅在能力首次处理时补全（已评估后不重写）。
- 队列管理（admin）：`GET /api/settings/ai-gen/queue`（计数）、`/queue/items`（分页列表）、`/assets`（全部能力生成视图，标注待补字段）、`POST /requeue`（重新入队，重扫空缺）、`POST /retry-failed`。无「重建」按钮（文本模型无关，补缺口模型下不适用）。
- 此功能仅管理员可见（设置页 adminOnly tab）；但队列会对所有资产写入自动入队，含普通用户创建的能力（admin 服务级 key 买单）。

### 10.4 本地推送（loom push）

通过 CLI `loom push` 把本地厂商目录（`.cursor/` / `.codebuddy/` / `.codex/` / `.claude/`）的内容推送到平台，创建或覆盖一个能力集。

- 端点：`POST /api/push`（CLI Bearer token 认证）
- CLI 选项：`--tool`（指定厂商）、`--name`（自定义名称）、`--visibility`（默认 private）
- 默认命名：`用户名/项目目录名`，用户名取自邮箱 `@` 前缀。
- 多厂商目录存在时交互选择。
- CLI 解析厂商目录为 `ImportedAsset[]`（扫描 `skills/` / `rules/` / `commands/` / `agents/` / `hooks/` / `mcp.json`），发送给 Server。
- Server 按 `(author, type, name)` upsert asset，按 `(user_id, name)` upsert 能力集。
- 同名 能力集 已存在且非 marketplace 来源 → 覆盖成员（全量替换 `capability_set_assets`，失联 asset GC）。
- 同名 能力集 来自 marketplace → 返回 409，提示换名。
- ClaudeCode 的 MCP 文件在项目根 `.mcp.json`，其他厂商在 vendor 目录内 `mcp.json`。

## 11. Web 页面清单

| 路由 | 页面 | 登录要求 | 主要功能 |
|------|------|----------|----------|
| `/login` | 登录页 | 否 | 邮箱密码登录 |
| `/` | 能力市场 | 否；未登录只看 public | 搜索、类型筛选、卡片、详情、安装入口 |
| `/capability-sets` | 能力集列表 | 否；未登录只看 public | 搜索、可见性筛选、详情、安装入口 |
| `/assets/new` | 新建能力 | 是 | 六类 Asset 表单、模板、上传、metadata、鉴权方式、AI 生成基础信息 |
| `/assets/:id/edit` | 编辑能力 | 是 | 编辑自己创建且非来源导入的 Asset，可 AI 生成基础信息 |
| `/capability-sets/new` | 新建能力集 | 是 | 左侧能力浏览 + 右侧组合画布 |
| `/capability-sets/:id/edit` | 编辑能力集 | 是 | 编辑自己创建或自己导入的 CapabilitySet |
| `/console` | 本地控制台 | 是 | 项目、镜像、安装态、能力管理 |
| `/docs` | 文档页 | 否 | 快速开始、CLI 命令、同步关系、能力类型、厂商官方链接、兼容矩阵、安装路径 |
| `/settings` | 设置页 | 是 | 账号、密码、CLI Token、AI 生成配置、能力信息生成（admin）、数据来源、能力鉴权配置、Codex/Claude Code 工具配置档与设备下发、语义搜索（admin）、用户管理（admin） |

主导航 tab 使用 `KeepAlive` 保持挂载：`/`、`/capability-sets`、`/console`、`/docs`、`/settings`。

## 12. 当前明确不做 / 暂未实现

以下不是当前代码能力：

- 企业组织、团队能力集、复杂 RBAC、SSO。
- 资产签名、安全扫描、审核流、沙箱执行 Hook。
- 用户自定义 Adapter、Adapter 插件化。
- 对任意本地目录的 Web 输入接管。
- 自动扫描所有项目目录。
- 复杂语义化版本范围、多发布渠道、版本历史表。
- 收藏、评分、评论、关注、推荐榜单、Fork CapabilitySet。
- 三方 diff UI 和复杂冲突自动合并。
- `.agent` 目标目录。

## 13. 验收口径（按当前代码）

第一阶段可按以下事实验收：

1. Web 可以登录、退出、修改密码、获取/重生成 CLI Token。
2. CLI 可以 login/logout/start/stop/status/register/unregister。
3. Web 可以创建、编辑、删除、搜索六类 Asset。
4. Skill 创建必须包含根 `SKILL.md`。
5. Web 可以创建、编辑、删除、搜索 CapabilitySet，并组合多个 Asset。
6. CapabilitySet 成员落盘身份冲突会被拦截。
7. Server 可以为 CapabilitySet 生成安装计划（添加订阅），同名撞车给出可裁决清单。
8. Agent 在线时，Web 可以执行安装并收到结果。
9. CLI Agent 会写入目标工具目录并更新 `~/.loom/locks/<projectId>.json`。
10. 本地控制台可以展示项目镜像、读取文件、刷新扫描、按订阅安装/卸载多个 CapabilitySet、管理单项能力。
11. auto 策略会对在线项目 best-effort 同步 CapabilitySet/Asset 变化。
12. Marketplace 可以添加 Git 来源、刷新、查看日志、设置轮询间隔。
13. 设置页可以配置 AI 服务；能力创建/编辑页可以生成并回填名称、别名、标签、描述，保存前不生效。
14. 设置页可以保存多套 Codex / Claude Code 工具配置档并选择在线设备下发；Agent 对用户级配置文件执行字段级合并，不删除未管理字段。
