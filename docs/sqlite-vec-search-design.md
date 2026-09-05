# sqlite-vec 语义搜索设计（能力市场增强）

> 状态：需求/设计草案，待关键决策确认后进入实现。
>
> 代码事实来源（调研于 2026-07-09）：
> - 搜索现状：`packages/server/src/routes/assets.ts`、`packages/server/src/routes/workspaces.ts`
> - DB schema：`packages/server/src/db/migrate.ts`、`packages/server/src/db/index.ts`
> - 导入链路：`packages/server/src/marketplace/pipeline.ts`（`diffAndUpsertAssets`）、`packages/server/src/routes/assets.ts`（POST/PUT）
> - AI 配置：`packages/server/src/lib/user-ai-settings.ts`、`packages/server/src/routes/ai.ts`

## 1. 背景与目标

### 1.1 现状

能力市场（Web `/` 页，对应 `GET /api/assets`）当前搜索为纯词法 `LIKE %query%`：

- 命中字段：`name`、`alias`、`description`。
- 标签：`tags LIKE %"tag"%`（JSON 数组子串匹配）。
- **正文内容（asset_files）完全不参与搜索**——skill 的 `SKILL.md`、rule/command/agent 的 .md、mcp 的 JSON 等都无法被检索。
- 无语义匹配：`react 组件生成` 无法命中 `react_component_generator`；`代码审查清单` 无法命中 `code_review_checklist`。
- 排序仅按 `updated_at DESC`，与相关性无关。

### 1.2 目标

接入 **sqlite-vec**（SQLite 向量扩展），在不破坏「一条 `npx @maolinc/cc-loom-server` 即可启动」零配置体验的前提下，为能力市场增加**语义搜索**，并让**名称、标签、描述**三类元信息信号都参与排序且**权重不同**（正文内容不参与向量化）。

### 1.3 非目标（本期不做）

- 工作空间（`/api/workspaces`）搜索增强——用户明确范围为「能力市场」。架构上预留复用空间，但不在本期实现。
- 跨语言翻译、多模态（图像/代码 AST）向量化。
- 全文检索结果高亮、片段截取（snippet）UI——可选增强，非核心。
- 引入外部托管向量库（Pinecone/Weaviate 等）——保持 SQLite 单文件。

### 1.4 约束

- **自托管、单进程、零外部依赖**：embedding 生成须走可配置的 OpenAI 兼容 `/embeddings` 端点，不得硬编码某云厂商。
- **匿名可用**：能力市场对未登录用户开放（仅 public），语义搜索必须在匿名请求下同样可用 → embedding 须为**服务端预计算**，查询向量也由服务端用服务级凭据生成，不依赖终端用户配置。
- **不阻塞写入**：创建/编辑/导入能力时，embedding 生成异步进行，失败不阻断主流程。
- **优雅降级**：embedding 服务未配置或不可用时，搜索自动回退到现有 `LIKE` 词法匹配，不报错给用户。
- **不破坏现有测试隔离**：所有非单元测试走 docker testkit；embedding 外部 API 在测试中可被 mock。

## 2. 搜索模型设计

### 2.1 混合检索（词法 + 语义）—— 推荐

**推荐采用混合检索**：FTS5（词法）+ sqlite-vec（语义）双路召回，加权融合排序。

理由：
- 纯语义向量对**精确标识符**（如 `react_component_generator`、`GITHUB_TOKEN`）召回不稳定；FTS5 精确/子串匹配能稳定命中。
- 纯 `LIKE` 无法理解语义；向量补足同义/跨语言。
- 两者互补，单路均有明显盲区。

> **决策点 A（需确认）**：是否接受混合检索带来的额外一张 FTS5 表与融合逻辑？还是只要纯语义（sqlite-vec）一路？
> 推荐：混合。若用户坚持最小改动，可退化为纯语义 + 保留现有 `LIKE` 作为兜底（语义失败时降级），但精度不如混合。

### 2.2 字段与权重

参与检索的字段及**默认权重**（语义融合系数，**支持管理员在设置页动态调整**，见 §4.1）：

| 字段 | 来源 | 默认权重 | 说明 |
|------|------|---------|------|
| `name` | `assets.name` + `assets.alias` | 0.40 | 稳定标识 + 展示别名；精确命中价值最高 |
| `tags` | `assets.tags`（JSON 数组，≤3） | 0.20 | 主/次标签，分类信号强但信息量少 |
| `description` | 手填 `assets.description` ⊕ 文档 frontmatter description（§2.3） | 0.40 | 语义主体（正文不参与），信息量最大；与 name 并重 |

**正文内容（asset_files body）不向量化**：正文含大量代码/JSON 噪声会稀释向量语义；仅上述元信息字段参与。`description` 字段为手填描述与文档头部 frontmatter description 的合并（见 §2.3）。

**权重三字段独立**（决策 B）：name/tags/description 分开向量化、分开成行，便于单独调权；三项归一化和为 1。

> 动态调整：管理员在设置页拖动滑块/填数字，写入 `search.embedding.weights`，搜索查询时即时读取最新值；无需重建索引（向量是按字段存的，权重只影响融合阶段，不参与向量化）。设置页对三项做归一化校验（和≈1，允许 ±0.01 浮动自动补齐到最小项）。

### 2.3 向量化字段构造规则

正文不参与向量化。三字段的文本来源：

| 字段 | 文本构造 |
|------|---------|
| `name` | `assets.name`；`assets.alias` 非空则拼接 `name + " " + alias` |
| `tags` | `assets.tags`（JSON 数组）展开为空格分隔串 |
| `description` | 手填 `assets.description` 与文档 frontmatter `description` 合并去重（见下） |

**frontmatter description 抽取（仅 skill / agent / command）**：

| 类型 | 来源文件 | 抽取位置 |
|------|---------|---------|
| `skill` | `SKILL.md`（根，或路径以 `/SKILL.md` 结尾） | YAML frontmatter 的 `description` 字段 |
| `agent` | 主 .md 文件 | 同上 |
| `command` | 主 .md 文件 | 同上 |
| `rule` / `mcp` / `hook` | — | 无 frontmatter description，description 字段仅用手填值 |

frontmatter 解析复用项目现有逻辑（与 `ai.ts` 的 `selectFilesForAi`、`vendor-reader.ts` 同源），保证与 push/marketplace 导入解析一致。

**合并去重规则**（description 字段）：
- 取手填 `assets.description` 与 frontmatter `description` 两个值，两侧均做 `trim()` + 折叠内部连续空白为单空格。
- 两侧**大小写敏感精确相等** → 只用一个，避免重复文本稀释向量（自然语言描述大小写差异通常有意义，不强转小写）。
- 两者均有值且不等 → 拼接 `手填 + "\n" + frontmatter`。
- 仅一者有值 → 用该值。
- 均空 → description 字段为空串，该字段不生成向量行（asset 仅 name/tags 两行）。

**触发更新的字段集**：仅当 `name`、`alias`、`tags`、手填 `description`、或 frontmatter `description` 任一变化时才需重算向量（见 §5.4）。**正文 body、metadata、compatible_tools 等变化不触发重算**。

### 2.4 检索流程（单次查询）

```
用户输入 query
   │
   ├─⓪ 可见性预过滤（先于两路检索）：按现有 conditions 算出当前用户可见 asset_id 集合，
        写入连接级临时表 search_visible(asset_id)。
   │
   ├─① 词法路（FTS5）：BM25 排序，WHERE asset_id IN (SELECT asset_id FROM search_visible)，
        取 top 100 候选 asset_id + score
   │
   ├─② 语义路（sqlite-vec，每字段一条 KNN）：
        a. 服务端 embed(query, "query") → 向量 q（非对称 input_type）
        b. 对 name / tags / description 各跑一条 KNN：
           SELECT asset_id, field, distance FROM asset_vec
           WHERE embedding MATCH ? AND k = 100 AND field = ?
             AND asset_id IN (SELECT asset_id FROM search_visible)
           ORDER BY distance
        c. 并集聚合：每个 asset 拿到它在各字段的相似度；
           score_vec(asset) = Σ_field w_field × (1 - distance_field)
           （该 asset 某字段没进 top 100 → 该字段贡献记 0）
   │
   ▼ 融合
   score_final(asset) = α × normalize(score_fts) + (1-α) × normalize(score_vec)
   α 默认 0.4（语义略占优），可配置
   │
   ▼
   叠加 type / tags / source 后过滤（可见性已在 ⓪ 预过滤，这三项是用户主动筛选，无召回损失）
   ▼
   按 score_final DESC 分页
```

**每字段一条 KNN**（决策 Q4）：保证每个字段独立获得 top-k 曝光、加权名副其实；避免单条跨字段 KNN 被"全局最强字段"垄断 top-k 而扭曲权重。marketplace 规模下 3 条 KNN 亚毫秒级。

**可见性预过滤**（决策 Q3）：用 metadata 列子查询把"不可见 private 能力"挡在 KNN 之外，避免不可见向量挤占 top-k 预算导致可见结果召回不足、排序被打乱（匿名用户尤其明显）。

- `normalize`：min-max 归一化到 [0,1]，使两路分数可比。
- **无 embedding 的 asset**：仅参与词法路；融合时其语义分记 0（不排除，避免新资产在 embedding 生成前完全不可见）。
- **embedding 服务不可用**：query 向量生成失败 → 整条请求回退为纯 FTS5/LIKE，返回结果并标注降级（可选响应头 `X-Loom-Search-Mode: lexical`）。

## 3. 存储设计

### 3.1 新增表

#### 3.1.1 向量表（sqlite-vec 虚拟表）

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS asset_vec USING vec0(
  embedding float[D] distance=cosine,
  asset_id  TEXT,
  field     TEXT   -- 'name' | 'tags' | 'description'
);
```

- `D` = embedding 维度，由配置的模型决定（如 `nvidia/nv-embed-v1`=4096、`text-embedding-3-small`=1536、`bge-m3`=1024）。
- **每个 asset 多行**：每个字段一行（最多 3 行/asset：name/tags/description；某字段为空则不生成该行），便于字段级加权融合。
- **用 metadata 列，不用辅助列**（ADR-0001）：`asset_id`/`field` 是 plain 列（**不带 `+`**）。实测辅助列 `+col` 不可在 KNN/DELETE 的 WHERE 过滤，metadata 列可以——这是按可见性子查询过滤、按 field 过滤、以及 `DELETE FROM asset_vec WHERE asset_id = ?` 直接删除的前提。
- **distance=cosine**：小写带 `=`（`DISTANCE_COSINE`/`distance_cosine` 不被解析，默认是 L2）。声明后 vec0 内部归一化，对非单位向量也返回真实 cosine 距离，**无需 JS 单位化**。
- KNN（每字段一条，见 §2.4）：`SELECT asset_id, field, distance FROM asset_vec WHERE embedding MATCH ? AND k = 100 AND field = ? AND asset_id IN (SELECT asset_id FROM <可见集>) ORDER BY distance;`

#### 3.1.2 词法表（FTS5，若采用混合检索）

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(
  asset_id UNINDEXED,
  name, tags, description,
  tokenize = 'trigram'  -- 中文子串匹配，零外部依赖（决策 A：混合检索）
);
```

- 与 `assets` 通过 `asset_id` 关联，重建即可，不存权威数据。
- FTS5 索引字段与向量化字段保持一致（name/tags/description，§2.3），不含正文——两路召回同字段，融合才有意义，且避免正文代码噪声。
- description 列写入 §2.3 合并后的描述文本（手填 ⊕ frontmatter），与向量化的 description 同源。

#### 3.1.3 索引元数据表（普通表）

```sql
CREATE TABLE IF NOT EXISTS asset_embeddings (
  asset_id      TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  embed_model   TEXT NOT NULL,      -- 生成时所用模型名
  embed_dim     INTEGER NOT NULL,   -- 维度，与 asset_vec D 对齐校验
  content_hash  TEXT NOT NULL,      -- name+alias+tags+手填description+frontmatter description 拼接 hash
  field_version INTEGER NOT NULL,   -- 权重/字段定义版本，schema 变更时强制重建
  status        TEXT NOT NULL,      -- 'pending' | 'ready' | 'failed'
  last_error    TEXT,
  updated_at    TEXT NOT NULL
);
```

- 用于：判断哪些 asset 需要重算（content_hash 变化）、检测模型/维度切换、失败重试。
- `status='ready'` 表示该 asset 在 `asset_vec` 中已有完整行。

### 3.2 与现有表的关系

- `assets` 为权威源；`asset_vec` / `asset_fts` / `asset_embeddings` 均为派生索引，可随时 DROP 重建。
- `asset_files` 的 CASCADE 删除已存在；asset 软删（`deleted_at`）时**同步删除其向量/FTS 行**（搜索不返回软删资产），或在查询层过滤。推荐物理删除派生索引行（派生数据可重建），保留 `assets` 软删行为不变。
- **不新增 `assets(id)` 之外的无 CASCADE 外键**——遵循项目测试规范中关于级联清理的约定。`asset_embeddings.asset_id` 带 CASCADE；`asset_vec` 是虚拟表，手动维护行生命周期。

### 3.3 sqlite-vec 加载

- 依赖：新增 `sqlite-vec` npm 包（提供预编译 `.so/.dylib/.dll`，`getLoadablePath()` 返回路径）。
- 加载：在 `packages/server/src/db/index.ts` 打开 db 后调用 `db.loadExtension(getLoadablePath())`。
  - better-sqlite3 默认启用 `loadExtension`，无需额外编译开关。
- 失败处理：加载失败不致命——记录日志，搜索降级为纯词法（FTS5 或 LIKE），服务仍可启动。
- 打包：`sqlite-vec` 的预编译二进制随依赖进入 `@maolinc/cc-loom-server` 发布包，无需用户额外安装。

### 3.4 中文分词

FTS5 内置 `unicode61` 不支持中文按词切分（会把整段中文当一个 token）。选项：

1. **`trigram` tokenizer**（SQLite 3.34+ 内置）：按 3-gram 切分，对中文子串匹配效果好，无需外部依赖。**推荐**。
2. 外部 ICU tokenizer：需编译，违背零配置原则，不采用。

若决策点 A 选择纯语义（不要 FTS5），则本节忽略。

## 4. Embedding 配置

### 4.1 服务级配置（区别于现有每用户 AI 配置）

现有 `user_ai_settings` 是**每用户**配置，用于 `/api/ai/asset-basic-info`。但 embedding 是服务端后台任务、需对匿名请求生效，故新增**服务级**配置（admin 维护，全站共用）。

存储：复用 `app_settings` 表，键前缀 `search.embedding.*`：

| key | 默认值 | 说明 |
|-----|-------|------|
| `search.embedding.enabled` | `0` | 总开关 |
| `search.embedding.provider` | `nvidia` | 提供商预设：`nvidia` / `openai` / `custom`（决定是否发送 `input_type` 等特有字段） |
| `search.embedding.base_url` | `https://integrate.api.nvidia.com/v1` | OpenAI 兼容基地址 |
| `search.embedding.api_key_cipher` | AES-256-GCM 密文 | 复用 `crypto.ts` 的 `encryptSecret`，明文不落库 |
| `search.embedding.model` | `nvidia/nv-embed-v1` | 模型名 |
| `search.embedding.dim` | `4096` | 向量维度，建 vec0 表/校验用；nv-embed-v1 为 4096 |
| `search.embedding.passage_input_type` | `passage` | **索引时**的 `input_type` 值；空串=不发该字段（兼容 OpenAI 原生） |
| `search.embedding.query_input_type` | `query` | **查询时**的 `input_type` 值；空串=不发该字段 |
| `search.embedding.extra_body` | `{"truncate":"NONE"}` | 透传的 provider 特有请求体字段（JSON）；空对象=不附加 |
| `search.embedding.weights` | `{"name":0.40,"tags":0.20,"description":0.40}` | 三字段权重，查询时动态读取，调整即时生效 |
| `search.embedding.alpha` | `0.4` | 词法/语义融合比 |
| `search.embedding.batch_size` | `32` | 单次 embedding 请求的 input 条数 |
| `search.embedding.concurrency` | `1` | 队列消费并发数（同时处理的 asset 数）；默认 1 以规避接口限频 |
| `search.embedding.min_interval_ms` | `0` | 两次 embedding 请求间的最小间隔（毫秒）；RPM 限频时设置，如 60000/rpm |
| `search.embedding.max_attempts` | `3` | 单条失败最大重试次数，超过则置 failed |
| `search.embedding.backoff_base_ms` | `5000` | 失败重试指数退避基数（next_attempt_at = now + base × 2^attempts） |

**提供商预设语义**：
- `nvidia`：发送 `input_type`（passage/query）+ `encoding_format:"float"` + `truncate`（来自 extra_body）。基地址/模型默认填 NVIDIA 值。
- `openai`：不发送 `input_type`/`truncate`（这两个字段对 OpenAI 原生模型无意义）；`encoding_format:"float"` 保留。基地址默认 `https://api.openai.com/v1`、模型 `text-embedding-3-small`、dim `1536`。
- `custom`：完全由 admin 配置，`input_type` 是否发送取决于 passage/query_input_type 是否非空。

切换 provider 预设时自动带出对应默认值（base_url/model/dim/input_type/extra_body），admin 可再覆盖。

### 4.2 API 调用

- 端点：`${base_url}/embeddings`（POST，`Authorization: Bearer <key>`）。
- **非对称 embedding**：同一模型在索引与查询时用不同 `input_type`。
  - 索引（写 asset_vec）：`embed(texts, "passage")` → 请求体含 `input_type: <passage_input_type>`。
  - 查询（搜索时）：`embed(query, "query")` → 请求体含 `input_type: <query_input_type>`。
  - 当对应 input_type 配置为空串时不发送该字段（兼容 OpenAI 原生）。
- 请求体（NVIDIA nv-embed-v1 示例）：
  ```json
  {
    "input": ["文本..."],
    "model": "nvidia/nv-embed-v1",
    "input_type": "passage",
    "encoding_format": "float",
    "truncate": "NONE"
  }
  ```
- 响应解析：标准 OpenAI 格式，取 `data[].embedding`（按 `index` 排序对齐 input 顺序）；`usage` 记账可选。
- 封装：新增 `packages/server/src/lib/embedding.ts`，导出 `embed(texts: string[], mode: "passage"|"query"): Promise<number[][]>`，内部按配置拼装请求体（含 input_type / extra_body / encoding_format）、处理超时与重试。`texts` 为某 asset 的各字段文本（最多 3 条：name/tags/description），单次请求批量。
- 与现有 `ai.ts` 的 chat completions 独立（不同端点、不同凭据——AI 基础信息生成仍是每用户配置，embedding 是服务级配置）。
- 超时 30s，失败重试 2 次（指数退避），批内单项失败不影响整批。
- 批量：按 `batch_size` 切片，单次请求 `input` 为多条文本。

### 4.3 模型/维度切换

维度 `D` 写死在 `asset_vec` 建表语句。model 变化（含维度变或同维不同模型）时进入**重建模式**（§5.6 模式 B）：检测 `embed_model`/`embed_dim` 与配置不一致 → 强制清空 `asset_vec` + 全量 manual 入队，期间搜索词法降级。设置页 `POST /api/settings/search/rebuild` 触发，二次确认。model 不变时走刷新模式（§5.6 模式 A），无需重建表。

## 5. 索引队列与生命周期

### 5.1 设计原则

- **持久化队列**：索引任务持久化在 `asset_embeddings` 表（status 驱动），进程重启不丢失，无需内存队列。
- **FTS5 与 vec 解耦**（ADR-0002、决策 Q1）：FTS5 在**入队时同步写入**（本地即时），vec 留 worker 异步。不变量：**每条非软删、非 adopted 能力永远有 FTS5 行**。`status='ready'` 只指 vec 侧完成；未 ready 的能力仍可经 FTS5 词法召回，融合时语义分记 0。
- **慢消费**：默认并发 1 + 可配 `min_interval_ms`，规避 embedding 接口限频；429 走指数退避重试。
- **去重**：`asset_embeddings` 以 `asset_id` 为主键，**每个能力至多一条队列项**；已在排队中（pending）的不重复入队。
- **读最新态执行 + 写回后复检**（决策 Q6）：worker 处理时读 asset **当前**内容（非入队快照），多次快速编辑只产生一条队列项；embed+写回后**无条件复检** content_hash，变了则重排，保证最终 embed 到最新内容。`enqueue` 对 `processing` 行 = no-op，不打断在飞 worker（靠复检兜住"编辑撞处理中"）。
- **崩溃恢复**（决策 Q6）：启动时把所有 `processing` → `pending`（复用 `migrate.ts` 里 sync_outbox "Recover orphan running rows on restart" 模式），避免崩溃后行卡死。
- **派生数据可重建**：`asset_vec` / `asset_fts` / `asset_embeddings` 均可 DROP 重建，软删时物理清理派生行。

### 5.2 队列表结构

复用 §3.1.3 的 `asset_embeddings`，补全队列字段：

```sql
CREATE TABLE IF NOT EXISTS asset_embeddings (
  asset_id        TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  status          TEXT NOT NULL,        -- 'pending' | 'processing' | 'ready' | 'failed'
  queued_at       TEXT NOT NULL,        -- 入队时间，FIFO 排序依据
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,                 -- 失败退避后最早可处理时间；NULL=立即可处理
  last_error      TEXT,                 -- 最近一次失败原因
  embed_model     TEXT,                 -- 生成时所用模型（检测模型切换）
  embed_dim       INTEGER NOT NULL,     -- 维度（检测维度切换）
  content_hash    TEXT NOT NULL,        -- name+alias+tags+手填description+frontmatter description 拼接 hash
  field_version   INTEGER NOT NULL,     -- 字段定义版本，schema 变更时强制重建
  processed_at    TEXT,                 -- 最近一次成功时间
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_emb_status_queue
  ON asset_embeddings(status, next_attempt_at, queued_at)
  WHERE status IN ('pending', 'processing');
```

- 主键 `asset_id` 天然去重——每个能力至多一行，不存在「重复排队」。
- `status` 即队列状态机：`pending`（排队中）→ `processing`（处理中）→ `ready`（已处理）/ `failed`（失败）。

### 5.3 入队逻辑（去重）

新增 `search-indexer.ts` 的 `enqueue(assetId, mode)`，`mode` ∈ `new` | `auto` | `manual`：

| 当前状态 | mode=new/auto | mode=manual（强制重排） |
|---------|---------------|----------------------|
| 无行 | INSERT pending, queued_at=now；**同步写 FTS5 行** | 同左 |
| pending | **no-op（去重）** | no-op（已在排队） |
| processing | **no-op**（不打断在飞 worker；靠 §5.5 写回后复检捕获处理期间的编辑） | 同左 |
| ready | 若 content_hash 变 → set pending, queued_at=now | set pending, queued_at=now, attempts=0 |
| failed | set pending, queued_at=now, attempts=0 | set pending, queued_at=now, attempts=0 |

- `new`：能力创建时。入队时同步写 `asset_fts` 行（FTS5 解耦于 worker，见 ADR-0002）。
- `auto`：能力编辑/导入后，**仅当 content_hash 变化**才入队（避免无意义重算）；content_hash 不变也同步刷新 FTS5（文本未变，幂等）。
- `manual`：admin 在管理界面点「重新入队」——属于**刷新模式**（同模型，见 §5.6）：忽略 content_hash 强制重排，旧向量继续服务直到被替换，无降级。

### 5.4 写入触发点

| 事件 | 触发点（代码位置） | 动作 |
|------|-------------------|------|
| 创建能力 | `assets.ts` POST `/api/assets` | `enqueue(id, 'new')`（含同步写 FTS5 行） |
| 编辑能力 | `assets.ts` PUT `/api/assets/:id` | 算新 content_hash（仅 name/alias/tags/手填description/frontmatter description 变化才变），`enqueue(id, 'auto')`（同步刷新 FTS5）；正文 body 变化不触发 |
| 市场导入 | `pipeline.ts` `diffAndUpsertAssets` | added → `enqueue(id,'new')`；updated → `enqueue(id,'auto')`（均同步写/刷新 FTS5） |
| `loom push` | `routes/push.ts` → 同 upsert 路径 | 同导入 |
| 软删/硬删 | `asset-gc.ts`、`assets.ts` DELETE | **物理删** `asset_vec`/`asset_fts`/`asset_embeddings` 对应行（派生数据，可重建；删 FTS5 行让其退出词法召回） |

### 5.5 worker 消费循环

`search-indexer.ts` 启动后台循环（复用现有 scheduler/setInterval 模式）：

1. 若 `enabled=0` 或 embedding 服务未配置 → 空转等待，不消费。
2. 启动时崩溃恢复：`UPDATE asset_embeddings SET status='pending', next_attempt_at=NULL WHERE status='processing'`。
3. 原子领取（单进程下事务即可）：取 `status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now)` 按 `queued_at ASC` 取 `concurrency` 条，置 `status='processing'`。
4. 对每个 processing asset：
   a. 读取当前 asset 的 name/alias/tags/description 文本（§2.3：手填 description 与 frontmatter description 合并），算当前 content_hash `h_cur`。
   b. 批量调 `embed([name, tags, description], 'passage')`（非空字段一次请求；空字段跳过不生成向量行）。
   c. 成功：删旧 `asset_vec` 行（`DELETE WHERE asset_id=?`）→ 插最多 3 行新向量 → set `status='ready'`, `embed_model`, `embed_dim`, `content_hash=h_cur`, `processed_at`, `attempts=0`, `next_attempt_at=NULL`。（FTS5 已在入队时写好，worker 不碰。）
   d. **写回后无条件复检**（决策 Q6）：再读一次当前 content_hash `h_now`；若 `h_now ≠ h_cur`（处理期间被编辑）→ set `status='pending'`（保留原 queued_at）重新排队，丢弃本次结果（下次重处理最新内容）。
   e. 失败（网络/429/5xx）：`attempts++`；若 < `max_attempts` → set `pending` + `next_attempt_at=now+backoff_base×2^attempts`；否则 set `failed` + `last_error`。
5. 每轮结束按 `min_interval_ms` 间隔（若 >0）等待，再进下一轮。

- **并发**：`concurrency` 控制单轮领取条数；默认 1 = 串行，最限频友好。
- **批量**：`batch_size` 控制单次 API 请求的 input 数；单 asset 的 3 字段始终同请求（保证同批次同模型同空间）。多个 asset 是否合并进一个 API 请求：当 `batch_size >= 3 × concurrency` 时可合并多 asset 字段，减少请求数；实现时按 `batch_size` 切片。

### 5.6 重建：刷新模式 vs 重建模式（决策 Q5）

保存 embedding 配置时，系统按 **model 是否变化**自动判定模式：

**模式 A「刷新」（model 不变）**：admin 点「重新入队」/「全部重新入队」，或 content_hash 变化的自动重排。
- 旧向量与新向量**同一向量空间**，仍有效 → **不 DROP**，worker 逐条替换。
- 搜索全程正常（语义+词法），**无降级**。
- `asset_vec` 表与 DDL 不动。manual 批量入队即此模式。

**模式 B「重建」（model 变化，含维度变或同维不同模型）**：不同向量空间，旧向量排名会错。
- 必须清空 `asset_vec`（维度变则 DROP+按新 D 重建表；同维不同模型则 DELETE 全部行）→ **期间搜索降级为纯词法**（靠 ADR-0002 解耦的 FTS5 兜底，不是无搜索）。
- 全量 `enqueue(all asset_ids, 'manual')`，worker 按队列慢慢消费（受 concurrency/限频约束）。
- 不做零停机切换（双表并行+原子 swap 复杂度高，收益不抵成本；词法降级可接受）。

- 检测：配置保存时比较 `embed_model` 与 `asset_embeddings.embed_model`（取最新 ready 行或配置存档）；model 变 → 强制模式 B、禁用刷新；model 不变 → 模式 A。
- 模式 B 期间设置页显示「重建中（词法降级）」+ 进度（ready 计数 / 总数）。

### 5.7 队列管理 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/settings/search/queue` | 计数汇总：`{pending, processing, ready, failed, total}` |
| GET | `/api/settings/search/queue/items?status=pending\|ready\|failed&page=&pageSize=` | 分页列表，JOIN assets 过滤 `deleted_at IS NULL AND adopted=0`；返回 asset_id/name/type/queued_at/attempts/last_error/processed_at/embed_model |
| POST | `/api/settings/search/requeue` | 手动重新入队（刷新模式，同模型）；body: `{assetIds: string[]}` 或 `{all: true}`（全部 ready 重新入队）；走 `enqueue(mode='manual')` |
| POST | `/api/settings/search/retry-failed` | 把所有 failed 置 pending 重试（等价 `requeue` all failed） |
| POST | `/api/settings/search/rebuild` | 重建模式（模型变更后）：清空 `asset_vec` + 全量 manual 入队；仅 admin，二次确认 |

所有管理 API 仅 admin 可访问（`requireAuth` + role 检查，与现有 admin 路由一致）。无 cancel 接口——取消 pending 收益不大（会让能力停留无向量态），需要时靠 requeue 即可。

## 6. 查询接口变更

### 6.1 `GET /api/assets`（保持兼容）

- 现有查询参数不变（`query`、`type`、`tags`、`source`、`visibility`、`page`、`pageSize`）。
- 当 `query` 非空且 embedding 已启用：
  - 走 §2.4 混合检索，`ORDER BY` 改为相关性分数。
  - `visibility` 走**预过滤**（见 §6.3，写入 search_visible 临时表）；`type`/`tags`/`source` 作为**后过滤**（用户主动筛选项）。
- `query` 为空时：维持 `updated_at DESC`（不影响浏览态）。
- embedding 未启用 / 降级时：维持现有 `LIKE` 逻辑。

### 6.2 可选新增

- `GET /api/search/status`：返回语义搜索是否启用、是否降级、索引计数概览（供前端展示徽标）。
- 响应头 `X-Loom-Search-Mode: hybrid|lexical`：告知前端本次检索模式（降级时为 lexical）。

### 6.3 可见性

语义检索仍须遵守现有可见性规则（匿名仅 public、admin 全见、普通用户 public+自己 private）。采用**可见性预过滤**（决策 Q3）：检索开始前按现有 conditions 算出可见 asset_id 集合，写入连接级临时表 `search_visible(asset_id)`；FTS5 与各字段 KNN 均带 `asset_id IN (SELECT asset_id FROM search_visible)` 子查询，把不可见能力挡在召回之外。`visibility` 不再作为后过滤（已在预过滤完成）；`type`/`tags`/`source` 仍为后过滤（用户主动筛选项，不涉及召回损失）。

## 7. 设置页 UI

在 `/settings` 新增「语义搜索」分区（admin 可见），分两块：**配置块** + **索引管理块**。

### 7.1 配置块

- **总开关**：启用/禁用向量存储。关闭 → worker 停止消费、写入不再入队、搜索降级为词法；队列与已建向量保留，重新开启即恢复。
- **提供商预设**下拉：`nvidia` / `openai` / `custom`；切换时自动带出对应默认值（base_url/model/dim/input_type/extra_body），admin 可覆盖。
- Embedding 服务配置：Base URL、API Key（脱敏显示，复用 env_vars 的密钥输入组件）、模型名、向量维度。
- **非对称 input_type 配置**：索引时值（passage）/ 查询时值（query）；留空表示该 provider 不使用 input_type（如 OpenAI 原生）。
- **额外请求体字段**（extra_body，JSON）：如 NVIDIA 的 `truncate`。
- **检索调参**：字段权重滑块（name/tags/description，归一化约束和为 1）、词法/语义融合比 α 滑块。
- **队列调参**：并发数（默认 1）、请求最小间隔 ms（限频时填）、最大重试次数、退避基数。
- 未配置或服务不可用时显示引导/告警文案。

### 7.2 索引管理块（队列可视化 + 控制）

**顶部状态卡片**（实时计数，轮询 `/queue`）：

```
┌──────────┬──────────┬──────────┬──────────┬──────────┐
│ 排队中   │ 处理中   │ 已处理   │ 失败     │ 总计     │
│   12     │    1     │   347    │    2     │   362    │
└──────────┴──────────┴──────────┴──────────┴──────────┘
```

- 数字颜色编码：排队中=中性、处理中=蓝、已处理=绿、失败=红（>0 高亮提醒）。
- 卡片可点击 → 跳到对应 tab 列表。

**操作栏**：
- 「全部重新入队」（刷新模式，model 不变）：所有 ready 重新入队，旧向量继续服务、无降级。
- 「重建索引」（重建模式，model 变更后启用）：清空 `asset_vec` + 全量入队，二次确认 + 提示「期间搜索降级为词法，按队列慢慢消费」。
- 「重试全部失败」：把 failed 全部置 pending。
- 「刷新」：手动刷新计数与列表。

**列表区（三个 tab）**：

| tab | 数据源 | 列 | 行操作 |
|-----|--------|-----|--------|
| 排队中 | status=pending | 能力名/类型、入队时间（相对，如「3 分钟前」）、尝试次数 | 「取消排队」（可选） |
| 已处理 | status=ready | 能力名/类型、模型、处理完成时间 | 「重新入队」 |
| 失败 | status=failed | 能力名/类型、失败原因（last_error 截断）、尝试次数 | 「重试」（重新入队） |

- 列表 JOIN assets，**过滤已删除（deleted_at IS NULL）和 adopted 能力**，确保不出现已删除项。
- 按 tab 语义排序：排队中按 `queued_at ASC`（FIFO 入队顺序，最上方=下一个将处理的）、已处理按 `processed_at DESC`、失败按 `updated_at DESC`。
- 分页（复用现有分页组件），支持按能力名搜索过滤。
- 行内「重新入队/重试」单点操作；批量勾选 + 「批量重新入队」（可选增强）。

**交互细节**：
- 处理中（processing）的项单独标灰，不可操作（避免与 worker 竞争）。
- 全部重新入队/重建/重试后，列表与计数即时刷新；轮询期间用乐观更新减少闪烁。
- 队列为空（全部 ready）时显示「所有能力已索引」空状态。

### 7.3 能力市场页联动（可选）

- 顶部搜索框旁展示「语义搜索已启用/词法模式」徽标（取 `/api/search/status` 或响应头 `X-Loom-Search-Mode`）。
- 降级时徽标变灰并 tooltip 说明原因（服务未配置/限频降级）。

## 8. 数据流（端到端）

```
[写入路径]
assets(POST/PUT) / pipeline 导入 / push
   └─→ 抽取 name+alias+tags+description（手填⊕frontmatter）文本 → 算 content_hash
       └─→ enqueue(assetId, mode)：去重（pending/processing 则 no-op）
           ├─→ 同步写/刷新 asset_fts 行（FTS5 解耦于 worker，ADR-0002）
           └─→ 写 asset_embeddings.status='pending'
               └─→ search-indexer worker（并发=concurrency，限频间隔）轮询领取 pending
                   └─→ 读当前内容 → embed([name,tags,description], "passage")
                       └─→ 删旧 vec 行 + 写 asset_vec(≤3 行) + status='ready' + content_hash
                       └─→ 写回后无条件复检 content_hash（变了重排）
                       （失败 → attempts++ 退避重试 / 超 max → failed）
（启动时崩溃恢复：processing → pending）

[查询路径]
GET /api/assets?query=...
   ├─→ 算可见 asset_id 集 → 临时表 search_visible
   ├─→ embedding.ts: embed(query, "query") → 向量 q
   ├─→ 每字段一条 KNN：asset_vec WHERE MATCH q AND k=100 AND field=? AND asset_id IN (search_visible)
   │     → 并集聚合 × 字段权重
   ├─→ asset_fts BM25 top 100（同样带可见性子查询）
   ├─→ 归一化 + α 融合
   ├─→ 叠加 type/tags/source 后过滤（可见性已预过滤）
   └─→ 分页返回（serialize 复用现有逻辑）

[管理路径]
GET  /api/settings/search/queue            → 计数汇总
GET  /api/settings/search/queue/items      → 分页列表（过滤已删除/adopted）
POST /api/settings/search/requeue          → 刷新模式重新入队（同模型）
POST /api/settings/search/retry-failed     → 批量重试失败项
POST /api/settings/search/rebuild          → 重建模式（模型变更，清空 vec + 全量入队）
```

## 9. 测试策略

遵循 `docs/testing/principles.md`，先分层再动手。

### 9.1 L1 单元测试（`pnpm test`）

- `embedding.ts`：请求体构造（input_type 随 mode 切换 passage/query、extra_body 透传）、响应解析（按 index 对齐）、批量切片、失败重试（mock fetch）。
- 字段构造：name+alias 拼接、tags 展开、description 合并去重（手填与 frontmatter 一致只用一个、不一致拼接、仅一者有值用该值、均空则该字段无向量行）；skill/agent/command 抽 frontmatter description、rule/mcp/hook 不抽。
- 融合排序：给定 FTS/vec 分数 + 权重，验证最终排序与归一化正确。
- `enqueue` 去重矩阵：覆盖 §5.3 表格每种 (当前状态, mode) 组合，断言是否产生 pending、queued_at 是否更新、attempts 是否重置。
- content_hash：仅 name/alias/tags/手填description/frontmatter description 变化才变；正文 body 变化不变（不触发重算）。

### 9.2 L3 真实链路（docker testkit）

- **不 mock 被测对象，只 mock 外部 embedding API**：用 testkit 起一个假 `/embeddings` 服务（返回确定性向量，如对文本做简单 hash → 固定维度向量），通过 `search.embedding.base_url` 指向它。假服务可注入故障（429/5xx/超时）以测重试与失败。
- 索引用例：
  - 创建能力 → 队列出现 pending → 轮询 `/queue` 至 ready → 用语义近义词搜索能命中（断言返回具体 asset id 与排序）。
  - **去重**：短时间内多次编辑同一能力 → `/queue` 中该能力只有一条 pending；ready 后向量对应最终内容（断言搜索结果为最终版本）。
  - **失败重试**：假服务先返回 429 → 队列项 attempts 递增 → 恢复 200 后转 ready；持续失败至 max_attempts → 转 failed + last_error 非空。
  - **手动重排**：对 ready 项调 `/requeue` → 回到 pending → 处理后 ready。
  - **已删除不出现**：软删一个能力 → `/queue/items` 列表与计数不再含它；搜索结果不含它。
  - **限频**：`min_interval_ms` 设正值 → 两次 embedding 请求间隔 ≥ 该值（通过假服务时间戳断言）。
  - **降级**：embedding 服务不可用/未配置 → 搜索返回词法结果，响应头 `X-Loom-Search-Mode: lexical`。
  - 匿名请求只命中 public 能力；字段权重调整后排序变化。
- 断言走可观测出口：API 响应中的 asset id 顺序、`/queue` 计数与列表、磁盘向量通过搜索结果间接验证；不直查 `asset_vec` 内部表（除非断言对象就是索引契约本身）。

### 9.3 回归

- 现有 `LIKE` 搜索用例在 embedding 未启用时仍全通过（行为不变）。
- sqlite-vec 扩展加载失败时，服务启动 + 词法搜索仍可用。

## 10. 性能与容量

- 规模预估：市场资产数百~数千量级，每 asset 3 向量 → 万级向量行。sqlite-vec KNN 在此规模亚毫秒级，无需近似索引。
- 查询开销：1 次 embedding API 调用（~100-300ms）+ 本地 KNN/BM25（<5ms）。瓶颈在 API 调用；可加短时查询向量缓存（LRU，key=query 文本）。
- 写入开销：批量 embedding，按 `batch_size` 聚合，避免逐条调用。
- 存储：1536 维 float32 ≈ 6KB/向量，万级 ≈ 60MB，对 SQLite 单文件可接受。

## 11. 风险与取舍

| 风险 | 应对 |
|------|------|
| sqlite-vec 预编译二进制在某些目标平台缺失 | 列入打包验证；缺失时降级词法，不阻断启动 |
| better-sqlite3 被编译为禁用 load_extension（罕见） | 启动时探测，失败降级 |
| embedding API 成本/延迟 | 批量化 + 仅元信息字段向量化 + 仅在字段变化时重算 + 限频间隔/并发控制 |
| 模型/维度切换需重建 | 重建模式（§5.6）：设置页二次确认 + 后台分批重建 + 进度可见 + 词法降级兜底 |
| 中文 FTS5 分词 | 用 `trigram` tokenizer，零外部依赖 |
| 字段级向量跨字段可比性 | 同一模型同空间，cosine 经归一化后加权融合，实测可接受；必要时切多表方案 |

## 12. 落地步骤（建议顺序）

1. 加载 sqlite-vec 扩展 + 建表迁移（asset_vec/asset_fts/asset_embeddings 含队列字段）+ 降级探测 → verify: 服务可启动，扩展加载日志可见，三表存在。
2. `embedding.ts`（含非对称 input_type）+ 服务级配置（app_settings + provider 预设）→ verify: 配置可读写、API 可调用（L1，mock fetch）。
3. 字段文本构造（§2.3：name+alias / tags / description 合并 frontmatter）+ `search-indexer.ts`（enqueue 去重 + worker 消费循环 + 退避重试）+ 写入钩子（create/edit/import/push/delete）→ verify: L3 索引 ready、去重/重试/已删除清理用例。
4. 队列管理 API（queue 计数/列表/requeue/retry-failed）+ 设置页索引管理 UI → verify: L3 计数与列表准确、手动重排生效。
5. 混合检索查询路径 + 融合排序 + 兼容现有过滤 + 降级 → verify: L3 语义/词法/降级用例全过。
6. 模型切换重建模式（清空 vec + 全量 manual 入队 + 词法降级）→ verify: 切模型后重建生效、期间降级、重建后语义恢复。
7. FTS5 trigram 中文分词 + 权重动态调参即时生效 → verify: 中文用例、改权重后排序即时变化。

## 13. 已确认决策

- **决策 A（混合检索）**：采用 FTS5 + sqlite-vec 双路召回 + α 融合。FTS5 用 `trigram` tokenizer 支持中文子串匹配。
- **决策 B（字段与权重）**：**三字段**向量化（name / tags / description），**正文内容不向量化**。默认权重 name 0.40 / tags 0.20 / description 0.40；description 为手填描述与文档 frontmatter description（仅 skill/agent/command）合并去重；权重存 `search.embedding.weights`，**查询时动态读取**，设置页调整即时生效、无需重建索引。仅 name/alias/tags/description 变化才触发重算。
- **决策 C（embedding 方案）**：**仅保留 OpenAI 兼容 `/embeddings` 端点方式，不内置本地推理库**（不引入 transformers.js/onnxruntime 依赖）。默认提供商 NVIDIA 免费端点 `https://integrate.api.nvidia.com/v1`、模型 `nvidia/nv-embed-v1`（4096 维）；同时兼容 OpenAI 原生格式。
  - **非对称 embedding**：nv-embed-v1 要求索引用 `input_type="passage"`、查询用 `input_type="query"`；OpenAI 原生模型不使用该字段。通过 `passage_input_type`/`query_input_type` 配置（空串=不发送）。
  - provider 预设（nvidia/openai/custom）决定默认值与特有字段（`input_type`、`truncate` 等）。
  - admin 可在设置页配置：提供商、base_url、api_key、模型、向量维度、input_type、extra_body。
  - 模型/维度切换 → 全量重建索引（§4.3）；内置兜底方案已弃用（避免 onnxruntime 包体积与 CPU 推理延迟）。
- **决策 D（缓存与高亮）**：本期不做查询向量缓存、不做结果高亮/snippet。后续视压测与产品诉求再加。
- **决策 E（索引队列）**：索引走**持久化队列**（`asset_embeddings` 以 asset_id 为主键，status 驱动），不引入额外队列表。
  - **去重**：主键保证每能力至多一条；已 pending/processing 不重复入队（processing 为 no-op，靠 worker 复检兜底）。
  - **慢消费**：并发默认 1（可配），可选 `min_interval_ms` 限频；429/失败指数退避重试，超 `max_attempts` 转 failed。
  - **总开关**：设置页可开关向量存储；关闭后 worker 停止、写入不入队、搜索降级词法，队列与已建向量保留。
  - **管理界面**：状态卡片（排队中/处理中/已处理/失败/总计）+ 三 tab 列表（排队中按入队顺序 FIFO、已处理、失败）+ 刷新/重试失败/重建；列表过滤已删除与 adopted 能力。
- **决策 F（FTS5 解耦，ADR-0002）**：FTS5 在入队时同步写，vec 留 worker 异步；`ready` 只指 vec；每条非软删/非 adopted 能力永远有 FTS5 行。导入期间词法召回不被异步 vec 拖累。
- **决策 G（vec0 schema，ADR-0001）**：用 metadata 列（`asset_id`/`field`，不带 `+`）+ `distance=cosine`；vec0 内部归一化、无需 JS 单位化；按 metadata 列直接 DELETE；KNN 支持子查询过滤。
- **决策 H（可见性预过滤）**：检索前算可见 asset_id 集写入临时表，FTS5 与各字段 KNN 均带 `asset_id IN (...)` 子查询；避免不可见向量挤占 top-k 预算。
- **决策 I（每字段一条 KNN）**：name/tags/description 各跑一条 KNN（k=100，带可见性子查询），并集后按字段权重融合；保证每字段独立曝光、加权名副其实。
- **决策 J（重建两模式）**：刷新（model 不变，不 DROP、无降级）vs 重建（model 变，清空 vec + 词法降级 + 全量入队）；系统按 model 是否变化自动判定；不做零停机切换。
- **决策 K（队列一致性）**：enqueue 对 processing=no-op；worker 写回后无条件复检 content_hash（变了重排）；启动时 processing→pending 崩溃恢复（复用 sync_outbox 模式）。
- **决策 L（description 一致定义）**：trim+折叠内部空白+大小写敏感精确相等 → 用一个，否则拼接；砍掉 cancel 接口。
