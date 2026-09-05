# Loom Docker 化测试体系 — 需求梳理

> **更新（2026-07）**：原 L2（`fastify.inject` 进程内集成，`packages/server/src/__tests__/e2e/`）已全部迁移为 L3 真实链路用例（`tests/l3-real-e2e/`）。本文下述 L2 相关章节为历史决策记录，实际以 `principles.md` 为准。

> 状态：需求阶段（未进入实现）。本文用于对齐目标、范围与关键决策，确认后再产出实施方案。
>
> 代码是事实来源。本文与 `product-functional-doc.md`、`justfile`、`packages/*/src/__tests__` 对照后得出。

---

## 1. 背景与问题诊断

### 1.1 现有测试体系（事实）

| 层 | 位置 | 驱动方式 | 隔离手段 |
|----|------|----------|----------|
| 单元 | `packages/adapter`、`packages/shared`、`packages/server/src/marketplace/__tests__` | vitest，纯函数 | 无 IO，天然隔离 |
| HTTP 集成（现称 e2e） | `packages/server/src/__tests__/e2e/*.test.ts` | vitest + `fastify.inject()`（**内存调用，不起真实端口**） | `makeApp()` 每用例新建 app + `DELETE FROM <所有表>`；marketplace 用 `installFixtureClone` mock git |
| CLI 集成 | `packages/cli/src/__tests__/*.test.ts` | vitest + 真实文件系统 | 项目目录用 `mkdtempSync(tmpdir())`；**但 lock/project/disabled 写全局 `~/.loom`**，靠 `afterEach` 手动 `removeLock/removeProject/rmSync(disabledPath)` |

### 1.2 "容易污染"的根因（具体，非泛化）

1. **CLI 测试触碰全局 `~/.loom`**
   - `capabilities.test.ts`、`scanner.test.ts` 等直接写 `~/.loom/locks/<id>.json`、`~/.loom/projects/<id>.json`、`~/.loom/disabled/<projectId>/...`。
   - 隔离完全依赖 `afterEach` 手动清理。用例中途崩溃/超时/断言失败 → 残留 lock/project/disabled → 下一用例读到脏数据。
   - `capabilities.test.ts` 注释已自认："清理隔离区残留，避免下一个用例污染"——说明该问题已实际发生过。

2. **现有"e2e"不是真实端到端**
   - `fastify.inject()` 不起真实 HTTP 端口，不起真实 WebSocket，不起真实 CLI agent 进程。
   - 因此 `test-report.md` 列的 P0 缺口（WebSocket 端到端安装、SPA UI）从未被覆盖。
   - 一旦要补"真实模拟测试"（真实 server 进程 + 真实 cli agent + 真实 WS + 真实磁盘），就会触碰真实端口与真实 `~/.loom`，污染面更大。

3. **fixture/seed 散落**
   - marketplace fixture 在 `server/src/marketplace/__tests__/fixtures/`；CLI 测试在用例内手搓 `writeLock/writeProject`；server e2e 在用例内手搓 asset/能力集。
   - 没有统一的 seed 数据集，"用例真实"无标准可依。

4. **并发执行会撞**
   - 多测试文件并发跑时，CLI 测试共用全局 `~/.loom`；若未来起真实 server，端口也会撞。
   - `just test-stable` 连跑 5 次依赖单进程内隔离，一旦上真实链路就不再稳定。

### 1.3 覆盖缺口（来自 `test-report.md`，仍有效）

| 优先级 | 缺口 |
|--------|------|
| P0 | WebSocket 端到端安装：install → agent 执行 → result 回传全链路 |
| P0 | SPA 7 个页面 UI 交互测试 |
| P1 | 并发创建、分页边界、XSS/注入、长连接重连 |
| P2 | 超大 content、Codex/ClaudeCode adapter 真实落盘 |

---

## 2. 目标与原则

### 2.1 目标

1. **Docker 镜像化**：一整套测试环境（运行时 + 数据 + fixture）打包成镜像，任何机器 `just test-docker-*` 即可复现。
2. **每个用例真实**：真实 server 进程、真实 cli agent 进程、真实 WebSocket、真实磁盘项目目录、真实 `~/.loom`（容器内）。
3. **三层用例支持**：单点测试、操作流程测试、用例流程编排测试。
4. **多场景、不为通过而写**：必须覆盖错误路径、边界、并发、冲突、一致性，而非只覆盖 happy path。
5. **justfile 统一入口**：所有测试命令收敛到 `just`，方便管理与 CI 调用。

### 2.2 原则

- **隔离优先**：容器/网络/卷隔离，禁止跨用例共享状态；隔离失败应让用例直接报错而非静默通过。
- **真实优先**：不 mock 被测对象本身（server/cli/adapter/WS 都跑真的）；只 mock 外部不可控依赖（如真实 GitHub、真实 AI 服务）。
- **失败即信号**：每个用例必须能产出"系统哪里坏了"的明确断言，而非"大概通过了"。
- **可重复**：任何环境、任何顺序跑同一命令，结果一致。
- **不为通过而写**：每条用例须能回答"它在保护什么不变量"；只测 happy path 的用例不合并。

---

## 3. 测试体系分层

保留现有低层，新增高层，形成金字塔。**不替换、不重写现有 L1/L2。**

### L1 — 单元测试（保留现状）
- 对象：纯函数（adapter 转换、schemas 校验、vendor-reader 解析、scanner 树构建）。
- 特征：无 IO、无网络、无 DB。
- 命令：`just test`（沿用）。

### L2 — 进程内集成测试（保留并轻改造）
- 对象：HTTP API 层，单进程内 server + SQLite。
- 现状：`fastify.inject()` + `DELETE FROM`。
- 改造点（仅隔离层面，不改用例语义）：DB 路径显式指向容器/临时目录，不依赖全局；为后续 Docker 化预留环境变量入口。
- 命令：`just test-e2e`（沿用）。

### L3 — 真实链路端到端（新增，Docker 化，重点）
- 对象：真实 server 进程 + 真实 cli agent 进程 + 真实 WebSocket + 真实磁盘。
- 覆盖：`login → register → install → sync → console → drift` 全链路。
- 形态：每用例一个独立容器，容器内起 server + agent，用完即毁。
- 命令：`just test-docker-e2e`。

### L4 — 用例流程编排（新增）
- 对象：多用户/多设备/多项目/多状态交互。
- 形态：编排脚本驱动多个 L3 容器或单容器内多角色。
- 命令：`just test-docker-scenario <name>`。

### L5 — UI 测试（新增，后置）
- 对象：React SPA 7 个页面交互。
- 驱动：Playwright 对容器内 server + 静态 web。
- 命令：`just test-docker-ui`。

---

## 4. Docker 化测试架构

### 4.1 镜像分层（多阶段）

| 镜像 | 作用 | 内容 |
|------|------|------|
| `loom-test-base` | 基础环境 | Node + pnpm + git + 系统依赖（better-sqlite3 编译工具链） |
| `loom-test-builder` | 编译中间层 | 能力集 源码 + `just build` 产物（server/cli/web dist） |
| `loom-test-runtime` | 测试运行时 | base + 编译产物 + vitest + 测试框架 + fixture 仓库 + seed 数据 + 编排器 |

构建产物在镜像内固化，测试时不再依赖宿主机源码状态，保证可重复。

### 4.2 容器拓扑

- **单用例单容器**：每个 L3/L4 用例起独立容器，用完即毁（`--rm`）。
- 容器内：
  - server 进程（监听容器内回环端口）
  - cli agent 进程（连接容器内 server）
  - 临时项目目录（`/tmp/loom-project-*`）
  - 隔离的 `HOME=/tmp/loom-home` → `~/.loom` 全在容器内
- 网络：容器内 loopback，不暴露端口到宿主；并发用例互不干扰。
- 卷：用 tmpfs 挂 `/tmp` 与 `/tmp/loom-home`，用完即弃，零残留。

### 4.3 数据管理

| 类型 | 位置 | 说明 |
|------|------|------|
| Fixture 仓库 | 镜像内 `/opt/loom/fixtures/repos/*` | 确定性本地 git 仓库（marketplace 测试用），不联网 |
| Seed 数据 | 镜像内 `/opt/loom/fixtures/seed/*.json` | 用户/asset/能力集 种子，按场景分组 |
| 项目模板 | 镜像内 `/opt/loom/fixtures/projects/*` | 预制 `.cursor/`、`.codebuddy/` 等目录结构 |
| 期望落盘 | 镜像内 `/opt/loom/fixtures/expected/*` | 安装后预期的磁盘快照，用于断言 |

### 4.4 隔离策略（对应根因）

| 根因 | 隔离手段 |
|------|----------|
| CLI 测试写全局 `~/.loom` | 容器内 `HOME=/tmp/loom-home`，`~/.loom` 随容器销毁 |
| 真实链路触碰端口/磁盘 | 容器独立 network namespace + tmpfs，无宿主暴露 |
| fixture 散落 | 统一打包进镜像，版本化 |
| 并发撞全局路径/端口 | 容器级隔离，可并发跑多个容器 |

---

## 5. 用例分类与场景矩阵

### 5.1 用例分类

| 类型 | 粒度 | 示例 |
|------|------|------|
| 单点 | 单个 API / 单命令 / 单 adapter 行为 | `POST /api/assets` 校验失败返回 400；`loom login` 错误 token 返回 401 |
| 操作流程 | 一个角色完成一个完整任务 | 用户登录 → 创建 asset → 组 能力集 → CLI 注册项目 → 安装 → 控制台看到镜像 |
| 流程编排 | 多角色/多项目/多状态 | 见 §6 |

### 5.2 场景维度（**必须覆盖，不为通过而写**）

每个维度的用例须独立存在，禁止用 happy path 用例"顺便覆盖"。

| 维度 | 必测场景（示例） |
|------|------------------|
| Happy path | 六类 asset 创建、能力集 组合、安装、同步 |
| 错误路径 | 认证失败、权限拒绝、校验失败、资源不存在、落盘身份冲突 409、marketplace 同名 409 |
| 边界 | 空 content、超长 content（>1MB）、page=0、超大 pageSize、空结果集、同名并发创建 |
| 一致性 | drift 自动清 lock、orphan 清理、lock 残留、MCP 聚合冲突、legacy lock 拒绝 toggle |
| 同步 | auto 在线同步、locked 不同步、离线期间变更上线补偿、agent 重连重推、成员移除不补偿（当前保守行为） |
| 生命周期 | 安装→更新→卸载→重装、token 重生成旧 token 失效、session 过期、能力 toggle on/off 来回搬家 |
| 并发 | 并发安装同一 能力集、并发 push 同名、并发创建同名 能力集 |
| 安全 | 路径穿越写入、symlink 逃逸（scanner 已有，需端到端复现）、XSS content 存储/读取、未授权访问私有 asset |

### 5.3 "不为通过而写"的硬约束

- 每条用例 PR 须注明保护的不变量（一行注释）。
- 禁止 `try/catch` 吞错后 `expect(true).toBe(true)`。
- 禁止为绕过 flake 加 `expect.assertions(0)` 或删除断言。
- 负向用例（期望失败）必须断言具体错误码/错误信息，不能只断言"非 200"。
- 并发用例必须断言最终一致不变量，不能只断言"无异常"。

---

## 6. 用例流程编排（L4）

### 6.1 编排模型

- **角色**：用户 A/B、设备 A/B、项目 A/B。
- **步骤**：有序操作 + 中间状态断言 + 最终不变量断言。
- **状态机**：在线/离线、auto/locked、installed/empty、token 有效/失效。

### 6.2 编排用例示例（须实现）

1. **跨用户 auto 同步编排**
   - 用户 A 创建 public 能力集（含 2 asset）→ 用户 B CLI 注册项目并安装 → A 更新成员（+1 asset）→ B 项目自动同步落盘 → 断言 B 磁盘出现第 3 个文件。

2. **离线补偿编排**
   - B 安装 能力集（auto）→ B agent 离线 → A 修改 asset 内容 → A 移除一个成员 → B 上线 → 断言：内容更新已补偿，成员移除**当前不补偿**（与产品文档一致）。

3. **token 生命周期编排**
   - A 获取 token → A 的 agent 在线 → A 重生成 token → 断言旧 token agent 断连 → A 用新 token 重连 → 项目状态恢复 online。

4. **drift 自愈编排**
   - 安装 能力集 → 手动删除 lock 中全部文件 → 触发 scan → 断言 lock 自动清空 + server current_capability_set 置空。

5. **聚合冲突编排**
   - 两个 MCP asset 同名 → 安装到同一 claudecode → 断言 `.mcp.json` 聚合后只剩一个 server（按产品定义的覆盖语义）。

---

## 7. justfile 命令规划

新增命令分组（命名前缀 `test-docker-`），与现有 `test*` 并存。

```just
# --- Docker 测试基础设施 ---
test-docker-build      # 构建测试镜像 (base → builder → runtime)
test-docker-shell      # 进入测试容器交互 (调试用)
test-docker-clean      # 清理测试镜像与卷

# --- L3 真实链路端到端 ---
test-docker-e2e        # 跑全部 L3 用例 (每用例独立容器)
test-docker-e2e-file PATTERN  # 跑指定 L3 用例

# --- L4 流程编排 ---
test-docker-scenario NAME     # 跑指定编排用例
test-docker-scenarios         # 跑全部编排用例

# --- L5 UI (后置) ---
test-docker-ui         # Playwright UI 测试

# --- 汇总 ---
test-docker-all        # L3 + L4 (+L5 if ready)
test-docker-stable     # 连跑 N 次确认无 flake (Docker 版 of test-stable)
```

现有命令保持不变：`test`、`test-e2e`、`test-marketplace`、`test-file`、`test-stable`、`test-watch`。

---

## 8. 范围与边界

### 做
- L3/L4/L5 用 Docker 镜像化。
- 统一 fixture/seed/expected 数据集。
- justfile 命令收敛。
- 覆盖 §5.2 全部场景维度。

### 不做（明确排除）
- 不替换、不重写现有 L1 单元与 L2 进程内集成测试。
- 不引入 K8s / docker swarm 等编排编排平台；单机 docker 即可。
- 不测真实 GitHub 网络（用本地 fixture git 仓库替代）。
- 不测真实 AI 生成接口（mock OpenAI 兼容服务）。
- 不做性能/压测基准（本期目标是功能正确性与稳定性，性能另立）。
- 不做 CI 平台特定集成（CI 直接调 `just test-docker-all` 即可）。

---

## 9. 落地分期（建议）

| 期 | 内容 | 验收 |
|----|------|------|
| Phase 1 | Docker 基础设施 + L3 happy path（一条全链路用例） | `just test-docker-build && just test-docker-e2e` 在干净机器通过 |
| Phase 2 | L3 场景矩阵铺开（§5.2 错误/边界/一致性/同步/生命周期/并发/安全） | 每维度至少 3 条用例，覆盖 test-report P0/P1 缺口 |
| Phase 3 | L4 流程编排（§6 全部编排用例） | 5 条编排用例全绿 |
| Phase 4 | L5 UI（Playwright） | 7 个页面核心交互覆盖 |

---

## 10. 决策点（已确认）

| # | 决策点 | 最终选择 | 说明 |
|---|--------|----------|------|
| D1 | L3 用例容器粒度 | **混合** | 运行用例时自行决定单容器或多容器；同一套用例支持两种运行模式，由运行命令参数选择 |
| D2 | 编排器实现 | **成熟能力优先** | 容器编排用 docker compose；测试步骤用 vitest TS；不引入额外重型框架 |
| D3 | UI 测试驱动 | **Playwright** | 对 SPA 友好，官方维护 |
| D4 | fixture git 仓库 | **镜像内置确定性 fixture**（按推荐） | 不联网，可重复 |
| D5 | L2 是否迁移容器 | **迁移** | L2 进程内集成测试也跑在容器内 |
| D6 | 测试镜像 base | **node:20-alpine + 编译工具链**（按推荐） | 体积小，builder 阶段处理原生模块 |
| D7 | 编排用例描述形式 | **TypeScript**（按推荐） | 类型安全，与 monorepo 一致 |
| D8 | Codex/ClaudeCode adapter 真实落盘 | **本期必须覆盖** | 补 P2 缺口 |

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| better-sqlite3 原生模块在镜像内需重编译 | builder 阶段编译，runtime 阶段只拷产物；锁定 alpine 兼容版本 |
| 单用例单容器启动慢 | 镜像精简 + base 层缓存 + 并行起容器 |
| 编排用例状态多、易 flake | 显式等待 + 状态轮询 + 最终不变量断言，禁用 sleep 硬等 |
| fixture 与产品演进脱节 | fixture 版本化，CI 校验 fixture 与当前 schema 一致 |

---

决策点已确认（见 §10）。下一步：实施方案见 `docs/testing/design.md`。
