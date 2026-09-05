/**
 * `loom unregister` —— 注销当前目录，抹掉该项目的全部痕迹。
 *
 * 流程：
 * 1. 在本地 `~/.loom/projects/` 中按 normalizedPath 匹配当前 cwd
 * 2. 调 `DELETE /api/projects/:id`（server 硬删项目行 + 关联表 + adopt 产物）
 * 3. 清本地 `~/.loom` 下该项目的全部痕迹：
 *    projects/<id>.json、locks/<id>.json、disabled/<id>/、stats/<id>.*
 * 4. 不删 .cursor 等工具目录（用户可能要保留）
 */
import { resolve } from "node:path";
import { getValidConfig } from "../lib/config.js";
import { api, ApiError } from "../lib/api.js";
import { findProjectByPath, removeProject } from "../lib/projects.js";
import { removeLock } from "../lib/locks.js";
import { clearDisabledForProject } from "../lib/reconcile-runner.js";
import { clearProjectSkillStats } from "../lib/skill-stats.js";
import { fail } from "../lib/errors.js";
import { ok, warn, kv, tip, blank } from "../lib/ui.js";

interface UnregisterOptions {
  /** 远端调用失败时仍清理本地缓存。 */
  force?: boolean;
}

export async function unregisterCommand(options: UnregisterOptions = {}): Promise<void> {
  const config = getValidConfig();
  if (!config) {
    fail("尚未登录，请先执行: loom login");
  }

  const cwd = resolve(process.cwd());
  const local = findProjectByPath(cwd);
  if (!local) {
    fail(`未找到当前目录的注册记录：${cwd}\n  执行 loom register 先注册，或确认你在正确的项目根目录。`);
  }

  try {
    await api<{ success: boolean }>(config, `/api/projects/${local.id}`, { method: "DELETE" });
  } catch (err) {
    if (err instanceof ApiError && options.force) {
      warn(`远端调用失败但 --force 已指定，仍清理本地：${err.message}`);
    } else if (err instanceof ApiError) {
      fail(`注销失败：${err.message}（用 --force 强制清理本地缓存）`);
    } else {
      throw err;
    }
  }

  // 抹掉本机 ~/.loom 下该项目的全部痕迹（与 server 硬删对应）。
  removeProject(local.id);
  removeLock(local.id);
  clearDisabledForProject(local.id);
  clearProjectSkillStats(local.id);

  ok(`项目已注销：${local.projectName}`);
  kv("Path", local.normalizedPath);
  blank();
  tip("已清理本地记录、lock、隔离区与 skill 统计");
  tip("工具目录（.cursor/.codebuddy/.codex/.claude）未被删除");
  tip("如需清理工具目录文件，请手动删除或重新安装别的 Workspace 覆盖");
}
