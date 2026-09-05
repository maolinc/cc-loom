# Loom UI 设计说明

> 本文按当前前端代码事实更新。代码是唯一事实来源；若本文与源码冲突，以源码为准，并更新本文。
>
> 关键源码入口：`packages/web/src/App.tsx`、`packages/web/src/api.ts`、`packages/web/src/components/*`、`packages/web/src/pages/*`、`packages/web/tailwind.config.js`。

## 1. 设计系统

### 1.1 视觉风格

- 风格：Soft Bento，柔和现代、低噪声、卡片化、轻阴影。
- 页面背景：浅灰蓝 `surface-muted`。
- 主内容宽度：`max-w-7xl mx-auto px-6 py-8`。
- 顶部导航：sticky、半透明白底、backdrop blur、细边框。
- 语言：全中文。

### 1.2 色彩 Token

来源：`packages/web/tailwind.config.js`。

| Token | 值 | 用途 |
|------|----|------|
| `brand.DEFAULT` | `#0062FF` | 主按钮、品牌、选中态 |
| `brand.soft` / `brand.100` | `#E0EDFF` | 选中背景、弱品牌底色 |
| `brand.50` | `#EFF5FF` | 极弱品牌背景 |
| `brand.600` | `#0052D6` | hover 主色 |
| `brand.700` | `#0743A8` | active 主色 |
| `surface.DEFAULT` | `#FFFFFF` | 白色卡片/页面表面 |
| `surface.card` | `#F7F8FA` | 卡片底 |
| `surface.muted` | `#F6F8FC` | 页面底 |
| `surface.sunken` | `#EEF3FA` | 下沉区域 |
| `text.primary` | `#111827` | 主文本 |
| `text.secondary` | `#4B5563` | 次文本 |
| `text.muted` | `#9CA3AF` | 弱文本 |

### 1.3 Asset 类型色标

来源：`@maolinc/cc-loom-shared` 的 `ASSET_TYPE_COLORS` 和 Tailwind 扩展色。

| 类型 | 底色 | 字色 |
|------|------|------|
| Skill | `#E0EDFF` | `#0062FF` |
| Rule | `#FEF3C7` | `#D97706` |
| MCP | `#D1FAE5` | `#059669` |
| Hook | `#EDE9FE` | `#7C3AED` |
| Command | `#CFFAFE` | `#0891B2` |
| Agent | `#FCE7F3` | `#DB2777` |

### 1.4 字体、圆角、阴影、动效

| 类型 | 当前值 |
|------|--------|
| 字体 | `Outfit`（拉丁/数字，几何无衬线）、`Noto Sans SC`（中文）、`JetBrains Mono`（代码/路径）、`system-ui`、`sans-serif` |
| 圆角 | `lg=10px`、`xl=14px`、`2xl=18px`、`3xl=24px`；胶囊形（rounded-full）用于筛选 chip、视图切换、状态徽标 |
| 阴影 | `soft`、`card`、`lift`、`panel`、`brand`（均带蓝灰色调） |
| 动效 | `fade-in`、`fade-up`、`scale-in`、`slide-in`；交互 `active:scale-[0.98]` 模拟按压 |

交互动画以短时、轻量为主：按钮 hover/active/按压、下拉 scale-in、面板 slide-in、loading spinner。键盘焦点统一可见描边（`:focus-visible` outline + 组件 `ring`）；选中色跟随品牌。

## 2. 应用路由与访问控制

来源：`packages/web/src/App.tsx`。

| 路由 | 页面组件 | 访问控制 | 挂载策略 |
|------|----------|----------|----------|
| `/login` | `LoginPage` | 已登录自动跳 `/` | 普通路由 |
| `/` | `HomePage` | 未登录可浏览 public | `KeepAlive` |
| `/workspaces` | `WorkspaceListPage` | 未登录可浏览 public | `KeepAlive` |
| `/console` | `LocalConsolePage` | 需要登录 | `KeepAlive` |
| `/docs` | `DocsPage` | 未登录可浏览 | `KeepAlive` |
| `/settings` | `SettingsPage` | 需要登录 | `KeepAlive` |
| `/workspaces/new` | `WorkspaceComposerPage` | 需要登录 | 普通路由 |
| `/workspaces/:id/edit` | `WorkspaceComposerPage` | 需要登录 | 普通路由 |
| `/assets/new` | `AssetComposerPage` | 需要登录 | 普通路由 |
| `/assets/:id/edit` | `AssetComposerPage` | 需要登录 | 普通路由 |
| `*` | `NotFound` | 需要登录区域内兜底 | 普通路由 |

关键规则：

- 主导航页使用 `KeepAlive`，切换 tab 时隐藏但不卸载，避免频繁重新请求。
- `/`、`/workspaces`、`/docs` 是 public tab。
- `/console`、`/settings`、编辑页是 protected path。
- 大页面使用 `lazy()` 代码分割。

## 3. 顶部导航

来源：`components/TopNav.tsx`、`App.tsx`。

应用壳：顶部导航（sticky，`h-[60px]`）+ 下方内容区（`max-w-7xl mx-auto px-6 py-8`）。`/login` 不挂顶栏。

结构：

```text
Loom Logo  能力市场  工作空间  本地控制台  文档  [新建 ▾]  [头像/登录]
```

行为：

- sticky 顶栏，半透明白底 + backdrop blur + 下边框。
- 当前路由高亮为 `bg-surface-sunken text-text-primary font-semibold`（中性底，品牌蓝仅留主操作）。
- Logo 为蓝色圆角方块 + 白色编织 mark（三根经线 + 一根流动纬线，中间经线压在纬线之上形成 over-under-over 交替编织，呼应「Loom 织机」隐喻）+ Loom 文本。
- `新建` 按钮是下拉菜单：
  - 新建能力 → 已登录跳 `/assets/new`，未登录跳 `/login`。
  - 新建工作空间 → 已登录跳 `/workspaces/new`，未登录跳 `/login`。
- 已登录显示邮箱首字母头像（圆角方块），点击进入 `/settings`。
- 未登录显示「登录」按钮。

当前代码没有全局「公共/个人」切换；可见性过滤在具体页面内实现。

## 4. API 与状态反馈设计

来源：`src/api.ts`、`components/PageState.tsx`、`components/Toast.tsx`。

### 4.1 API 封装

- 所有请求以 `/api` 为 base。
- 使用 `credentials: include` 携带 cookie。
- 页面收到统一 `ApiResponse<T>`：`success`、`data`、`error`。
- 网络错误和非 JSON 响应不抛异常，返回可展示错误。
- 非 `/auth/me` 请求返回 401 时，触发全局未授权处理，清空登录态。

### 4.2 页面状态

统一使用：

- `CardGridSkeleton`
- `InlineLoading`
- `ErrorState`
- `EmptyState`
- Toast 成功/错误反馈
- `ConfirmDialog` 替代原生 confirm

## 5. 登录页

来源：`pages/LoginPage.tsx`。

功能：

- 邮箱 + 密码登录。
- 未注册邮箱登录时由后端自动创建账号，并直接使用本次提交的 6–128 位密码；首个管理员由服务启动环境变量显式创建。
- 登录成功写入 `AuthProvider` user state。
- 登录失败展示错误。
- 已登录用户访问 `/login` 自动跳转 `/`。

## 6. 能力市场首页

来源：`pages/HomePage.tsx`、`components/AssetCard.tsx`、`components/DetailPanel.tsx`。

布局：

- 顶部：搜索输入 + 类型筛选 +「创建能力」按钮。
- 内容：响应式卡片网格：`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`。
- 分页：`pageSize=30`，支持「加载更多」。
- 状态：首屏 skeleton、错误态、空态。

交互：

- 搜索参数：`query`。
- 类型筛选参数：`type`。
- 点击卡片打开 `DetailPanel type="asset"`。
- 关闭详情后刷新第一页，保证编辑/删除后列表同步。
- 未登录点击创建能力跳 `/login`。

空态文案根据是否筛选、是否登录区分。

## 7. 工作空间列表页

来源：`pages/WorkspaceListPage.tsx`、`components/WorkspaceCard.tsx`。

布局：

- 顶部：搜索输入 + 可见性筛选（仅登录用户显示）+「新建工作空间」按钮。
- 可见性筛选：全部 / 公开 / 个人。
- 内容：响应式 3 列卡片网格。
- 状态：skeleton、错误态、空态。

交互：

- 搜索参数：`query`。
- 可见性参数：`visibility`。
- 点击卡片打开 `DetailPanel type="workspace"`。
- 导入工作空间卡片显示导入人，并显示「第三方」标识；来源名称作为标识 tooltip。
- 关闭详情后刷新列表。

## 8. 详情面板

来源：`components/DetailPanel.tsx`。

### 8.1 通用结构

- 以浮层形式打开，支持关闭。
- Asset 模式：直接读取 `/assets/:id`，文件内容随详情返回。
- Workspace 模式：读取 `/workspaces/:id`，初始只拿文件元信息；单文件内容按需请求 `/assets/:id/file?path=...` 并缓存。
- Workspace 内 Asset 按 `ASSET_TYPES` 顺序分组，组内按稳定名称 `name` 排序并显示 `name`，避免目录语义受别名影响。
- 左侧树面板宽度可拖拽调整，范围约 180–500px。

### 8.2 文件路径预览

详情面板和工作空间画布都调用 `isAssetDirLayout()` 来判断目录/平铺布局，避免 UI 预览与 adapter 脱节。

### 8.3 安装面板

详情面板复用 `lib/installFlow.ts`：

1. Workspace 安装：直接使用 `workspaceId`。
2. 单 Asset 安装：先创建/复用项目隐式 Workspace。
3. 调 `/install/plan` 生成计划。
4. 调 `/install/execute` 执行安装。

安装参数：项目、目标工具、同步策略（`auto` / `locked`）。

## 9. 能力创建 / 编辑页

来源：`pages/AssetComposerPage.tsx`、`lib/assetForm.ts`、`lib/capabilitySpec.ts`。

路由：

- `/assets/new`
- `/assets/:id/edit`

布局：

- 顶部：返回、标题、错误提示、取消、创建/保存按钮。
- 主体：`grid-cols-1 lg:grid-cols-[1fr_320px]`。
- 左侧分区表单：类型、基础信息（含 AI 生成按钮）、类型配置、兼容工具/可见性、文件。
- 右侧 sticky 实时面板：规范说明、安装路径预览、校验清单。

能力类型录入规则：

| 类型 | UI 录入形态 | 文件规则 |
|------|-------------|----------|
| Skill | directory | 必须有根 `SKILL.md`，可上传文件夹 |
| Rule | single | Markdown 文本，需配置 globs |
| MCP | config | JSON，支持按 transport 生成 mcpServers 模板 |
| Hook | directory | hook 事件 / matcher / command + 脚本，可上传文件夹 |
| Command | single | Markdown，需 trigger，如 `/review` |
| Agent | single | Markdown 子代理说明 |

行为：

- 新建默认类型为 Skill。
- 新建默认兼容工具为 Cursor、CodeBuddy、ClaudeCode。
- 切换类型会重置文件模板，避免不同类型内容残留。
- 支持手动模式和上传模式。
- 当用户已填写基础信息或已上传/编辑文件后，可点击「AI 生成」调用 `/api/ai/asset-basic-info` 生成名称、标签、描述并回填；标签最多 3 个，第一个是范围更大的主标签，后续标签细化技术栈、对象或场景；只有后续点击创建/保存才真正生效。
- 编辑态不能更改能力类型。
- 保存成功后：新建跳 `/`；编辑返回上一页。

## 10. 工作空间编排页

来源：`pages/WorkspaceComposerPage.tsx`、`components/AssetBrowser.tsx`、`components/WorkspaceCanvas.tsx`。

路由：

- `/workspaces/new`
- `/workspaces/:id/edit`

布局：

- 整页固定高度：`h-[calc(100vh-8rem)]`。
- 外层白色圆角卡片，边框和 soft shadow。
- 左侧固定宽 `360px`：能力浏览器。
- 右侧：工作空间画布。

左侧能力浏览器：

- 搜索能力。
- 类型筛选。
- 显示数量 / loading。
- 点击能力添加或移除。
- hover 400ms 后显示首文件预览。
- hover 按钮可打开详情预览。

右侧画布：

- 基本信息：名称、描述。
- 目标工具多选：Cursor、CodeBuddy、Codex、ClaudeCode。
- 可见性：公开 / 个人。
- 已选能力按类型分组，组内按稳定名称 `name` 排序并显示 `name`。
- 目录预览使用 `isAssetDirLayout()`。
- 保存前校验：名称、至少一个目标工具、至少一个能力。

## 11. 本地控制台

来源：`pages/LocalConsolePage.tsx` 和 `pages/local-console/*`。

### 11.1 页面信息架构

当前为多空间订阅版（ADR-0006）：

- 顶部：driftCleared banner（如触发）。
- 左侧：项目列表（每项目显示订阅摘要）。
- 右上：项目 header（名称、状态、路径复制、重新扫描）。
- 右中：**订阅条**——每条空间订阅一张卡（名称、留存徽标、auto/locked 切换、
  目标厂商管理、⋯ 菜单含卸载/编辑/导出），隐式订阅呈现为「单独添加的能力」简卡，
  末尾「+ 添加空间」入口卡。
- 右下：本地镜像，支持两种视图：
  - 按厂商横向 tab。
  - 按能力矩阵（平铺，一行一能力；名称格渲染来源空间徽标，共享能力多个徽标；
    可按来源空间过滤）。

### 11.2 数据刷新

- 项目列表 30 秒轮询，非活跃 KeepAlive tab 暂停。
- 选中项目后拉 `/projects/:id/state`。
- 点击刷新走 `/projects/:id/scan`。
- 页面打开 WebSocket `/ws`，收到 `web:project:state_changed` 后刷新当前项目 state 和项目列表。
- WebSocket 非活跃时断开；重连退避 3s 起，最大 30s。

### 11.3 本地镜像

厂商目录来自 `TARGET_TOOLS` / `TARGET_DIRS`：

- Cursor：`.cursor`
- CodeBuddy：`.codebuddy`
- Codex：`.codex`
- ClaudeCode：`.claude`，另展示根 `.mcp.json`

镜像展示：

- `exists`：目录/根文件痕迹是否存在。
- `managedCount`：Loom lock 管理的文件数。
- `externalCount`：非 Loom 管理文件数。
- `missingCount`：lock 期望但磁盘缺失的文件数。
- 文件节点可标记 `managed`、`assetId`、`enabled`。

### 11.4 核心操作

- 添加空间（装为一条新订阅；同名撞车在确认前逐条裁决：跳过该能力/全部跳过/取消）。
- 添加能力。
- 按订阅卸载工作空间（共享能力按引用计数保留）。
- 订阅级 auto/locked 切换与目标厂商调整（在各订阅卡上）。
- 编辑/导出等次级操作在订阅卡的 more 菜单中组织。
- 单项能力 toggle / remove（项目级生效；共享能力给「同时被空间 X 引用」轻提示）。
- 点击文件或目录打开 `PreviewPanel`。
- Loom 管理文件可跳转 Asset 详情。

## 12. 设置页

来源：`pages/SettingsPage.tsx`、`pages/settings/AccountTab.tsx`、`pages/settings/AiTab.tsx`、`pages/settings/AiInfoTab.tsx`、`pages/settings/MarketplaceTab.tsx`、`pages/settings/AuthConfigTab.tsx`、`pages/settings/ToolConfigTab.tsx`、`pages/settings/SearchTab.tsx`、`pages/settings/AdminTab.tsx`。

设置页包含多个 tab：

| Tab | 可见性 | 功能 |
|-----|--------|------|
| 账号 | 所有登录用户 | 修改密码、查看/复制/重新生成 CLI Token |
| AI 生成 | 所有登录用户 | 每用户配置 OpenAI 兼容服务的 Base URL、模型、API Key |
| 能力信息生成 | 仅管理员 | 服务级 AI 配置 + 后台生成队列管理（补缺口模型，镜像 SearchTab 的配置块 + 索引管理块） |
| 数据来源 | 所有登录用户 | 管理 Marketplace Git 来源、同步频率、刷新、日志、删除 |
| 能力鉴权配置 | 所有登录用户 | 凭据值 + 显式分发（env/path 双轴） |
| AI 工具配置 | 所有登录用户 | 多套 Codex / Claude Code 用户级配置档 + 在线设备下发 |
| 语义搜索 | 仅管理员 | Embedding 服务级配置 + 向量索引队列管理 |
| 用户管理 | 仅管理员 | 用户列表与停用 |

### 12.1 AI 生成 Tab

- 表单字段：AI Base URL、模型、API Key。
- GET `/api/settings/ai` 不回传 API Key 明文，只返回 `apiKeyConfigured`。
- API Key 输入框留空时保持旧 Key；输入新 Key 后替换。

### 12.2 数据来源 Tab

- 自动同步频率选项来自 `POLL_INTERVAL_OPTIONS`：5 分钟、30 分钟、1 小时、6 小时、1 天。
- 来源列表显示同步状态点、名称、repo URL、能力数量、工作空间数量、上次同步时间、错误摘要。
- 操作：刷新、日志、删除、添加来源。
- 删除和添加通过独立 Dialog 完成。

### 12.3 AI 工具配置 Tab

- 顶部说明凭据加密、仅在线设备下发、重复下发即切换三项边界。
- 配置档卡片展示工具类型、名称、Base URL、当前设备与最近下发时间；支持新建、编辑、删除和下发。
- Codex 表单显示完整文件路径并覆盖 `config.toml` 根键、provider section、`features.goals` 与 `auth.json` API Key；`model_provider` 与 Provider name 使用同一个输入值。
- Claude Code 表单显示完整文件路径，覆盖 `settings.json.env` 中的 Token、Base URL、模型映射、超时与功能开关，并显式展示 `~/.claude.json.hasCompletedOnboarding`；可选项默认留空，输入框通过 placeholder 解释字段意义与示例值。
- 下发弹框只列在线设备，可多选；已存在同工具配置时提示将替换当前配置档。
- 密钥输入永不回显；编辑时留空保持旧值。保存配置档不会自动下发。

## 13. 文档页

来源：`pages/DocsPage.tsx`。

布局：

- 顶部标题：文档。
- 左侧 sticky 目录。
- 右侧正文。
- 滚动时根据 section 顶部位置高亮当前目录项。
- 点击目录平滑滚动。
- 命令块支持复制，复制后短时显示已复制。

章节：

1. 快速开始
2. CLI 命令
3. 本地怎么同步：用「平台保存清单、本机写文件、控制台看结果」三步解释平台更新与本地项目的关系，避免暴露过多技术术语
4. 能力类型
5. 厂商目录规范：包含对应厂商官方说明链接
6. 兼容性矩阵
7. 安装路径

快速开始中的 endpoint 获取：

1. 优先 `GET /api/config` 的 `externalUrl`。
2. 失败时使用 `window.location.origin`。
3. SSR 兜底为 `http://localhost:47474`。

维护要求：文档页内的静态兼容矩阵和安装路径必须与 `@maolinc/cc-loom-shared` / `@maolinc/cc-loom-adapter` 同步；运行时真实安装行为以 adapter 为准。

## 14. 兼容性与安装路径展示规范

UI 展示应以当前运行时 adapter 为准：

| 类型 | Cursor | CodeBuddy | Codex | ClaudeCode |
|------|--------|-----------|-------|------------|
| Skill | 支持 | 支持 | 支持 | 支持 |
| Rule | 支持 | 支持 | 支持 | 支持 |
| MCP | 支持 | 支持 | 支持 | 支持 |
| Hook | 不支持 | 支持 | 支持 | 支持 |
| Command | 支持 | 支持 | 不支持 | 支持 |
| Agent | 不支持 | 支持 | 不支持 | 支持 |

关键安装路径：

| 类型 | Cursor | CodeBuddy | Codex | ClaudeCode |
|------|--------|-----------|-------|------------|
| Skill | `.cursor/skills/<name>/SKILL.md` | `.codebuddy/skills/<name>/SKILL.md` | `.codex/skills/<name>/SKILL.md` | `.claude/skills/<name>/SKILL.md` |
| Rule | `.cursor/rules/<name>.md` | `.codebuddy/rules/<name>.md` | `.codex/rules/<name>.md` | `.claude/rules/<name>.md` |
| MCP | `.cursor/mcp.json` | `.codebuddy/mcp.json` | `.codex/mcp.json` | `.mcp.json` |
| Hook | — | `.codebuddy/hooks/<name>/...` + `.codebuddy/settings.json` | `.codex/hooks/<name>/...` + `.codex/hooks.json` | `.claude/hooks/<name>/...` + `.claude/hooks/hooks.json` |
| Command | `.cursor/commands/<name>.md` | `.codebuddy/commands/<name>.md` | — | `.claude/commands/<name>.md` |
| Agent | — | `.codebuddy/agents/<name>.md` | — | `.claude/agents/<name>.md` |

注意：Rule / Command / Agent 是否包一层 `<name>/` 目录取决于 `isAssetDirLayout()`；表中是常见单文件平铺展示。

## 15. 通用组件使用规范

| 组件 | 使用场景 |
|------|----------|
| `Button` | 主按钮、次按钮、ghost、loading、icon |
| `SearchInput` | 能力/工作空间搜索和类型筛选 |
| `PageState` | loading、empty、error |
| `Toast` | 操作结果反馈 |
| `ConfirmDialog` | 删除、卸载、移除能力等确认 |
| `Modal` | 通用弹窗 |
| `DetailPanel` | Asset/Workspace 详情和安装 |
| `FileTree` / `ContentViewer` | 文件树和内容查看 |
| `KeepAlive` | 主导航 tab 缓存 |

新增 UI 优先复用现有组件；页面私有组件放对应 `pages/<page>/` 子目录。

## 16. 当前 UI 不包含的能力

当前前端代码没有实现：

- 全局公共/个人空间切换器。
- 收藏、评分、评论、关注、推荐榜单。
- 三方 diff UI。
- 组织/团队空间。
- 资产风险等级、签名、安全扫描 UI。
- `.agent` 目标工具 UI。
- Web 任意输入本地路径接管项目。
