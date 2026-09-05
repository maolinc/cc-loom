/**
 * Git fixture — 把一个普通目录变成真 git 仓库，供 marketplace 链路 L3 测试用。
 *
 * 原则（docs/testing/principles.md §4）：唯一允许的 mock 是 marketplace 的 git clone，
 * 用本地 fixture 仓库代替联网。本 helper 不 patch server 代码，而是造一个真实的
 * `file://` 仓库，让 server 的 git-runner 真正 `git clone` / `git fetch`。
 *
 * 用法:
 *   const fx = createGitFixture(FIXTURE_GENERIC);
 *   await api.addMarketplace(fx.url);    // server 真 clone
 *   fx.commit();                          // bump SHA
 *   await api.refreshMarketplace(id);     // server 真 fetch 到新 SHA
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export interface GitFixture {
  /** `file://` URL — 传给 marketplace add 的 repoUrl。 */
  url: string;
  /** 本地仓库目录绝对路径。 */
  path: string;
  /** 取当前 HEAD SHA。 */
  sha(): string;
  /** 新建一次提交（默认改一个 marker 文件），返回新 SHA。用于模拟上游更新触发 refresh。 */
  commit(opts?: { file?: string; content?: string }): string;
  /** 删除临时仓库。 */
  dispose(): void;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Loom Test",
  GIT_AUTHOR_EMAIL: "test@loom.local",
  GIT_COMMITTER_NAME: "Loom Test",
  GIT_COMMITTER_EMAIL: "test@loom.local",
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString().trim();
}

/**
 * 把 sourceDir 内容复制到临时目录并初始化为 git 仓库（一次初始提交）。
 * sourceDir 通常是 marketplace fixture 目录（普通目录，非 git 仓库）。
 */
export function createGitFixture(sourceDir: string): GitFixture {
  const repoPath = mkdtempSync(join(tmpdir(), "loom-gitfix-"));
  cpSync(sourceDir, repoPath, { recursive: true });

  git(["init", "-q"], repoPath);
  git(["add", "-A"], repoPath);
  git(["commit", "-q", "-m", "initial"], repoPath);

  const url = `file://${repoPath}`;
  const sha = () => git(["rev-parse", "HEAD"], repoPath);

  return {
    url,
    path: repoPath,
    sha,
    commit(opts: { file?: string; content?: string } = {}) {
      const file = opts.file ?? ".loom-marker";
      const content = opts.content ?? sha();
      writeFileSync(join(repoPath, file), content);
      git(["add", "-A"], repoPath);
      git(["commit", "-q", "-m", "bump"], repoPath);
      return sha();
    },
    dispose() {
      rmSync(repoPath, { recursive: true, force: true });
    },
  };
}
