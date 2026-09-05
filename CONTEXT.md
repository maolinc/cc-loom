# Loom 能力上下文

Loom 管理可分发到本地项目的「能力」（skill/rule/mcp/hook/command/agent）、能力到项目的安装关系，以及这些能力运行所需的鉴权凭据与 AI 生成的基本信息。本上下文定义这些侧的统一语言。

## Language

## 安装与能力集

**能力集（Capability Set）**:
由多个能力组成、可复用并可整体安装到项目的命名组合。它表达能力编排，不代表文件目录、开发环境或隔离的工作区域。
_Avoid_: 工作空间、Workspace、能力包

**多能力集安装（Multi-capability-set Install）**:
一个项目同时安装多个能力集，能力叠加生效。取代旧的「项目只有一个当前组合、切换即整体替换」语义。
_Avoid_: 切换能力集、当前能力集（currentCapabilitySetId 单值模型）

**能力集订阅（Capability Set Subscription）**:
项目与能力集之间的一条安装关系。同步策略和目标厂商属于这条订阅，每个能力集可独立选择；共享能力按能力与厂商的组合计数引用。
_Avoid_: 空间订阅、Workspace Subscription、安装实例、项目的 syncPolicy 字段

**隐式能力集（Implicit Capability Set）**:
单项能力直接添加到项目时所使用的内部能力组合。界面不把它展示为普通能力集，而呈现为「单独添加的能力」。
_Avoid_: 隐式 Workspace、项目级游离能力、单能力旁路安装

**能力共享（Asset Sharing）**:
同一 asset id 被同一项目的多个订阅引用时，磁盘上只落一份，按订阅引用计数；卸载某订阅时仅当它是最后一个引用者才删除该能力文件。共享能力的开关/移除是**项目级**操作（磁盘只有一份，无法按订阅区别对待），对引用它的所有订阅同时生效。
_Avoid_: 覆盖安装、按能力集复制能力文件、订阅级开关

**撞车裁决（Conflict Adjudication）**:
同名不同 id 的能力落盘路径必然撞车，不属于能力共享。安装计划阶段以 conflict 报出，安装流程中逐条裁决：跳过该能力（仅本次不装，非永久排除）、全部跳过并继续、或取消安装。不静默覆盖。
_Avoid_: 静默覆盖、整体拒绝安装

**能力鉴权声明（Auth Declaration）**:
一条描述「某能力需要什么凭据、以何种方式消费」的声明，挂在资产上，随资产分发。结构为绑定列表（见「鉴权绑定」）。声明只描述需求，不含值。
_Avoid_: 鉴权方式、auth 配置、凭据声明

**鉴权绑定（Auth Binding）**:
鉴权声明中的一个条目，形如 `{ credentialName, kind, envKey?, path?, authPageUrl? }`。`kind:"env"` 表示凭据值推送到设备系统环境变量（`envKey` 下）；`kind:"path"` 表示值在 reconcile 时替换进 MCP server 定义的指定路径。一个资产可有多个绑定。
_Avoid_: 鉴权项、auth entry

**凭据名（Credential Name）**:
绑定中的 `credentialName`，是资产侧声明与用户侧凭据值之间的显式链接键。同名即视为同一凭据，使「此凭据被哪些资产/项目使用」可被可靠追踪。
_Avoid_: 鉴权名、auth 名

**凭据（Credential）**:
用户在设置页维护的「凭据名 → 加密值」对。值 AES-256-GCM 加密落 DB，明文永不通过 REST 返回。仅承载值与使用关系，不承载路径。
_Avoid_: 密钥、secret、env var（env var 是 `kind:"env"` 绑定的消费产物，不是凭据本身）

**注入路径（Injection Path）**:
`kind:"path"` 绑定中定位凭据值写入位置的路径。相对**未包装的 MCP server 定义**（不含 `mcpServers.<key>` 前缀），`/` 分隔。单 server 资产直指定义；多 server 包装资产第一段为 server key。
_Avoid_: 鉴权路径、auth path

**字面替换（Literal Substitution）**:
reconcile 渲染时把解密后的凭据真实值写进 server 定义对应路径的渲染方式（而非写入 `${VAR}` 占位符交给运行时展开）。因为 http MCP 的 header 等字段不被运行时展开。
_Avoid_: 引用展开、变量插值、模板替换

**纯函数渲染（Pure Render）**:
每次 reconcile 从「资产创作内容 + 当前存在的凭据值」重新派生磁盘文件的渲染模型。有值→写入；无值→保留作者原始叶子。轮换/吊销凭据触发受影响项目 re-enqueue，无需 per-binding 撤销状态。
_Avoid_: 撤销日志、diff 回滚

**显式分发（Explicit Distribution）**:
凭据值不随配置自动下发；用户在设置页显式「选项目/设备下发」（opt-in），记录在 `credential_distributions`。reconcile 渲染路径绑定仅当 `(credentialName, 项目)` 已分发才写真实值，否则保留作者叶子。与 `env_vars` 同构。
_Avoid_: 自动下发、隐式应用

**分发维度（Distribution Axis）**:
凭据值到达的目标维度。env 绑定 = credential × 设备（推系统环境变量，走 `env:push`）；path 绑定 = credential × 项目（写进项目 `.mcp.json`）。两者共用同一凭据存储与分发记录，维度差异记在目标字段。
_Avoid_: 下发目标

## 设备工具配置

**工具配置档（Tool Config Profile）**:
用户保存的一套 Codex 或 Claude Code 用户级配置。配置档包含一个加密凭据（Codex API Key / Claude Auth Token）与该工具的非敏感配置字段；REST 只返回 `secretConfigured`，不返回明文。配置档不会随保存自动生效，必须显式选择在线设备下发。
_Avoid_: 环境变量凭据、能力集配置（前者是单一凭据，后者面向项目能力安装）

**工具配置下发（Tool Config Distribution）**:
把工具配置档通过在线 Agent 合并写入设备当前用户的 `~/.codex/` 或 `~/.claude/`。文件不存在则创建；存在则只更新该配置档负责的键。每台设备每个工具只记录最近一次成功下发的配置档，重复下发即切换。删除服务端配置档不反向删除设备文件。
_Avoid_: 全量覆盖、项目安装、自动同步

## 能力信息生成

**能力信息生成（Asset AI Info Generation）**:
后台为已落库能力自动补全空缺描述性元信息（alias/tags/description/auth.bindings）的服务。区别于编辑页「AI 生成」按钮（每用户、交互式、保存前回填候选，不入此队列）。不生成 `name`——name 是落盘身份，应由作者显式给出。
_Avoid_: AI 自动填、AI 元数据生成

**补缺口（Gap-fill）**:
能力信息生成队列的写入语义——只填当前为空的字段，已有字段（无论人工还是 AI 填的）永不重算。与向量化的「随内容变化重算」相反；代价是 AI 生成内容随源变化而陈旧，需作者手动清空该字段再触发重填。
_Avoid_: 重算、自动更新、增量生成

**能力信息队列（Asset AI Info Queue）**:
持久化在 `asset_ai_info` 表、以 asset_id 为主键、status 驱动的生成队列。每能力至多一条；入队去重（pending/processing 则 no-op）；worker 慢消费、失败指数退避。镜像 `asset_embeddings` 结构，但无 content_hash——空字段检查即「是否需调 AI」的信号。
_Avoid_: AI 生成队列、info 队列

**服务级 AI 配置（Service-level AI Config）**:
admin 维护、全站共用的 AI 配置（chat 兼容端点 + 加密 key + 并发/限频/重试调度参数），供后台队列使用。区别于每用户配置（仅供编辑页交互式按钮）。marketplace 调度器触发的生成无用户上下文，必须走服务级。
_Avoid_: 全局 AI 配置（用「服务级」强调与每用户并存，不混用）
