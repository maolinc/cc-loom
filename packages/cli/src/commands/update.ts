/**
 * `loom update` —— 更新 loom CLI 到最新版本。
 *
 * 走全局包管理器重装 @maolinc/cc-loom。包管理器按 npm_config_user_agent 尽力识别
 * （pnpm/yarn），否则默认 npm（与 README 文档化安装方式一致）。
 * 子进程 stdio 直接继承，用户可见实时进度。
 *
 * 安装来源保留：优先从已安装 @maolinc/cc-loom 的 package.json（`_from`/`_resolved`）恢复
 * 安装时使用的 registry 与 dist-tag，避免私有源用户被公网同名包顶替；
 * 读不到来源时退回默认 `@latest` + 当前 registry。
 *
 * 已知限制：npx 临时执行场景下，重读到的版本可能是 npx 缓存中的旧值；
 * 全局已更新，重启 loom 后即生效。
 */
import { spawn } from "node:child_process";
import { getCliVersion, clearVersionCache } from "../lib/version.js";
import { resolveInstallSource } from "../lib/install-source.js";
import { CliFailure } from "../lib/errors.js";
import { ok, info, tip, blank, color } from "../lib/ui.js";

type PackageManager = "npm" | "pnpm" | "yarn";

/** spawn 返回类型的统一接口，兼容不同 @types/node 版本（@types/node@25 的 ChildProcess
 *  类型在部分解析路径下丢失 EventEmitter 成员，用 NodeJS.EventEmitter 规避）。 */
type SpawnedProc = NodeJS.EventEmitter;

function detectPackageManager(): PackageManager {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  return "npm";
}

function installArgs(pm: PackageManager, spec: string, registry?: string): string[] {
  const base: string[] =
    pm === "pnpm" ? ["add", "-g", spec]
      : pm === "yarn" ? ["global", "add", spec]
        : ["install", "-g", spec];
  if (registry) base.push("--registry", registry);
  return base;
}

export async function updateCommand(): Promise<void> {
  const pm = detectPackageManager();
  const before = getCliVersion();
  const src = resolveInstallSource();
  const spec = src?.spec ?? "@maolinc/cc-loom@latest";

  info(`当前版本：${color.cyan(before)}`);
  if (src) {
    info(`安装来源：${color.cyan(src.registry)} ${color.dim(`(${spec})`)}`);
  }
  info(`通过 ${color.cyan(pm)} 更新中…`);
  blank();

  const code = await run(pm, installArgs(pm, spec, src?.registry));
  if (code !== 0) {
    throw new CliFailure(`${pm} 更新失败（退出码 ${code}）`, 1);
  }

  clearVersionCache();
  const after = getCliVersion();
  blank();
  if (before === after) {
    ok(`已是最新版本 ${color.cyan(after)}`);
  } else {
    ok(`已更新 ${color.dim(before)} → ${color.green(after)}`);
  }
  tip("若 Agent 正在运行，执行 loom stop && loom start 以加载新版本");
  tip("若提示 loom: No such file or directory / command not found，执行 hash -r 或打开新终端");
}

/** 以继承 stdio 方式运行包管理器，返回退出码。 */
function run(pm: PackageManager, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(pm, args, {
      stdio: "inherit",
      // Windows 上 npm/pnpm/yarn 是 .cmd，需要 shell 才能找到
      shell: process.platform === "win32",
    }) as unknown as SpawnedProc;
    child.on("error", (e: Error) => reject(new CliFailure(`无法启动 ${pm}：${e.message}`)));
    child.on("close", (code: number | null) => resolve(code ?? 1));
  });
}
