# CLI 与本地 Agent 数据流

> 事实来源：`packages/cli/src/index.ts`、`commands/*`、`lib/*`、`ws/*`。修改本地文件 IO、Agent 协议、lock、扫描/watch 时必须先读源码。

## CLI 命令入口

`packages/cli/src/index.ts` 使用 Commander 注册命令：

| 命令 | 文件 | 用途 |
|------|------|------|
| `loom login` | `commands/login.ts` | 校验 CLI Token，写 `~/.loom/config.json` |
| `loom logout` | `commands/logout.ts` | 删除本地 config，不影响服务端 token |
| `loom start` | `commands/start.ts` | 启动本地 Agent，默认后台 daemon，`-f` 前台 Ink TUI |
| `loom stop` | `commands/stop.ts` | 停止后台 Agent |
| `loom status` | `commands/status.ts` | 查看连接、设备、项目状态，离线可用 |
| `loom register` | `commands/register.ts` | 注册当前目录为 Loom 项目 |
| `loom unregister` | `commands/unregister.ts` | 注销当前项目：server 硬删 + 抹掉本机 `~/.loom` 全部痕迹 |
| `loom push` | `commands/push.ts` | 推送本地厂商目录到平台，创建或覆盖工作空间 |
| `loom version` | `commands/version.ts` | 打印当前 CLI 版本（与 `--version` 一致，来自 package.json） |
| `loom update` | `commands/update.ts` | 全局重装 `@maolinc/cc-loom@latest` 自更新，按 npm_config_user_agent 识别包管理器 |

统一错误：命令实现抛 `CliFailure` 或 `ApiError`，入口转成清晰 stderr 和退出码。

## loom push

`commands/push.ts` 把本地厂商目录推送到平台。

流程：
1. 检测 `detectTargets(cwd)`，多厂商时交互选择（或 `--tool` 指定）。
2. `GET /api/auth/me` 获取邮箱，取 `@` 前缀为用户名。
3. 默认命名 `用户名/项目目录名`，`--name` 可覆盖。
4. `lib/vendor-reader.ts` 的 `parseVendorDir(vendorPath, tool, projectRoot)` 解析厂商目录为 `ImportedAsset[]`：
   - 扫描 `skills/` / `rules/` / `commands/` / `agents/` / `hooks/` / `mcp.json`。
   - ClaudeCode 的 MCP 在项目根 `.mcp.json`。
   - `compatibleTools` 固定为推送的厂商。
   - 解析逻辑参照 `server/marketplace/providers/generic-git.ts`。
   - **name 推导**：skill 取 SKILL.md frontmatter `name:`，无则取目录名；rule/command/agent 取 frontmatter `name`，无则取文件名。详见 `shared-and-adapter.md` 的「Asset 身份命名规则」。
5. `POST /api/push` 发送 `{ name, visibility, targetTool, assets }`。
6. Server 在 upsert 前检测批次内同名 `(type, name)`：两个 frontmatter `name` 相同的 skill 会被 409 拒绝并指出冲突来源路径，避免静默折叠丢失。用户需修改其中一个的 frontmatter `name` 使其唯一。
7. 不需要 Agent 在线，直接 HTTP 调用。

## 本地路径

`lib/paths.ts` 是唯一来源：

| 路径 | 用途 |
|------|------|
| `~/.loom/config.json` | `CliConfig`: endpoint、token、deviceId |
| `~/.loom/projects/<id>.json` | `LocalProjectRecord`: 服务端 `Project` + endpoint + lastInstalledAt |
| `~/.loom/locks/<projectId>.json` | `LockFile`（v3）: subscriptions 订阅快照、管理文件、能力开关、聚合文件贡献者 |
| `~/.loom/logs/agent.log` | 后台 daemon 日志 |
| `~/.loom/disabled/<projectId>/...` | 关闭能力的隔离副本 |
| `~/.loom/agent.pid` | pidfile |

写 JSON 走 `lib/atomic.ts` 的原子写。写项目目录文件走 `lib/safe-write.ts`，不要绕过安全路径检查。

## 登录和设备绑定

`commands/login.ts`：

- 要求 `--token`，格式必须以 `prsm_` 开头。
- 默认 endpoint 来自 `DEFAULT_ENDPOINT`。
- 调 `GET /api/auth/me` 校验 token。
- 登录只写 config，不创建设备；设备注册延迟到 `loom start`。

`commands/start.ts` 的 `ensureDeviceRegistered()`：

- 如果 config 中没有 `deviceId`，调用 `POST /api/devices/register`。
- 成功后 `mergeConfig({ deviceId })` 回写。

## `loom start` 三种执行态

`commands/start.ts`：

1. parent（默认）
   - 检查 config 和 pidfile。
   - spawn detached daemon 子进程，传 `LOOM_DAEMON_CHILD=1`。
   - 等 pidfile 出现后打印 pid、日志路径并退出。

2. daemon-child
   - 无 TUI。
   - 写 `~/.loom/logs/agent.log`，按 5MB 轮转，保留 5 份。
   - 写 pidfile。
   - 建立 `AgentClient`，wire 项目镜像和安装处理。

3. foreground (`-f`)
   - 渲染 Ink `StartApp`。
   - 仍启用项目镜像、watcher 和 req/res 分发。

## Agent WebSocket 客户端

`ws/client.ts`：

- 连接 URL：`config.endpoint` 的 http(s) 替换为 ws(s)，路径 `/ws`。
- open 后发送 `auth`，payload 含 token 和 deviceId。
- 心跳：收到 server `heartbeat` 后发 `pong`。
- 自动重连：1s / 2s / 4s / 8s / 16s / 30s 封顶。
- `stop()` 后清 timer、listener、ws，且不再重连。

`ws/messages.ts` 定义 CLI 侧消息常量：

- 基础：`auth`、`auth_ok`、`heartbeat`、`pong`、`error`、`ack`。
- 通用请求响应：`req`、`res`。
- 主动推送：`project:state`、`skill:usage`。
- op：`project:scan`、`project:read_file`、`install:uninstall`、`project:purge`、`env:push`、`env:revoke`、`reconcile`。

wire 协议 v2/v3 下所有「落盘指令」收口到单一 `reconcile` op（请求体
`WsReconcileRequest`：subscriptions 订阅快照 + targetTools + plan），CLI 端
`lib/reconcile-runner.ts` 只负责按 plan 落盘并重建 v3 lock。auth 时 CLI 自报
`capabilities: { reconcileV2, subscriptionsV3 }`，server 硬门槛校验（ADR-0006）。

`project:purge`（server→agent）：抹掉该项目在 `~/.loom` 下的全部痕迹——`projects/<id>.json`、`locks/<id>.json`、`disabled/<id>/`、`stats/<id>.*`，并停止 watcher。与 `install:uninstall` 的区别：uninstall 只清 lock 管理的厂商文件 + lock，保留项目注册记录；purge 连注册记录一起删，使该 projectId 在本地彻底消失（避免注销后再次 register 出现新旧两条本地记录）。

Server 侧 `ws/gateway.ts` 没有导入这些常量，字符串需保持一致；若抽到 shared，需两端一起改。

## 安装落盘

`lib/installer.ts` 的 `applyInstallPlan(plan, projectRoot)`：

1. 读旧 lock。
2. `orphans = old locked files - incoming diff paths`，删除 orphan 文件并修剪空目录。
3. 应用每个 `DiffEntry`：
   - `add` / `modify`：安全解析路径后原子写。
   - `merge`：读现有文件，调用 `@maolinc/cc-loom-adapter` 的 `mergeContent()` 后写入。
   - `remove`：删除文件并修剪空目录。
4. 写新 lock。
5. 成功时更新本地项目 `lastInstalledAt`。
6. 返回 `InstallResult`。

单文件失败不会中断整个 plan，会收集到 `errors`，最终 `success = errors.length === 0`。

### Lock 形态

`lib/locks.ts` 负责读写 lock，`installer.ts` 构建：

- legacy lock：`assets.__plan__.files` 保存全部文件。
- per-asset lock：当 diff 携带 `assetId` / `tool` 时，写入：
  - `assets[assetId].vendors[tool] = { enabled, files }`
  - `aggregates[tool] = [{ file, contributingAssetIds, serverKeys? }]`（mcp 聚合额外持久化 `serverKeys`：真实 server key → assetId。wrapped MCP 资产的内层 server key 可能 ≠ 资产名，scanner 据此把磁盘 mcp.json 的 server 正确归到受管资产，避免能力视图与厂商视图分叉）

本地控制台单项能力操作依赖 per-asset lock。改 install plan 字段时必须检查 scanner、capabilities 和 UI。

## 项目镜像、扫描与 watcher

`commands/start.ts` 的 `wireProjectMirror()`：

- Agent authed 后遍历 `~/.loom/projects`，启动 watcher 并推送初始 state。
- 本地文件变化后 debounce 扫描并 `pushProjectState()`。
- Server 可通过 req/res 主动请求 scan、read file、uninstall、capability 操作。
- `capability:toggle/add/remove` 按 projectId 串行排队，避免 mcp/hook 聚合并发写交叉。

`lib/watcher.ts`：

- 使用 chokidar。
- 每个项目 watch 项目根，但 ignored 只允许四个厂商目录和根 `.mcp.json`。
- 事件 debounce 500ms。
- 不跟随 symlink。

`lib/scanner.ts`：

- 只扫描 `TARGET_DIRS` 对应目录和 ClaudeCode 根 `.mcp.json`。
- 不读文件内容，只统计 size（mcp.json 例外：解析 server 名以判定归属）。
- 依据 lock 标记 managed/external/missing。
- 如果 lock 存在且所有 expected 文件都不在磁盘，自动删除 lock，`driftCleared=true`，`installedWorkspaceId=null`。
- **单一真值源**：先算一次 cell 模型（`buildCells`，per-(能力×厂商) 的 enabled/files/presentCount/assetId/external/mcp-server 归属），`LocalProjectState.capabilities` 与厂商树标注/计数（`managedAssetCount`/`externalCount`）均从它投影。能力视图与厂商视图共用同一份判定，差异只在 UI 分组，避免「两路各算」导致开关/计数/external 分类分叉。
- mcp server 归属由 `lock.aggregates[tool].serverKeys`（v2）决定；旧 lock 退化为单资产启发式 + 按 asset.name 匹配。
- 对 mcp.json 会解析 virtual mcp-server 子节点；受管 MCP 能力行的 `files`/`presentCount` 据实补齐（不再恒为空/0）。
- disabled 的能力会在原位置生成占位节点，供 UI 渲染关闭状态。

## 单项能力管理

`lib/capabilities.ts` 是本地控制台 add/toggle/remove 的实际落盘逻辑：

- 输入通常来自 Server 下发的 `ManifestAssetEntry[]`。
- `toggle`：关闭时把文件移到 `~/.loom/disabled/<projectId>/...`，开启时移回或重算写入。
- `add`：把新能力写入对应 vendor，并更新 per-asset lock；mcp/hook 会重算 aggregate。
- `remove`：删除该能力文件、更新 aggregate、更新 lock。

这些操作必须维持 lock 与磁盘一致，否则 scanner 和 Server 的 `project_installed_assets` 会错。

## 安全边界
- 项目文件写入必须通过 `resolveSafe()` / `writeFileAtomic()` / `removeFileAndPruneEmptyDirs()`。
- 扫描和 watcher 只处理 Loom 支持的目标工具目录，不遍历项目全量文件。
- `.mcp.json` 是 ClaudeCode MCP 的例外根文件，safe-write、watcher、scanner 都需要保持一致。
- 不要把 disabled 隔离区放入项目目录；当前设计放在 `~/.loom/disabled`，避免 IDE 继续读取关闭内容。

## 设备级工具配置合并

- `tool-config:apply` 与项目无关，由 `commands/start.ts` 直接分发到 `lib/tool-config.ts`。
- 路径固定为当前用户 `~/.codex/config.toml`、`~/.codex/auth.json`、`~/.claude/settings.json`、`~/.claude.json`，server payload 不能指定路径。
- Codex TOML 按根键和 section 精确 upsert；Claude / auth JSON 先验证顶层对象再做字段合并。无效 JSON 必须拒绝覆盖。
- 所有文件原子写入；API Key / Token 不写 Agent 日志，日志只记录配置档名称、工具和文件路径。

## Skill 调用统计（旁路）

仅 skill 类型，统计「能力被实际调用次数」。通过工具的 `PreToolUse(matcher=Skill)` hook 捕获，旁路、不影响安装/扫描主链路。

事实来源：`lib/skill-tracker.ts`、`lib/skill-stats.ts`、`lib/tracker-script.ts`、`lib/paths.ts`。

链路：

1. Agent 启动（`commands/start.ts` headless/foreground）调 `ensureTrackerScript()`，幂等写入 `~/.loom/hooks/skill-usage-tracker.cjs`（零依赖 Node 脚本）。
2. `lib/skill-tracker.ts` 的 `applySkillTracker(projectId, projectRoot, lock)`：按 lock 里各厂商是否有 enabled skill，幂等向该厂商「唯一」hook 注册文件注入/移除指向脚本的 `PreToolUse/Skill` command hook，并用合成 id `__skill_tracker__` 登记到 `lock.aggregates`。在 `installer.applyInstallPlan`（写 lock 前）与 `capabilities.runOp`（每次 toggle/add/remove）后调用。cursor 虽已支持 hook 分发，但 skill-tracker 暂未接入（Cursor 的 preToolUse matcher 不含 "Skill"，需另设匹配口径）⇒ 其 skill 暂不统计。
3. 工具调用 skill 时脚本被 spawn：从 stdin 取 `tool_input.skill` 等，append 一行到 `~/.loom/stats/<projectId>.events.log`（O_APPEND 原子），立即 exit 0。
4. `lib/skill-stats.ts`：`consumeSkillEvents()` 抢占事件日志、按 skill 名经 lock 映射 assetId，累加 `local`（本地展示）+ `pending`（市场增量）。scanner 的 `buildCells` 注入 `AssetCapability.invocationCount = local[assetId]`。
5. Agent（`start.ts` wireProjectMirror 的 15s 定时 + 推送前）`flushUsage()`：消费事件、`client.reportSkillUsage()` 上报 `pending`（增量），成功后 `clearReportedUsage()` 扣减。
6. 移除能力清 `local`（`clearLocalSkillCount`，不动 pending）；卸载项目清全部统计（`clearProjectSkillStats`，flush 后）。

不变量：上报的是增量；本地清零/重装不影响市场累计（Server 只增不减）。`local` 随项目走、移除清零、重装从 0。
