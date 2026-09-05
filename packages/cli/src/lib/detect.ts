/**
 * 探测项目目录中已存在的 AI 工具子目录。
 * 用 `@maolinc/cc-loom-shared` 的 `TARGET_DIRS` 单一来源映射，避免在 CLI 端重复维护。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { TARGET_DIRS, TARGET_TOOLS, type TargetTool } from "@maolinc/cc-loom-shared";

export function detectTargets(cwd: string): TargetTool[] {
  return TARGET_TOOLS.filter((t) => {
    const dir = TARGET_DIRS[t];
    return dir.length > 0 && existsSync(resolve(cwd, dir));
  });
}
