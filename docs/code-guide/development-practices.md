# 开发规范、验证与文档维护

> 事实来源：根 `package.json`、各 package `package.json`、`vitest.config.ts`、现有源码风格。

## 基本原则

- `@maolinc/cc-loom-shared` 是跨端类型和校验的优先入口。
- `@maolinc/cc-loom-adapter` 必须保持纯转换逻辑，不依赖数据库、网络或用户项目 IO。
- Server 负责 API、DB、WS 编排，不直接写用户项目文件。
- CLI Agent 负责本地文件 IO、lock、扫描和 watcher。
- Web 通过 `/api` 和 `/ws` 与 Server 交互，不直接读写本地文件。
- 代码是唯一事实来源；本目录文档必须追随代码。

## 变更前检查清单

按任务选读：

- 产品边界：`product-functional-doc.md`。
- UI 设计：`ui-design-spec.md`。
- 技术结构：`docs/code-guide/README.md` 和对应专题文档。
- 已有测试：相关 package 的 `src/__tests__` 或 `marketplace/__tests__`。

## 常用命令

根目录：

```bash
pnpm build
pnpm typecheck
pnpm dev
```

package 级命令：

| 包 | 命令 |
|----|------|
| `packages/shared` | `pnpm --filter @maolinc/cc-loom-shared build`、`pnpm --filter @maolinc/cc-loom-shared typecheck` |
| `packages/adapter` | `pnpm --filter @maolinc/cc-loom-adapter build`、`pnpm --filter @maolinc/cc-loom-adapter typecheck` |
| `packages/server` | `pnpm --filter @maolinc/cc-loom-server build`、`pnpm --filter @maolinc/cc-loom-server typecheck`、`pnpm --filter @maolinc/cc-loom-server test` |
| `packages/cli` | `pnpm --filter @maolinc/cc-loom build`、`pnpm --filter @maolinc/cc-loom typecheck`、`pnpm --filter @maolinc/cc-loom test` |
| `packages/web` | `pnpm --filter @maolinc/cc-loom-web build`、`pnpm --filter @maolinc/cc-loom-web typecheck`、`pnpm --filter @maolinc/cc-loom-web dev` |

当前根 `pnpm lint` 映射到 `pnpm -r lint`，但各 package 目前没有 `lint` 脚本；不要把它当作已可用验证，除非先补齐脚本。

`justfile` 是项目命令入口索引；需要安装/启动/打包时先读 `justfile`。

## 测试位置

| 区域 | 位置 |
|------|------|
| Server 单元/集成 | `packages/server/src/__tests__` |
| Server E2E | `packages/server/src/__tests__/e2e` |
| Marketplace | `packages/server/src/marketplace/__tests__` |
| Marketplace providers | `packages/server/src/marketplace/__tests__/providers` |
| CLI | `packages/cli/src/__tests__` |
| Adapter 行为 | 当前主要通过 server tests 覆盖，且 adapter 包自身无 test 脚本 |
| Web | 当前 package 未配置 test 脚本，以 typecheck/build 为主 |

修改行为时优先加/改对应测试；不能验证时在最终说明原因。

## 常见跨包改动规则

### 新增/修改 `AssetType`

至少检查：

1. `packages/shared/src/constants.ts`：`ASSET_TYPES`、labels、colors、dir、`ADAPTER_SUPPORT`。
2. `packages/shared/src/types.ts`：metadata 类型、manifest/lock 是否受影响。
3. `packages/shared/src/schemas.ts`：metadata schema、create/update 校验。
4. `packages/shared/src/layout.ts`：目录/平铺规则。
5. `packages/adapter/src/base.ts` 和各 adapter：生成、聚合、支持类型。
6. `packages/adapter/src/install-key.ts`：落盘身份冲突。
7. Server routes：asset create/update、install plan、conflict、auto-sync。
8. CLI installer/scanner/capabilities：lock、落盘、镜像。
9. Web 表单、类型展示、兼容矩阵、本地控制台。
10. 更新 `docs/code-guide/shared-and-adapter.md`。

### 新增/修改 `TargetTool`

至少检查：

1. `TARGET_TOOLS`、`TARGET_DIRS`、labels、`ADAPTER_SUPPORT`。
2. 新增 adapter 类和 `registry.ts`。
3. CLI watcher/scanner/safe-write 是否允许对应目录。
4. Web 兼容矩阵、安装目标选择、本地控制台 vendor tab。
5. Server install plan 和冲突检测。
6. 更新 code guide。

### 修改安装计划或 lock

至少检查：

- `packages/shared/src/types.ts` 的 `InstallPlan`、`DiffEntry`、`LockFile`。
- `packages/server/src/routes/install.ts`。
- `packages/cli/src/lib/installer.ts`。
- `packages/cli/src/lib/locks.ts`。
- `packages/cli/src/lib/scanner.ts`。
- `packages/cli/src/lib/capabilities.ts`。
- `packages/server/src/routes/projects.ts`。
- Web 本地控制台组件。

### 修改 WebSocket op

至少检查：

- Server `ws/gateway.ts`。
- Server 发起方 `routes/projects.ts` / `routes/install.ts` / `lib/auto-sync.ts`。
- CLI `ws/messages.ts`。
- CLI `ws/client.ts`。
- CLI `commands/start.ts` 的 request dispatcher。
- Web 调用相关 API 的页面。

## 文档维护规则

本目录由 AI 自行维护，但必须遵守：

- 任何文档事实都要能追溯到源码路径。
- 代码与文档冲突时，以代码为准，更新文档。
- 不记录猜测、计划或未实现功能。
- 不为文档一致性改业务代码。
- 只更新受本次代码变更影响的文档，避免无关重写。

每次完成涉及结构/流程/契约的改动后，至少检查：

- `docs/code-guide/README.md` 的索引是否仍正确。
- 对应专题文档的入口文件、endpoint、消息名、表名、命令是否仍正确。
- `AGENTS.md` 中的项目文件索引是否能引导 AI 找到 code guide。

## 验证建议

按改动范围选择最小有效验证：

- 只改 shared/adapter 类型或纯函数：`pnpm --filter @maolinc/cc-loom-shared typecheck`、`pnpm --filter @maolinc/cc-loom-adapter typecheck`，必要时 server/cli typecheck。
- 改 Server API/DB/WS：`pnpm --filter @maolinc/cc-loom-server test`，再 `pnpm --filter @maolinc/cc-loom-server typecheck`。
- 改 CLI Agent/installer/scanner：`pnpm --filter @maolinc/cc-loom test`，再 `pnpm --filter @maolinc/cc-loom typecheck`。
- 改 Web：`pnpm --filter @maolinc/cc-loom-web typecheck` 或 `pnpm --filter @maolinc/cc-loom-web build`。
- 跨包改动：根 `pnpm typecheck` 或 `pnpm build`。

验证通过才能说通过；未运行要说明原因。
