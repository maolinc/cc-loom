/**
 * 启停真实 cli agent 进程（通过 CLI 命令，最真实）。
 *
 * 流程: login → start (daemon) → register → 等待 agent 上线。
 * 清理: stop（读 pidfile 杀进程）。
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_BIN, LOOM_HOME } from "./env.js";

/** spawn 返回类型的统一接口，兼容不同 @types/node 版本。 */
type SpawnedProc = NodeJS.EventEmitter & {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: string): void;
};

export interface AgentHandle {
  projectRoot: string;
  projectId: string;
  /** agent daemon 的 pidfile 路径，stop 时用 */
  stopped: boolean;
}

/** 运行一条 CLI 命令，返回 stdout。失败时抛错含 stderr。 */
export function runCli(
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [CLI_BIN, ...args], {
      cwd: opts?.cwd,
      env: { ...process.env, LOOM_FORCE_TTY: "0", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as SpawnedProc;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`CLI 超时: loom ${args.join(" ")}\nstderr: ${stderr}`));
    }, opts?.timeout ?? 30000);

    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("exit", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`CLI 失败 (code=${code}): loom ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 启动 agent 并注册项目。步骤:
 * 1. loom login — 写 config
 * 2. loom start — 启动 daemon（自动注册设备）
 * 3. loom register — 注册项目（在 projectRoot 下执行）
 * 4. 轮询 server API 确认 agent 在线
 */
export async function startAgent(opts: {
  endpoint: string;
  token: string;
  projectRoot: string;
  /** 通过 server API 检查 agent 是否在线的回调 */
  isOnline: (projectId: string) => Promise<boolean>;
}): Promise<AgentHandle> {
  // 1. login
  await runCli(["login", "--endpoint", opts.endpoint, "--token", opts.token]);

  // 2. start (daemon 模式，--force 避免上一个测试残留 pidfile 冲突)
  await runCli(["start", "--force"], { timeout: 15000 });

  // 2.5 等待 deviceId 写入 config（daemon 异步注册设备，register 依赖它）
  await waitForDeviceId(10000);

  // 3. register
  const regOut = await runCli(["register"], { cwd: opts.projectRoot, timeout: 15000 });

  // 4. 从本地 ~/.loom/projects/ 读 projectId
  const projectId = findProjectIdByPath(opts.projectRoot);
  if (!projectId) {
    throw new Error(`无法找到项目 ID (path=${opts.projectRoot})\nregister 输出: ${regOut}`);
  }

  // 5. 等待 agent 在线（server 端确认）
  await waitForOnline(opts.isOnline, projectId, 20000);

  return { projectRoot: opts.projectRoot, projectId, stopped: false };
}

export async function stopAgent(h: AgentHandle): Promise<void> {
  if (h.stopped) return;
  try {
    await runCli(["stop", "--force"], { timeout: 10000 });
  } catch {
    // stop 失败不阻塞，容器销毁会清理
  }
  h.stopped = true;
}

/** 从 LOOM_HOME/projects/ 目录读项目 ID（按 normalizedPath 匹配）。 */
function findProjectIdByPath(normalizedPath: string): string | null {
  const projectsDir = join(LOOM_HOME, "projects");
  try {
    const entries = readdirSync(projectsDir);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const raw = readFileSync(join(projectsDir, name), "utf-8");
      const rec = JSON.parse(raw);
      if (rec.normalizedPath === normalizedPath) return id;
    }
  } catch {
    // 目录不存在或读取失败
  }
  return null;
}

/** 等 config.json 中出现 deviceId（daemon 异步注册设备后写入）。 */
async function waitForDeviceId(timeoutMs: number): Promise<void> {
  const { readFileSync, existsSync } = await import("node:fs");
  const configPath = join(LOOM_HOME, "config.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (existsSync(configPath)) {
        const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
        if (cfg.deviceId) return;
      }
    } catch { /* 还没写好 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待 deviceId 超时 (${timeoutMs}ms)`);
}

async function waitForOnline(
  isOnline: (projectId: string) => Promise<boolean>,
  projectId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await isOnline(projectId)) return;
    } catch {
      // API 可能还没就绪
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`agent 上线超时 (${timeoutMs}ms, projectId=${projectId})`);
}
