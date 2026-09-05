# Server 数据流与关键路径

> 事实来源：`packages/server/src/index.ts`、`routes/*`、`ws/gateway.ts`、`db/index.ts`、`db/migrate.ts`、`lib/*`、`marketplace/*`。

## 应用组装

`packages/server/src/index.ts`：

- `buildApp(opts)`：创建 Fastify 实例，运行 `migrate()`，注册插件、hook、routes、WebSocket gateway；不调用 `listen()`，测试可用 `app.inject()`。
- 主进程执行时读取：
  - `PORT`，默认 `DEFAULT_SERVER_PORT = 47474`
  - `HOST`，默认 `DEFAULT_SERVER_HOST = 127.0.0.1`
  - `LOOM_EXTERNAL_URL`，仅用于输出 external URL
- 安全环境变量：`LOOM_ADMIN_EMAIL`、`LOOM_ADMIN_PASSWORD`、`LOOM_CORS_ORIGINS`、`LOOM_COOKIE_SECURE`。
- 插件：helmet、rate-limit、CORS、cookie、compress、websocket、static。
- 静态托管：存在 `packages/web/dist` 时托管 SPA；`index.html` 不长期缓存，hash chunk 长期缓存。
- 启动后调用 `startScheduler()` 开启 Marketplace 定时同步。

## 数据库

`packages/server/src/db/index.ts`：

- 默认数据目录：`~/.loom`。
- 可用 `LOOM_DATA_DIR` 覆盖。
- SQLite：`loom.db`。
- 开启 `journal_mode = WAL` 和 `foreign_keys = ON`。

`packages/server/src/db/migrate.ts`：

- 每次 `buildApp()` 执行，幂等建表/补列/建索引。
- 重要表见 `architecture.md`。
- 注意已有多处兼容性 `try { ALTER TABLE ... } catch {}`，新增列时沿用幂等迁移方式。

## 认证模型

入口：`routes/auth.ts`、`lib/auth.ts`、`lib/auth-cache.ts`。

- Web 登录：`POST /api/auth/login`，成功写 `loom_session` httpOnly cookie。
- 当前用户：`GET /api/auth/me`，支持 cookie session 或 Bearer CLI token。
- CLI token：`GET /api/auth/cli-token` 获取，`POST /api/auth/cli-token/regenerate` 重新生成。
- Web logout 删除 session 并清 cookie。
- 首次启动必须通过 `LOOM_ADMIN_EMAIL` + `LOOM_ADMIN_PASSWORD` 初始化管理员；代码中无固定凭据。
- 登录时如果邮箱不存在，会用本次提交的 6–128 位密码创建普通用户。
- 新密码使用 scrypt；旧 `salt:sha256` hash 在一次成功登录后重写。
- 登录路由每分钟最多 10 次；cookie 为 httpOnly + sameSite=lax，生产环境默认 secure。

鉴权 hook：

- `requireAuth`：要求 Web cookie session。
- `requireCliAuth`：要求 CLI Bearer token。
- `requireAnyAuth`：cookie 或 CLI token 均可。

## REST API 概览

当前 routes 中的 endpoint：

| 文件 | Endpoint |
|------|----------|
| `routes/config.ts` | `GET /api/config` |
| `routes/auth.ts` | `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`POST /api/auth/change-password`、`GET /api/auth/cli-token`、`POST /api/auth/cli-token/regenerate` |
| `routes/devices.ts` | `GET /api/devices`、`POST /api/devices/register`、`PUT /api/devices/:id/heartbeat` |
| `routes/assets.ts` | `GET /api/assets`、`GET /api/assets/:id`、`GET /api/assets/:id/file`、`GET /api/assets/:id/download`、`POST /api/assets`、`PUT /api/assets/:id`、`DELETE /api/assets/:id` |
| `routes/workspaces.ts` | `GET /api/workspaces`、`GET /api/workspaces/:id`、`POST /api/workspaces`、`PUT /api/workspaces/:id`、`DELETE /api/workspaces/:id`、`GET /api/workspaces/:id/manifest`、`GET /api/workspaces/:id/download` |
| `routes/install.ts` | `POST /api/install/plan`、`POST /api/install/execute` |
| `routes/projects.ts` | `GET /api/projects`、`GET /api/projects/:id`、`POST /api/projects/register`、`PUT /api/projects/:id`、`POST /api/projects/:id/sync-policy`、`DELETE /api/projects/:id`、`POST /api/projects/:id/purge`、`GET /api/projects/:id/state`、`POST /api/projects/:id/scan`、`GET /api/projects/:id/files`、`POST /api/projects/:id/uninstall`、`POST /api/projects/:id/capabilities/toggle`、`POST /api/projects/:id/capabilities/add`、`POST /api/projects/:id/implicit-workspace`、`POST /api/projects/:id/capabilities/remove` |
| `routes/marketplaces.ts` | `GET /api/marketplaces`、`POST /api/marketplaces`、`DELETE /api/marketplaces/:id`、`POST /api/marketplaces/:id/refresh`、`GET /api/marketplaces/:id/logs` |
| `routes/settings.ts` | `GET /api/settings/marketplace`、`PUT /api/settings/marketplace`、`GET /api/settings/ai`、`PUT /api/settings/ai` |
| `routes/tool-config-profiles.ts` | Codex / Claude Code 配置档 CRUD、分发记录、在线设备显式下发 |
| `routes/ai.ts` | `POST /api/ai/asset-basic-info` |
| `routes/push.ts` | `POST /api/push` |

### Codex / Claude Code 工具配置档

- `tool_config_profiles` 按用户保存配置；`secret_cipher` 复用 `master.key` AES-256-GCM，`config_json` 只保存非敏感字段。
- `tool_config_distributions` 以 `(device_id, tool)` 为主键，只表达设备该工具最近成功下发的配置档。
- 分发接口校验设备归属、在线状态与 Agent 协议能力后，通过 `requestFromAgent(..., "tool-config:apply")` 实时下发；失败设备不写分发记录。
- 删除配置档只删除服务端记录，不向设备发送删除指令，避免破坏本地配置。

## Asset 流程

`routes/assets.ts`：

- 列表和详情会按登录态过滤可见性：未登录只看 public；登录后可看 public + 自己的 private。
- `asset_files` 多文件内容与 `assets` 元数据分表存储。
- workspace 详情只返回文件元信息，不含 content；查看单文件内容走 `GET /api/assets/:id/file?path=...`。
- 创建/更新使用 `@maolinc/cc-loom-shared` schema 校验。
- 来自 marketplace source 的 asset 可由 source `added_by` 对应导入人编辑；删除仍受保护。
- `name` 是落盘稳定标识，只能包含英文、数字、`_`、`-`；`alias` 是展示别名，可中文，`sourceUrl` 是可备注的来源地址，搜索会匹配 `name` / `alias` / `description`。
- 已被工作空间或本地项目引用的 Asset 禁止修改 `name`，避免路径或 MCP/Hook 聚合 key 改变后本地出现重复能力；展示文案变化使用 `alias`。
- 更新内容相关字段（files / metadata / compatibleTools / name）后，触发 `syncAssetContentToProjects(assetId)`，对 auto + 在线项目 best-effort 回推。
- `routes/ai.ts` 的 `POST /api/ai/asset-basic-info` 根据当前表单和文件上下文调用用户配置的 OpenAI 兼容服务，只返回名称、别名、标签、描述，不写入 Asset；标签最多 3 个，第一个为主标签，后续为细化次标签。
- 删除走 `deleteOrRetainAsset()`：被引用时可能软删除留存，避免已安装/被 workspace 引用内容丢失。
- `assets.invocation_count` 列记录 skill 被实际调用累计次数（全局、只增不减）；由 Agent 通过 `skill:usage` 增量上报，`serialize()` 以 `invocationCount` 返回，市场卡片 0 不显示。

## Workspace 流程

`routes/workspaces.ts`：

- 列表按登录态和 visibility 过滤。
- 详情包含成员 asset 的 light 形态；包括已软删但仍被该 workspace 引用的 retained asset。
- 创建/更新成员时调用 `detectInstallKeyConflicts()`，阻止同一目标工具下会互相覆盖的 asset 组合。
- 更新成员后会对移出的 retained asset 尝试 GC，并调用 `syncWorkspaceMembersToProjects()` 对 auto + 在线项目同步成员增删。
- `GET /api/workspaces/:id/manifest` 用于产出安装所需 manifest。
- `GET /api/assets/:id/download` 与 `GET /api/workspaces/:id/download` 把能力 / 工作空间打成 zip 下载。渲染逻辑在 `lib/download-archive.ts`：
  - 无 `tool` 参数（默认）：预览结构铺放，与详情面板安装路径预览一致（`<typeDir>/<name>/<file.path>` 目录型 / `<typeDir>/<file.path>` 平铺型 / mcp 直接 `<file.path>`），asset_files 原样不聚合、不重组，完整体不多不少。**单能力下载**（`/api/assets/:id/download`）同样铺放但**不带顶层类型目录**（`<name>/<file.path>` / `<file.path>`），zip 就是「能力本身」。
  - `?tool=cursor,claudecode`（可多选）：走 `adapter.generate`，产出各厂商 `<targetDir>/...` 完整安装包；不兼容类型被 adapter 跳过，响应头 `X-Loom-Skipped`（URL 编码 JSON）标注被排除能力，供前端提示。未知 tool 值静默忽略。
  - 不写任何描述文件。可见性与详情接口一致。

## 安装计划与执行（多空间订阅，ADR-0006）

`routes/install.ts`：

1. `POST /api/install/plan`
   - 校验 `projectId`、`workspaceId`、`targetTools`、`policy`（+ 可选 `skipAssetIds`）。
   - 查询 workspace 和成员 asset，构造 `Manifest`（必须包含 `sourcePath`）。
   - 计算 `effectiveTools = request.targetTools ∩ workspace.targetTools`。
   - 对每个 adapter 生成 `DiffEntry[]`（`mcp`/`hook` 聚合用 `operation: merge`）。
   - 撞车检测：待装成员与项目「其它来源」受管能力（其它订阅的 workspace_assets −
     跳过集 ∪ project_capabilities）同名同类型不同 id 时，产出结构化
     `conflictingAssets`（可裁决），不静默覆盖。

2. `POST /api/install/execute` — 语义 = 添加/重装一条订阅：
   - 校验撞车裁决完整性（未裁决的撞车必须全部在 `skipAssetIds` 中，否则 409）。
   - UPSERT `project_subscriptions` 行（policy/targetTools 挂订阅）+ 整组替换
     `project_subscription_excludes`（跳过集）。
   - `enqueueReconcileAndWait`：worker 用 `reconcileProject` 从 DB 重算 plan 推给 CLI；
     失败回滚订阅与跳过集。
   - 主动发一次 `project:scan` 请求刷新缓存。

订阅数据访问收口在 `lib/subscriptions.ts`（隐式订阅 = `workspace_id = ''` 哨兵）。
卸载订阅：`DELETE /api/projects/:id/subscriptions/:wid`（共享能力按引用计数保留）；
订阅级 `sync-policy` / `targets` 各有端点。

Server 不直接写用户项目文件；所有实际文件 IO 由 CLI Agent 完成。

## WebSocket gateway

`ws/gateway.ts`：

- 路径：`/ws`。
- 两类连接：
  - Agent：发送 `auth`，payload 含 CLI token 和 deviceId。
  - Web：可通过 cookie 自动认证，或保留 `web_auth` 兼容路径。
- Agent 连接成功后：
  - 更新 device online。
  - 把该 device 的非 unregistered 项目置为 online。
  - 存入内存 `agents: Map<deviceId, ConnectedAgent>`。
  - 调用注入的 `compensateDeviceOnConnect()` 做 auto 项目重连补偿。
- 断开后：
  - device offline。
  - 相关项目 offline（排除 unregistered）。
  - 清理 pending request。

消息：

| 方向 | type | 用途 |
|------|------|------|
| Agent → Server | `auth` | CLI token + deviceId 认证 |
| Server → Agent | `heartbeat` | 心跳 |
| Agent → Server | `pong` | 心跳响应，节流写 `last_online_at` |
| Server → Agent | `install` | 旧安装协议，投递 `InstallPlan` |
| Agent → Server | `install_result` | 安装结果 |
| Server → Agent | `req` | 通用 request/response，带 `requestId` 和 `op` |
| Agent → Server | `res` | 通用响应 |
| Agent → Server | `project:state` | 主动推送 `LocalProjectState` |
| Agent → Server | `skill:usage` | 主动上报 skill 调用次数增量（`{projectId, items:[{assetId,delta}]}`），`ingestSkillUsage` 校验项目归属后 `UPDATE assets SET invocation_count = invocation_count + delta`（只增不减），广播 web 刷新 |
| Server → Web | `web:project:state_changed` | 通知 web 重拉项目 state |

`requestFromAgent()` 是 Server 主动问 Agent 的通用入口，有超时和 pending 清理。

## 项目本地镜像与单项能力管理

`routes/projects.ts`：

- `/state`：优先返回 30 秒内缓存；Agent 离线时可返回最后缓存并带 warning；无缓存返回 409。
- `/scan`：强制请求 Agent 重新扫描。
- `/files`：请求 Agent 读取某个托管路径的文件内容。
- `/uninstall`：请求 Agent 删除 lock 管理文件并清 lock。
- `DELETE /:id`（CLI `loom unregister` 路径）：硬删项目行 + 关联表（`project_capabilities` / `project_disabled_assets` / `project_installed_assets`）+ 仅本项目引用的 adopt 产物；CLI 同时抹掉本机 `~/.loom` 痕迹。
- `/capabilities/toggle`、`/add`、`/remove`：通过 `requestFromAgent()` 下发单项能力操作。
- `/implicit-workspace`：单 Asset 安装时为项目创建/复用隐式 workspace，使安装仍走统一 `/install/plan` / `/execute` 管线。
- `/purge`（Web 端「删除项目」）：服务端清关联表 + adopt 产物；Agent 在线时下发 `project:purge` RPC 抹掉本机 `~/.loom` 痕迹后硬删项目行（深度清理），离线时软删（status=unregistered）待 Agent 重连由 `compensateDeviceOnConnect` 补发 `project:purge` 自愈并硬删项目行。两条删除路径共用 `lib/project-purge.ts` 的 `purgeProjectDbRows` / `hardDeleteProject`。

Server 以 Agent 推送的 `LocalProjectState.capabilities` 对账 `project_installed_assets`，该表是 asset 留存/GC 的安装引用事实来源。

## 自动同步

`lib/auto-sync.ts`（ADR-0006：syncPolicy 挂在订阅上，入队资格按「存在相关 auto 订阅」判定）：

- workspace 成员变化：`syncWorkspaceMembersToProjects()` 重对账以 auto 订阅该空间的项目。
- asset 内容变化：`syncAssetContentToProjects()` 重对账经 auto 订阅（或 auto 隐式订阅）
  安装该 asset 的项目（账本以 `project_installed_assets` 为准）。
- Agent 重连补偿：`compensateDeviceOnConnect()` 入队有任一 auto 订阅（显式，或有能力的
  隐式）的项目；保守不补偿成员移除。
- 订阅从 `locked` 切回 `auto`：`syncProjectNow()` 立即重推。

统一为「项目状态变化 → enqueueReconcile → worker 用 reconcileProject 算最新 plan」
单一路径（wire 协议 v2/v3）。这些调用是 best-effort，不阻塞原 HTTP 响应。

## Marketplace

- 来源 CRUD、刷新、日志和同步间隔设置均要求管理员角色。
- Git 地址仅允许无凭据 HTTPS（SSH shorthand 会转为 HTTPS），解析到私网或保留地址时拒绝。

关键文件：

- `marketplace/service.ts`：source 增删查入口。
- `marketplace/pipeline.ts`：clone/fetch、provider 解析、diff/upsert asset 和 plugin workspace、写日志。
- `marketplace/providers/*`：不同来源格式解析。解析对齐官方 Claude Code 插件规范（https://code.claude.com/docs/zh-CN/plugins-reference#component-path-fields ；schema：https://www.schemastore.org/claude-code-plugin-manifest.json ）。
  - `registry.ts` 按 `.claude-plugin/{marketplace,plugin}.json` 是否存在选 `claude-code-plugin`，否则 `generic-git`。
  - `claude-code-plugin.ts`：marketplace 模式按 `plugins[].source` 发 child source 或就地解析本地 plugin；plugin 模式就地解析。`plugin.json` 的组件字段**全部为顶层**（官方 schema 无 `components` 包装）：`skills`/`commands`/`agents`/`hooks`/`mcpServers`。语义对齐官方路径行为规则（https://code.claude.com/docs/zh-CN/plugins-reference#path-behavior-rules ）：
    - `skills`（string\|array）**添加到**默认 `skills/` 扫描；声明路径三态（flat `.md`/含根级 `SKILL.md` 的单目录/容器目录）由 `extractDeclaredAssetPath` 处理。支持 `skills/<category>/<name>/SKILL.md` 嵌套布局（如 mattpocock/skills），默认扫描只认一层。**市场根异常**：marketplace 条目 `source` 解析为市场根（自指向 `./`，或规范化 URL 与当前数据源相同）时，原地解析根插件，声明子目录**替换**默认 `skills/` 扫描。**根 `SKILL.md` 单 skill plugin**（官方 v2.1.142+）：plugin 根有 `SKILL.md`、无 `skills/` 子目录、无 `skills` 字段时，自动作为单 skill 加载（`extractRootSkill`，name 取 frontmatter `name` 否则目录基名）。
    - `commands`（string\|array\|object）/**`agents`**（string\|array）声明时**替换**默认目录扫描；commands 的 object 形态把 key 作为命令名（→ `/key`）。声明时默认目录不扫描（要保留需显式列出 `"./commands/"`）。
    - `hooks`（string\|array\|object）/`mcpServers`（string\|array\|object）**合并**：默认文件 + manifest 声明（路径文件 / 内联 object / 数组）。string 路径形如 `./x.json`。
    - 按 `sourcePath` 去重，避免默认扫描与 manifest 重复。
  - `generic-git.ts`：无 manifest 仓库的通用扫描——按 `skills/`/`rules/`/`agents/`/`commands/`/`hooks/<name>/hook.json`（Loom 原生 bundle）/ `hooks/hooks.json`（官方事件分组文件）/ `.mcp.json` 提取；skill 须有根级 `SKILL.md`（或顶层单 `.md`），深层嵌套 `skills/<cat>/<name>/SKILL.md` 不由默认扫描识别（需 manifest 声明）。导出 `extractDeclaredAssetPath`/`extractHooksFile`/`extractHooksInline`/`extractMcpFile`/`extractMcpInline` 供 plugin provider 复用。
  - CLI 侧 `packages/cli/src/lib/vendor-reader.ts` 镜像 `generic-git.ts` 的 `extractAssetDir`（`loom push` 本地读取），skill 规范判定同步。
- `marketplace/scheduler.ts`：定时同步。
- `marketplace/db-helpers.ts`：source/log 查询封装。

当前导入逻辑：

1. source 指向 git repo，`pipeline.ts` clone/fetch 到本地路径。
2. 根据 source kind 选择 provider，产出 `ImportedAsset[]` 和 `ImportedPlugin[]`。
3. **按 `source.assetTypesFilter` 过滤**（`pipeline.ts` 的 `applyAssetTypeFilter`）：`null` = 全部类型（默认）；非空数组 = 仅保留这些类型，并丢弃过滤后无 asset 的 plugin。childSources 不受影响；子源继承父源的 `assetTypesFilter`（`ensureChildSources` 写入）。
4. 按 `sourcePath` upsert `assets` / `asset_files`；新导入 asset 的 `sourceUrl` 默认写 source repo URL，后续用户编辑不由同步覆盖。
5. plugin 被映射为 public workspace，并刷新 `workspace_assets`。
6. 上游删除的 asset/workspace 会被删除；若被项目/工作空间留存逻辑保护，需检查 GC 相关代码。

`assetTypesFilter` 由 `POST /api/marketplaces` 的 `assetTypes`（`marketplaceCreateSchema`，`AssetType[]` 可选）经 `normalizeAssetTypesFilter` 规范化：缺省/空/覆盖全部 → `null`（= 全部）。持久化在 `marketplace_sources.asset_types_filter`（TEXT，JSON 数组或 NULL）。导入/刷新均生效。

## Push（本地推送）

`routes/push.ts`：

- 端点：`POST /api/push`，`requireCliAuth` 认证。
- 请求体：`PushRequest`（name、visibility、targetTool、assets: ImportedAsset[]）。
- Asset upsert：按 `(author, type, name, source_id IS NULL, deleted_at IS NULL)` 匹配。存在 → 更新 files/metadata/compatibleTools；不存在 → 新建。
- Workspace upsert：按 `(user_id, name, deleted_at IS NULL)` 查找。存在且 `source_id IS NULL` → 覆盖成员（删旧关联 → 加新关联 → 失联 asset GC）；存在且 `source_id IS NOT NULL` → 409；不存在 → 新建。
- 依赖 DB 唯一索引 `idx_workspaces_user_name`（`user_id, name WHERE deleted_at IS NULL`）保证同名查找至多一条。
- CLI 侧解析逻辑在 `packages/cli/src/lib/vendor-reader.ts`，参照 `marketplace/providers/generic-git.ts` 的解析模式。
