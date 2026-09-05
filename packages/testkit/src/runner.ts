/**
 * 测试入口调度 — Docker ENTRYPOINT。
 *
 * 用法:
 *   node runner.js --layer l3 [--mode single|multi] [--grep file-pattern]
 *   node runner.js --layer l4 [--mode single|multi] [--scenario file-pattern]
 *   node runner.js --layer l5
 *   node runner.js --all [--mode single]
 *
 * --grep / --scenario 均按文件路径 substring 过滤（如 "search-semantic" 匹配
 * tests/l3-real-e2e/search-semantic.test.ts；"cross-user-sync" 匹配 l4 同名文件）。
 * 无匹配文件时 vitest 以非零码退出，不产生假绿。
 *
 * 单元测试 (L1) 不在本 runner 范围 — 走 `pnpm test` 本地跑。
 * 原 L2 (fastify.inject 进程内集成) 已全部迁移为 L3 真实链路用例，见 tests/l3-real-e2e/。
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const VITEST_CONFIG = resolve(__dirname, "../vitest.config.ts");

const args = process.argv.slice(2);

function argValue(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

const layer = argValue("--layer");
const mode = argValue("--mode") ?? "single";
const grep = argValue("--grep");
const scenario = argValue("--scenario");
const all = hasFlag("--all");

function runVitest(testDir: string, opts?: { grep?: string; config?: string }): void {
  // 用 workspace 内置 vitest (1.6.x)，不用 npx（会装 v4 不兼容）
  const vitestBin = resolve(__dirname, "../node_modules/.bin/vitest");
  const config = opts?.config ?? VITEST_CONFIG;
  // grep 按文件路径过滤（位置参数 substring 匹配），而非 -t 测试名：
  // -t 匹配 describe/it 标题，文件名不在标题里时全跳过并以 exit 0 假绿
  // （justfile test-docker-e2e-file / test-docker-scenario 的 PATTERN 都是文件名/stem）。
  // 无匹配文件时 vitest 以 exit 1 退出，不会假绿。
  const target = opts?.grep ? `${testDir}/${opts.grep}` : testDir;
  const parts = [`"${vitestBin}"`, "run", `--config "${config}"`, `"${target}"`];
  if (process.env.DEBUG_TESTS === "1") {
    parts.push("--reporter=verbose");
  }
  const cmd = parts.join(" ");
  console.log(`[runner] mode=${mode} → ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: process.env });
}

/** L5 用 Playwright 驱动浏览器测试 SPA。 */
function runPlaywright(): void {
  const pwBin = resolve(__dirname, "../node_modules/.bin/playwright");
  // dist/ → ../../../tests/l5-ui/ (workspace root 下的 tests)
  const config = resolve(__dirname, "../../../tests/l5-ui/playwright.config.ts");
  const cmd = `"${pwBin}" test --config "${config}"`;
  console.log(`[runner] L5 → ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: process.env, cwd: "/opt/loom" });
}

function main(): void {
  try {
    if (all || layer === "l3") {
      runVitest("tests/l3-real-e2e", { grep });
    }
    if (all || layer === "l4") {
      if (scenario) {
        runVitest("tests/l4-scenarios", { grep: scenario });
      } else {
        runVitest("tests/l4-scenarios");
      }
    }
    if (all || layer === "l5") {
      runPlaywright();
    }
    console.log("[runner] ✔ 全部通过");
  } catch (err) {
    console.error("[runner] ✘ 测试失败", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
