/**
 * `loom push` —— 把本地厂商目录的内容推送到平台，创建或覆盖一个能力集。
 *
 * 流程：
 * 1. 检查登录配置
 * 2. 检测当前目录的厂商目录（.cursor/.codebuddy/.codex/.claude）
 * 3. 多个时交互选择（或 --tool 指定）
 * 4. 获取用户邮箱，提取用户名
 * 5. 解析厂商目录为 ImportedAsset[]
 * 6. 确定能力集名（默认 用户名/项目目录名，或 --name）
 * 7. POST /api/push
 * 8. 打印结果
 */
import { resolve, basename } from "node:path";
import type { SessionUser, TargetTool, ImportedAsset, PushResult } from "@maolinc/cc-loom-shared";
import { TARGET_DIRS, TARGET_TOOL_LABELS } from "@maolinc/cc-loom-shared";
import { getValidConfig } from "../lib/config.js";
import { api, ApiError } from "../lib/api.js";
import { detectTargets } from "../lib/detect.js";
import { parseVendorDir } from "../lib/vendor-reader.js";
import { fail } from "../lib/errors.js";
import { ok, info, kv, nextSteps, promptSelect, color } from "../lib/ui.js";

export interface PushOptions {
  tool?: string;
  name?: string;
  visibility?: string;
}

export async function pushCommand(opts: PushOptions): Promise<void> {
  const config = getValidConfig();
  if (!config) {
    fail("尚未登录，请先执行: loom login --endpoint <url> --token <token>");
  }

  const cwd = resolve(process.cwd());

  // 1. 检测厂商目录
  const detected = detectTargets(cwd);
  if (detected.length === 0) {
    fail("未检测到任何厂商目录（.cursor/.codebuddy/.codex/.claude），请在包含这些目录的项目中执行");
  }

  // 2. 选择厂商
  let tool: TargetTool;
  if (opts.tool) {
    const requested = opts.tool as TargetTool;
    if (!detected.includes(requested)) {
      fail(`未检测到 ${TARGET_TOOL_LABELS[requested]} 目录（${TARGET_DIRS[requested]}）`);
    }
    tool = requested;
  } else if (detected.length === 1) {
    tool = detected[0]!;
  } else {
    const idx = await promptSelect(
      "检测到多个厂商目录",
      detected.map((t) => ({
        label: color.bold(TARGET_TOOL_LABELS[t]),
        hint: `${TARGET_DIRS[t]}/`,
      })),
    );
    tool = detected[idx]!;
  }

  // 3. 获取用户信息
  let me: SessionUser;
  try {
    me = await api<SessionUser>(config, "/api/auth/me");
  } catch (err) {
    if (err instanceof ApiError && err.code === "auth") {
      fail("Token 无效或已过期，请到 Web 设置页重新生成后再 loom login");
    }
    throw err;
  }

  const username = me.email.split("@")[0] || "user";
  const projectDir = basename(cwd);

  // 4. 确定能力集名
  const name = opts.name || `${username}/${projectDir}`;

  // 5. 解析厂商目录
  const vendorPath = resolve(cwd, TARGET_DIRS[tool]);
  let assets: ImportedAsset[];
  try {
    assets = await parseVendorDir(vendorPath, tool, cwd);
  } catch (err) {
    fail(`解析厂商目录失败：${(err as Error).message}`);
  }

  if (assets.length === 0) {
    fail(`${TARGET_TOOL_LABELS[tool]} 目录中没有可识别的能力文件（skills/rules/commands/agents/hooks/mcp.json）`);
  }

  // 打印解析摘要
  const typeCounts: Record<string, number> = {};
  for (const a of assets) {
    typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
  }
  const summary = Object.entries(typeCounts)
    .map(([t, n]) => `${color.cyan(t)}: ${n}`)
    .join("  ");
  info(`解析到 ${color.bold(String(assets.length))} 个能力  ${summary}`);

  // 6. 推送
  const visibility = (opts.visibility as "public" | "private") || "private";
  const result = await api<PushResult>(config, "/api/push", {
    method: "POST",
    body: JSON.stringify({ name, visibility, targetTool: tool, assets }),
  });

  // 7. 打印结果
  ok(`${result.created ? "已创建" : "已覆盖"}能力集：${color.bold(result.capabilitySetName)}`);
  kv("ID", result.capabilitySetId);
  kv("Assets", String(result.assetCount));
  kv("Tool", TARGET_TOOL_LABELS[tool]);
  kv("Visibility", visibility);
  nextSteps([
    ["Web 能力集列表", "查看并安装到项目"],
  ]);
}
