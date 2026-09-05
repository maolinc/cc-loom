# 能力信息生成队列：补缺口模型，非重算；服务级配置

Loom 新增的「能力信息生成」后台队列镜像向量化（`asset_embeddings` 队列表 + worker + 入队 hook + 设置页管理）的骨架，但在写入语义上刻意偏离：采用**补缺口**模型——worker 只为空字段（alias/tags/description/auth.bindings）调 AI 生成并回填，已有字段永不重算；不做 origin 区分人工与 AI；不做模型切换 rebuild；不生成 `name`（落盘身份）。配置走服务级（admin，`app_settings`），与每用户表单按钮配置并存：队列走服务级（marketplace 调度器无用户上下文），表单按钮走每用户。

## 考虑过的选项

- **重算 AI 字段（需 origin 标记，随源内容变化重算 AI 字段、人工字段不动）**：否决。origin 追踪的 schema/UI 复杂度与「导入数据源也自动」的批量诉求不匹配；且用户明确选了「只填空」。
- **候选暂存待审阅（suggestion 侧表，不动 assets，人工接受才落库）**：否决。marketplace 大批量导入无人在环审阅，与「导入数据源也自动」冲突。
- **只填空字段（采纳）**：最简、保护人工内容、契合批量；代价是接受 AI 生成内容随源变化而陈旧。

## 后果

- 不做 `rebuild` 按钮：文本模型无关，无向量空间失效语义。管理按钮 = requeue all（重扫空缺）+ retry failed + 单条 requeue/retry + 刷新。
- 切 chat 模型不需重建：旧文本仍有效，仅新生成用新模型。
- 队列表 `asset_ai_info` 比 `asset_embeddings` 少 `content_hash`/`field_version`/`embed_dim`——空字段检查即信号，不需要靠 hash 检测内容变化。
- 写回用**条件 UPDATE**（仅当字段仍为空才写）防「worker 处理中用户并发填入」竞态，替代向量化基于 content_hash 的写回复检。
- 入队 hook 与向量化同一批点：`assets.ts` 创建/编辑、`pipeline.ts` added/updated、`push.ts`、`asset-gc.ts` 删除清理；enqueue 去重（pending/processing 则 no-op，ready → 重扫空缺）；启动崩溃恢复 processing→pending。
- `name` 全局不再由 AI 生成（队列与表单按钮都不生成）——name 是落盘身份，`(type,name)` 是落盘 key，被引用后不可改，自动生成风险高。
- `auth.bindings` 队列自动补全（空则补）：可能给无需鉴权的能力误加声明，与 [[credential-axis-typed]] 的谨慎语义有张力；用户接受此代价。误加的声明经正常鉴权系统流转（不匹配 `credentialName` → 「待配置」提示），不直接破坏安装。
- **访问控制**：队列面（配置 + 管理路由 + 设置页 tab）全 `requireAdmin`；编辑页「AI 生成」按钮仍每用户、所有登录用户可用（与队列并存）。队列对所有资产写入自动入队，**含普通用户创建的能力**——后台维护由 admin 的服务级 key 买单。即「此功能仅管理员」只限队列管理面，不限制谁的资产被补全、也不动表单按钮。
- **跨系统触发向量重算**：AI-info worker 写 `alias`/`tags`/`description` 后调 `enqueueSearchIndex(id,'auto')`——这三个字段正是向量化的输入（content_hash = name+alias+tags+手填description+frontmatter description），不触发会让向量停在「字段为空时的旧内容」，语义搜索召回不到 AI 填的新描述。content_hash 去重保证：alias/tags/description 写入→hash 变→重算；**仅** auth.bindings 写入→hash 不变→no-op（auth 不在 hash）。FTS5 在 enqueue 时同步刷新（ADR-0002），词法搜索即时反映新描述。**无回环**：向量化写 `asset_vec`/`asset_embeddings`，不动 `assets` 列，不会回流 AI-info 队列。embedding 未启用时 `enqueueSearchIndex` 自然 no-op。
