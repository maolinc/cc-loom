# Web 前端结构与数据流

> 事实来源：`packages/web/src/main.tsx`、`App.tsx`、`api.ts`、`hooks/*`、`pages/*`、`components/*`。

## 技术栈与入口

- React 18 + Vite + TypeScript。
- 路由：React Router。
- 样式：Tailwind CSS + Radix UI 组件。
- 图标：`lucide-react`。
- 入口：
  - `src/main.tsx`
  - `src/App.tsx`
- Vite 配置：`vite.config.ts`
  - dev port 来自 `DEFAULT_WEB_DEV_PORT = 47475`
  - `/api` 代理到 `http://localhost:47474`
  - `/ws` 代理到 `ws://localhost:47474`

## API 封装

`src/api.ts`：

- 所有请求以 `/api` 为 base。
- `credentials: include`，依赖 cookie session。
- 页面消费统一 `ApiResponse<T>`：`{ success, data?, error? }`。
- 网络错误、非 JSON 响应不会抛出，而是返回失败信封。
- 非 `/auth/me` 请求收到 401 时，会调用全局 `onUnauthorized`，由 `AuthProvider` 清空登录态。

新增页面请求时优先使用 `api.get/post/put/delete`，不要在页面里散落裸 `fetch`。

## 登录态

`hooks/useAuth.tsx`：

- `AuthProvider` 首次挂载调用 `GET /api/auth/me`。
- `login(email, password)` 调 `POST /api/auth/login`，成功写 user state。
- `logout()` 调 `POST /api/auth/logout` 并清 user state。
- `setUnauthorizedHandler()` 用于 API 层收到 401 后统一清状态。

## 路由结构

`App.tsx`：

- `/login`：未登录显示 `LoginPage`，已登录跳首页。
- 其他路径走 `AuthenticatedLayout`。
- 主导航缓存页用 `KeepAlive` 保持挂载，避免切 tab 重新请求：
  - `/` → `HomePage`
  - `/capability-sets` → `CapabilitySetListPage`
  - `/console` → `LocalConsolePage`
  - `/docs` → `DocsPage`
  - `/settings` → `SettingsPage`
- 瞬时编辑页不缓存：
  - `/capability-sets/new`
  - `/capability-sets/:id/edit`
  - `/assets/new`
  - `/assets/:id/edit`

访问控制：

- public tab：`/`、`/capability-sets`、`/docs` 可在未登录状态渲染。
- protected path：`/console`、`/settings`、编辑页等需要登录，未登录跳 `/login`。

大页面通过 `lazy()` 做路由级代码分割。

## 页面职责

| 页面 | 文件 | 职责 |
|------|------|------|
| 能力市场 | `pages/HomePage.tsx` | 浏览能力，使用 `AssetBrowser` / `AssetCard` / `DetailPanel`；导入能力卡片显示导入人和具体来源方；skill 卡片展示 `invocationCount`（>0 才显示，紧凑格式 k/w） |
| 能力集列表 | `pages/CapabilitySetListPage.tsx` | 浏览能力集；导入能力集卡片显示导入人和第三方标识 |
| 能力编辑 | `pages/AssetComposerPage.tsx` | 创建/编辑 Asset、多文件、metadata 表单、AI 生成基础信息回填 |
| 能力集编辑 | `pages/CapabilitySetComposerPage.tsx` | 创建/编辑 CapabilitySet 和成员能力 |
| 本地控制台 | `pages/LocalConsolePage.tsx` | 查看项目、安装状态、本地镜像、单项能力操作、删除项目（purge） |
| 文档页 | `pages/DocsPage.tsx` | 快速开始、CLI 命令、平台/本地同步关系、能力类型、厂商官方链接、兼容矩阵、安装路径 |
| 设置页 | `pages/SettingsPage.tsx` | 设置容器页，包含账号、AI 生成和 Marketplace tab |
| 登录页 | `pages/LoginPage.tsx` | 登录表单 |

本地控制台子组件：

- `pages/local-console/CapabilityMatrix.tsx`（skill 行展示本地 `invocationCount`）
- `MirrorTreeView.tsx`
- `PreviewPanel.tsx`
- `local-console/AddCapabilitySetMenu.tsx`
- `VendorTabStrip.tsx`
- `AddCapabilityDialog.tsx`

设置页子组件：

- `pages/settings/AccountTab.tsx`
- `pages/settings/AiTab.tsx`
- `pages/settings/MarketplaceTab.tsx`
- `pages/settings/ToolConfigTab.tsx`（Codex / Claude Code 多配置档、在线设备多选下发）

## 关键组件

| 组件 | 职责 |
|------|------|
| `TopNav` | 顶部导航和登录状态入口 |
| `KeepAlive` | tab 页面隐藏但保持挂载 |
| `AssetBrowser` | 能力浏览列表 |
| `DetailPanel` | Asset/CapabilitySet 详情面板骨架：文件预览、左右栏布局。CapabilitySet 模式右栏双态（能力集信息 ↔ 点选能力的基本信息；能力完整详情按需拉取 `/assets/:id?lite=1`，失败回退 payload 子集 limited 渲染） |
| `AssetMeta` | 能力元信息 + 下载 zip + 编辑/删除（权限门控）；`mode="limited"` + `notice` 徽章用于留存/无权回退（隐藏鉴权行与全部操作按钮） |
| `InstallSection` | 安装到本地项目（单能力走 `/capabilities/add`，能力集走 installFlow 计划预览） |
| `CapabilitySetCanvas` | 能力集能力组合视图 |
| `FileTree` / `ContentViewer` | 文件树和内容展示 |
| `PageState` | loading/empty/error 等页面状态 |
| `Toast` | 全局提示 |
| `ConfirmDialog` / `Modal` | 通用确认和弹窗 |
| `AddSourceDialog` | 添加数据源弹框：仓库地址 + ref + **导入能力类型多选**（默认全选，`ASSET_TYPES` chip 组，至少保留一项；全选时不传 `assetTypes` → 服务端规范化为 null=全部） |
| `Button` / `SearchInput` | 基础 UI 控件 |

新增 UI 时优先复用这些组件；若引入新通用组件，应放 `components/`，页面私有组件放页面子目录。

## 安装流程胶水

`lib/installFlow.ts` 把两种来源统一成同一安装管线：

1. CapabilitySet 安装：已有 `capabilitySetId`。
2. 单 Asset 安装：先调用 `POST /projects/:id/capabilities/add`，拿项目专属隐式 能力集。
3. 生成计划：`POST /install/plan`。
4. 执行安装：`POST /install/execute`。

页面不应绕过这个胶水直接拼装单 Asset 安装逻辑。

## 下载

`DetailPanel` 内置下载入口，均走浏览器 `fetch` + blob 落盘（带 cookie 同源鉴权）：

- 单能力下载：`DownloadAssetButton`（`components/AssetMeta.tsx` 内）→ `GET /api/assets/:id/download`，zip 内为该能力完整内容（预览结构铺放）。任何能查看该能力的用户都可下载。
- 能力集下载：`CapabilitySetDownloadSection` → `GET /api/capability-sets/:id/download`，厂商多选（默认不选 = 预览结构含全部能力）；勾选厂商后实时提示哪些能力因不兼容将被排除，下载后读取 `X-Loom-Skipped` 头用 toast 提示被排除能力。

## 表单与能力类型辅助

- `lib/assetForm.ts`：Asset 表单数据、文件、metadata 相关辅助；校验 `name` 只能包含英文、数字、`_`、`-`，`alias` 可中文且用于展示，`sourceUrl` 用于备注来源地址。
- `lib/capabilitySpec.ts`：能力类型展示/字段配置。
- `lib/fileUpload.ts`：上传文件解析。
- `lib/assetDisplay.ts`：Asset 展示名辅助，优先显示 `alias`，否则显示 `name`。
- `lib/time.ts`：时间展示辅助。

涉及 Asset 类型、metadata 字段、工具兼容性时，必须同时检查 `@maolinc/cc-loom-shared` 的 schema 和常量。

## 本地控制台数据流

典型链路：

```text
LocalConsolePage
  ├─ GET /api/projects                       （含 subscriptions 订阅数组）
  ├─ GET /api/projects/:id/state
  ├─ POST /api/projects/:id/scan
  ├─ GET /api/projects/:id/files?path=...
  ├─ POST /api/install/plan|execute          （添加/重装订阅；execute 带 skipAssetIds 撞车裁决）
  ├─ POST /api/projects/:id/subscriptions/:capabilitySetId/sync-policy|targets
  ├─ DELETE /api/projects/:id/subscriptions/:capabilitySetId   （卸载单条订阅）
  ├─ POST /api/projects/:id/uninstall        （卸载全部）
  ├─ POST /api/projects/:id/purge   （删除项目：抹掉服务端 + 本地痕迹）
  └─ POST /api/projects/:id/capabilities/*
       ↓
Server requestFromAgent()
       ↓
CLI Agent 扫描/读文件/落盘/改 lock
       ↓
Agent push project:state
       ↓
Server cache + web:project:state_changed
```

多能力集订阅（ADR-0006）：「当前能力集卡」已替换为 `local-console/SubscriptionStrip.tsx`
订阅条；添加能力集走 `local-console/AddCapabilitySetMenu.tsx`；同名撞车由
`components/InstallConflictDialog.tsx` 逐条裁决；能力矩阵来源徽标/过滤依赖
server 端 `lib/capability-sources.ts` 富化的 `cap.sources`。

如果 UI 显示的 managed/external/missing、enabled、capabilities 不对，通常需要同时检查：

- CLI `scanner.ts` 是否正确构造 `LocalProjectState`。
- Server `ws/gateway.ts` 是否 ingest 并对账。
- `routes/projects.ts` 是否返回了最新 state。
- Web local-console 组件是否正确消费。

## UI 修改注意事项

- 设计相关先读 `ui-design-spec.md`。
- 产品边界先读 `product-functional-doc.md`。
- 主导航 tab 当前依赖 `KeepAlive`，不要随意改成普通 route 卸载，否则会改变请求/状态行为。
- API 错误应展示 `res.error`，不要假设请求会抛异常。
- 对受保护页面使用现有 `ProtectedRoute` 行为，不要在页面内部重复做登录跳转。
