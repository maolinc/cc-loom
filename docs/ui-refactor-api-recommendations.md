# 前端 UI 重构 — 接口数据可用性与建议扩展清单

本文档配合本次 `packages/web` 前端 UI 重构产出，说明：

1. 现有接口字段对优秀 UI 呈现的支撑情况；
2. 为进一步提升体验，建议**可选**新增的接口字段（均为向后兼容增量，前端已有 fallback）。

> 原则：本次重构**不依赖**任何后端改动即可运行。以下字段为「锦上添花」，按收益优先级逐步落地即可。

---

## 1. 现有数据已足够支撑的能力

| 场景 | 依赖的现有字段 | 说明 |
|------|----------------|------|
| 能力市场卡片 | `Asset.type / name / description / tags / compatibleTools / author / version / updatedAt / sourceDisplayName` | 信息层级完整 |
| 单 Asset 安装 | `POST /projects/:id/capabilities/add` + `/install/plan` + `/install/execute` | 已复用隐式能力集闭环，无需扩展 install schema |
| 能力集卡片 | `CapabilitySet.name / description / visibility / targetTools / version`，列表附带 `assetTypes` | 组成类型统计来自 `assetTypes` |
| 本地控制台镜像 | `LocalProjectState.vendors / capabilities / installedCapabilitySetId / driftCleared / legacyLock` | 厂商目录、能力开关、漂移修复均已覆盖 |
| 安装计划预览 | `InstallPlan.diff / conflicts` | diff 树与冲突提示可渲染 |

---

## 2. 建议新增（可选）字段

### 2.1 Asset 列表项（`GET /api/assets`）

| 字段 | 类型 | UI 收益 |
|------|------|---------|
| `fileCount` | number | 卡片直接显示文件数，免去打开详情才知道体量 |
| `capabilitySetCount` | number | 展示「被 N 个能力集引用」，辅助判断质量 |
| `installCount` | number | 市场热度排序与「热门」标识 |
| `metadataSummary` | string | 列表无需各端按 type 拼装 metadata 摘要 |
| `riskFlags` | `{ executable?: boolean; network?: boolean }` | 卡片提前标注 Hook 可执行 / MCP 联网风险 |

### 2.2 CapabilitySet 列表项（`GET /api/capability-sets`）

| 字段 | 类型 | UI 收益 |
|------|------|---------|
| `assetCount` | number | 与 `assetTypeCounts` 配合显示总量（现仅有 `assetTypes` 数组） |
| `installedProjectCount` | number | 展示「已安装到 N 个项目」，体现复用度 |
| `lastInstalledAt` | string | 列表排序与「最近使用」 |
| `sourceDisplayName` | string | 标注来源仓库（与 Asset 对齐） |

> 当前前端从列表附带的 `assetTypes` 推断类型分布；正式声明 `assetTypeCounts` 可减少前端聚合。

### 2.3 Project 列表项（`GET /api/projects`）

| 字段 | 类型 | UI 收益 |
|------|------|---------|
| `lastScanAt` | string | 项目卡显示「最近扫描」，无需进入详情 |
| `problemCount` | number | 项目列表直接标红「N 处缺失/冲突」 |
| `currentCapabilitySetSummary` | `{ assetCount; targetTools }` | 列表内预览当前能力集规模 |

> `deviceName` / `lastOnlineAt` 已通过 `device` 字段提供，前端已使用。

### 2.4 安装计划（`POST /api/install/plan`）

| 字段 | 类型 | UI 收益 |
|------|------|---------|
| `skippedItems` | `{ tool; type; count; reason }[]` | 在 diff 顶部显示「目标工具 X 不支持 N 项，已跳过」黄条（设计稿要求） |
| `operationSummaryByTool` | `Record<TargetTool, { add; modify; remove }>` | 按厂商汇总变更，替代逐行 diff 心算 |
| `safetyFlags` | `{ writesExecutable; networkAccess; mergeConfig }` | 安装前安全提示（Hook/MCP） |
| `planHash` | string | 前端比对 plan 与执行参数是否一致；当前已通过「参数变更即清空 plan」规避陈旧问题 |

### 2.5 Marketplace 来源（`GET /api/marketplaces`）

| 字段 | 类型 | UI 收益 |
|------|------|---------|
| `nextSyncAt` | string | 显示「下次同步时间」 |
| `syncStage` / `syncProgress` | string / number | 刷新时显示进度，而非仅 spinner |
| `latestCommitSha` + 提交时间 | string | 展示来源最新版本信息 |

---

## 3. 落地建议

- 上述字段全部以**可选字段**形式追加到对应 `serialize*` 响应中，`@maolinc/cc-loom-shared` 的接口用 `?:` 声明，前端按 `field ?? fallback` 消费。
- 优先级：`skippedItems`（设计稿明确要求） > Asset/CapabilitySet 列表聚合计数 > Project `problemCount` > Marketplace 同步进度。
- 任一字段缺失时，当前前端均能正常工作，不会报错或留白。
