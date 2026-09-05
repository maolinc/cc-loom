/**
 * Asset 表单工具 —— 默认值、按类型的 metadata 组装、payload 转换。
 *
 * 与 `@maolinc/cc-loom-shared` 的 assetCreateSchema / assetUpdateSchema 对齐：
 *  - files 至少 1 个，每个 { path, content } 非空
 *  - compatibleTools 至少 1 个
 *  - metadata 按 type 强校验（rule.globs / mcp.transport / hook.events+hooks / command.trigger）
 *
 * 第一阶段只覆盖各类型「必要」的 metadata 字段，复杂发布治理留待后续。
 */
import type { AssetType, AssetAuthBinding, TargetTool, Visibility } from "@maolinc/cc-loom-shared";
import { getSpec, slugify, templateFilesForType, type TemplateContext } from "./capabilitySpec.js";

export interface AssetFormFile {
  path: string;
  content: string;
  /** "base64" 表示 content 是二进制文件的 base64（来自整体上传）；省略为文本。 */
  encoding?: "base64";
}

export interface AssetFormState {
  name: string;
  alias: string;
  sourceUrl: string;
  type: AssetType;
  description: string;
  tags: string;
  visibility: Visibility;
  compatibleTools: TargetTool[];
  files: AssetFormFile[];
  /** 文件录入方式：手动编写 / 整体上传。两者二选一，不混用。 */
  fileMode: "manual" | "upload";
  /** 用户是否手动改动过文件区（决定切换类型/模式时是否重新播种模板，不参与提交）。 */
  filesTouched: boolean;
  // 各类型 metadata 的扁平字段（提交时按 type 收敛）
  ruleGlobs: string;
  hookEvents: string[];
  hookMatcher: string;
  hookType: string;
  hookCommand: string;
  commandTrigger: string;
  // 鉴权声明：绑定列表（ADR-0003，跨类型通用）。每个绑定 = 凭据名 × kind(env|path) × 目标。
  authBindings: AssetAuthBindingFormRow[];
}

/** 表单内的一行鉴权绑定（编辑态用空字符串占位，提交时收敛）。 */
export interface AssetAuthBindingFormRow {
  credentialName: string;
  kind: "env" | "path";
  envKey: string;
  path: string;
  authPageUrl: string;
}

/** 默认建议文件名（按类型规范）。 */
export function defaultFileName(type: AssetType, name: string): string {
  return getSpec(type).primaryFile(slugify(name));
}

/** 用当前表单上下文为某类型生成模板文件（类型切换 / 初始化时使用）。 */
export function seedFiles(type: AssetType, form: Partial<AssetFormState>): AssetFormFile[] {
  const ctx: TemplateContext = {
    name: form.name?.trim() ?? "",
    slug: slugify(form.name ?? ""),
    description: form.description?.trim() ?? "",
    globs: form.ruleGlobs?.trim() || undefined,
  };
  return templateFilesForType(type, ctx);
}

export function emptyAssetForm(): AssetFormState {
  const base: AssetFormState = {
    name: "",
    alias: "",
    sourceUrl: "",
    type: "skill",
    description: "",
    tags: "",
    visibility: "private",
    compatibleTools: ["cursor", "codebuddy", "claudecode"],
    files: [],
    fileMode: "manual",
    filesTouched: false,
    ruleGlobs: "",
    hookEvents: ["PreToolUse"],
    hookMatcher: "",
    hookType: "command",
    hookCommand: "",
    commandTrigger: "",
    authBindings: [],
  };
  base.files = seedFiles(base.type, base);
  return base;
}

/** 把后端 Asset 详情回填进表单（编辑态）。 */
export function assetToForm(asset: any): AssetFormState {
  const base = emptyAssetForm();
  const md = asset.metadata || {};
  return {
    ...base,
    name: asset.name ?? "",
    alias: asset.alias ?? "",
    sourceUrl: asset.sourceUrl ?? "",
    type: asset.type ?? "skill",
    description: asset.description ?? "",
    tags: (asset.tags ?? []).join(", "),
    visibility: asset.visibility ?? "private",
    compatibleTools: asset.compatibleTools ?? base.compatibleTools,
    // 编辑态视为已有内容，不再用模板覆盖。
    filesTouched: true,
    files:
      (asset.files ?? []).map((f: any) => ({ path: f.path, content: f.content ?? "", encoding: f.encoding ?? undefined })) || base.files,
    ruleGlobs: Array.isArray(md.globs) ? md.globs.join(", ") : "",
    hookEvents: Array.isArray(md.events) && md.events.length > 0
      ? md.events
      : (md.event ? [md.event] : ["PreToolUse"]),
    hookMatcher: md.matcher ?? "",
    hookType: md.hooks?.[0]?.type ?? "command",
    hookCommand: md.hooks?.[0]?.command ?? "",
    commandTrigger: md.trigger ?? "",
    authBindings: (asset.auth?.bindings ?? []).map((b: AssetAuthBinding): AssetAuthBindingFormRow => ({
      credentialName: b.credentialName ?? "",
      kind: b.kind,
      envKey: b.envKey ?? "",
      path: b.path ?? "",
      authPageUrl: b.authPageUrl ?? "",
    })),
  };
}

function buildMetadata(form: AssetFormState): Record<string, unknown> {
  switch (form.type) {
    case "rule":
      return {
        globs: form.ruleGlobs
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    case "mcp":
      // 传输方式 / 命令 / URL 全部由 mcp.json 文件内容承载；这里只推断 transport（schema 必填字段）
      return { transport: inferMcpTransport(form.files[0]?.content ?? "") };
    case "hook":
      return {
        events: form.hookEvents,
        ...(form.hookMatcher.trim() ? { matcher: form.hookMatcher.trim() } : {}),
        hooks: [
          {
            type: form.hookType.trim() || "command",
            ...(form.hookCommand.trim() ? { command: form.hookCommand.trim() } : {}),
          },
        ],
      };
    case "command":
      return { trigger: form.commandTrigger.trim() };
    default:
      return {};
  }
}

/** 表单校验，返回错误信息（null = 通过）。 */
export function validateAssetForm(form: AssetFormState): string | null {
  if (!form.name.trim()) return "请输入名称";
  const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
  if (tags.length > 5) return "标签最多 5 个";
  if (form.compatibleTools.length === 0) return "请至少选择一个兼容工具";
  const files = form.files.filter((f) => f.path.trim() && f.content.trim());
  if (files.length === 0) return "请至少添加一个包含路径与内容的文件";
  if (form.type === "skill" && !files.some((f) => f.path.trim() === "SKILL.md"))
    return "Skill 必须包含一个 SKILL.md 文件（位于技能目录根）";
  if (form.type === "rule" && !form.ruleGlobs.trim()) return "Rule 需要至少一个匹配 glob";
  if (form.type === "mcp") {
    const cfg = files[0];
    try {
      JSON.parse(cfg?.content ?? "");
    } catch {
      return "MCP 配置不是合法 JSON";
    }
    // 传输方式 / 命令 / URL 均由 mcp.json 文件内容承载，不在此校验
  }
  if (form.type === "hook" && form.hookEvents.length === 0) return "Hook 需要至少一个事件";
  if (form.type === "command" && !form.commandTrigger.trim()) return "Command 需要触发词，如 /review";
  // 鉴权绑定校验：每行按 kind 校验目标字段；path 绑定仅对 mcp 有效。
  for (const [i, b] of form.authBindings.entries()) {
    if (!b.credentialName.trim()) return `第 ${i + 1} 条鉴权绑定的凭据名不能为空`;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(b.credentialName.trim())) return `第 ${i + 1} 条凭据名只能包含字母、数字、下划线、连字符，且不以数字开头`;
    if (b.kind === "env") {
      if (!b.envKey.trim()) return `第 ${i + 1} 条 env 绑定必须填写环境变量名`;
      if (!/^[A-Z_][A-Z0-9_]*$/.test(b.envKey.trim())) return `第 ${i + 1} 条环境变量名只能包含大写字母、数字、下划线，且不以数字开头`;
    } else {
      if (!b.path.trim()) return `第 ${i + 1} 条 path 绑定必须填写注入路径`;
      if (form.type !== "mcp") return `第 ${i + 1} 条 path 绑定仅适用于 mcp 能力`;
    }
    if (b.authPageUrl.trim() && !/^https?:\/\//.test(b.authPageUrl.trim())) return `第 ${i + 1} 条鉴权页面地址需为 http(s):// 开头的 URL`;
  }
  // 凭据名不重复
  const credNames = form.authBindings.map((b) => b.credentialName.trim());
  if (new Set(credNames).size !== credNames.length) return "凭据名不能重复";
  return null;
}

/**
 * 从 mcp.json 文件内容推断传输方式（schema 的 transport 字段必填，但 UI 不再采集）。
 *
 * 同时识别两种写法：
 * - 标准 `{ mcpServers: { <key>: { command, args } | { type, url } } }`（表单 / 安装侧格式）
 * - 顶层 `{ command }` 或 `{ type, url }`（与 server 侧 extract-metadata 一致）
 *
 * 解析失败或无法判别时回退到 stdio（与 server 侧 mcpMetadata 的默认一致）。
 */
export function inferMcpTransport(content: string): "stdio" | "http" | "sse" {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "stdio";
  }
  if (!parsed || typeof parsed !== "object") return "stdio";
  const servers = parsed.mcpServers;
  if (servers && typeof servers === "object") {
    const first = Object.values(servers)[0];
    if (first && typeof first === "object") {
      if (typeof (first as any).command === "string") return "stdio";
      if ((first as any).type === "sse") return "sse";
      if ((first as any).type === "http") return "http";
    }
  }
  if (typeof parsed.command === "string") return "stdio";
  if (parsed.type === "sse") return "sse";
  if (parsed.type === "http") return "http";
  return "stdio";
}

/** 转成 create/update 请求体。 */
export function formToPayload(form: AssetFormState, mode: "create" | "update") {
  const files = form.files
    .filter((f) => f.path.trim() && f.content.trim())
    .map((f) => ({ path: f.path.trim(), content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) }));
  const tags = form.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const base: {
    name: string;
    alias: string;
    sourceUrl: string;
    description: string;
    tags: string[];
    files: { path: string; content: string; encoding?: "base64" }[];
    compatibleTools: TargetTool[];
    visibility: Visibility;
    metadata: Record<string, unknown>;
    auth: { bindings: Array<{ credentialName: string; kind: "env" | "path"; envKey?: string; path?: string; authPageUrl?: string }> };
  } = {
    name: form.name.trim(),
    alias: form.alias.trim(),
    sourceUrl: form.sourceUrl.trim(),
    description: form.description.trim(),
    tags,
    files,
    compatibleTools: form.compatibleTools,
    visibility: form.visibility,
    metadata: buildMetadata(form),
    auth: {
      bindings: form.authBindings
        .map((b) => ({
          credentialName: b.credentialName.trim(),
          kind: b.kind,
          ...(b.kind === "env" && b.envKey.trim() ? { envKey: b.envKey.trim() } : {}),
          ...(b.kind === "path" && b.path.trim() ? { path: b.path.trim() } : {}),
          ...(b.authPageUrl.trim() ? { authPageUrl: b.authPageUrl.trim() } : {}),
        })),
    },
  };
  // create 必须带 type；update 不改 type（保持后端按字段宽松校验）。
  return mode === "create" ? { ...base, type: form.type } : base;
}
