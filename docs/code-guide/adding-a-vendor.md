# 新增厂商（TargetTool）改动清单

> 目的：让新增一个 AI 工具厂商（如 Cursor / Codex / CodeBuddy / ClaudeCode 之外的第五个）变成按图索骥的机械操作，而不是每次重新逆向整个仓库。
>
> 事实来源：`packages/shared/src/constants.ts`、`packages/adapter/src/*`、`packages/cli/src/lib/*`、`packages/web/src/**`。文档与代码冲突时以代码为准，并回头修本文。

## 什么时候用这份清单

- 新增一个 `TargetTool` 枚举值（一个新厂商目录，如 `.foo/`）。
- 不适用于：给已有厂商加一种新的 `AssetType` 支持（那是改 `supportedTypes` + `ADAPTER_SUPPORT`，见 `shared-and-adapter.md`）。

## 核心契约

Loom 的厂商接入是"**一处注册，多处自动**"的模型。`@maolinc/cc-loom-shared` 的四个常量（`TARGET_TOOLS` / `TARGET_TOOL_LABELS` / `TARGET_DIRS` / `ADAPTER_SUPPORT`）是单一事实来源，绝大多数消费方（CLI 的 detect / safe-write / scanner、Web 的 tab / 矩阵 / 文档页、Server 的 reconcile-plan / outbox）都从这四个常量派生，**不会**也**不应该**硬编码厂商名。

只有少数"厂商特殊行为"是硬编码的（MCP 落盘位置、hook 事件名映射、agent 格式转写等），它们通过 `BaseAdapter` 的虚方法下沉到 adapter 子类。新增厂商时，先判断你的厂商是否需要这些特殊行为——大多数情况下**不需要**，沿用 `BaseAdapter` 默认即可。

---

## 第 0 步：调研厂商官方规范（最关键，不可跳过）

> **这一步错了，后面全错。** Loom 的 adapter 是把统一中间格式（Manifest）翻译成各厂商的落盘规范——翻译规则只能来自厂商官方文档，不能凭"看起来像 ClaudeCode"猜。Cursor 的 camelCase 事件名、Codex 的 agent TOML、ClaudeCode 的项目根 `.mcp.json`、CodeBuddy 把 hooks 嵌入 settings.json——这些全是官方明文规定，错一个就装不上或装错位。

### 0.1 调研来源与优先级

1. **厂商官方文档（唯一权威来源）**。优先级：官网文档 > 官方示例仓库 > 官方 changelog/release notes。既有四个 adapter 的源码注释里都附了官方链接（如 `cursor.ts` 顶部、`claudecode.ts` 的 `.mcp.json` 说明），可作为各厂商文档入口的参照。
2. **官方文档找不到时**：看官方 CLI/IDE 的实际产物（装一次该厂商，观察它生成的目录与文件结构），或官方仓库的 schema/校验代码。**不要从 Loom 既有 adapter 类比猜测**——那是"Loom 的翻译结果"，不是"厂商规范"。
3. **第三方博客/AI 回答一律不作数**，最多用来定位官方文档关键词。时效性强的内容（事件集合、schema 版本）必须落到官方当前文档。

把每条规范的**官方链接**记下来，填进决策表的"证据"列——后续 adapter 子类注释、`DocsPage.tsx` 的 `officialLinks`、PR 描述都要复用这些链接。

### 0.2 逐能力调研清单

对六类 `AssetType` 逐一确认厂商是否支持、以及支持的规范细节。**"不支持"也要明确记录**——它决定 `supportedTypes` 是否包含该类型，以及 L3 用例里"不支持类型不落盘"断言。

#### skill（技能）
- 厂商是否支持"技能"这种能力？目录位置（`<targetDir>/skills/<name>/`？）。
- 入口文件名（`SKILL.md`？还是别的？）及其 frontmatter 要求（`name` / `description` 是否必填、是否有额外字段）。
- 命名规则：技能身份是 frontmatter `name` 还是目录名？（Loom 用 frontmatter `name`，见 `shared-and-adapter.md` §Asset 身份命名规则——确认厂商口径一致，否则安装后厂商识别不到。）

#### rule（规则/行为约束）
- 厂商是否有"项目级规则"概念？目录位置、文件格式（Markdown？）。
- glob/匹配范围机制：厂商读什么字段决定规则作用于哪些文件？（Loom metadata 用 `globs: string[]`——确认厂商字段名与语义。）
- 是否支持子目录组织（影响目录型 vs 平铺型渲染）。

#### mcp（MCP 服务）
- **配置文件落盘位置**：厂商从哪里读项目级 MCP 配置？是 `<targetDir>/mcp.json`，还是项目根的某个文件（ClaudeCode 是项目根 `.mcp.json`，且官方明确不从 `.claude/` 读），还是嵌入 settings.json？
- **配置文件格式**：外层包装是 `{ mcpServers: { ... } }` 还是别的 key？单 server 定义的字段（`command` / `args` / `env` / `transport`）。
- 传输方式支持（stdio / sse / http）——影响 metadata 校验。

#### hook（钩子）
- **注册表落盘位置**：独立文件（`<targetDir>/hooks.json`？）还是嵌入 settings.json 的 `hooks` 字段（ClaudeCode / CodeBuddy）？注意 Claude Code 项目级 hook 只从 `settings.json` / `settings.local.json` 顶层 `hooks` 字段加载，`hooks/hooks.json` 仅 plugin 包内有效、独立项目不读取。
- **事件名命名空间**：厂商用 PascalCase（ClaudeCode/Codex/CodeBuddy）还是 camelCase（Cursor）？事件集合是什么？（如 Cursor 没有 `PostCompact`/`Notification` 对应事件。）
- **matcher 机制**：事件是否支持 matcher 字段过滤？字段名与语义。
- **命令路径占位符**：厂商 hook 命令里用什么指代项目根？`${CLAUDE_PROJECT_DIR}`（ClaudeCode 专属）？项目相对路径（Cursor）？还是别的占位符？
- **schema 版本字段**：注册表文件是否要求版本号（Cursor 的 `version: 1`）？首次安装时 existing 为空需补哪些非用户数据字段？
- **聚合文件外层包装**：除了 `hooks` 字段，是否还有其他必填顶层字段？

#### command（斜杠命令）
- 厂商是否支持**项目级**斜杠命令？还是只有用户级目录（Codex 的 prompts 在 `~/.codex/prompts/`，超出项目级安全边界 → Loom 不分发）？
- 目录位置、文件格式、触发词字段（Loom metadata 用 `trigger`）。
- 是否支持子目录。

#### agent（子代理）
- 厂商是否支持子代理？目录位置。
- **文件格式**：Markdown（ClaudeCode/Cursor/CodeBuddy）还是 TOML（Codex 的 `name`/`description`/`developer_instructions`）？必填字段是什么？
- 这决定是否需要覆写 `renderAssetFiles()` 做格式转写。

### 0.3 调研产出：填写决策表

把 0.2 的调研结果填入下表。**每一行都必须有官方文档证据**——没有证据的格子标记"待查"并回去补，不要填默认值。答案直接决定后面要改几个文件、覆写哪些方法。

| 决策点 | 选项 | 影响 | 官方证据（链接/文档段落） |
|--------|------|------|--------------------------|
| 厂商 ID（`TargetTool` 字面量） | 小写 ASCII，如 `"foo"` | 全仓唯一 key，不可改 | —（Loom 内部约定） |
| 显示名 | 如 `"Foo"` | `TARGET_TOOL_LABELS` | 厂商官网首页/品牌名 |
| 项目目录名 | 如 `.foo` | `TARGET_DIRS` | 官方"项目配置"文档 |
| 支持哪些 `AssetType` | 6 类的全集或子集 | `supportedTypes` + `ADAPTER_SUPPORT` | 逐类官方文档见 0.2 |
| MCP 配置落盘位置 | 默认 `<targetDir>/mcp.json`，或项目根 `<file>` | 是否覆写 `mcpConfigPath()` | 官方 MCP 配置文档 |
| MCP 配置文件格式 | `{ mcpServers: {} }` 或别的 | `aggregateMcps` 输出形态 | 同上 |
| Hook 注册表落盘位置 | 默认 `<targetDir>/hooks/hooks.json`（通用回退），或嵌入 settings.json | 是否覆写 `hooksAggregatePath()` + `emitHookRegistry()`；ClaudeCode/CodeBuddy 走 `settings.json` + `settings-with-hooks` | 官方 hooks 文档 |
| Hook 事件名命名空间 | PascalCase（默认）或自定义映射 | 是否覆写 `mapHookEvent()` | 官方 hooks 事件列表 |
| Hook 事件集合 | 哪些事件有对应、哪些无对应 | `mapHookEvent` 返回 null 的事件集 | 同上 |
| Hook 命令路径前缀 | 默认 `${CLAUDE_PROJECT_DIR}/<targetDir>/hooks/<name>/` | 是否覆写 `rewriteHookEntry()` | 官方 hook 命令路径约定 |
| Hook schema 版本字段 | 无，或必填版本号 | 是否覆写 `mergeAggregate()` 补字段 | 同上 |
| Agent 文件格式 | Markdown（默认）或 TOML 等需转写 | 是否覆写 `renderAssetFiles()` | 官方子代理文档 |
| Command 是否项目级 | 项目级（默认）或仅用户级 → 不分发 | 是否进入 `supportedTypes` | 官方 prompts/commands 文档 |
| 是否需要厂商 logo | Web 展示需要 | `ToolIcon` + svg 资源 | 厂商品牌资源页 |

**判断特殊行为的捷径**（仅在调研确认后使用）：如果调研结果显示新厂商"长得像 ClaudeCode"（PascalCase hooks、MCP 在 vendor 目录内、agent 是 Markdown、command 项目级），直接 `extends BaseAdapter` 不覆写任何方法即可。Cursor / Codex / CodeBuddy 三个子类存在的全部原因就是上表里某几项与默认不同——**先有官方规范，再用此捷径核对，而不是反过来**。

---

## 第 1 步：`@maolinc/cc-loom-shared` 契约（必改）

**文件**：`packages/shared/src/constants.ts`

四处都要加新厂商的条目，保持四个 Record 的 key 集合与 `TARGET_TOOLS` 完全一致：

```ts
export const TARGET_TOOLS = ["claudecode", "codex", "cursor", "codebuddy", "foo"] as const;

export const TARGET_TOOL_LABELS: Record<TargetTool, string> = {
  // ...existing
  foo: "Foo",
};

export const TARGET_DIRS: Record<TargetTool, string> = {
  // ...existing
  foo: ".foo",
};

export const ADAPTER_SUPPORT: Record<TargetTool, readonly AssetType[]> = {
  // ...existing
  foo: ["skill", "rule", "mcp", "hook", "command", "agent"], // 按决策表填
};
```

**注意**：
- `TARGET_TOOLS` 的顺序决定前端展示顺序（`sortTargetTools` 依赖此顺序）。新厂商通常加到末尾。
- `ADAPTER_SUPPORT` 必须与下一步 adapter 实例的 `supportedTypes` **逐字一致**——它是前端的静态副本，避免把 adapter 包打进 web bundle。注释已明确写明"修改 adapter 时记得同步这里"。

**验证**：`pnpm --filter @maolinc/cc-loom-shared typecheck`；`TARGET_TOOL_LABELS` / `TARGET_DIRS` / `ADAPTER_SUPPORT` 的 key 数量必须等于 `TARGET_TOOLS.length`（TS 会让缺 key 报错，但多 key 不会，需自查）。

---

## 第 2 步：`@maolinc/cc-loom-adapter` 引擎（必改）

### 2.1 新建 adapter 子类

**文件**：`packages/adapter/src/foo.ts`（仿照最简单的 `claudecode.ts` 起步）

最小实现（无任何特殊行为）：

```ts
import type { AssetType, TargetTool } from "@maolinc/cc-loom-shared";
import { BaseAdapter } from "./base.js";

/**
 * Foo 适配：项目级 .foo/ 目录，沿用 BaseAdapter 默认行为
 * （MCP 写 .foo/mcp.json、hooks 写 .foo/hooks/hooks.json、事件名 PascalCase 原样）。
 */
export class FooAdapter extends BaseAdapter {
  tool: TargetTool = "foo";
  targetDir = ".foo";
  supportedTypes: readonly AssetType[] = ["skill", "rule", "mcp", "hook", "command", "agent"];
}
```

需要特殊行为时按需覆写（参考既有子类）：

| 想做什么 | 覆写方法 | 参考子类 |
|----------|----------|----------|
| MCP 写项目根 / 其他路径 | `protected mcpConfigPath()` | `claudecode.ts` |
| Hook 注册表写到别的文件 | `hooksAggregatePath()` + `emitHookRegistry()` | `codex.ts` / `codebuddy.ts` |
| Hook 嵌入 settings.json | 同上，且 `mergeStrategy: "settings-with-hooks"` | `codebuddy.ts` |
| Hook 事件名映射 / 部分事件不支持 | `mapHookEvent()` | `cursor.ts` |
| Hook 命令路径不用 `${CLAUDE_PROJECT_DIR}` | `rewriteHookEntry()` | `cursor.ts` |
| Agent 转写为非 Markdown 格式 | `renderAssetFiles()`（同时覆盖 `generate()` 与 `generateForAsset()` 两条路径，`generateForAsset` 在 `base.ts` 里已处理 passthrough/mcp/hook 分流，子类一般只需关心 agent 分支） | `codex.ts` |
| Reconcile 落盘需补 schema 字段 | `mergeAggregate()` | `cursor.ts`（补 `version: 1`） |

### 2.2 注册 adapter

**文件**：`packages/adapter/src/registry.ts`

```ts
import { FooAdapter } from "./foo.js";

const adapters: Adapter[] = [
  new CursorAdapter(),
  new CodeBuddyAdapter(),
  new ClaudeCodeAdapter(),
  new CodexAdapter(),
  new FooAdapter(), // ← 加这里
];
```

### 2.3 导出（可选）

**文件**：`packages/adapter/src/index.ts`

如果有外部消费方直接 `import { FooAdapter }`，加一行 `export { FooAdapter } from "./foo.js";`。绝大多数消费方走 `getAdapter()` / `listAdapters()`，**不需要**直接 import 类。

**验证**：`pnpm --filter @maolinc/cc-loom-adapter typecheck && pnpm --filter @maolinc/cc-loom-adapter test`。

---

## 第 3 步：CLI（通常自动，按需改）

下列文件都从 `TARGET_DIRS` / `TARGET_TOOLS` 派生，**新增厂商后无需改动**即可工作：

| 文件 | 为什么自动 |
|------|-----------|
| `packages/cli/src/lib/detect.ts` | `detectTargets` 遍历 `TARGET_TOOLS` × `TARGET_DIRS` |
| `packages/cli/src/lib/safe-write.ts` | `ALLOWED_TOP_DIRS = Object.values(TARGET_DIRS)`，新厂商目录自动获得写入白名单 |
| `packages/cli/src/lib/locks.ts` | 全部用 `TargetTool` 泛型，无字面量 |
| `packages/cli/src/lib/reconcile-runner.ts` | `adapterByTool` 由 `listAdapters()` 构建 |
| `packages/cli/src/lib/watcher.ts` | 监视 `TARGET_DIRS`（见下方特例） |

**需要按需检查的硬编码点**：

### 3.1 项目根 MCP 文件特例

**文件**：`packages/cli/src/lib/safe-write.ts`

```ts
const ALLOWED_ROOT_FILES = new Set([".mcp.json"]);
```

只有当新厂商的 adapter 把 MCP 写到**项目根的某个文件**（而非 `<targetDir>/mcp.json`）时才需要改：把该文件名加入此白名单。否则保持不变。ClaudeCode 是目前唯一触发此特例的厂商。

### 3.2 项目根文件的扫描呈现

**文件**：`packages/cli/src/lib/scanner.ts`（搜索 `claudecode 特例`）

scanner 有一段专门把项目根 `.mcp.json` 合并进 `vendors.claudecode` 树的逻辑。如果新厂商也有"落在项目根、不在 vendor 目录内"的产物，需要仿照这段为新厂商加一段合并逻辑；否则跳过。

### 3.3 watcher 对项目根文件的监视

**文件**：`packages/cli/src/lib/watcher.ts`（约第 43 行注释处）

watcher 默认监视 `TARGET_DIRS`，但 `.mcp.json` 这类项目根文件需要显式追加。仅当第 3.1/3.2 触发时才需要在这里同步加路径。

### 3.4 vendor-reader 的 MCP 提取

**文件**：`packages/cli/src/lib/vendor-reader.ts`（约第 402 行）

```ts
if (tool === "claudecode") {
  // 从项目根 .mcp.json 提取
} else {
  // 从 <vendor>/mcp.json 提取
}
```

这是 `loom push` 从本地目录反向提取资产的逻辑。**仅当新厂商的 MCP 落盘位置不是 `<targetDir>/mcp.json`** 时才需要扩展此分支（建议改写为按 adapter 的 `mcpAggregatePath()` 派生，而非继续堆 `if`）。默认位置厂商无需改动。

---

## 第 4 步：Server（通常无需改）

Server 端 `compatible_tools` / `target_tools` / `tool` 列在 SQLite 中是 `TEXT`（存 JSON），**无 enum 约束、无迁移**。下列消费方都从 `TARGET_TOOLS` / `ADAPTER_SUPPORT` 派生：

- `packages/server/src/lib/reconcile-plan.ts`
- `packages/server/src/lib/outbox-worker-v2.ts`
- `packages/server/src/lib/asset-conflicts.ts`
- `packages/server/src/lib/download-archive.ts`
- `packages/server/src/routes/projects.ts` / `capability-sets.ts`

**需要按需检查的硬编码点**：

### 4.1 Marketplace 导入的默认 compatibleTools

**文件**：`packages/server/src/marketplace/providers/generic-git.ts`（约第 258 行）

```ts
compatibleTools: ["claudecode", "codebuddy", "codex"],
```

这是 generic-git 提取资产时的默认兼容厂商集合（不含 cursor 是因为历史原因，cursor 走单独兼容性判断）。**新厂商是否要进入这个默认集合是一个产品决策**——决定 marketplace 导入的资产默认是否对新厂商可见。要加就加，不加也不影响功能（用户可在能力集里手动勾选）。

---

## 第 5 步：Web（必改 2 处，其余自动）

下列组件都从 shared 常量派生，**新增厂商后自动渲染**：

- `pages/local-console/VendorTabStrip.tsx`（`TARGET_TOOLS.filter`）
- `pages/local-console/CapabilityMatrix.tsx`（`ADAPTER_SUPPORT`）
- `pages/local-console/ManageTargetsRow.tsx`（`sortTargetTools`）
- `components/AssetCard.tsx` / `DetailPanel.tsx` / `CapabilitySetCard.tsx`（遍历 `compatibleTools`）

### 5.1 厂商 logo（必改）

**文件**：`packages/web/src/components/ToolIcon.tsx`

```ts
import fooLogo from "../assets/tool-logos/foo.svg?url";

const LOGOS: Record<TargetTool, string> = {
  // ...existing
  foo: fooLogo,
};
```

同时把 logo SVG 放到 `packages/web/src/assets/tool-logos/foo.svg`。`LOGOS` 是 `Record<TargetTool, string>`，TS 会强制你补齐——**这是新增厂商时唯一一个编译器会主动拦住你的地方**，可以利用它作为"是否漏改 Web"的检查点。

### 5.2 文档页厂商规范（必改）

**文件**：`packages/web/src/pages/DocsPage.tsx`

在 `VENDOR_SPECS` 数组里追加一个条目，描述该厂商目录结构、官方文档链接、落盘说明。这是面向用户的"厂商目录规范"展示页，缺了会让用户看不到新厂商的文档。

### 5.3 资产默认兼容厂商（按需）

**文件**：`packages/web/src/lib/assetForm.ts`（约第 76 行）

```ts
compatibleTools: ["cursor", "codebuddy", "claudecode"],
```

这是创建资产时的默认勾选厂商。是否把新厂商加入默认集合是产品决策（影响新建资产时默认是否勾选新厂商）。

### 5.4 安装路径预览（按需）

**文件**：`packages/web/src/pages/AssetComposerPage.tsx`（约第 610 行 `installPath` 函数）

```ts
case "mcp": return tool === "claudecode" ? ".mcp.json" : `${dir}/mcp.json`;
```

仅当新厂商的 MCP 落盘位置不是 `<targetDir>/mcp.json` 时，需要扩展此三元判断（建议重构为按 adapter 派生，而非继续堆 `if`）。其他类型的路径预览走 `TARGET_DIRS`，自动。

**验证**：`pnpm --filter web typecheck && pnpm --filter web build`。`LOGOS` 的 `Record<TargetTool, string>` 约束会拦住漏加 logo 的情况。

---

## 第 6 步：测试（L1 快速反馈 + L3 强制门槛）

> 分层与隔离原理见 `docs/testing/principles.md`。要点：**L2（`fastify.inject` 进程内集成）已于 2026-07 全部迁移为 L3 真实链路用例，不再独立存在**——本节说"L3"即涵盖原 L2 的 HTTP API 用例。L1 走 `pnpm test` 本地跑；L3/L4/L5 一律走 docker。

新增厂商**必须**有 L3 用例覆盖——这是"该厂商真能装、真按预期落盘、真能清理"的唯一硬保证。L1 是快速反馈层，L3 是强制门槛，二者都要补。

### 6.1 L1 单元测试（快速反馈，必补）

进程内、无 IO，秒级跑完。位置：`packages/server/src/__tests__/adapter-*.test.ts`（与既有厂商的测试并列）。

| 测试文件 | 新厂商要补什么 |
|----------|----------------|
| `adapter-install-key.test.ts` | 新 adapter 的 `computeInstallKey` 坐标——`(tool, type, name)` 维度天然隔离，断言新厂商与既有厂商同名 asset 不判重 |
| `adapter-layout.test.ts` | 新 adapter 的 `generate()` 对每种 `supportedTypes` 产出预期路径（目录型 vs 平铺型） |
| `adapter-mcp.test.ts` | 新 adapter 的 MCP 聚合：single / wrapped 两种 content 形态、`mcpConfigPath()` 路径 |
| `adapter-hooks.test.ts` | 仅当覆写了 `mapHookEvent` / `emitHookRegistry` / `rewriteHookEntry` 时补——事件名映射、聚合文件位置/包装、命令路径改写 |
| `adapter-merge.test.ts` | 仅当覆写了 `mergeAggregate` 时补——reconcile 落盘保留 foreign 条目 |
| `adapter-codex-agent.test.ts` 的同款 | 仅当新厂商有 agent 格式转写（非 Markdown）时新建一个，仿照 codex agent TOML 用例 |

跑法：`pnpm --filter @maolinc/cc-loom-server test`（或 `pnpm test`）。

### 6.2 L3 真实链路测试（强制门槛，必补）

**核心文件**：`tests/l3-real-e2e/install-flow.test.ts`

这是每个厂商的"落盘契约"——标题已写明"六类 asset × 四种 targetTool"。**新增厂商必须在此文件追加一个 `it(...)` 用例**，仿照既有的 `"cursor: ..."` / `"claudecode: ..."` 用例，覆盖该厂商 `supportedTypes` 的全部类型 × 落盘路径矩阵。

用例不变量（沿用既有 `installAndAssert` helper + `assetBuilders` + `expectFileExists`/`expectFileNotExists`/`expectFileContains`）：

1. **正向落盘矩阵**：对该厂商 `supportedTypes` 里每种类型，断言**具体落盘路径**（如 `.foo/skills/<name>/SKILL.md`、`.foo/mcp.json`、`.foo/hooks.json`）。路径用 `TARGET_DIRS` 派生，不要硬编码到测试常量。
2. **不支持类型不落盘**：对该厂商 `supportedTypes` 之外的类型（仿照 codex 不支持 `command`），断言对应路径**不存在**（`expectFileNotExists`）——保护"silent skip"不变量。
3. **聚合文件内容**：MCP 聚合文件应含 server key（`expectFileContains`）；hook 聚合文件应含映射后的事件名、命令路径前缀；若厂商有 schema 字段（如 Cursor 的 `version: 1`）断言其存在。
4. **不可映射事件跳过**：仅当覆写了 `mapHookEvent` 时补——一个本厂商不支持的事件（仿照 cursor 的 `PostCompact`）应不落附属文件、不进注册表。
5. **项目根特例**：仅当新厂商 MCP 写项目根时补——断言根文件存在（如 `.mcp.json`）且 vendor 目录内**无** `mcp.json`。

**按需补的其他 L3 用例**（视厂商特殊行为而定，有则必补）：

| 场景 | 文件 | 触发条件 |
|------|------|----------|
| `loom push` 反向提取 | `tests/l3-real-e2e/push.test.ts` | 该厂商有非标准 MCP 路径或特殊目录结构（vendor-reader 有分支） |
| 卸载/切换清理 | `tests/l3-real-e2e/happy-path.test.ts` 的卸载段、`drift-self-heal.test.ts` | 该厂商有项目根文件（scanner 有合并段、watcher 有监视路径） |
| 单项能力 add | `tests/l3-real-e2e/single-asset-install.test.ts` | 默认应自动工作，但若该厂商有特殊路径建议加一条断言 |

**testkit 接口**（`@maolinc/cc-loom-testkit`，全部真实链路）：

```ts
import {
  startServer, stopServer,              // 真实 server 进程
  startAgent, stopAgent,                // 真实 CLI daemon + WS
  makeProject, cleanupProject,          // 临时项目目录
  ApiClient,                            // 真实 HTTP 调用
  assetBuilders,                        // skill/rule/mcp/hook/command/agent 工厂
  expectFileExists, expectFileNotExists, expectFileContains,
  expectFileSet, expectLock, expectLockVendorState,
} from "@maolinc/cc-loom-testkit";

// 用例骨架（仿 install-flow.test.ts）
const skill = await api.createAsset(assetBuilders.skill("f-skill", ["foo"]));
const capabilitySet = await api.createCapabilitySet(
  { name: "ws-foo", targetTools: ["foo"], visibility: "public" },
  [skill.id],
);
await setup(server.baseUrl, token);  // startAgent + register
const { result } = await api.installExecute({
  projectId: agent.projectId, capabilitySetId: capabilitySet.id, targetTools: ["foo"], policy: "locked",
});
expect(result.success).toBe(true);
expectFileExists(projectRoot, ".foo/skills/f-skill/SKILL.md");
expectLockVendorState(projectId, "foo", /* enabled asset ids */);
```

**"不为通过而写"**：断言具体路径 / 具体文件内容 / 具体 lock vendor state，而非"非 200"或 `expect(true).toBe(true)`；覆盖正向 + 不支持类型跳过两条路径，不用 `sleep` 硬等代替状态轮询（`startAgent` 的 `isOnline` 回调已是状态轮询）。

### 6.3 L4 编排（按需）

`tests/l4-scenarios/multi-asset-install.test.ts` 当前编排"同一 能力集 装到两个项目的不同厂商"。**仅当新厂商有特殊行为（项目根文件、agent 转写）值得加入多厂商编排时**，扩展此用例把新厂商作为第二个/第三个落盘目标，断言其目录。无特殊行为则跳过。

### 6.4 L5 UI（按需）

`tests/l5-ui/` 是 Playwright。新增厂商会让 VendorTabStrip / CapabilityMatrix / DocsPage 多渲染一格——**仅当新厂商的 UI 交互本身是新功能时**才加 L5 用例。一般情况下 L5 不需要为新增厂商专门补。

---

## 验证总清单

### 本地快速验证（L1 + 类型 + 构建）

```bash
pnpm --filter @maolinc/cc-loom-shared typecheck
pnpm --filter @maolinc/cc-loom-adapter typecheck
pnpm --filter @maolinc/cc-loom typecheck
pnpm --filter @maolinc/cc-loom-server typecheck
pnpm --filter web typecheck && pnpm --filter web build
pnpm test          # L1 单元（含 adapter-install-key / adapter-layout 等）
pnpm build         # 全量构建（docker 跑 L3 前必须先 build）
```

`Record<TargetTool, ...>` 的 TS 约束会强制补齐 shared 常量与 `ToolIcon.LOGOS`——typecheck 全绿基本不会漏掉"完整性"改动。

### Docker 跑 L3（强制门槛）

L3/L4/L5 一律走 docker（容器级销毁替代手动清理，原理见 `docs/testing/principles.md` §2）。通过 `justfile` 统一入口：

```bash
just test-docker-build              # 构建测试镜像（首次/依赖变更后跑一次）

# 只跑 L3（含原 L2 的 HTTP API 用例 + 真实 install/agent/WS 链路）
just test-docker-e2e                # 全部 L3
just test-docker-e2e-file install-flow   # 只跑 install-flow（新厂商用例就在这里）
just test-docker-e2e-file push           # 只跑 push（若有 vendor-reader 改动）
just test-docker-e2e-dev            # dev 模式：卷挂载 tests/，改用例 0 重建

# L4 编排 / L5 UI（按需）
just test-docker-scenarios          # 全部 L4
just test-docker-scenario multi-asset-install
just test-docker-ui                 # L5 Playwright

# 一次性全跑 + 稳定性验证
just test-docker-all                # L3 + L4 + L5
just test-docker-stable             # 连跑 5 次验证无 flake
just test-docker-clean              # 清理镜像
```

**最小验证路径**：改完代码 → `pnpm test`（L1 绿）→ `pnpm build` → `just test-docker-build` → `just test-docker-e2e-file install-flow`（新厂商 L3 用例必须绿）。这一条链路是新厂商改动的**强制验收线**。

### 人工冒烟（L3 覆盖不到的部分）

1. Web 能力集编辑器里勾选新厂商 → 安装计划预览的落盘路径与决策表一致。
2. `loom start` 后本地控制台 → VendorTabStrip 出现新厂商 tab、logo 正常、CapabilityMatrix 的"不支持"单元格正确。
3. Docs 页 → 新厂商的目录规范展示。

---

## 反例：不要改这些地方

| 不要动 | 原因 |
|--------|------|
| `packages/server/src/db/migrate.ts` | `tool` 列是 `TEXT` 存 JSON，无 enum 约束 |
| `packages/shared/src/schemas.ts` | schema 用 `TARGET_TOOLS` 派生校验，自动 |
| `packages/shared/src/types.ts` | `TargetTool` 是 `typeof TARGET_TOOLS[number]`，自动 |
| `packages/cli/src/lib/detect.ts` | 遍历常量，自动 |
| `packages/cli/src/lib/safe-write.ts` 的 `ALLOWED_TOP_DIRS` | `Object.values(TARGET_DIRS)`，自动（只有 `ALLOWED_ROOT_FILES` 需要时才动） |
| 各 Web 组件里遍历 `compatibleTools` / `TARGET_TOOLS` 的循环 | 自动 |

一个简单的"是否改对了"的自检：**`TargetTool` 这个 union 在 TS 里加了一个字面量后，所有 `Record<TargetTool, ...>` 都会被编译器强制补齐**。让 `pnpm typecheck` 全绿，就基本不会漏掉 shared / web logo / adapter 这些"完整性"改动；剩下的硬编码特例（MCP 路径、scanner 合并、push 提取）需要对照第 3、4、5 步的清单逐一确认。

---

## 示例：假想厂商 "Foo" 的最小改动集

假设 Foo 是一个"长得像 ClaudeCode"的厂商（PascalCase hooks、MCP 在 `.foo/mcp.json`、agent 是 Markdown、全 6 类支持）。

改动文件清单：

1. `packages/shared/src/constants.ts` — 4 个 Record 各加 `foo` 条目。
2. `packages/adapter/src/foo.ts` — 新建，`extends BaseAdapter`，仅设 `tool` / `targetDir` / `supportedTypes`。
3. `packages/adapter/src/registry.ts` — `adapters` 数组加 `new FooAdapter()`。
4. `packages/web/src/components/ToolIcon.tsx` — import + `LOGOS` 加 `foo`。
5. `packages/web/src/assets/tool-logos/foo.svg` — 放 logo。
6. `packages/web/src/pages/DocsPage.tsx` — `VENDOR_SPECS` 加一条。
7. `tests/l3-real-e2e/install-flow.test.ts` — **追加一个 `"foo: ..."` L3 用例**（强制门槛，覆盖全 supportedTypes 落盘矩阵 + 不支持类型跳过）。
8. `packages/server/src/__tests__/adapter-install-key.test.ts` / `adapter-layout.test.ts` — L1 单元测试补新 adapter 的判重坐标与路径渲染。

**总计 8 个文件**，0 个硬编码特例分支。如果 Foo 的 MCP 要写项目根 `.foo.mcp.json`，则再加：safe-write 的 `ALLOWED_ROOT_FILES`、scanner 的合并段、watcher 的监视路径、vendor-reader 的提取分支、AssetComposerPage 的 `installPath` 三元——共 5 处特例，与 ClaudeCode 当前的特例分布完全对称；L3 侧相应补 `push.test.ts`、`drift-self-heal.test.ts` 的断言。
