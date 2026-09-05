# 以能力集取代工作空间

## 决策

Loom 将可复用、可整体安装的能力组合统一命名为「能力集（Capability Set）」。类型、接口、路由、持久化字段、CLI 输出和用户界面只暴露这一套领域语言：

- REST 使用 `/api/capability-sets`，Web 使用 `/capability-sets`。
- 公共字段使用 `capabilitySetId` / `capabilitySetName`，SQLite 使用 `capability_sets` / `capability_set_assets` / `capability_set_id`。
- 项目与能力集的唯一关系是 `CapabilitySetSubscription`；不保留项目级“当前能力集”单值。
- `Workspace` 只保留在 pnpm workspace、容器工作目录等技术语境，以及旧数据迁移边界中。

## 原因

`Workspace` 容易让人联想到项目目录、IDE 工作区或隔离环境，与该对象只负责组合能力的事实不符。保留旧名作为长期公共契约会持续放大这种认知偏差，也会迫使后续功能同时维护两套路由、类型和错误文案。

## 迁移

Server 启动时原地迁移旧 SQLite 表、关联列和索引，并把旧项目单值关系写入 `project_subscriptions` 后删除旧列。CLI 只在读取旧 lock 时接受 `workspaceId` / `workspaceName`，下一次写入即输出规范的 `subscriptions[].capabilitySet*` 结构。

不提供旧 `/api/workspaces` 路由或旧 shared 类型别名。产品尚未正式发布，保持单一契约比长期兼容更重要。

## 后果

- 这是一次明确的 API 和类型破坏性变更，Server、Web、CLI、testkit 与测试必须同步升级。
- 存量 SQLite 与本地 lock 数据可继续使用，不要求用户手工重建。
- 新代码搜索 `workspace` 时，命中应只属于技术 workspace 或显式迁移测试。
