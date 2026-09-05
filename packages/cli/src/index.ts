#!/usr/bin/env node
/**
 * Loom CLI 主入口。
 *
 * 设计要点：
 * - 所有命令通过 `runCommand` 包一层，把 `CliFailure` 转成 `program.error()` 退出。
 *   这样命令实现者只需 `throw new CliFailure("…")`，不要散落 `process.exit`。
 * - `exitOverride()` 让 commander 自身的错误（参数缺失等）也走我们的统一退出路径。
 */
import { Command, CommanderError } from "commander";
import { DEFAULT_ENDPOINT } from "@maolinc/cc-loom-shared";
import { CliFailure } from "./lib/errors.js";
import { ApiError } from "./lib/api.js";
import { err as printError } from "./lib/ui.js";

import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { registerCommand } from "./commands/register.js";
import { unregisterCommand } from "./commands/unregister.js";
import { pushCommand } from "./commands/push.js";
import { versionCommand } from "./commands/version.js";
import { updateCommand } from "./commands/update.js";
import { getCliVersion } from "./lib/version.js";

const program = new Command();

program
  .name("loom")
  .description("Loom CLI — AI 能力平台本地工具")
  .version(getCliVersion())
  .exitOverride();

program
  .command("login")
  .description("校验 Token 并写入本地配置")
  .option("--token <token>", "CLI Token（在 Web 设置页生成）")
  .option("--endpoint <url>", "Loom 服务端地址", DEFAULT_ENDPOINT)
  .option("--force", "即使 token/endpoint 未变也强制重新校验")
  .action((opts) => runCommand(() => loginCommand(opts)));

program
  .command("logout")
  .description("清除本地凭据（不影响服务端 Token）")
  .action(() => runCommand(logoutCommand));

program
  .command("start")
  .description("启动本地 Agent（默认后台运行，日志写 ~/.loom/logs/agent.log）")
  .option("-f, --foreground", "前台运行并显示 TUI（不 daemon 化）")
  .option("--force", "忽略 pidfile，强制启动")
  .action((opts) => runCommand(() => startCommand(opts)));

program
  .command("stop")
  .description("停止本机正在运行的 Agent")
  .option("--force", "SIGTERM 超时后用 SIGKILL 强杀")
  .action((opts) => runCommand(() => stopCommand(opts)));

program
  .command("status")
  .description("查看连接、设备、项目状态（离线可用）")
  .option("--json", "以 JSON 输出，便于脚本化（脚本可断言 exitCode=0 + 解析 stdout）")
  .action((opts) => runCommand(() => statusCommand(opts)));

program
  .command("register")
  .description("注册当前项目目录到 Loom")
  .action(() => runCommand(registerCommand));

program
  .command("unregister")
  .description("注销当前项目目录")
  .option("--force", "远端调用失败仍清理本地缓存")
  .action((opts) => runCommand(() => unregisterCommand(opts)));

program
  .command("push")
  .description("推送本地厂商目录到平台，创建或覆盖工作空间")
  .option("--tool <tool>", "指定厂商 (cursor|codebuddy|codex|claudecode)")
  .option("--name <name>", "自定义工作空间名称（默认: 用户名/项目目录名）")
  .option("--visibility <visibility>", "可见性 public|private（默认: private）")
  .action((opts) => runCommand(() => pushCommand(opts)));

program
  .command("version")
  .description("查看当前 CLI 版本")
  .action(() => runCommand(versionCommand));

program
  .command("update")
  .description("更新 loom CLI 到最新版本")
  .action(() => runCommand(updateCommand));

main();

async function main(): Promise<void> {
  try {
    // 没传子命令时打印 help 并以 0 退出（commander 默认 1，与 `loom help` 不一致）。
    if (process.argv.length <= 2) {
      program.outputHelp();
      process.exit(0);
    }
    await program.parseAsync();
  } catch (e) {
    if (e instanceof CommanderError) {
      // commander 自己的退出（--help 等）— 直接传播退出码
      process.exit(e.exitCode);
    }
    if (e instanceof CliFailure) {
      printError(e.message);
      process.exit(e.exitCode);
    }
    if (e instanceof ApiError) {
      printError(e.message);
      process.exit(1);
    }
    printError(`未捕获错误：${(e as Error)?.stack ?? e}`);
    process.exit(1);
  }
}

async function runCommand(fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CliFailure) {
      printError(e.message);
      process.exit(e.exitCode);
    }
    if (e instanceof ApiError) {
      printError(e.message);
      process.exit(1);
    }
    throw e;
  }
}
