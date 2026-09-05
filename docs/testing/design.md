# Loom Docker 化测试体系 — 实施方案

> **更新（2026-07）**：原 L2（`fastify.inject` 进程内集成）已全部迁移为 L3 真实链路用例，`packages/server/src/__tests__/e2e/` 已删除，runner `--layer l2` 已移除。本文下述 L2 相关内容为历史设计记录，实际以 `principles.md` 为准。

> 依据：`docs/testing/requirements.md`（决策点已确认）。
> 代码事实来源：`packages/server/src/db/index.ts`（`LOOM_DATA_DIR` 已支持）、`packages/cli/src/lib/paths.ts`（`homedir()` 无环境变量入口）、`packages/shared/src/constants.ts`（端口 47474）。

---

## 1. 架构总览

```
宿主机 (just test-docker-*)
  │
  ├─ docker build ─► loom-test-runtime 镜像
  │     ├─ /opt/loom/dist          (server/cli/web 编译产物)
  │     ├─ /opt/loom/fixtures      (确定性 fixture: repos/seed/projects/expected)
  │     └─ /opt/loom/testkit       (测试框架: L3 runner / L4 orchestrator / L5 playwright)
  │
  └─ docker run --rm ─► 单用例容器 (L3) / compose 多容器 (L4) / playwright 容器 (L5)
        ├─ HOME=/tmp/loom-home     (~/.loom 隔离，随容器销毁)
        ├─ LOOM_DATA_DIR=/tmp/loom-home/.loom  (server DB 隔离)
        ├─ server 进程 (监听容器内 47474)
        ├─ cli agent 进程 (连容器内 server)
        └─ vitest 跑测试代码 (断言)
```

**隔离三件套**（容器内，零残留）：
- `HOME=/tmp/loom-home` → CLI 的 `~/.loom` 全在容器内
- `LOOM_DATA_DIR=/tmp/loom-home/.loom` → server 的 `loom.db` 在容器内
- tmpfs 挂 `/tmp` → 项目目录、DB、lock 用完即弃

---

## 2. 必要的代码改造（最小侵入）

### 2.1 CLI paths.ts — 加 `LOOM_HOME` 环境变量入口

`packages/cli/src/lib/paths.ts:9` 当前：
```ts
export const LOOM_DIR = join(homedir(), ".loom");
```

改为：
```ts
export const LOOM_DIR = process.env.LOOM_HOME
  ? process.env.LOOM_HOME
  : join(homedir(), ".loom");
```

理由：
- 与 server `LOOM_DATA_DIR` 风格一致。
- 测试可显式指定 `LOOM_HOME=/tmp/loom-home/.loom`，不依赖 `homedir()`。
- 生产无影响（不设环境变量时行为不变）。

**注意**：CLI 的 `LOOM_HOME` 指向 `.loom` 目录本身（与 `~/.loom` 等价），server 的 `LOOM_DATA_DIR` 也指向 `.loom` 目录。容器内统一设：
```
HOME=/tmp/loom-home
LOOM_DATA_DIR=/tmp/loom-home/.loom
LOOM_HOME=/tmp/loom-home/.loom
```

### 2.2 L2 测试 helpers — 容器内复用

`packages/server/src/__tests__/e2e/helpers.ts` 的 `makeApp()` 已依赖 `LOOM_DATA_DIR`（通过 db/index.ts）。容器内设好环境变量即可，**无需改 helpers**。

### 2.3 不改的部分
- server `index.ts`：`buildApp()` / `start()` 已支持 `PORT`/`HOST` 环境变量。
- 现有 L1 单元、L2 集成测试用例语义不变，只是运行环境迁入容器。

---

## 3. 目录结构

```
loom/
├── docker/
│   ├── Dockerfile.test-base        # 基础环境 (node:20-alpine + 工具链)
│   ├── Dockerfile.test-runtime     # runtime: base + 编译产物 + fixture + testkit
│   └── docker-compose.scenario.yml # L4 多容器编排模板
├── packages/
│   └── testkit/                    # @maolinc/cc-loom-testkit — 测试框架 (新增包)
│       ├── package.json
│       ├── src/
│       │   ├── env.ts              # 容器内环境变量约定
│       │   ├── server-runner.ts    # 启停真实 server 进程
│       │   ├── agent-runner.ts     # 启停真实 cli agent 进程
│       │   ├── project-sandbox.ts  # 临时项目目录 + 模板
│       │   ├── api-client.ts       # HTTP/WS 客户端 (复用 @maolinc/cc-loom-shared 类型)
│       │   ├── assertions.ts       # 磁盘快照 / lock / DB 断言
│       │   ├── fixtures.ts         # fixture 加载器
│       │   └── orchestrator.ts     # L4 多角色状态机编排
│       └── tsconfig.json
├── tests/                          # 跨包测试用例 (新增, 不属于任何 package)
│   ├── l3-real-e2e/                # L3 真实链路
│   │   ├── happy-path.test.ts
│   │   ├── install-flow.test.ts
│   │   ├── sync-auto.test.ts
│   │   ├── drift-self-heal.test.ts
│   │   ├── token-lifecycle.test.ts
│   │   ├── adapter-codex-claudecode.test.ts   # D8: 必须覆盖
│   │   ├── conflict-identity.test.ts
│   │   ├── concurrency.test.ts
│   │   ├── security-path-traversal.test.ts
│   │   └── ...
│   ├── l4-scenarios/               # L4 流程编排
│   │   ├── cross-user-sync.test.ts
│   │   ├── offline-compensate.test.ts
│   │   ├── token-reconnect.test.ts
│   │   ├── drift-clear.test.ts
│   │   └── mcp-aggregate-conflict.test.ts
│   ├── l5-ui/                      # L5 Playwright
│   │   ├── login.spec.ts
│   │   ├── asset-crud.spec.ts
│   │   ├── capability-set-composer.spec.ts
│   │   ├── console.spec.ts
│   │   └── ...
│   └── fixtures/                   # 确定性测试数据 (构建进镜像)
│       ├── repos/                  # 本地 git 仓库 (marketplace 测试)
│       │   ├── generic-skills/
│       │   ├── cc-plugin/
│       │   └── empty-repo/
│       ├── seed/                   # JSON seed (用户/asset/能力集)
│       │   ├── users.json
│       │   ├── assets-six-types.json
│       │   └── capability-sets.json
│       ├── projects/               # 预制项目模板 (.cursor/ 等)
│       │   ├── empty/
│       │   ├── cursor-with-rules/
│       │   └── claudecode-with-mcp/
│       └── expected/               # 安装后预期磁盘快照
│           ├── install-cursor-skill/
│           └── install-claudecode-mcp/
└── justfile                        # 新增 test-docker-* 命令
```

---

## 4. 镜像设计

### 4.1 Dockerfile.test-base

```dockerfile
FROM node:20-alpine

# better-sqlite3 编译需要
RUN apk add --no-cache python3 make g++ git

WORKDIR /workspace
```

### 4.2 Dockerfile.test-runtime（多阶段）

```dockerfile
# ---- builder ----
FROM loom-test-base:latest AS builder
WORKDIR /workspace
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ ./packages/
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm -r build

# ---- runtime ----
FROM loom-test-base:latest AS runtime
WORKDIR /opt/loom

# 编译产物 (不带走源码与 node_modules 的 dev 依赖)
COPY --from=builder /workspace/packages/server/dist  ./dist/server
COPY --from=builder /workspace/packages/cli/dist     ./dist/cli
COPY --from=builder /workspace/packages/web/dist     ./dist/web
COPY --from=builder /workspace/packages/adapter/dist ./dist/adapter
COPY --from=builder /workspace/packages/shared/dist  ./dist/shared

# 运行时依赖 (仅 production deps)
COPY --from=builder /workspace/packages/server/node_modules ./node_modules/server
COPY --from=builder /workspace/packages/cli/node_modules    ./node_modules/cli

# 测试框架 + 用例 + fixture
COPY packages/testkit/   ./testkit
COPY tests/              ./tests
COPY packages/server/package.json packages/cli/package.json \
     packages/shared/package.json packages/adapter/package.json ./package-meta/

# 测试运行依赖
RUN cd testkit && corepack enable && pnpm install --frozen-lockfile --prod
RUN npx playwright install --with-deps chromium

ENV HOME=/tmp/loom-home
ENV LOOM_DATA_DIR=/tmp/loom-home/.loom
ENV LOOM_HOME=/tmp/loom-home/.loom
ENV LOOM_SERVER_BIN=/opt/loom/dist/server/index.js
ENV LOOM_CLI_BIN=/opt/loom/dist/cli/index.js

ENTRYPOINT ["node", "/opt/loom/testkit/runner.js"]
```

---

## 5. 数据 fixture 组织

### 5.1 fixture 仓库（替代真实 GitHub）

`tests/fixtures/repos/` 下每个目录是一个**已 init 的本地 git 仓库**，含确定性内容与 SHA。构建镜像时 `git init` + commit 固化。

| 仓库 | 内容 | 用途 |
|------|------|------|
| `generic-skills` | 2 个 skill（dir-layout + flat） | marketplace 导入测试 |
| `cc-plugin` | claude-code-plugin 结构 | plugin 能力集 导入 |
| `empty-repo` | 空仓库 | 边界：空导入 |

marketplace 测试时把 `repos/<name>` 当作 `cloneOrFetch` 的源（替代真实 git URL）。

### 5.2 seed 数据

`tests/fixtures/seed/*.json`，按场景分组，testkit 加载后通过 API 灌入：

```json
// assets-six-types.json
[
  { "type": "skill", "name": "scout", "files": [{"path":"SKILL.md","content":"# scout"}], ... },
  { "type": "rule", "name": "ts-strict", "metadata": {"globs":["**/*.ts"]}, ... },
  { "type": "mcp", "name": "fs-server", "metadata": {"transport":"stdio","command":"npx"}, ... },
  { "type": "hook", "name": "pre-commit", ... },
  { "type": "command", "name": "refactor", ... },
  { "type": "agent", "name": "reviewer", ... }
]
```

### 5.3 项目模板

`tests/fixtures/projects/<name>/` 预制厂商目录，测试时 cp 到临时项目根：
- `empty/`：无任何厂商目录
- `cursor-with-rules/`：已有 `.cursor/rules/external.md`（测试 external 文件识别）
- `claudecode-with-mcp/`：已有项目根 `.mcp.json`（测试聚合 merge）

### 5.4 期望快照

`tests/fixtures/expected/<scenario>/` 存安装后的预期磁盘结构（文件路径 + 内容），`assertions.ts` 做递归 diff。

---

## 6. L3 真实链路测试框架（@maolinc/cc-loom-testkit）

### 6.1 server-runner.ts

启停真实 server 子进程（非 fastify.inject）：

```ts
export async function startServer(opts?: { port?: number }): Promise<ServerHandle> {
  const port = opts?.port ?? 0; // 0 = 随机端口, server 启动后读 stdout 解析
  const proc = spawn("node", [process.env.LOOM_SERVER_BIN!], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 等 "Loom Server running at" 出现, 解析端口
  const actualPort = await waitForServerReady(proc);
  return { proc, port: actualPort, baseUrl: `http://127.0.0.1:${actualPort}` };
}

export async function stopServer(h: ServerHandle): Promise<void> {
  h.proc.kill("SIGTERM");
  await waitForExit(h.proc);
}
```

### 6.2 agent-runner.ts

启停真实 cli agent：

```ts
export async function startAgent(opts: {
  endpoint: string; token: string;
  projectRoot: string;
}): Promise<AgentHandle> {
  // 先 login (写 ~/.loom/config.json)
  await runCli(["login", "--endpoint", opts.endpoint, "--token", opts.token]);
  // cd projectRoot && register
  await runCli(["register"], { cwd: opts.projectRoot });
  // start agent (foreground, 后台进程由 testkit 管理)
  const proc = spawn("node", [process.env.LOOM_CLI_BIN!, "start", "-f"], {
    cwd: opts.projectRoot,
    env: { ...process.env, LOOM_FORCE_TTY: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForAgentConnected(proc);
  return { proc, projectRoot: opts.projectRoot };
}
```

### 6.3 project-sandbox.ts

```ts
export function makeProject(template?: string): string {
  const root = mkdtempSync(join("/tmp", "loom-proj-"));
  if (template) cpSync(join(FIXTURES, "projects", template), root, { recursive: true });
  return root;
}
```

### 6.4 assertions.ts

磁盘 / lock / DB 三类断言：

```ts
// 递归比对磁盘与期望快照
export function expectDiskMatches(root: string, expectedDir: string): void
// 断言 lock 文件存在且 assets/聚合符合预期
export function expectLock(projectId: string, expected: Partial<LockFile>): void
// 断言 server DB 某表某行
export function expectDbRow(table: string, where: object, expected: object): void
// 断言 agent 进程在线/离线 (通过 WS 状态)
export function expectAgentOnline(server: ServerHandle, projectId: string): Promise<void>
```

### 6.5 用例骨架（happy-path.test.ts 示例）

```ts
import { describe, it, expect, afterEach } from "vitest";
import { startServer, stopServer } from "@maolinc/cc-loom-testkit/server-runner";
import { startAgent, stopAgent } from "@maolinc/cc-loom-testkit/agent-runner";
import { makeProject } from "@maolinc/cc-loom-testkit/project-sandbox";
import { ApiClient } from "@maolinc/cc-loom-testkit/api-client";
import { expectDiskMatches, expectLock } from "@maolinc/cc-loom-testkit/assertions";

describe("L3: happy path 全链路", () => {
  let server, agent, projectRoot, api;

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    if (server) await stopServer(server);
  });

  it("登录→创建asset→组能力集→注册项目→安装→磁盘落盘", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("alice@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(seed.skill("scout"));
    const capabilitySet = await api.createCapabilitySet("set1", [skill.id], ["cursor"]);

    projectRoot = makeProject("empty");
    agent = await startAgent({ endpoint: server.baseUrl, token, projectRoot });

    const plan = await api.installPlan({
      projectId: agent.projectId, capabilitySetId: capabilitySet.id,
      targetTools: ["cursor"], policy: "auto",
    });
    const result = await api.installExecute(plan);
    expect(result.errors).toEqual([]);

    expectDiskMatches(projectRoot, "expected/install-cursor-skill");
    expectLock(agent.projectId, { policy: "auto", capabilitySetId: capabilitySet.id });
  });
});
```

---

## 7. L4 流程编排设计

### 7.1 orchestrator.ts — 多角色状态机

```ts
export interface Scenario {
  name: string;
  // 角色定义
  users: { email: string }[];
  devices: { user: string; name: string; project: string; template?: string }[];
  // 步骤序列 (每步可断言中间态)
  steps: ScenarioStep[];
}

export interface ScenarioStep {
  desc: string;
  actor: "server" | "user" | "device";  // 谁执行
  target?: string;                       // 哪个 user/device
  action: (ctx: ScenarioCtx) => Promise<void>;
  assert?: (ctx: ScenarioCtx) => Promise<void>;  // 步后断言
}
```

### 7.2 编排用例：跨用户 auto 同步

```ts
export const crossUserSync: Scenario = {
  name: "cross-user-auto-sync",
  users: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
  devices: [
    { user: "bob", name: "bob-dev", project: "bob-proj", template: "empty" },
  ],
  steps: [
    { actor: "user", target: "alice", desc: "创建 public 能力集(2 asset)",
      action: async (ctx) => {
        ctx.state.capabilitySet = await ctx.api("alice").createCapabilitySet("shared", [a1,a2], ["cursor"], "public");
      }},
    { actor: "user", target: "bob", desc: "安装 alice 的 能力集",
      action: async (ctx) => {
        await ctx.api("bob").install(ctx.devices.bob.projectId, ctx.state.capabilitySet.id, ["cursor"], "auto");
      },
      assert: async (ctx) => {
        await expectAgentOnline(ctx.server, ctx.devices.bob.projectId);
        expectDiskMatches(ctx.devices.bob.root, "expected/bob-2-assets");
      }},
    { actor: "user", target: "alice", desc: "更新成员 +1 asset",
      action: async (ctx) => {
        await ctx.api("alice").updateCapabilitySet(ctx.state.capabilitySet.id, [a1,a2,a3]);
      }},
    { actor: "server", desc: "等待 auto 同步",
      action: async (ctx) => { await waitForSync(ctx.server, ctx.devices.bob.projectId); },
      assert: async (ctx) => {
        expectDiskMatches(ctx.devices.bob.root, "expected/bob-3-assets");
      }},
  ],
};
```

### 7.3 多容器编排（D1 混合模式 - 多容器场景）

L4 中跨设备/跨用户的场景，需要多个 agent 容器时用 `docker-compose.scenario.yml`：

```yaml
services:
  server:
    image: loom-test-runtime
    environment:
      - PORT=47474
    # server 单独跑
  agent-alice:
    image: loom-test-runtime
    depends_on: [server]
    environment:
      - LOOM_ENDPOINT=http://server:47474
  agent-bob:
    image: loom-test-runtime
    depends_on: [server]
    environment:
      - LOOM_ENDPOINT=http://server:47474
```

**运行时选择模式（D1 混合）**：同一套用例支持两种运行方式，由运行命令参数决定，不在用例代码里绑死：
- `--mode single`（默认）：单容器内多进程（server + agent + vitest），快，适合本地迭代。
- `--mode multi`：compose 多容器，每个 agent 独立容器，隔离最强，适合 CI 与严格回归。

runner.js 透传 `--mode`；justfile 命令加 `MODE` 参数：
```just
test-docker-e2e MODE="single":
    docker run --rm {{TEST_IMG}}:latest node testkit/runner.js --layer l3 --mode {{MODE}}
```

---

## 8. L5 UI 测试（Playwright）

```ts
// l5-ui/login.spec.ts
import { test, expect } from "@playwright/test";
import { startServer } from "@maolinc/cc-loom-testkit/server-runner";

test.beforeAll(async () => {
  // 共享一个 server 实例
  globalThis.__server = await startServer();
});

test("登录页 → 输入邮箱密码 → 跳转首页", async ({ page }) => {
  await page.goto(globalThis.__server.baseUrl);
  await page.fill('[name=email]', 'ui@example.com');
  await page.fill('[name=password]', 'test-user-password');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/');
  await expect(page.locator('text=能力市场')).toBeVisible();
});
```

Playwright 对容器内 server + 静态 web 产物驱动，覆盖 7 个页面核心交互。

---

## 9. justfile 命令实现

```just
# --- Docker 测试 -------------------------------------------------------------

# 镜像 tag (用 git short sha 或 latest)
TEST_IMG := "loom-test-runtime"
TEST_BASE := "loom-test-base"

# 构建测试基础镜像
test-docker-base:
    docker build -f docker/Dockerfile.test-base -t {{TEST_BASE}}:latest docker/

# 构建测试 runtime 镜像 (含编译产物 + fixture + testkit)
test-docker-build: test-docker-base
    docker build -f docker/Dockerfile.test-runtime -t {{TEST_IMG}}:latest .

# 进入测试容器交互 (调试)
test-docker-shell:
    docker run --rm -it {{TEST_IMG}}:latest /bin/sh

# --- L3 真实链路端到端 ---
# 运行模式 MODE: single(默认,单容器多进程) | multi(compose多容器,最强隔离)
# 跑全部 L3 用例
test-docker-e2e MODE="single":
    docker run --rm {{TEST_IMG}}:latest node testkit/runner.js --layer l3 --mode {{MODE}}

# 跑指定 L3 用例 (按名模糊匹配): just test-docker-e2e-file happy
# 可加模式: just test-docker-e2e-file happy multi
test-docker-e2e-file PATTERN MODE="single":
    docker run --rm {{TEST_IMG}}:latest node testkit/runner.js --layer l3 --mode {{MODE}} --grep "{{PATTERN}}"

# --- L4 流程编排 ---
# 跑指定编排用例: just test-docker-scenario cross-user-sync
# 可加模式: just test-docker-scenario cross-user-sync multi
test-docker-scenario NAME MODE="single":
    docker run --rm {{TEST_IMG}}:latest node testkit/runner.js --layer l4 --mode {{MODE}} --scenario "{{NAME}}"

# 跑全部编排用例
test-docker-scenarios MODE="single":
    docker run --rm {{TEST_IMG}}:latest node testkit/runner.js --layer l4 --mode {{MODE}}

# --- L5 UI ---
test-docker-ui:
    docker run --rm {{TEST_IMG}}:latest node testkit/runner.js --layer l5

# --- 汇总 ---
# 跑全部 Docker 测试 (L3 + L4 + L5)
test-docker-all MODE="single": test-docker-build
    docker run --rm {{TEST_IMG}}:latest node testkit/runner.js --all --mode {{MODE}}

# 稳定性验证 (连跑 5 次确认无 flake)
test-docker-stable MODE="single":
    @for i in 1 2 3 4 5; do \
      echo "=== Run $i ==="; \
      docker run --rm {{TEST_IMG}}:latest node testkit/runner.js --all --mode {{MODE}} || exit 1; \
    done

# --- L2 迁移到容器 (D5) ---
# L2 进程内集成测试也在容器内跑 (隔离 LOOM_DATA_DIR)
test-docker-l2:
    docker run --rm {{TEST_IMG}}:latest node testkit/runner.js --layer l2

# 清理测试镜像
test-docker-clean:
    docker rmi {{TEST_IMG}}:latest {{TEST_BASE}}:latest 2>/dev/null || true
```

---

## 10. runner.js — 测试入口调度

`packages/testkit/src/runner.ts`（编译为 runner.js）：

```ts
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const layer = argValue(args, "--layer");        // l2|l3|l4|l5
const grep = argValue(args, "--grep");
const scenario = argValue(args, "--scenario");
const mode = argValue(args, "--mode") ?? "single";  // single|multi (D1 运行时选择)
const all = args.includes("--all");

// mode 决定执行后端：single → docker run 单容器内多进程；multi → docker compose
const runOpts = { mode, grep };

if (all || layer === "l2") runVitest("tests/l2", runOpts);      // 迁移后的 L2
if (all || layer === "l3") runVitest("tests/l3-real-e2e", runOpts);
if (all || layer === "l4") runScenarioOrVitest("tests/l4-scenarios", scenario, runOpts);
if (all || layer === "l5") runPlaywright("tests/l5-ui");

function runVitest(dir: string, opts: { mode: string; grep?: string }) {
  if (opts.mode === "multi") {
    // multi: 用 docker compose 起 server + 各 agent 独立容器, 再跑 vitest 连过去
    execSync("docker compose -f /opt/loom/docker/docker-compose.scenario.yml up -d", { stdio: "inherit" });
  }
  // single: server + agent 在当前容器内以子进程起 (testkit server-runner/agent-runner 负责)
  const cmd = ["npx", "vitest", "run", dir];
  if (opts.grep) cmd.push("-t", opts.grep);
  try { execSync(cmd.join(" "), { stdio: "inherit" }); }
  finally { if (opts.mode === "multi") execSync("docker compose -f /opt/loom/docker/docker-compose.scenario.yml down", { stdio: "ignore" }); }
}
```

---

## 11. 首批用例清单（Phase 1 验收）

Phase 1 只交付基础设施 + 以下 5 条 L3 用例，证明链路通：

| # | 用例 | 验证不变量 |
|---|------|-----------|
| 1 | `happy-path.test.ts` | 登录→创建→安装→落盘→lock 全链路通 |
| 2 | `install-flow.test.ts` | 六类 asset × 四种 targetTool 落盘路径正确（含 D8: codex/claudecode） |
| 3 | `token-lifecycle.test.ts` | 重生成 token → 旧 token agent 断连 → 新 token 重连 |
| 4 | `drift-self-heal.test.ts` | lock 文件全缺 → scan 自动清 lock → server current_capability_set 置空 |
| 5 | `conflict-identity.test.ts` | 同名 skill 落盘冲突 → 409；MCP 聚合覆盖语义正确 |

Phase 1 验收命令：
```bash
just test-docker-build && just test-docker-e2e
```
在干净机器（仅装 docker）上通过。

---

## 12. 场景矩阵（Phase 2 铺开目标）

按需求 §5.2，Phase 2 每维度至少 3 条：

| 维度 | 用例（示例） |
|------|-------------|
| 错误路径 | 登录错密码 / 创建 asset 校验失败 / 安装不存在的 能力集 / push 同名 marketplace 409 |
| 边界 | 空 content asset / >1MB content / page=0 / 并发创建同名 能力集 |
| 一致性 | drift 自愈 / orphan 清理 / lock 残留 / MCP 聚合冲突 / legacy lock 拒绝 toggle |
| 同步 | auto 在线同步 / locked 不同步 / 离线补偿 / 重连重推 / 成员移除不补偿 |
| 生命周期 | 安装→更新→卸载→重装 / token 重生成 / session 过期 / toggle 来回搬家 |
| 并发 | 并发安装 / 并发 push / 并发创建 能力集 |
| 安全 | 路径穿越 / symlink 逃逸 / XSS content / 未授权访问私有 |

---

## 13. 落地步骤

| 步骤 | 内容 | 验证 |
|------|------|------|
| 1 | CLI `paths.ts` 加 `LOOM_HOME` 环境变量 | `just test` 现有用例不破 |
| 2 | 创建 `packages/testkit` 包骨架 + `docker/` 目录 | `pnpm install` 通过 |
| 3 | 写 `Dockerfile.test-base` + `Dockerfile.test-runtime` | `just test-docker-build` 成功 |
| 4 | 实现 testkit 核心：server-runner / agent-runner / project-sandbox / assertions | 容器内手动跑通启停 |
| 5 | 写 fixture（repos/seed/projects/expected 首批） | fixture 加载器能读 |
| 6 | 写 Phase 1 的 5 条 L3 用例 | `just test-docker-e2e` 全绿 |
| 7 | 加 justfile `test-docker-*` 命令 | `just --list` 可见且可跑 |
| 8 | Phase 2: 按矩阵铺用例 | 每维度 ≥3 条 |
| 9 | Phase 3: L4 编排器 + 5 条编排用例 | `just test-docker-scenarios` 全绿 |
| 10 | Phase 4: L5 Playwright UI | `just test-docker-ui` 全绿 |

---

## 14. 不做（边界重申）

- 不重写现有 L1/L2 用例语义。
- 不引入 K8s。
- 不测真实 GitHub / 真实 AI 服务。
- 不做性能基准。
- 不做 CI 平台特定集成（CI 调 `just test-docker-all` 即可）。
