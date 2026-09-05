# 能力鉴权声明与凭据：通用绑定 + 路径注入

为了支持「凭据不在环境变量里、而在 MCP 配置 JSON 内」（如 tapd 的 `headers.X-Tapd-Access-Token`），把能力的鉴权从单一扁平结构升级为统一的「绑定列表」，并把凭据值在 reconcile 渲染时**字面替换**进 MCP server 定义。

## 关键决策

1. **声明（资产侧）与凭据（用户侧）分离。** 资产携带 `auth.bindings: [{ credentialName, kind, envKey?, path?, authPageUrl? }]` 描述「需要什么凭据、放在哪里」；用户在设置页维护凭据名→加密值。`credentialName` 是两者之间的显式链接，使「此凭据被哪些资产/项目使用」可被可靠追踪。

2. **`kind: "env" | "path"`。** `env` = 旧语义，凭据值推送到设备系统环境变量（`envKey` 下），走现有 `env:push` 通道；`path` = 新语义，值在 reconcile 渲染时替换进 server 定义的指定路径。空 `bindings` 即无鉴权（替代旧 `method:"none"`）。

3. **字面替换（非引用展开）。** server 渲染时把解密后的真实值写进 `.mcp.json` 的对应叶子。选字面替换是因为 http MCP 的 header / 任意 JSON 字段里的 token，目标运行时不会展开 `${VAR}` 引用；引用模型对这些场景失效。代价：明文凭据会落到项目磁盘文件——但这与现状一致（用户本就是把 token 硬贴进 `.mcp.json`），Loom 只是把管理收口。

4. **纯函数渲染，无 per-binding 撤销状态。** 每次 reconcile 从「资产创作内容 + 当前存在的凭据值」重新派生磁盘文件：有值→写入/覆盖/自动创建叶子；无值→保留作者原始叶子。轮换/吊销凭据触发受影响项目 re-enqueue（`enqueueReconcile` fire-and-forget），离线设备下次 reconcile 补齐。不存撤销日志，磁盘文件始终是派生产物。

5. **路径解析规则。** 路径相对**未包装的 server 定义**（不含 `mcpServers.<key>` 前缀），`/` 分隔（`headers/X-Tapd-Access-Token`，安全容纳含点的 key）。单 server 资产 → 路径直指定义；多 server 包装资产 → 第一段为 server key，其后相对该定义。

6. **替换失败处理。** 叶子非字符串 / 路径中途遍历到非对象 → 该资产 reconcile 失败并报错，不写盘；路径不存在 → 自动创建叶子（功能核心，不限定路径形状白名单）。`path` 绑定仅对 `type:mcp` 资产有效，其余类型拒绝。

7. **显式分发，与 `env_vars` 同构。** 凭据值不会在配置时自动下发到项目；用户在设置页显式「选项目下发」（opt-in），记录在 `credential_distributions`（credentialName × projectId，镜像 `env_var_distributions`）。reconcile 渲染路径绑定时，**仅当** `(credentialName, projectId)` 已在分发表 → 写真实值；否则保留作者原始叶子。轮换 = 更新值 + re-enqueue 已分发的项目；取消分发 = 删分发记录 + re-enqueue → 作者叶子回归。这与「不在安装时写值、需用户去设置页手动操作」的产品取舍一致——安装只负责把声明落地，值的注入是用户主动行为。

8. **使用关系记录：reconcile-end 钩子，insert-only 超+移除时删。** 用户×项目×已装 MCP×path 绑定的使用记录由单个钩子维护：每次 reconcile 完成时对受影响资产 upsert 其当前 binding 行（INSERT OR IGNORE，超集，保证轮换不漏项目），MCP 从项目移除时删其行。能力集直接安装/卸载、能力 enable/disable 都收敛到同一个 reconcile 钩子，不可能漏某个路径。偏差窗口 = 「权威变更 → 下次 reconcile」，与磁盘 `.mcp.json` 陈旧窗口重合，两者不会长时背离。

9. **env 与 path 统一到同一凭据存储。** `kind:"env"` 与 `kind:"path"` 共用 `credentials`（值存储）+ `credential_distributions`（显式分发）。现有 `env_vars` / `env_var_distributions` 迁移进统一表。两者分发维度不同：env = credential × device（推送系统环境变量，走 `env:push`），path = credential × project（写进项目 `.mcp.json`）。维度差异记录在分发记录的目标字段，不破坏统一存储。`credentialName` 成为 env 与 path 共一的链接键，消除今天 env 绑定与值之间的隐式同名匹配。

10. **非 MCP 资产仅支持 `kind:"env"` 绑定。** skill/rule/hook/command/agent 没有结构化 def 供 path 注入，只走 env；`kind:"path"` 绑定在校验时对这些类型拒绝（决策 6）。

11. **AI 基础信息生成对 mcp 推断 path 绑定。** `ai.ts` 的生成 prompt 在 `type:"mcp"` 时扩展为可从 def 内容识别疑似凭据的 header/字段并产出 path 绑定（best-effort）；非 mcp 类型不推断 path。手动声明为主，AI 推断为辅。

## 后果

- reconcile plan 的 `.mcp.json` 文件内容现在含明文凭据——与 `env:push` 同一 WSS 通道、同一信任边界，但需新增「绝不记录 reconcile payload 文件内容」规则（与 env-vars 同口径）。
- 旧的 `assets.auth_method / auth_env_key / auth_page_url` 三列迁移为子表 `asset_auth_bindings`；现有 `method=env, envKey=X` → `[{credentialName:"X", kind:"env", envKey:"X"}]`。
- 凭据使用关系（资产×绑定×项目）成为可查询的派生视图，驱动设置页「被用到哪里」与轮换/吊销的 re-enqueue。
