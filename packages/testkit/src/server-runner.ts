/**
 * 启停真实 server 进程（非 fastify.inject）。
 *
 * 单容器模式下 server 监听 127.0.0.1 + 随机端口，避免并行测试文件冲突。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_BIN } from "./env.js";

/** spawn 返回类型的统一接口，兼容不同 @types/node 版本。 */
type SpawnedProc = NodeJS.EventEmitter & {
  kill(signal?: string): void;
  killed: boolean;
  pid: number;
};

export interface ServerHandle {
  proc: SpawnedProc;
  port: number;
  baseUrl: string;
  /** 本次 server 专属的临时数据目录；stopServer 时清理。 */
  dataDir: string;
}

/** 找一个空闲端口（listen 0 后立即 close，OS 仍会保留一小段时间，足够 spawn）。 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("无法获取空闲端口"));
      }
    });
    srv.on("error", reject);
  });
}

/** 等 server HTTP 端口可响应，或超时。比解析 stdout 更可靠。 */
async function waitForHttp(baseUrl: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/auth/me`);
      // 401 也算 server 就绪（只是没登录）
      if (res.status === 401 || res.ok) return;
    } catch {
      // 还没就绪
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server HTTP 就绪超时 (${timeoutMs}ms, url=${baseUrl})`);
}

export async function startServer(opts?: { port?: number; adminEmail?: string; adminPassword?: string }): Promise<ServerHandle> {
  const port = opts?.port ?? await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // 每个 server 进程独占一个临时 LOOM_DATA_DIR，确保用例间 DB 完全隔离
  // （容器内 LOOM_DATA_DIR 是共享的；不覆盖则会串号/串 workspace 名）。
  const dataDir = mkdtempSync(join(tmpdir(), "loom-server-"));
  const proc = spawn("node", [SERVER_BIN], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      LOOM_DATA_DIR: dataDir,
      LOOM_ADMIN_EMAIL: opts?.adminEmail ?? "admin@loom.test",
      LOOM_ADMIN_PASSWORD: opts?.adminPassword ?? "test-admin-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as SpawnedProc;
  // 进程意外退出时快速失败
  const exitPromise = new Promise<never>((_, reject) => {
    proc.on("exit", (code: number | null) => reject(new Error(`server 进程意外退出 (code=${code})`)));
  });
  await Promise.race([waitForHttp(baseUrl), exitPromise]);
  return { proc, port, baseUrl, dataDir };
}

export async function stopServer(h: ServerHandle): Promise<void> {
  if (!h.proc.killed) {
    h.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        h.proc.kill("SIGKILL");
        resolve();
      }, 5000);
      h.proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  // 清理本次 server 的临时 DB 目录，避免 tmp 堆积。
  rmSync(h.dataDir, { recursive: true, force: true });
}
