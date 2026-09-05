/**
 * 路径白名单 + 原子文件写入。
 *
 * 安全边界（产品文档 §9.12.2）：
 *   Local Agent 只允许在已注册项目目录内、且仅顶层为 `.cursor` / `.codebuddy`
 *   / `.codex` / `.claude` 的子树写入。任何越界路径必须抛错且不写入。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { TARGET_DIRS } from "@maolinc/cc-loom-shared";

/** 顶层目录白名单（去掉 mcp 这类空串）。 */
const ALLOWED_TOP_DIRS = new Set(
  Object.values(TARGET_DIRS).filter((d): d is string => d.length > 0),
);

/**
 * 项目根直接落地的白名单文件。Claude Code 官方明确要求 `.mcp.json` 必须放在项目根，
 * 不在 `.claude/` 子树（https://code.claude.com/docs/en/debug-your-config）。
 * 这里维护一份精确白名单，避免放宽到任意项目根写入。
 */
const ALLOWED_ROOT_FILES = new Set([".mcp.json"]);

export class UnsafePathError extends Error {
  constructor(public readonly relPath: string, reason: string) {
    super(`不安全的路径 "${relPath}": ${reason}`);
    this.name = "UnsafePathError";
  }
}

/**
 * 把 server 下发的相对路径解析到 projectRoot 下的绝对路径。
 *
 * 拒绝规则：
 * 1. 绝对路径
 * 2. 含 `..` 跳出 projectRoot
 * 3. 顶层目录不在 ALLOWED_TOP_DIRS（满足 §9.12.2）
 */
export function resolveSafe(projectRoot: string, relPath: string): string {
  if (!relPath || isAbsolute(relPath)) {
    throw new UnsafePathError(relPath, "必须是相对路径");
  }
  const normalized = normalize(relPath);
  if (normalized.startsWith("..")) {
    throw new UnsafePathError(relPath, "不允许 .. 跳出项目根");
  }
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  const top = segments[0];
  // 单段顶层文件：仅允许 ALLOWED_ROOT_FILES 中显式列出的（如 Claude Code 官方 .mcp.json）
  if (segments.length === 1 && top) {
    if (!ALLOWED_ROOT_FILES.has(top)) {
      throw new UnsafePathError(
        relPath,
        `顶层文件仅允许 ${[...ALLOWED_ROOT_FILES].join(" / ")}，其余路径必须以 ${[...ALLOWED_TOP_DIRS].join(" / ")} 开头`,
      );
    }
    const abs = resolve(projectRoot, normalized);
    const rel = relative(projectRoot, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new UnsafePathError(relPath, "解析后落在项目根之外");
    }
    return abs;
  }
  if (!top || !ALLOWED_TOP_DIRS.has(top)) {
    throw new UnsafePathError(
      relPath,
      `顶层目录必须是 ${[...ALLOWED_TOP_DIRS].join(" / ")} 之一`,
    );
  }
  const abs = resolve(projectRoot, normalized);
  const rel = relative(projectRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UnsafePathError(relPath, "解析后落在项目根之外");
  }
  // 二次校验：rel 的首段必须仍是白名单目录或允许的根文件（防符号链接绕过）
  const relSegments = rel.split(sep).filter(Boolean);
  const relTop = relSegments[0];
  if (!relTop) {
    throw new UnsafePathError(relPath, "解析后顶层为空");
  }
  if (relSegments.length === 1) {
    if (!ALLOWED_ROOT_FILES.has(relTop)) {
      throw new UnsafePathError(relPath, "解析后顶层文件不在白名单内");
    }
  } else if (!ALLOWED_TOP_DIRS.has(relTop)) {
    throw new UnsafePathError(relPath, "解析后顶层目录不在白名单内");
  }
  return abs;
}

export function writeFileAtomic(abs: string, content: string, encoding?: "base64"): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  // base64 → 解码成原始字节写入（二进制文件）；否则按 UTF-8 文本写入。
  if (encoding === "base64") {
    writeFileSync(tmp, Buffer.from(content, "base64"));
  } else {
    writeFileSync(tmp, content, "utf-8");
  }
  renameSync(tmp, abs);
}

/**
 * 按原始字节移动文件（保留二进制内容），目标父目录自动创建。
 * 用于能力开关在 vendor 目录与隔离区之间搬家——不能用 utf-8 文本往返，
 * 否则二进制文件会被破坏。
 */
export function moveFileBinarySafe(srcAbs: string, dstAbs: string): void {
  mkdirSync(dirname(dstAbs), { recursive: true });
  const tmp = `${dstAbs}.${process.pid}.tmp`;
  copyFileSync(srcAbs, tmp);
  renameSync(tmp, dstAbs);
  unlinkSync(srcAbs);
}

export function readIfExists(abs: string): string | null {
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf-8");
}

/**
 * 与 `writeFileAtomic` 对称的安全读：先用 `resolveSafe` 校验白名单+逃逸，
 * 然后调 `readIfExists`。供 `project:read_file` 处理器使用，确保 server 只能
 * 通过 agent 读到 §9.12.2 边界内的文件，不会因为 server 端 bug 误读到任意路径。
 */
export function readFileSafe(projectRoot: string, relPath: string): string | null {
  const abs = resolveSafe(projectRoot, relPath);
  return readIfExists(abs);
}

export function removeIfExists(abs: string): void {
  if (existsSync(abs)) unlinkSync(abs);
}

/**
 * 删除某个相对项目根的文件，并把空了的父目录一路向上清掉，直到遇到非空目录或
 * 走出项目根（含 ALLOWED_TOP_DIRS 顶层本身）。
 *
 * 解决症状：切换 / 卸载 Workspace 后，文件被清掉但 `.cursor/skills/`、
 * `.cursor/rules/typescript/` 等空目录仍残留，scanner 会把它们以「(空)」形态
 * 渲染到 UI 上，给人「还有内容」的错觉。
 *
 * 容错：任何 ENOENT / ENOTEMPTY 都吞掉；这只是清理性操作，不应阻塞主流程。
 */
export function removeFileAndPruneEmptyDirs(projectRoot: string, relPath: string): void {
  const abs = resolveSafe(projectRoot, relPath);
  if (existsSync(abs)) unlinkSync(abs);
  pruneEmptyAncestors(projectRoot, dirname(abs));
}

/**
 * 从 dir 向上删除空目录，直到：
 *  - 目录非空；
 *  - 目录就是 projectRoot；
 *  - 目录已经在 projectRoot 之外（保险检查）。
 *
 * 不依赖 ALLOWED_TOP_DIRS 白名单：本函数只在 dir 已经位于 projectRoot 内时
 * 调用（删除时由 resolveSafe 保证），向上 prune 的过程不会跨出去。
 */
export function pruneEmptyAncestors(projectRoot: string, dir: string): void {
  const root = resolve(projectRoot);
  let cursor = resolve(dir);
  while (cursor !== root) {
    const rel = relative(root, cursor);
    if (rel.startsWith("..") || isAbsolute(rel)) return; // 已跑出 root，停
    let entries: string[];
    try {
      entries = readdirSync(cursor);
    } catch {
      return; // 目录已不存在或不可读，停
    }
    if (entries.length > 0) return;
    try {
      rmdirSync(cursor);
    } catch {
      return; // 并发 / 权限 / 仍有不可见文件 → 不再向上
    }
    cursor = dirname(cursor);
  }
}

/** 把 projectRoot 与相对路径拼起来；调用方已用 resolveSafe 校验过时的便捷函数。 */
export function joinSafe(projectRoot: string, relPath: string): string {
  return resolveSafe(projectRoot, relPath);
}
