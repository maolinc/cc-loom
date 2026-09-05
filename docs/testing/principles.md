# Loom Docker 化测试体系 — 原理文档

> 本文描述测试体系的设计原理与核心机制。代码是事实来源；若本文与源码冲突，以源码为准。
>
> 相关文档：`docs/testing/requirements.md`（需求）、`docs/testing/design.md`（实施方案）。

---

## 1. 核心问题：为什么需要这套体系

原有测试的污染根因在三处：

| 根因 | 现象 | 后果 |
|------|------|------|
| CLI 测试写全局 `~/.loom/{locks,projects,disabled}` | 靠 `afterEach` 手动清理 | 用例崩溃 = 残留 = 下一用例脏数据 |
| 旧 "e2e" 用 `fastify.inject()` 内存调用 | 不起真实端口 / WS / agent 进程 | 从未覆盖 install → agent → WS → 落盘 真实链路 |
| fixture/seed 散落各处 | 每个用例手搓数据 | "用例真实"无标准 |

> 旧 L2（`fastify.inject` 进程内集成）已于 2026-07 全部迁移为 L3 真实链路用例
> （`tests/l3-real-e2e/`），`packages/server/src/__tests__/e2e/` 已删除。原 L2 层
> 不再独立存在。

---

## 2. 隔离原理：容器级销毁替代手动清理

**核心思想**：不靠"用完清理"，靠"用完销毁"。

```
┌─ docker run --rm ──────────────────────────────────┐
│                                                    │
│  ENV HOME=/tmp/loom-home          ← 容器内 home   │
│  ENV LOOM_DATA_DIR=/tmp/.../.loom ← server DB    │
│  ENV LOOM_HOME=/tmp/.../.loom     ← CLI 数据     │
│  ENV PLAYWRIGHT_BROWSERS_PATH=...   ← 浏览器       │
│                                                    │
│  ┌─ server 进程 ──┐    ┌─ cli agent 进程 ──┐       │
│  │ Fastify + WS   │◄──│ WebSocket 长连接  │       │
│  │ SQLite (tmp)   │   │ ~/.loom/locks/   │       │
│  └────────────────┘    └───────────────────┘       │
│                                                    │
│  ┌─ vitest / playwright ──────────────────┐        │
│  │ 测试代码：启动 server → 调 API → 断言   │        │
│  └────────────────────────────────────────┘        │
│                                                    │
└──────────── docker rm (容器销毁，一切归零) ─────────┘
```

**关键机制**：

| 隔离层 | 手段 | 效果 |
|--------|------|------|
| 文件系统 | `HOME=/tmp/loom-home`，容器销毁即清 | `~/.loom` 零残留 |
| 数据库 | `LOOM_DATA_DIR` 指向容器内 tmp | SQLite 随容器消失 |
| 网络 | 容器内 `127.0.0.1` + 随机端口 | 并发容器不冲突 |
| 进程 | 容器独立 PID namespace | agent daemon 不逃逸 |
| 浏览器 | `PLAYWRIGHT_BROWSERS_PATH` 固定路径 | 不依赖 HOME |

**对比原有方式**：
- 原有：`afterEach(() => removeLock(id))` → 崩溃 = 残留 = 污染
- 现在：容器 `--rm` → 无论怎么崩溃，容器销毁 = 一切归零

---

## 3. 分层原理：金字塔模型

```
           ┌───────────┐
           │  L5  UI   │  Playwright 驱动 chromium，测 SPA 交互
           │  5 用例   │  原理: 真实浏览器 → 真实 DOM → 真实用户行为
           ├───────────┤
           │  L4  编排  │  多用户/多设备/多项目状态机
           │  3 用例   │  原理: 多角色并发 + 状态流转 + 最终一致断言
           ├───────────┤
           │  L3  链路  │  真实 server + agent + WS + 磁盘（含原 L2 的 HTTP API 用例）
           │ many 用例 │  原理: 不 mock 被测对象，只 mock 外部依赖
           ├───────────┤
           │  L1  单元  │  纯函数 / adapter 进程内，无 IO
           │ (原有)   │  原理: 输入 → 输出，无副作用
           └───────────┘
```

**分层原则**：
- 越底层越快、越稳定、覆盖越细
- 越顶层越慢、越真实、覆盖越广
- **L1 单元测试**走 `pnpm test` 本地跑；**L3/L4/L5 非单元测试**一律走 docker runner

---

## 4. L3 真实链路原理

L3 是整个体系的核心——它测的是**真实的系统行为**，不是 mock。

**"真实"的含义**：

```
测试代码 (vitest)
    │
    ├─ 1. startServer()
    │      spawn("node", [server/dist/index.js])  ← 真实 server 进程
    │      等待 HTTP /api/auth/me 返回 401         ← HTTP 轮询判断就绪
    │
    ├─ 2. api.login("alice@example.com")
    │      fetch(POST /api/auth/login)             ← 真实 HTTP 请求
    │      自动创建用户，返回 session cookie         ← 真实 DB 写入
    │
    ├─ 3. api.createAsset(skill)
    │      fetch(POST /api/assets)                 ← 真实 Zod 校验
    │      写入 assets + asset_files 表            ← 真实 SQLite
    │
    ├─ 4. startAgent(endpoint, token, projectRoot)
    │      runCli(["login", ...])                   ← 真实 CLI 命令
    │      runCli(["start", "--force"])             ← 真实 daemon 进程
    │      等待 config.json 出现 deviceId           ← 异步设备注册
    │      runCli(["register"])                     ← 真实项目注册
    │      轮询 GET /api/devices 直到 online        ← 真实 WebSocket 连接确认
    │
    ├─ 5. api.installExecute(plan)
    │      POST /api/install/execute                ← server 构建 Manifest
    │      → adapter 生成 DiffEntry[]               ← 真实格式转换
    │      → WebSocket 推送给 agent                 ← 真实 WS 通信
    │      → agent 写磁盘 + 写 lock                 ← 真实文件 IO
    │      → agent 回传 InstallResult               ← 真实结果回传
    │
    └─ 6. expectFileExists(root, ".cursor/skills/scout/SKILL.md")
           expectLock(projectId, { capabilitySetId, policy })
                                              ← 断言真实磁盘 + 真实 lock 文件
```

**只 Mock 什么**：
- marketplace 测试的 git clone → 用本地 fixture 仓库（不联网）
- AI 生成接口 → 不测（外部依赖）

**不 Mock 什么**（全部跑真的）：
- server 进程、CLI agent 进程、WebSocket、SQLite、文件系统、adapter 转换

---

## 5. L4 编排原理

L3 测的是"单角色单流程"，L4 测的是"多角色多状态"。

```
跨用户同步编排:

  用户 A (alice)                    用户 B (bob)
      │                                 │
      │ 创建 skill-a + skill-b          │
      │ 创建 能力集 (含 skill-a)     │
      │                                 │
      │                                 │ 注册项目 + 启动 agent
      │                                 │ 安装 能力集 (auto)
      │                                 │ ←磁盘: skill-a ✓, skill-b ✗
      │                                 │
      │ 更新 能力集 (+skill-b)       │
      │                                 │ ← auto 同步触发
      │                                 │ ←磁盘: skill-a ✓, skill-b ✓
      │                                 │
      └──────── 最终不变量 ──────────────┘
                B 磁盘有 2 个 skill 文件
```

**编排的核心**：
- 多个 `ApiClient` 实例（每个用户一个 session）
- 多个 `AgentHandle`（每个设备一个 agent 进程）
- 步骤间有**中间断言**（验证中间态正确）
- 最终有**不变量断言**（验证系统一致性）

---

## 6. L5 UI 测试原理

```
Playwright config (webServer 自动管理 server 生命周期)
    │
    ├─ webServer.command = "node server/dist/index.js"
    │   Playwright 启动 server，等端口 47474 就绪
    │
    ├─ chromium (headless)
    │   page.goto("http://127.0.0.1:47474/login")
    │   page.fill('input[type=email]', '...')
    │   page.click('button[type=submit]')
    │   page.waitForURL("/")
    │   expect(body).toContainText("能力市场")
    │
    └─ webServer 自动停止 (测试结束)
```

**原理**：Playwright 的 `webServer` 配置自动管理 server 进程的生命周期——启动、等就绪、测完停止。浏览器通过真实 HTTP 访问 SPA，操作真实 DOM。

---

## 7. Docker 镜像原理

```
Dockerfile.test-base (node:22-slim + 工具链 + Playwright 依赖)
    │
    └─ Dockerfile.test-runtime (分层缓存)
         │
         ├─ Layer 1: COPY package.json + lockfile
         │            → pnpm install              ← 缓存层 (改用例不重跑)
         │
         ├─ Layer 1.5: playwright install chromium ← 缓存层
         │
         ├─ Layer 2: COPY packages/ + tests/
         │            → pnpm -r build             ← 源码变了才重跑
         │
         └─ Layer 3: ENV (HOME, LOOM_DATA_DIR, ...)
                     ENTRYPOINT runner.js
```

**分层缓存原理**：
- Docker 按层缓存，上层变了才重跑下层
- `pnpm install` 只依赖 `package.json` + `lockfile` → 改用例不改依赖 → 缓存命中
- `pnpm build` 依赖源码 → 改用例会重跑（~30s，可接受）
- **dev 模式**：`docker run -v tests/:/opt/loom/tests` 挂载宿主机目录 → 0 重建

---

## 8. "不为通过而写"原理

每条用例必须回答："它在保护什么不变量"。

| 用例类型 | 示例 | 不变量 |
|----------|------|--------|
| 正向 | happy-path: 安装后磁盘文件 + lock 一致 | `expectFileSet(root, [".cursor/..."])` |
| 负向 | error-path: 错误密码 → 401 + "密码" | `expect(status).toBe(401)` + `expect(error).toContain("密码")` |
| 边界 | boundary: >1MB content 能创建+安装 | `expect(written.length).toBe(big.length)` |
| 并发 | concurrency: 并发创建同名 能力集 | 1 fulfilled + 1 rejected(409) |
| 一致性 | drift: 删全部文件 → agent 重连 → lock 自动清 | `expectNoLock(projectId)` |

**禁止的做法**：
- `try/catch` 吞错后 `expect(true).toBe(true)`
- 只断言"非 200"而不断言具体状态码
- 用 `sleep(5000)` 硬等代替状态轮询
- 只测 happy path 不测失败路径

---

## 9. runner 调度原理

```
node runner.js --all --mode single
    │
    ├─ --layer l3  → runVitest("tests/l3-real-e2e")
    │                 用 testkit 的 vitest.config.ts (单线程, 60s 超时)
    │
    ├─ --layer l4  → runVitest("tests/l4-scenarios")
    │
    └─ --layer l5  → runPlaywright()
                      用 Playwright CLI (非 vitest)
                      chromium headless
```

**关键设计**：
- L1 单元测试不在 runner 范围 — 走 `pnpm test` 本地跑
- L3/L4 用 testkit 的 vitest（`singleFork: true` 串行避免端口冲突）
- L5 用 Playwright（完全不同的测试框架，有自己的 webServer 管理）
- `--mode single`（单容器多进程）/ `--mode multi`（docker compose 多容器）运行时选择

---

## 10. 数据流总结

```
用户写用例 (tests/l3-real-e2e/xxx.test.ts)
    │
    ├─ 本地开发: just test-docker-e2e-dev
    │             docker run -v tests/:/opt/loom/tests (卷挂载, 0 重建)
    │
    └─ CI/正式: just test-docker-build && just test-docker-e2e
                 docker build (分层缓存, install 层命中)
                 docker run --rm (容器内跑, 销毁即清)
```

---

## 11. 测试体系总览

| 层 | 文件数 | 用例数 | 场景覆盖 |
|----|--------|--------|----------|
| L1 | 6+ | — | 单元：adapter 路径/install-key/merge/mcp、reconcile-plan、cli scanner 等（`pnpm test`） |
| L3 | 28 | ~146 | 真实链路：auth/settings/capability-sets/marketplaces/push/full-flow/edit-protection/env-vars/install-plan/auto-sync/retention/outbox/sync-outbox + happy/drift/lifecycle/security/conflict/boundary/token |
| L4 | 3 | 3 | 流程编排：跨用户同步 / 离线补偿 / 多项目多工具 |
| L5 | 2 | 5 | Playwright UI：登录 / 导航 |

## 12. justfile 命令速查

```bash
just test                       # 本地跑单元测试 (L1)
just test-docker-build          # 构建镜像
just test-docker-all            # 跑全部 L3+L4+L5
just test-docker-e2e            # 只跑 L3
just test-docker-e2e-dev        # 改用例即跑（卷挂载，0 重建）
just test-docker-e2e-file happy # 跑指定用例
just test-docker-scenarios      # 跑 L4 编排
just test-docker-ui             # 跑 L5 Playwright
just test-docker-stable         # 连跑 5 次验证无 flake
just test-docker-clean          # 清理镜像
```
