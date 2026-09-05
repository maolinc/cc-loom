/**
 * `loom register` —— 把当前目录注册到 Loom。
 *
 * 与旧版的差异：
 * - 用 `detectTargets` 复用 `@maolinc/cc-loom-shared.TARGET_DIRS`，修复旧版返回 `claude`
 *   这种非 TargetTool 字面量、被服务端 zod 拒掉的 bug。
 * - 注册成功后落本地 `~/.loom/projects/<id>.json`，满足产品文档 §9.6.3。
 * - 强制要求已 `loom start` 过一次（拿到 deviceId）。
 * - 输出包含当前账号 email，提示 Web 端要用同一邮箱登录才能看到。
 */
import { resolve } from "node:path";
import { hostname } from "node:os";
import type { Project, ProjectRegisterInput, SessionUser } from "@maolinc/cc-loom-shared";
import { getValidConfig } from "../lib/config.js";
import { api, ApiError } from "../lib/api.js";
import { detectTargets } from "../lib/detect.js";
import { writeProject, type LocalProjectRecord } from "../lib/projects.js";
import { fail } from "../lib/errors.js";
import { ok, info, kv, nextSteps, color } from "../lib/ui.js";

export async function registerCommand(): Promise<void> {
  const config = getValidConfig();
  if (!config) {
    fail("尚未登录，请先执行: loom login --endpoint <url> --token <token>");
  }
  if (!config.deviceId) {
    fail("尚未绑定设备，请先执行: loom start （它会自动注册设备）");
  }

  const cwd = resolve(process.cwd());
  const projectName = cwd.split(/[\\/]/).filter(Boolean).pop() || hostname();
  const detected = detectTargets(cwd);

  // 先拉一次 me，让用户在输出里看到当前 token 绑定的邮箱（多账号场景的关键防呆）。
  let email: string | null = null;
  try {
    const me = await api<SessionUser>(config, "/api/auth/me");
    email = me?.email ?? null;
  } catch (err) {
    if (err instanceof ApiError && err.code === "auth") {
      fail("Token 无效或已过期，请到 Web 设置页重新生成后再 loom login");
    }
    // 网络/服务端故障下继续走，下一步 register 会再报一次错
  }

  if (detected.length > 0) {
    info(`检测到工具目录：${detected.map((t) => color.cyan(t)).join(", ")}`);
  } else {
    info("未检测到任何工具目录（可在 Web 安装时勾选目标，安装时自动创建）");
  }

  const body: ProjectRegisterInput = {
    deviceId: config.deviceId,
    projectName,
    normalizedPath: cwd,
    detectedTargets: detected,
  };

  const project = await api<Project>(config, "/api/projects/register", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const record: LocalProjectRecord = {
    ...project,
    endpoint: config.endpoint,
  };
  writeProject(record);

  ok(`项目已注册：${color.bold(project.projectName)}`);
  kv("ID", project.id);
  kv("Path", project.normalizedPath);
  kv("Status", project.status);
  kv("Targets", (project.detectedTargets || []).join(", ") || color.dim("无"));
  if (email) {
    kv("Account", email);
  }
  if (email) {
    nextSteps([
      ["Web 端登录", `用 ${email} 登录后进入「本地控制台」`],
    ]);
  } else {
    nextSteps([
      ["Web 端登录", "用同一账号登录后进入「本地控制台」查看项目"],
    ]);
  }
}
