import { spawn } from "node:child_process";

const GIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class GitRunnerError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = "GitRunnerError";
  }
}

function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // spawn 带 stdio 数组返回 ChildProcessByStdio，其事件接口在不同 @types/node
    // 版本间不一致；用 NodeJS.EventEmitter 统一访问 .on()。
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }) as unknown as
      NodeJS.EventEmitter & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; kill(signal: string): void };
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new GitRunnerError(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`, stderr));
    }, GIT_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new GitRunnerError(`failed to spawn git: ${err.message}`, stderr));
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new GitRunnerError(`git ${args[0]} exited with code ${code}`, stderr));
      }
    });
  });
}

export async function gitClone(repoUrl: string, dest: string, ref?: string): Promise<void> {
  const args = ["clone", "--depth", "1"];
  if (ref) {
    args.push("--branch", ref);
  }
  args.push(repoUrl, dest);
  await runGit(args);
}

export async function gitFetch(repoDir: string, ref?: string): Promise<void> {
  await runGit(["fetch", "--depth", "1", "origin", ref ?? "HEAD"], repoDir);
  await runGit(["reset", "--hard", "FETCH_HEAD"], repoDir);
}

export async function gitHeadSha(repoDir: string): Promise<string> {
  const out = await runGit(["rev-parse", "HEAD"], repoDir);
  return out.trim();
}
