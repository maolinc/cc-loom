/**
 * 临时项目目录沙箱。从 fixture 模板复制，用完由测试 afterEach 清理。
 */
import { cpSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES_DIR } from "./env.js";

/**
 * 创建临时项目目录。若指定 template，从 fixtures/projects/<template>/ 复制。
 * .gitkeep 文件（仅用于 git 占位）不会被复制。
 * 返回绝对路径。调用方负责 rmSync 清理。
 */
export function makeProject(template?: string): string {
  const root = mkdtempSync(join(tmpdir(), "loom-proj-"));
  if (template) {
    const src = join(FIXTURES_DIR, "projects", template);
    if (existsSync(src)) {
      cpSync(src, root, {
        recursive: true,
        filter: (s) => !s.endsWith(".gitkeep"),
      });
    }
  }
  return root;
}

/** 清理临时项目目录。 */
export function cleanupProject(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
