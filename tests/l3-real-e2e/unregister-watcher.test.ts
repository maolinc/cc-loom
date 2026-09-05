/**
 * L3 `loom unregister` 后是否仍监听该项目文件 —— 回归用例。
 *
 * 不变量：`loom unregister` 之后，运行中的 daemon Agent 必须停止对该项目的
 * 文件监听。后续在项目目录内修改厂商目录文件，Agent 日志中不应再出现时间戳
 * 晚于该次写文件的 `检测到项目 <id> 本地变更`（watcher.onChange 触发的日志）。
 *
 * 真实性：server / agent 均为真实进程，HTTP + WebSocket + 磁盘真实读写，
 * 断言走 agent.log 这一可观测出口。
 *
 * 背景：`loom unregister` 走 DELETE /api/projects/:id（仅服务端硬删 + CLI 抹本地），
 * 不下发 project:purge RPC。daemon Agent 只能靠 30s 周期的 reconcile() 发现本地
 * 记录消失再 watcher.stop(id)。本用例在 unregister 之后立刻改文件，验证此刻
 * watcher 是否已被停掉——若没停，日志会记录一次变更推送，用例转红。
 *
 * 时序约束：reconcile() 仅在 onAuthed 即时调用一次 + 之后每 30s 一次。即时那次
 * 项目还在，不会 stop watcher；下一次要等到 +30s。因此只要整个用例在 auth 后
 * 30s 内跑完，reconcile 永远不会抢先停掉 watcher——RED/GREEN 完全由「unregister
 * 是否主动停 watcher」决定，消除定时器竞态。
 *
 * 归因：daemon 与测试同一容器同一系统时钟，日志带 ISO 时间戳。self-check 的
 * onChange 会跑 syncTracker 等可能向项目目录再写一次（触发二次 onChange 后幂等
 * 收敛），产生「残留事件」。为避免把残留事件误判为 unregister 后的推送，断言只
 * 统计时间戳 >= 写文件时刻（writeStart）的「本地变更」行——残留事件时间戳必然
 * 早于 writeStart，被排除。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  startServer,
  stopServer,
  type ServerHandle,
  startAgent,
  runCli,
  type AgentHandle,
  makeProject,
  cleanupProject,
  ApiClient,
  assetBuilders,
  expectFileExists,
  LOOM_HOME,
} from "@maolinc/cc-loom-testkit";

const AGENT_LOG = join(LOOM_HOME, "logs", "agent.log");
const NEEDLE = "本地变更";

function readAgentLog(): string {
  try {
    return readFileSync(AGENT_LOG, "utf-8");
  } catch {
    return "";
  }
}

/** 解析日志中每条「本地变更」行的 ISO 时间戳（ms epoch）。无法解析的跳过。 */
function changeEventTimes(): number[] {
  const out: number[] = [];
  for (const line of readAgentLog().split("\n")) {
    if (!line.includes(NEEDLE)) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isNaN(t)) out.push(t);
  }
  return out;
}

describe("L3 unregister-watcher: 注销后停止监听项目文件", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  beforeEach(() => {
    agent = null;
    projectRoot = null;
  });

  afterEach(async () => {
    try { await runCli(["stop", "--force"], { timeout: 5000 }); } catch { /* ignore */ }
    if (agent) { agent.stopped = true; }
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  it("loom unregister 之后修改厂商文件，Agent 不应再推送变更", async () => {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login("unreg-watch@example.com");
    const token = await api.getCliToken();

    const skill = await api.createAsset(assetBuilders.skill("unreg-watch-skill", ["cursor"]));
    const ws = await api.createCapabilitySet(
      { name: "ws-unreg-watch", description: "unregister watcher", targetTools: ["cursor"], visibility: "public" },
      [skill.id],
    );

    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot: projectRoot!,
      isOnline: async () => {
        const devices = await api.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });
    const projectId = agent.projectId;

    await api.installExecute({
      projectId, capabilitySetId: ws.id, targetTools: ["cursor"], policy: "locked",
    });
    expectFileExists(projectRoot, ".cursor/skills/unreg-watch-skill/SKILL.md");

    const skillFile = join(projectRoot, ".cursor/skills/unreg-watch-skill/SKILL.md");

    // 等 chokidar 起来（install 的 startWatchingAndPush 刚 start，需 ready 窗口）。
    await new Promise((r) => setTimeout(r, 2000));

    // self-check：改文件，确认 watcher 活着、日志通道通。带重试，排除 init 丢事件。
    let watcherAlive = false;
    for (let attempt = 0; attempt < 4 && !watcherAlive; attempt++) {
      appendFileSync(skillFile, `\n# self-check ${attempt}\n`);
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (readAgentLog().includes(NEEDLE)) { watcherAlive = true; break; }
      }
    }
    if (!watcherAlive) {
      console.error("[diag] agent.log tail:\n", readAgentLog().slice(-3000));
    }
    expect(watcherAlive).toBe(true);

    // 留 4s 静默期让 self-check 的残留事件（syncTracker 二次 onChange 等）落盘，
    // 时间戳早于 writeStart，归因时被排除。
    await new Promise((r) => setTimeout(r, 4000));

    // 被测动作：loom unregister（在项目目录下）。它只动 ~/.loom，不动项目目录，
    // 不会自身触发 watcher 事件。
    await runCli(["unregister"], { cwd: projectRoot, timeout: 15000 });
    // 让 unregister 落地，但远不到 30s reconcile 周期。
    await new Promise((r) => setTimeout(r, 500));

    // unregister 之后修改厂商目录文件。writeStart 之后任何「本地变更」都只能来自这次写。
    mkdirSync(join(projectRoot, ".cursor/skills/unreg-watch-skill"), { recursive: true });
    const writeStart = Date.now();
    writeFileSync(skillFile, "# changed after unregister\n");

    // 等 debounce(500ms) + awaitWriteFinish(200ms) + 落盘窗口，捕捉任何推送。
    let postHits = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      postHits = changeEventTimes().filter((t) => t >= writeStart).length;
      if (postHits > 0) break;
    }

    // 核心断言：unregister 之后 daemon 不应再因该项目文件变更而推送。
    if (postHits > 0) {
      throw new Error(
        `注销后 Agent 仍在监听项目文件：writeStart 后出现 ${postHits} 次变更推送。\n` +
          `writeStart=${writeStart} (${new Date(writeStart).toISOString()})\n` +
          `agent.log tail:\n${readAgentLog().slice(-2000)}`,
      );
    }
  }, 60000);
});
