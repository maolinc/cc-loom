/**
 * 能力创建规范（capability spec）—— 每种 Asset 类型的「厂商规范」在创建侧的落地。
 *
 * 背景：六类能力的文件组织方式并不相同：
 *   - skill / hook   → 目录形态（主文件 + 可附带脚本、参考资料、子目录），需要支持整体上传
 *   - rule / command / agent → 单文件 Markdown（带 frontmatter）
 *   - mcp            → 单个 JSON 配置（安装时多个 MCP 合并进一个 mcp.json）
 *
 * 本模块把这些差异收敛成数据，驱动创建弹框的：
 *   1. 规范提示（hint）
 *   2. 初始模板文件（template）
 *   3. 文件编辑器布局（layout）与上传方式（allowFolder / accept）
 *
 * 真正的安装路径/合并语义仍由 packages/adapter 决定，这里只负责「创建时录入什么」。
 */
import type { AssetType } from "@maolinc/cc-loom-shared";

export type LayoutKind = "single" | "directory" | "config";

export interface TemplateContext {
  name: string;
  slug: string;
  description: string;
  /** rule 的 globs（逗号分隔原文），用于 frontmatter 占位 */
  globs?: string;
}

export interface CapabilitySpec {
  /** 文件组织方式：单文件 / 目录 / JSON 配置 */
  layout: LayoutKind;
  /** 主文件默认名（传入 slug） */
  primaryFile: (slug: string) => string;
  /** 是否允许「上传文件夹」（仅目录形态有意义） */
  allowFolder: boolean;
  /** 上传文件时的 accept 过滤（不传则不限） */
  accept?: string;
  /** 创建弹框顶部的规范说明 */
  hint: string;
  /** 初始模板文件（类型选定时播种） */
  template: (ctx: TemplateContext) => { path: string; content: string }[];
}

/** 与后端口径一致的 slug（仅前端展示/默认名用）。 */
export function slugify(name: string): string {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const skillTemplate = ({ name, description }: TemplateContext) => [
  {
    path: "SKILL.md",
    content: `---
name: ${name || "my-skill"}
description: ${description || "一句话说明这个 Skill 的用途与触发时机"}
---

# ${name || "My Skill"}

## 用途
说明这个 Skill 解决什么问题。

## 何时使用
描述应当触发该能力的场景。

## 使用步骤
1. ...
2. ...
`,
  },
];

const ruleTemplate = ({ description, globs }: TemplateContext) => [
  {
    path: "rule.md",
    content: `---
description: ${description || "说明这条规则约束什么"}
globs: ${globs || "**/*"}
alwaysApply: false
---

在此填写规则正文：约束 AI 的行为、代码风格或安全边界。
`,
  },
];

const mcpTemplate = ({ slug }: TemplateContext) => [
  {
    path: "mcp.json",
    content: `{
  "mcpServers": {
    "${slug || "my-server"}": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
`,
  },
];

const hookTemplate = (_ctx: TemplateContext) => [
  {
    path: "hook.sh",
    content: `#!/usr/bin/env bash
set -euo pipefail

# Hook 脚本：事件 JSON 通过 stdin 传入。
# 退出码 0 放行；非 0 表示拦截（具体语义参见各厂商 Hook 文档）。

input=$(cat)
echo "$input" >/dev/null
`,
  },
];

const commandTemplate = ({ description }: TemplateContext) => [
  {
    path: "command.md",
    content: `---
description: ${description || "说明这个命令做什么"}
argument-hint: ""
---

在此编写命令的提示词正文，可使用 $ARGUMENTS 接收用户输入。
`,
  },
];

const agentTemplate = ({ name, description }: TemplateContext) => [
  {
    path: "agent.md",
    content: `---
name: ${name || "my-agent"}
description: ${description || "说明这个子代理擅长处理的任务"}
tools: []
---

你是一个专注于 …… 的子代理。

## 职责
- ...

## 工作方式
- ...
`,
  },
];

export const CAPABILITY_SPECS: Record<AssetType, CapabilitySpec> = {
  skill: {
    layout: "directory",
    primaryFile: () => "SKILL.md",
    allowFolder: true,
    hint: "Skill 为目录形态：主文件 SKILL.md（含 name/description frontmatter），可附带脚本、参考文档等子文件或子目录。安装时整体写入 skills/<名称>/，因此可直接「上传文件夹」。",
    template: skillTemplate,
  },
  rule: {
    layout: "single",
    primaryFile: (slug) => `${slug || "rule"}.md`,
    allowFolder: false,
    accept: ".md,.mdc,.markdown,.txt",
    hint: "Rule 为单文件 Markdown：frontmatter 声明 description / globs（匹配范围）/ alwaysApply。Cursor 使用 .mdc，其余厂商使用 .md，由适配器处理扩展名。",
    template: ruleTemplate,
  },
  mcp: {
    layout: "config",
    primaryFile: () => "mcp.json",
    allowFolder: false,
    accept: ".json,application/json",
    hint: "MCP 为 JSON 配置：可填写完整的 { \"mcpServers\": { ... } }，或单个 server 定义。多个 MCP 能力会在安装时合并进同一个 mcp.json。",
    template: mcpTemplate,
  },
  hook: {
    layout: "directory",
    primaryFile: () => "hook.sh",
    allowFolder: true,
    hint: "Hook 为目录形态：上方选择触发事件（可多选，安装时全部注册）/ Matcher / 执行命令（写入各厂商的 Hook 注册表），下方提供可执行脚本。安装时脚本写入 hooks/<名称>/，可「上传文件夹」携带多个脚本。",
    template: hookTemplate,
  },
  command: {
    layout: "single",
    primaryFile: (slug) => `${slug || "command"}.md`,
    allowFolder: false,
    accept: ".md,.markdown,.txt",
    hint: "Command 为单文件 Markdown：通过 /触发词 调用，frontmatter 可声明 description / argument-hint，正文是提示词模板。Codex 的 prompts 位于用户级目录，超出项目安全边界故不分发。",
    template: commandTemplate,
  },
  agent: {
    layout: "single",
    primaryFile: (slug) => `${slug || "agent"}.md`,
    allowFolder: false,
    accept: ".md,.markdown,.txt",
    hint: "Agent（子代理）为单文件 Markdown：frontmatter 声明 name / description / tools，正文是子代理系统提示词。Codex 无原生 Agent，安装时跳过。",
    template: agentTemplate,
  },
};

export function getSpec(type: AssetType): CapabilitySpec {
  return CAPABILITY_SPECS[type];
}

/** 用类型模板播种初始文件。 */
export function templateFilesForType(
  type: AssetType,
  ctx: TemplateContext,
): { path: string; content: string }[] {
  return getSpec(type).template(ctx);
}
