/**
 * CLI 统一输出与交互样式模块。
 *
 * 设计原则：
 * - 所有面向用户的终端输出都经过这里，保证视觉风格一致。
 * - 颜色使用 picocolors，自动适配非 TTY / NO_COLOR 环境。
 * - 符号统一：✓ 成功 / ✗ 失败 / ⚠ 警告 / ● 状态 / → 提示。
 * - key-value 对齐，便于扫读。
 */
import pc from "picocolors";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ── 符号 ──────────────────────────────────────────────────────────────────

export const SYM = {
  ok: pc.green("✔"),
  err: pc.red("✘"),
  warn: pc.yellow("⚠"),
  dot: pc.cyan("●"),
  arrow: pc.dim("→"),
  dash: pc.dim("—"),
} as const;

// ── 基础输出 ───────────────────────────────────────────────────────────────

/** 成功消息：✔ 绿色前缀。 */
export function ok(msg: string): void {
  console.log(`${SYM.ok} ${msg}`);
}

/** 错误消息（非退出）：✘ 红色前缀。 */
export function err(msg: string): void {
  console.error(`${SYM.err} ${pc.red(msg)}`);
}

/** 警告消息：⚠ 黄色前缀。 */
export function warn(msg: string): void {
  console.log(`${SYM.warn} ${pc.yellow(msg)}`);
}

/** 信息消息：● 青色前缀。 */
export function info(msg: string): void {
  console.log(`${SYM.dot} ${msg}`);
}

/** 暗色提示文本，无前缀。 */
export function tip(msg: string): void {
  console.log(pc.dim(msg));
}

/** 空行。 */
export function blank(): void {
  console.log();
}

// ── 结构化输出 ─────────────────────────────────────────────────────────────

/**
 * 分区标题：粗体 + 下划线。
 * 用于 status、push 等多区块输出的段落分隔。
 */
export function header(title: string): void {
  console.log(pc.bold(title));
  console.log(pc.dim("─".repeat(Math.max(title.length * 2, 20))));
}

/**
 * key-value 对，key 暗色右对齐到固定宽度，value 正常色。
 * 用于 login / register / push 等结果展示。
 */
export function kv(key: string, value: string): void {
  const k = pc.dim(key.padEnd(10));
  console.log(`  ${k}  ${value}`);
}

/**
 * 下一步引导块。
 * 接收命令 + 描述的元组数组，输出带 → 的缩进列表。
 */
export function nextSteps(steps: Array<[cmd: string, desc: string]>): void {
  blank();
  console.log(pc.bold("下一步"));
  for (const [cmd, desc] of steps) {
    console.log(`  ${pc.cyan(cmd.padEnd(35))}  ${pc.dim(desc)}`);
  }
}

// ── 交互输入 ───────────────────────────────────────────────────────────────

/**
 * 交互式选择列表。
 *
 * @param title  提示标题
 * @param options  选项数组（label + 可选 hint）
 * @returns 选中的索引
 */
export async function promptSelect(
  title: string,
  options: Array<{ label: string; hint?: string }>,
): Promise<number> {
  blank();
  console.log(pc.bold(title));
  options.forEach((opt, i) => {
    const num = pc.cyan(`${i + 1}.`);
    const hint = opt.hint ? pc.dim(`  ${opt.hint}`) : "";
    console.log(`  ${num} ${opt.label}${hint}`);
  });

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      `\n${pc.dim("请选择")} [1-${options.length}]: `,
    );
    const idx = parseInt(answer.trim(), 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= options.length) {
      throw new Error("无效的选择");
    }
    return idx;
  } finally {
    rl.close();
  }
}

// ── 便捷色函数 ─────────────────────────────────────────────────────────────

export const color = {
  green: pc.green,
  red: pc.red,
  yellow: pc.yellow,
  cyan: pc.cyan,
  dim: pc.dim,
  bold: pc.bold,
  gray: pc.gray,
};
