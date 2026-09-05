# 架构与代码结构

> 事实来源：根 `package.json`、`pnpm-workspace.yaml`、`tsconfig.json`、各 package `package.json`、`packages/*/src/index.ts`。

## Monorepo

- 包管理：`pnpm workspace`，workspace 范围是 `packages/*`。
- 语言：TypeScript，根 `tsconfig.json` 使用 `strict: true`、`isolatedModules: true`、`noUncheckedIndexedAccess: true`。
- Node 要求：`>=20`。
- 根脚本：
  - `pnpm build` → `pnpm -r build`
  - `pnpm dev` → `pnpm -r dev`
  - `pnpm typecheck` → `pnpm -r typecheck`
  - `pnpm lint` → `pnpm -r lint`，但当前各 package 未定义 `lint` 脚本，运行前需确认。

## 包职责与依赖方向

| 包 | package name | 入口 | 职责 | 主要依赖 |
|----|--------------|------|------|----------|
| `packages/shared` | `@maolinc/cc-loom-shared` | `src/index.ts` | 公共常量、类型、Zod schema、Asset 布局判定 | `zod` |
| `packages/adapter` | `@maolinc/cc-loom-adapter` | `src/index.ts` | 把 workspace manifest 转为各目标工具文件；合并策略；落盘身份判重 | `@maolinc/cc-loom-shared` |
| `packages/server` | `@maolinc/cc-loom-server` | `src/index.ts` | Fastify API、SQLite、WebSocket gateway、Marketplace 同步、静态托管 web dist | `@maolinc/cc-loom-shared`、`@maolinc/cc-loom-adapter`、Fastify、`better-sqlite3` |
| `packages/cli` | `loom` | `src/index.ts` | CLI 命令、本地 Agent、WebSocket 客户端、项目注册、安装落盘、扫描/watch | `@maolinc/cc-loom-shared`、`@maolinc/cc-loom-adapter`、Commander、Ink、ws、chokidar |
| `packages/web` | `@maolinc/cc-loom-web` | `src/main.tsx` / `src/App.tsx` | React + Vite SPA，能力市场、工作空间、本地控制台、设置页 | `@maolinc/cc-loom-shared`、React、React Router、Radix UI、Tailwind |

依赖边界：

```text
shared  ← adapter
shared  ← server → adapter
shared  ← cli    → adapter
shared  ← web
```

`web` 不依赖 `adapter`，目标工具支持矩阵在 `@maolinc/cc-loom-shared` 中有静态副本 `ADAPTER_SUPPORT`，真实生成逻辑仍在 `packages/adapter`。

## 运行时数据流

```text
浏览器 React SPA
  │ HTTP /api（cookie session）
  ▼
Fastify Server
  │ SQLite ~/.loom/loom.db
  │ WebSocket /ws
  ▼
CLI Agent（loom start）
  │ 本地 ~/.loom/* 元数据
  │ 文件写入/扫描/watch
  ▼
用户项目目录（.cursor / .codebuddy / .codex / .claude / .mcp.json）
```

关键路径：

1. Web 创建/编辑 `Asset`、`Workspace` → Server 写 SQLite。
2. Web 对项目生成安装计划 → Server 用 `@maolinc/cc-loom-adapter` 把 workspace manifest 转成 `InstallPlan.diff`。
3. Web 执行安装 → Server 通过 WebSocket 投递给在线 CLI Agent。
4. CLI Agent 在本机项目目录安全写文件，更新 `~/.loom/locks/<projectId>.json`。
5. CLI Agent 扫描目标工具目录并推送 `LocalProjectState`。
6. Server 缓存状态、对账 `project_installed_assets`，Web 本地控制台再拉取展示。

## 服务端存储

- 默认数据目录：`~/.loom`。
- 可用环境变量：`LOOM_DATA_DIR` 覆盖服务端数据目录，测试用临时目录避免污染用户数据。
- SQLite 路径：`~/.loom/loom.db`。
- 数据库连接：`packages/server/src/db/index.ts`。
- 表结构和迁移：`packages/server/src/db/migrate.ts`，每次 `buildApp()` 会调用 `migrate()`。

主要表：

| 表 | 用途 |
|----|------|
| `users` / `sessions` / `cli_tokens` | Web 登录态和 CLI Token |
| `devices` | CLI Agent 设备绑定与在线状态 |
| `assets` / `asset_files` | 能力元数据和多文件内容 |
| `workspaces` / `workspace_assets` | 工作空间及其能力成员 |
| `projects` | 已注册本地项目、当前 workspace、同步策略 |
| `project_installed_assets` | 服务端镜像账本，以 Agent 上报的真实安装集合对账 |
| `marketplace_sources` / `marketplace_sync_logs` | 外部来源和同步日志 |
| `app_settings` | 应用设置，如 Marketplace 轮询间隔 |

## CLI 本地存储

路径集中在 `packages/cli/src/lib/paths.ts`：

| 路径 | 用途 |
|------|------|
| `~/.loom/config.json` | endpoint、CLI token、deviceId |
| `~/.loom/projects/<id>.json` | 本机注册项目记录 |
| `~/.loom/locks/<projectId>.json` | Loom 管理文件账本、工作空间、策略、能力开关 |
| `~/.loom/logs/agent.log` | 后台 Agent 日志，轮转写入 |
| `~/.loom/disabled/<projectId>/...` | 单项能力关闭时的隔离副本 |
| `~/.loom/agent.pid` | 后台 Agent pidfile |

## 端口和启动

- Server 默认端口：`47474`，常量在 `DEFAULT_SERVER_PORT`。
- Web dev 默认端口：`47475`，Vite 代理 `/api` 和 `/ws` 到 `47474`。
- `@maolinc/cc-loom-server` 启动后如存在 `packages/web/dist`，会托管 SPA；否则仅提供 API/WS。

## 入口文件

- Server 组装：`packages/server/src/index.ts` 的 `buildApp()`。
- CLI 命令注册：`packages/cli/src/index.ts`。
- Web 路由：`packages/web/src/App.tsx`。
- Adapter 注册表：`packages/adapter/src/registry.ts`。
- Shared 导出：`packages/shared/src/index.ts`。
