/**
 * 生成 / 更新 skill 调用统计的 hook 脚本到 `~/.loom/hooks/skill-usage-tracker.cjs`。
 *
 * 由 Agent（daemon / foreground）启动时幂等调用。脚本零依赖、纯 Node CommonJS，
 * 被 AI 工具在 PreToolUse(Skill) 时 spawn：从 stdin 读取 hook JSON，解析被调用的
 * skill 名，append 一行到 `~/.loom/stats/<projectId>.events.log`，然后立即 exit 0。
 *
 * 设计约束（旁路、不影响主流程）：
 *   - 只做一次 append（O_APPEND 原子），不读 lock、不联网、不携带 token。
 *   - 任何异常都吞掉并 exit 0，绝不阻塞或干扰工具调用（监控型 hook）。
 *   - 无 stdout 输出 ⇒ 工具按默认 allow 继续。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { HOOKS_DIR, SKILL_TRACKER_SCRIPT } from "./paths.js";

const SCRIPT = `#!/usr/bin/env node
// Loom skill usage tracker (auto-generated). Do not edit.
// 宽匹配模式：挂在 PreToolUse(全部)，由脚本自行判断是否为一次 skill 调用。
// 命中 skill 调用 -> 记 events.log；同时把每次 hook 输入摘要写入 debug.log 便于排查
// 各工具真实的 hook_event_name / tool_name。脚本极轻、任何异常都吞掉并 exit 0。
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
function cap(file, line, max) {
  try {
    let prev = "";
    try { prev = fs.readFileSync(file, "utf8"); } catch (e) {}
    const next = prev + line;
    // 简单容量护栏：超过 max 字节则只保留尾部
    if (next.length > max) fs.writeFileSync(file, next.slice(next.length - max));
    else fs.appendFileSync(file, line);
  } catch (e) {}
}
try {
  const projectId = process.argv[2];
  if (!projectId) process.exit(0);
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch (e) { raw = ""; }
  let j = {};
  try { j = JSON.parse(raw || "{}"); } catch (e) { j = {}; }
  const dir = path.join(os.homedir(), ".loom", "stats");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  const evt = j.hook_event_name || j.hookEventName || "";
  const toolName = j.tool_name || j.toolName || "";
  const ti = (j && (j.tool_input || j.toolInput)) || {};

  // debug：记录事件名、工具名、tool_input 的键，便于确认各工具的真实触发形态
  const dbg = JSON.stringify({
    ts: Date.now(), event: evt, tool: toolName,
    tiKeys: ti && typeof ti === "object" ? Object.keys(ti) : [],
  }) + "\\n";
  cap(path.join(dir, projectId + ".debug.log"), dbg, 200000);

  // 判定是否为 skill 调用：
  //  1) 工具名像 skill（Skill / use_skill / run_skill 等）
  //  2) 或 tool_input 带 skill 名字段
  const toolIsSkill = /skill/i.test(String(toolName));
  let skill = ti.skill || ti.skill_name || ti.skillName || (toolIsSkill ? (ti.name || ti.command) : "");
  if (typeof skill !== "string") skill = String(skill || "");
  skill = skill.trim().replace(/^\\//, "");
  if (!skill) process.exit(0);

  const line = JSON.stringify({ skill: skill, ts: Date.now() }) + "\\n";
  fs.appendFileSync(path.join(dir, projectId + ".events.log"), line);
} catch (e) { /* swallow */ }
process.exit(0);
`;

export function ensureTrackerScript(): void {
  try {
    mkdirSync(HOOKS_DIR, { recursive: true });
    writeFileSync(SKILL_TRACKER_SCRIPT, SCRIPT, { mode: 0o755 });
  } catch {
    // 写脚本失败不应阻止 Agent 启动；统计只是旁路能力
  }
}
