# 多能力集订阅安装模型

项目与 CapabilitySet 原为 1:1（`Project.currentCapabilitySetId` 单值 + `Project.syncPolicy`，「切换能力集」= 整体替换）。产品目标是让本地控制台支持一个项目同时安装多个能力集、能力叠加生效。本 ADR 以「能力集订阅」实体取代单值字段，并围绕它重定义共享、冲突、卸载与同步语义。产品未上线，不做旧版 CLI 协议兼容。

## 关键决策

1. **能力集订阅（Capability Set Subscription）是项目与能力集的唯一关系实体。** 形如 `(projectId, capabilitySetId, syncPolicy, targetTools, installedAt)`，一个项目持有多条订阅。`Project.currentCapabilitySetId` 与 `Project.syncPolicy` 废止，存量数据无感迁移为一条订阅。同步策略（auto/locked）与目标厂商都挂在订阅上——装多个能力集的典型动机正是区别对待它们。

2. **能力共享 = 单例 + (能力 × 厂商) 引用计数。** 同一 asset id 被多个订阅引用时磁盘只落一份，落在各订阅 targetTools 的并集里；卸载某订阅时，仅当它是该 (能力 × 厂商) 的最后一个引用者才撤文件。与 per-asset lock 的 `assets[id].vendors[tool]` 结构同构，lock 条目补订阅归属列表即可。拒绝「按能力集复制文件」——磁盘是唯一真值源，一份文件无法按订阅区别对待。

3. **共享能力的开关/移除是项目级操作。** toggle/remove 对被多个订阅引用的能力同时生效，UI 给「同时被能力集 X 引用」轻提示。不存在订阅级开关（与决策 2 同一论据）。

4. **同名不同 id 撞车在 plan 阶段报 conflict，逐条裁决。** 落盘路径必然撞车的能力不属于共享；安装流程弹冲突清单，每条可选「跳过该能力」，另给「全部跳过并继续」「取消安装」。跳过 = 仅本次不装，非永久排除（冲突方卸载后可重装补齐）。不静默覆盖——否则引用计数与卸载语义直接乱套。

5. **隐式 CapabilitySet 保留，降级为带 implicit 标记的普通订阅。** 单项能力「添加」仍复用统一安装流程，不发明第二条链路；UI 上隐式订阅不渲染为「能力集」，呈现为「单独添加的能力」分组。

6. **移除「切换能力集」入口。** 订阅只有增（添加）减（卸载）两种变化；「切换」是卸载 + 添加的组合，保留它会在用户心智中制造第三种语义，且一键替换全部能力在多能力集时代是危险操作。

7. **硬版本门槛，不做旧 Agent 兼容。** 产品未上线，协议与 lock 格式直接升级，Server 可要求最低 CLI 版本；不维护「多订阅投影为单订阅」之类的有损兼容层。

## 后果

- DB：`projects.current_capability_set_id` / `projects.sync_policy` 废止，新增订阅表（承载 syncPolicy/targetTools/installedAt/implicit 标记）；`project_installed_assets` 引用计数语义按订阅细化。
- Lock 格式升级：条目记录订阅归属；`capabilitySetId` 单值字段由订阅集合取代。
- 安装协议：`POST /api/install/plan|execute` 改为订阅语义（添加订阅而非替换）；`conflicts` 从阻断报错升级为可裁决项，execute 接受跳过清单。
- 控制台 UI：单「当前能力集卡」改为订阅条（每个能力集一卡 + 添加入口）；能力矩阵保持平铺，新增来源能力集徽标与能力集过滤器；两视图同源原则（`scanner.buildCells`）不变。
- 自动同步：auto 推送的触发与面向对象从「项目」改为「订阅」；凭据 path 轴分发（ADR-0004，credential × 项目）不受影响。
