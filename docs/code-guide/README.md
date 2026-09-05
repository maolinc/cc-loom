# Loom 项目代码指南

> 目的：让 AI 或开发者在开始具体任务前快速建立代码上下文，避免每次从零扫描整个仓库。
>
> 维护原则：**代码是唯一事实来源**。本目录只是源码索引和开发导航；当文档与代码冲突时，以代码为准，并优先更新文档。

## 使用方式

1. 先读本页，判断任务属于哪一层。
2. 按任务只读对应指南和其列出的源码入口。
3. 修改代码后，如果改动影响本指南描述的结构、数据流、公共契约、命令或约定，必须同步更新对应文档。
4. 不要为了让文档成立而改代码；应让文档追随代码。

## 指南目录

| 文档 | 适用场景 | 事实来源入口 |
|------|----------|--------------|
| `architecture.md` | 需要理解 monorepo 分层、依赖方向、运行时总数据流、本地/服务端存储 | `package.json`、`pnpm-workspace.yaml`、各 package `package.json`、`packages/*/src/index.ts` |
| `shared-and-adapter.md` | 修改类型、校验、Asset 类型、目标工具、落盘路径、合并策略、冲突判定 | `packages/shared/src/*`、`packages/adapter/src/*` |
| `server-flows.md` | 修改 HTTP API、WebSocket、SQLite、安装计划、自动同步、Marketplace | `packages/server/src/index.ts`、`routes/*`、`ws/gateway.ts`、`db/migrate.ts` |
| `cli-agent-flows.md` | 修改 CLI 命令、本地 Agent、项目注册、安装落盘、lock、扫描、watcher | `packages/cli/src/index.ts`、`commands/*`、`lib/*`、`ws/*` |
| `web-flows.md` | 修改 React 页面、路由、登录态、API 调用、本地控制台交互 | `packages/web/src/App.tsx`、`api.ts`、`hooks/*`、`pages/*` |
| `development-practices.md` | 新增功能前确认规范、验证命令、测试位置、文档维护清单 | 根 `package.json`、各 package `package.json`、`vitest.config.ts` |

## 快速定位：按任务读哪些文档

| 任务 | 推荐阅读 |
|------|----------|
| 新增一种能力类型或目标工具 | `shared-and-adapter.md` → `server-flows.md` → `cli-agent-flows.md` → `web-flows.md` |
| 新增一个厂商（TargetTool） | `adding-a-vendor.md`（改动清单 + 决策表，按图索骥） |
| 调整安装/卸载/单项能力开关 | `shared-and-adapter.md` → `server-flows.md` → `cli-agent-flows.md` |
| 调整项目本地镜像或本地控制台 | `cli-agent-flows.md` → `server-flows.md` → `web-flows.md` |
| 修改登录、CLI Token、设备绑定 | `server-flows.md` → `cli-agent-flows.md` → `web-flows.md` |
| 修改能力市场或工作空间编辑 | `server-flows.md` → `web-flows.md` |
| 修改 Marketplace 导入/同步 | `server-flows.md` |
| 修改 UI 页面布局或路由 | `web-flows.md`，涉及设计时另读 `ui-design-spec.md` |

## 当前代码总览

Loom 是 TypeScript pnpm workspace：

```text
packages/shared   公共常量、类型、Zod 校验、布局判定
packages/adapter  各 AI 工具目录/配置文件的纯转换逻辑
packages/server   Fastify API + WebSocket gateway + SQLite + 静态资源托管
packages/cli      loom CLI + 本地 Agent + 文件落盘/扫描/watch
packages/web      React + Vite SPA
```

核心运行链路：

```text
React SPA
  └─ HTTP /api + cookie session
Fastify Server
  ├─ SQLite: ~/.loom/loom.db（可用 LOOM_DATA_DIR 覆盖）
  └─ WebSocket /ws
CLI Agent: loom start
  ├─ ~/.loom/config.json / projects / locks / logs / disabled
  └─ 项目目录内 .cursor / .codebuddy / .codex / .claude / .mcp.json
```

## AI 文档维护协议

每次改代码时检查：

- 改了 package 职责、入口、依赖、脚本：更新 `architecture.md` / `development-practices.md`。
- 改了 `AssetType`、`TargetTool`、`ADAPTER_SUPPORT`、schema、manifest、lock、layout：更新 `shared-and-adapter.md`，并检查 server/CLI/web 调用点。
- 改了 REST endpoint、DB 表、WebSocket 消息、自动同步、Marketplace：更新 `server-flows.md`。
- 改了 CLI 命令、本地路径、daemon、installer、safe write、scanner、watcher：更新 `cli-agent-flows.md`。
- 改了页面、路由、API 封装、登录态、本地控制台 UI 行为：更新 `web-flows.md`。
- 新增测试或验证命令：更新 `development-practices.md`。

更新文档时应：

- 先读对应源码入口，确认事实。
- 写清“入口文件 / 数据来源 / 副作用 / 验证点”。
- 删除过期描述，不保留“历史上曾经”。除非代码仍兼容旧路径且对维护有价值。
- 避免写未来计划、猜测和未实现行为。
