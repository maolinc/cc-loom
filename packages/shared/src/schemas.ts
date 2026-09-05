import { z } from "zod";
import {
  ASSET_TYPES,
  AUTH_BINDING_KINDS,
  CREDENTIAL_AXES,
  POLL_INTERVAL_OPTIONS,
  PROJECT_STATUSES,
  SYNC_POLICIES,
  TARGET_TOOLS,
  USER_ROLES,
  VISIBILITY_OPTIONS,
} from "./constants.js";
import type { AssetType, AuthBindingKind, UserRole } from "./constants.js";

export const emailSchema = z.string().email("请输入有效的邮箱地址");

// 登录用：仅校验非空。不在登录入口做长度校验，避免向攻击者泄露密码长度规则，
// 也兼容历史/迁移账号可能存在的非策略密码。长度策略在「设置/修改密码」时强制。
export const passwordSchema = z.string().min(1, "密码不能为空");

// 新注册及修改密码：强制长度策略，登录旧账号仍只校验非空以支持迁移。
export const passwordPolicySchema = z
  .string()
  .min(6, "密码至少需要 6 位")
  .max(128, "密码不能超过 128 位");

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordPolicySchema,
});

// 各 Asset 类型的 metadata 形态（单一来源）。按 Asset.type 判别，杜绝
// 「mcp 传空 metadata 蒙混」之类的错配。详见 docs/asset-uniqueness-design.md §8.4。
const skillMetadataSchema = z.object({}).strict();
const agentMetadataSchema = z.object({}).strict();
const ruleMetadataSchema = z.object({ globs: z.array(z.string()) }).strict();
const mcpMetadataSchema = z.object({
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  url: z.string().optional(),
}).strict();
const hookMetadataSchema = z.object({
  event: z.string().min(1).optional(),
  events: z.array(z.string().min(1)).min(1).optional(),
  matcher: z.string().optional(),
  hooks: z.array(z.object({ type: z.string() }).passthrough()).min(1),
  passthrough: z.literal(true).optional(),
  registrations: z.array(z.object({
    event: z.string().min(1),
    entry: z.record(z.string(), z.unknown()),
  })).optional(),
}).strict().refine(
  (md) => (md.events && md.events.length > 0) || !!md.event,
  { message: "hook 需要至少一个事件（events 或 event）" },
);
const commandMetadataSchema = z.object({ trigger: z.string() }).strict();

/** type → 对应 metadata schema。供按 Asset.type 强校验。 */
const metadataSchemaByType: Record<AssetType, z.ZodTypeAny> = {
  skill: skillMetadataSchema,
  agent: agentMetadataSchema,
  rule: ruleMetadataSchema,
  mcp: mcpMetadataSchema,
  hook: hookMetadataSchema,
  command: commandMetadataSchema,
};

// 字段级宽松校验（不绑定 type）——用于 update 只改 metadata 不改 type 时的兜底，
// 以及向后兼容历史数据。精确的按 type 校验在 assetCreate/Update 的 superRefine 内做。
export const assetMetadataSchema = z.union([
  skillMetadataSchema,
  ruleMetadataSchema,
  mcpMetadataSchema,
  hookMetadataSchema,
  commandMetadataSchema,
]);

/** 在 superRefine 上下文里按 type 校验 metadata，失败时挂到 metadata 路径。 */
function refineMetadataByType(
  type: AssetType,
  metadata: unknown,
  ctx: z.RefinementCtx,
): void {
  const schema = metadataSchemaByType[type];
  const result = schema.safeParse(metadata ?? {});
  if (!result.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["metadata"],
      message: `${type} 的 metadata 不合法：${result.error.issues[0]?.message ?? "结构错误"}`,
    });
  }
}

export const assetFileSchema = z.object({
  path: z.string().min(1, "文件路径不能为空").max(500),
  content: z.string().min(1, "文件内容不能为空"),
  // "base64" → content 为二进制文件的 base64；缺省为 UTF-8 文本。
  encoding: z.literal("base64").optional(),
});

/**
 * Skill 领域规则：最小单元是 `skills/<name>/SKILL.md`，必须包含一个位于技能目录
 * 根的 `SKILL.md`。供 create/update 的 superRefine 复用。
 */
export function skillFilesHaveEntry(files: { path: string }[] | undefined): boolean {
  if (!files) return true; // 未提供 files 时不在此校验（update 可能只改别的字段）
  return files.some((f) => f.path.trim() === "SKILL.md");
}

function refineSkillEntry(
  type: AssetType | undefined,
  files: { path: string }[] | undefined,
  ctx: z.RefinementCtx,
): void {
  if (type !== "skill") return;
  if (!skillFilesHaveEntry(files)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["files"],
      message: "Skill 必须包含一个 SKILL.md 文件（位于技能目录根）",
    });
  }
}

const assetNameSchema = z.string()
  .min(1, "名称不能为空")
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "名称只能包含英文、数字、_、-");

/**
 * 凭据名：跨资产/项目复用的链接键。限定为字母/数字/下划线/连字符，不以数字开头，
 * 兼顾可读与安全（不与 shell 变量名规则冲突，path 绑定时也可作稳健标识）。
 */
const credentialNameSchema = z
  .string()
  .trim()
  .min(1, "凭据名不能为空")
  .max(100)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "凭据名只能包含字母、数字、下划线、连字符，且不以数字开头");

/** 环境变量名：大写字母/数字/下划线，不以数字开头（写入设备系统 env 的合法名）。 */
const envVarKeySchema = z
  .string()
  .trim()
  .min(1, "环境变量名不能为空")
  .max(200)
  .regex(/^[A-Z_][A-Z0-9_]*$/, "环境变量名只能包含大写字母、数字、下划线，且不以数字开头");

/**
 * 单条鉴权绑定（ADR-0003）。按 kind 校验：
 * - env：envKey 必填且为合法环境变量名；path 应缺省。
 * - path：path 必填（/ 分隔的注入路径，相对未包装 server def）；envKey 应缺省。
 *   path 绑定仅对 type=mcp 资产有效——该约束在 assetCreate/Update 的 superRefine
 *   内按 type 拦截（此处只校验单条结构）。
 * authPageUrl 两种 kind 都可选（须为合法 URL）。
 */
export const assetAuthBindingSchema = z
  .object({
    credentialName: credentialNameSchema,
    kind: z.enum(AUTH_BINDING_KINDS),
    envKey: envVarKeySchema.optional(),
    path: z.string().trim().min(1, "注入路径不能为空").max(300).optional(),
    authPageUrl: z.string().trim().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "env") {
      if (!data.envKey) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["envKey"], message: "env 绑定必须填写环境变量名" });
      }
      if (data.path !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "env 绑定不应填写注入路径" });
      }
    } else {
      // kind === "path"
      if (!data.path) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "path 绑定必须填写注入路径" });
      }
      if (data.envKey !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["envKey"], message: "path 绑定不应填写环境变量名" });
      }
    }
    if (data.authPageUrl && !/^https?:\/\//.test(data.authPageUrl)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authPageUrl"], message: "鉴权页面地址需为 http(s):// 开头的 URL" });
    }
  });

/**
 * 鉴权声明 = 绑定列表。空数组（或 undefined）= 无鉴权。
 * 同一资产内凭据名不重复（校验），避免分发语义歧义。
 */
export const assetAuthSchema = z
  .object({
    bindings: z.array(assetAuthBindingSchema).max(20, "鉴权绑定最多 20 条").default([]),
  })
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const b of data.bindings) {
      if (seen.has(b.credentialName)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bindings"], message: `凭据名 ${b.credentialName} 重复` });
      }
      seen.add(b.credentialName);
    }
  });

const assetCreateBase = z.object({
  name: assetNameSchema,
  alias: z.string().trim().max(100, "别名不能超过 100 个字符").optional().default(""),
  sourceUrl: z.string().trim().max(500, "来源地址不能超过 500 个字符").optional().default(""),
  type: z.enum(ASSET_TYPES),
  description: z.string().trim().max(500, "描述不能超过 500 个字符").optional().default(""),
  tags: z.array(z.string().max(50)).max(5, "标签最多 5 个").default([]),
  files: z.array(assetFileSchema).min(1, "至少需要一个文件"),
  compatibleTools: z.array(z.enum(TARGET_TOOLS)).min(1, "至少选择一个兼容工具"),
  visibility: z.enum(VISIBILITY_OPTIONS),
  metadata: assetMetadataSchema.optional().default({}),
  auth: assetAuthSchema.optional(),
});

/**
 * path 绑定仅对 type=mcp 资产有效（非 mcp 无结构化 def 供注入）；type 未提供时
 * （update 不改 type 的兜底）由路由层结合现有 asset.type 校验，这里只拦截显式非法。
 */
function refineAuthBindingsByType(
  type: AssetType | undefined,
  auth: { bindings?: Array<{ kind: AuthBindingKind; credentialName: string }> } | undefined,
  ctx: z.RefinementCtx,
): void {
  const bindings = auth?.bindings;
  if (!bindings || bindings.length === 0) return;
  if (type !== undefined && type !== "mcp") {
    const hasPath = bindings.some((b) => b.kind === "path");
    if (hasPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth", "bindings"],
        message: "path 鉴权绑定仅适用于 mcp 能力",
      });
    }
  }
}

export const assetCreateSchema = assetCreateBase.superRefine((data, ctx) => {
  refineMetadataByType(data.type, data.metadata, ctx);
  refineSkillEntry(data.type, data.files, ctx);
  refineAuthBindingsByType(data.type, data.auth, ctx);
});

export const assetUpdateSchema = assetCreateBase
  .partial()
  .extend({
    version: z.string().optional(),
    metadata: assetMetadataSchema.optional(),
    files: z.array(assetFileSchema).min(1).optional(),
    auth: assetAuthSchema.optional(),
  })
  .superRefine((data, ctx) => {
    // 仅当本次同时提供 type 与 metadata 时才按 type 强校验；只改其一时无法判别，
    // 退回字段级宽松校验（assetMetadataSchema 已挡明显非法）。
    if (data.type !== undefined && data.metadata !== undefined) {
      refineMetadataByType(data.type, data.metadata, ctx);
    }
    // type 显式为 skill 且提供 files 时校验 SKILL.md；只改 files 不带 type 的情况
    // 由路由层结合现有 asset.type 兜底。
    refineSkillEntry(data.type, data.files, ctx);
    refineAuthBindingsByType(data.type, data.auth, ctx);
  });

export const capabilitySetCreateSchema = z.object({
  name: z.string().min(1, "名称不能为空").max(100),
  description: z.string().min(1, "描述不能为空").max(500),
  targetTools: z.array(z.enum(TARGET_TOOLS)).min(1, "至少选择一个目标工具"),
  visibility: z.enum(VISIBILITY_OPTIONS),
  assetIds: z.array(z.string().min(1)).optional(),
});

export const capabilitySetUpdateSchema = capabilitySetCreateSchema.partial().extend({
  version: z.string().optional(),
});

export const projectRegisterSchema = z.object({
  deviceId: z.string(),
  projectName: z.string().min(1),
  normalizedPath: z.string().min(1),
  detectedTargets: z.array(z.enum(TARGET_TOOLS)),
});

export const installRequestSchema = z.object({
  projectId: z.string().min(1),
  capabilitySetId: z.string().min(1),
  targetTools: z.array(z.enum(TARGET_TOOLS)).min(1, "至少选择一个目标工具"),
  policy: z.enum(SYNC_POLICIES),
  /**
   * 撞车裁决结果（ADR-0006）：本次安装跳过的 incoming asset id 集合。
   * 跳过 = 仅本次不装，非永久排除（冲突方卸载后可重装补齐）。
   */
  skipAssetIds: z.array(z.string().min(1)).optional(),
});

export const assetSearchSchema = z.object({
  query: z.string().optional(),
  type: z.enum(ASSET_TYPES).optional(),
  tags: z.array(z.string()).optional(),
  /** 按来源筛选：来源 ID，或特殊值 "local" 表示本地创建（无来源）。 */
  source: z.string().optional(),
  visibility: z.enum(VISIBILITY_OPTIONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const capabilitySetSearchSchema = z.object({
  query: z.string().optional(),
  visibility: z.enum(VISIBILITY_OPTIONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const marketplaceCreateSchema = z.object({
  repoUrl: z.string().trim().max(2048).superRefine((value, ctx) => {
    if (/^git@[^:]+:[^/]+\/.+$/.test(value)) return;
    // shared targets Node without DOM lib declarations; use a lightweight
    // protocol/credential check here and let the server parse the final URL.
    const https = /^https:\/\/([^/]+)(?:\/|$)/.exec(value);
    if (https) {
      if (https[1]?.includes("@")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "仓库地址不能包含用户名或密码" });
      }
    } else if (!/^file:\/\//.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "请输入有效的仓库地址" });
    }
  }),
  ref: z.string().max(200).optional(),
  /**
   * 仅导入这些能力类型；缺省 = 全部类型。传完整集合等价于缺省（规范化为 null）。
   */
  assetTypes: z.array(z.enum(ASSET_TYPES)).optional(),
});

export const marketplaceDeleteQuerySchema = z.object({
  keepAssets: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
});

export const marketplaceUpdateSchema = z.object({
  enabled: z.boolean(),
});

export const settingsUpdateSchema = z.object({
  pollIntervalMinutes: z.number().int().refine((v) => (POLL_INTERVAL_OPTIONS as readonly number[]).includes(v), {
    message: "无效的轮询间隔",
  }),
});

export const aiSettingsUpdateSchema = z.object({
  baseUrl: z.string().trim().url("请输入有效的 AI Base URL"),
  apiKey: z.string().trim().optional(),
  model: z.string().trim().min(1, "模型名称不能为空").max(100).default("gpt-4o-mini"),
});

export const assetBasicInfoGenerateSchema = z.object({
  type: z.enum(ASSET_TYPES),
  name: z.string().max(100).optional().default(""),
  alias: z.string().max(100).optional().default(""),
  // 超出长度时截断而非报错——这些字段只是喂给 AI 的提示，截断不影响生成流程。
  description: z.string().transform((s) => (s.length > 500 ? s.slice(0, 500) : s)).optional().default(""),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({}),
  files: z.array(z.object({
    path: z.string().transform((s) => (s.length > 500 ? s.slice(0, 500) : s)),
    // 超出长度时截断而非报错——实际喂给 AI 的长度由服务端 buildFileContext 进一步控制。
    content: z.string().transform((s) => (s.length > 50_000 ? s.slice(0, 50_000) : s)),
  })).transform((arr) => (arr.length > 50 ? arr.slice(0, 50) : arr)).optional().default([]),
});

export const generatedAssetBasicInfoSchema = z.object({
  // AI 不再生成 name；保留可选以兼容旧调用方/历史数据。
  name: assetNameSchema.optional(),
  alias: z.string().trim().min(1, "别名不能为空").max(100),
  tags: z.array(z.string().trim().min(1).max(50)).min(1).max(5),
  description: z.string().trim().min(1).max(500),
  auth: assetAuthSchema.optional(),
});

// ============ Credentials（设置页：凭据值 + 显式分发，ADR-0003）============
//
// 凭据名 = 绑定的 credentialName 链接键。值 AES-256-GCM 加密落 DB，明文永不回传。
// 分发显式 opt-in：env → 设备系统环境变量；path → 项目 .mcp.json 注入（reconcile 时渲染）。

export const credentialCreateSchema = z.object({
  name: credentialNameSchema,
  /**
   * 分发轴（创建时定型，不可变）。env→只可下发到设备；path→只可分发到项目。
   * 创建后由服务端落库，更新接口不接受此字段。
   */
  axis: z.enum(CREDENTIAL_AXES),
  value: z.string().min(1, "凭据值不能为空").max(8192),
  description: z.string().trim().max(500, "描述不能超过 500 个字符").optional().default(""),
});

export const credentialUpdateSchema = z.object({
  name: credentialNameSchema.optional(),
  /** 留空表示保持原值不变。 */
  value: z.string().max(8192).optional(),
  description: z.string().trim().max(500, "描述不能超过 500 个字符").optional(),
});

/**
 * 凭据分发。axis=env 时 targetIds 为设备 id（推系统环境变量）；
 * axis=path 时 targetIds 为项目 id（标记为已分发，下次 reconcile 注入）。
 * axis 必须与凭据自身的 axis 一致（服务端校验：禁止跨轴分发）。
 */
export const credentialDistributeSchema = z.object({
  axis: z.enum(CREDENTIAL_AXES),
  targetIds: z.array(z.string().min(1)).min(1, "至少选择一个目标"),
});

// ============ Tool Config Profiles（Codex / Claude Code 设备配置）============

const toolProfileNameSchema = z.string().trim().min(1, "配置名称不能为空").max(80, "配置名称不能超过 80 个字符");
const toolConfigUrlSchema = z.string().trim().url("Base URL 格式不正确").max(2048);
const optionalConfigValueSchema = z.string().trim().max(256);

export const codexToolConfigSchema = z.object({
  modelProvider: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Provider ID 只能包含字母、数字、下划线和连字符").max(64),
  disableResponseStorage: z.boolean(),
  networkAccess: z.enum(["enabled", "disabled"]),
  windowsWslSetupAcknowledged: z.boolean(),
  baseUrl: toolConfigUrlSchema,
  wireApi: z.literal("responses"),
  requiresOpenaiAuth: z.boolean(),
  goals: z.boolean(),
});

export const claudeCodeToolConfigSchema = z.object({
  baseUrl: toolConfigUrlSchema,
  defaultFableModel: optionalConfigValueSchema,
  defaultFableModelName: optionalConfigValueSchema,
  defaultHaikuModel: optionalConfigValueSchema,
  defaultHaikuModelName: optionalConfigValueSchema,
  defaultOpusModel: optionalConfigValueSchema,
  defaultOpusModelName: optionalConfigValueSchema,
  defaultSonnetModel: optionalConfigValueSchema,
  defaultSonnetModelName: optionalConfigValueSchema,
  model: optionalConfigValueSchema,
  apiTimeoutMs: z.string().trim().max(12).refine((value) => value === "" || /^\d+$/.test(value), "API 超时必须是毫秒整数"),
  disableNonessentialTraffic: optionalConfigValueSchema,
  experimentalAgentTeams: optionalConfigValueSchema,
  enableToolSearch: optionalConfigValueSchema,
  hasCompletedOnboarding: z.boolean(),
});

export const toolConfigProfileCreateSchema = z.discriminatedUnion("tool", [
  z.object({
    name: toolProfileNameSchema,
    tool: z.literal("codex"),
    config: codexToolConfigSchema,
    secret: z.string().min(1, "API Key 不能为空").max(8192),
  }),
  z.object({
    name: toolProfileNameSchema,
    tool: z.literal("claudecode"),
    config: claudeCodeToolConfigSchema,
    secret: z.string().min(1, "Auth Token 不能为空").max(8192),
  }),
]);

export const toolConfigProfileUpdateSchema = z.discriminatedUnion("tool", [
  z.object({
    name: toolProfileNameSchema,
    tool: z.literal("codex"),
    config: codexToolConfigSchema,
    secret: z.string().min(1).max(8192).optional(),
  }),
  z.object({
    name: toolProfileNameSchema,
    tool: z.literal("claudecode"),
    config: claudeCodeToolConfigSchema,
    secret: z.string().min(1).max(8192).optional(),
  }),
]);

export const toolConfigDistributeSchema = z.object({
  deviceIds: z.array(z.string().min(1)).min(1, "至少选择一台设备"),
});

/**
 * `loom push` 请求校验。assets 复用 ImportedAsset 结构，但做基本字段检查；
 * asset 级的 metadata 强校验由 Server 端 push 路由在 upsert 时兜底。
 */
const pushAssetSchema = z.object({
  sourcePath: z.string().min(1),
  name: z.string().min(1).max(100),
  type: z.enum(ASSET_TYPES),
  description: z.string().max(500).default(""),
  files: z.array(assetFileSchema).min(1, "至少需要一个文件"),
  compatibleTools: z.array(z.enum(TARGET_TOOLS)).min(1),
  version: z.string().default("1.0.0"),
  tags: z.array(z.string().max(50)).max(5).default([]),
  originAuthor: z.string().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});

export const pushSchema = z.object({
  name: z.string().min(1, "名称不能为空").max(100),
  visibility: z.enum(VISIBILITY_OPTIONS),
  targetTool: z.enum(TARGET_TOOLS),
  assets: z.array(pushAssetSchema).min(1, "至少包含一个能力"),
});

export type ValidatedPush = z.infer<typeof pushSchema>;

export type ValidatedMarketplaceCreate = z.infer<typeof marketplaceCreateSchema>;
export type ValidatedSettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export type ValidatedAiSettingsUpdate = z.infer<typeof aiSettingsUpdateSchema>;
export type ValidatedAssetBasicInfoGenerate = z.infer<typeof assetBasicInfoGenerateSchema>;
export type ValidatedGeneratedAssetBasicInfo = z.infer<typeof generatedAssetBasicInfoSchema>;

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ValidatedAssetCreate = z.infer<typeof assetCreateSchema>;
export type ValidatedAssetUpdate = z.infer<typeof assetUpdateSchema>;
export type ValidatedCapabilitySetCreate = z.infer<typeof capabilitySetCreateSchema>;
export type ValidatedCapabilitySetUpdate = z.infer<typeof capabilitySetUpdateSchema>;
export type ValidatedInstallRequest = z.infer<typeof installRequestSchema>;
export type ValidatedAssetSearch = z.infer<typeof assetSearchSchema>;
export type ValidatedCapabilitySetSearch = z.infer<typeof capabilitySetSearchSchema>;
export type ValidatedCredentialCreate = z.infer<typeof credentialCreateSchema>;
export type ValidatedCredentialUpdate = z.infer<typeof credentialUpdateSchema>;
export type ValidatedCredentialDistribute = z.infer<typeof credentialDistributeSchema>;
export type ValidatedToolConfigProfileCreate = z.infer<typeof toolConfigProfileCreateSchema>;
export type ValidatedToolConfigProfileUpdate = z.infer<typeof toolConfigProfileUpdateSchema>;

// ============ Admin：用户管理 / 注册上限 / 白名单 ============

export const adminUpdateRoleSchema = z.object({
  role: z.enum(USER_ROLES),
});

export const adminUpdateStatusSchema = z.object({
  disabled: z.boolean(),
});

export const registrationSettingsSchema = z.object({
  /** 0 表示不限制 */
  maxUsers: z.number().int().min(0).max(1_000_000),
});

export const whitelistSettingsSchema = z.object({
  enabled: z.boolean(),
  emails: z.array(z.string().email("白名单中包含无效邮箱")).max(1000, "白名单最多 1000 条"),
});

export type ValidatedAdminUpdateRole = z.infer<typeof adminUpdateRoleSchema>;
export type ValidatedAdminUpdateStatus = z.infer<typeof adminUpdateStatusSchema>;
export type ValidatedRegistrationSettings = z.infer<typeof registrationSettingsSchema>;
export type ValidatedWhitelistSettings = z.infer<typeof whitelistSettingsSchema>;

// ============ Embedding / 语义搜索设置 ============

const embeddingWeightsSchema = z.object({
  name: z.number().min(0).max(1),
  tags: z.number().min(0).max(1),
  description: z.number().min(0).max(1),
});

export const embeddingSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  useLexical: z.boolean().optional(),
  useSemantic: z.boolean().optional(),
  provider: z.enum(["nvidia", "openai", "custom"]).optional(),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().optional(),
  model: z.string().trim().optional(),
  dim: z.number().int().positive().optional(),
  passageInputType: z.string().optional(),
  queryInputType: z.string().optional(),
  extraBody: z.record(z.unknown()).optional(),
  weights: embeddingWeightsSchema.optional(),
  alpha: z.number().min(0).max(1).optional(),
  simThreshold: z.number().min(0).max(1).optional(),
  batchSize: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  minIntervalMs: z.number().int().min(0).optional(),
  maxAttempts: z.number().int().positive().optional(),
  backoffBaseMs: z.number().int().min(0).optional(),
}).strict().refine(
  // 拦截「同一次请求显式把两者都关」。合并态（关一个、另一个本就关）由路由层补拦。
  (v) => !(v.useLexical === false && v.useSemantic === false),
  { message: "词法与语义不能同时关闭，至少保留一种搜索模式" },
);

export const searchRequeueSchema = z.object({
  assetIds: z.array(z.string().min(1)).optional(),
  all: z.boolean().optional(),
}).refine(
  (v) => (v.all === true) || (v.assetIds && v.assetIds.length > 0),
  { message: "需指定 assetIds 或 all=true" },
);

export type ValidatedEmbeddingSettingsUpdate = z.infer<typeof embeddingSettingsUpdateSchema>;
export type ValidatedSearchRequeue = z.infer<typeof searchRequeueSchema>;

// ============ 能力信息生成队列（ADR-0005）============

export const aiGenSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(["openai", "custom"]).optional(),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().optional(),
  model: z.string().trim().optional(),
  overwrite: z.boolean().optional(),
  concurrency: z.number().int().positive().optional(),
  minIntervalMs: z.number().int().min(0).optional(),
  maxAttempts: z.number().int().positive().optional(),
  backoffBaseMs: z.number().int().min(0).optional(),
}).strict();

export const aiInfoRequeueSchema = z.object({
  assetIds: z.array(z.string().min(1)).optional(),
  all: z.boolean().optional(),
}).refine(
  (v) => (v.all === true) || (v.assetIds && v.assetIds.length > 0),
  { message: "需指定 assetIds 或 all=true" },
);

export type ValidatedAiGenSettingsUpdate = z.infer<typeof aiGenSettingsUpdateSchema>;
export type ValidatedAiInfoRequeue = z.infer<typeof aiInfoRequeueSchema>;
