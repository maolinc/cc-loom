import type { AssetType, HookMetadata, Manifest, ManifestAssetEntry, ReconcileAggregateEntry, TargetTool } from "@maolinc/cc-loom-shared";
import { hookEventsOf } from "@maolinc/cc-loom-shared";
import { isAssetDirLayout } from "@maolinc/cc-loom-shared";
import type { Adapter, AdapterFile, AdapterOutput } from "./types.js";

/** name → 文件名安全的 slug：小写、非字母数字折叠为 `-`、去首尾 `-`。 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 子目录映射：Asset 类型 → 目标目录下的子目录名 */
function getAssetDir(type: AssetType): string {
  switch (type) {
    case "skill":
      return "skills";
    case "rule":
      return "rules";
    case "hook":
      return "hooks";
    case "command":
      return "commands";
    case "agent":
      return "agents";
    case "mcp":
      return ""; // MCP handled separately
  }
}

/**
 * 文件扩展名映射。tool 参数预留给后续工具特定差异（如 Codex agent TOML，待 P1 实现）。
 * 注：hook 不在此处理 — 它走聚合写出分支。
 */
function getFileExtension(_type: AssetType, _tool: TargetTool): string {
  return ".md";
}

export abstract class BaseAdapter implements Adapter {
  abstract tool: TargetTool;
  abstract targetDir: string;
  /** 该 Adapter 支持的 Asset 类型；不在此列表的将在 generate 阶段被跳过 */
  abstract supportedTypes: readonly AssetType[];

  generate(manifest: Manifest): AdapterOutput {
    const files: AdapterFile[] = [];
    const mcps: ManifestAssetEntry[] = [];
    const hooks: ManifestAssetEntry[] = [];
    const skipped: ManifestAssetEntry[] = [];

    for (const asset of manifest.assets) {
      // Only include assets compatible with this tool
      if (!asset.compatibleTools.includes(this.tool)) continue;

      // Skip asset types this adapter doesn't support (e.g. Cursor + agent, Codex + command)
      if (!this.supportedTypes.includes(asset.type)) {
        skipped.push(asset);
        continue;
      }

      if (asset.type === "mcp") {
        mcps.push(asset);
      } else if (asset.type === "hook") {
        // 厂商事件名空间可能不覆盖资产声明的任何事件（如 Cursor 用 camelCase 且事件集
        // 不同）：全部事件 mapHookEvent 返回 null → 整个 hook 资产跳过（不落附属文件、
        // 不进注册表）。
        if (this.registrableHookEvents(asset.metadata as HookMetadata | undefined).length === 0) {
          skipped.push(asset);
          continue;
        }
        hooks.push(asset);
      } else {
        files.push(...this.renderAssetFiles(asset));
      }
    }

    // 把所有 MCP 资产汇总到该厂商规定的 mcp 配置文件（参考 §9.4.3 MCP 特殊处理）。
    const mcpFile = this.aggregateMcps(mcps);
    if (mcpFile) files.push(mcpFile);

    // 聚合所有 hook 资产 → 厂商规范的配置文件 + hooks 包内附属文件原样落到 hooks/<name>/<rel>。
    if (hooks.length > 0) {
      for (const h of hooks) {
        // passthrough（adopt 的 foreign hook）：附属文件按精确磁盘路径原样落盘，
        // 不做 hooks/<name>/ 目录变换——保持扁平脚本等外部路径 round-trip。
        const passthrough = (h.metadata as HookMetadata | undefined)?.passthrough === true;
        for (const f of h.files) {
          if (f.path === "hook.json") continue; // 元数据已合并进注册文件
          files.push({
            path: passthrough ? f.path : `${this.targetDir}/hooks/${h.name}/${f.path}`,
            content: f.content,
            ...(f.encoding ? { encoding: f.encoding } : {}),
          });
        }
      }
      this.emitHookRegistry(hooks, files);
    }

    return { files, targetDir: this.targetDir, skipped };
  }

  /**
   * 单 Asset 的文件渲染（不含 mcp / hook 聚合路径）。capabilities 流程下被
   * `cli/lib/capabilities.ts` 调用以增量加入或重算单 asset 的文件。
   *
   * 调用约束（不在此处校验，由调用方负责）：
   *   - asset.compatibleTools 必须包含 this.tool；
   *   - asset.type 必须在 this.supportedTypes 内（mcp / hook 调用方应改走 aggregate 路径）。
   *
   * 对 type=mcp 或 type=hook 的 asset 统一返回空数组：这两类必须由
   * `aggregateMcps()` / `emitHookRegistry()` 重算后写出聚合文件，单 asset
   * 视角无意义。capabilities 流程在 toggle/add/remove mcp/hook 时会
   * 1) 调本方法收 hook 包附属文件（type=hook 才有），2) 重算 aggregate。
   */
  generateForAsset(asset: ManifestAssetEntry): AdapterFile[] {
    // passthrough：外部能力 adopt 时存的是精确磁盘相对路径（asset_files.path 即落盘路径），
    // 直接原样写出，不做 targetDir/dir/name/slug 变换——保证 rule/command/agent/skill
    // 扁平文件等任意外部路径 round-trip。metadata.passthrough 由 adopt 设置。
    if ((asset.metadata as { passthrough?: boolean })?.passthrough === true) {
      return asset.files.map((f) => ({
        path: f.path,
        content: f.content,
        ...(f.encoding ? { encoding: f.encoding } : {}),
      }));
    }
    if (asset.type === "mcp") return [];
    if (asset.type === "hook") {
      // 声明的事件全部不可映射到本厂商时（如 Cursor 未覆盖的事件集）不产出附属文件——
      // 与 generate() 的 skipped 口径一致，避免落孤儿文件。
      if (this.registrableHookEvents(asset.metadata as HookMetadata | undefined).length === 0) return [];
      // hook 包附属文件（hook.json 之外的）。aggregate 入口由调用方走
      // recomputeHooksAggregate / emitHookRegistry。passthrough（adopt 的 foreign hook）
      // 按精确磁盘路径原样落盘，不做 hooks/<name>/ 目录变换。
      const passthrough = (asset.metadata as HookMetadata | undefined)?.passthrough === true;
      const out: AdapterFile[] = [];
      for (const f of asset.files) {
        if (f.path === "hook.json") continue;
        out.push({
          path: passthrough ? f.path : `${this.targetDir}/hooks/${asset.name}/${f.path}`,
          content: f.content,
          ...(f.encoding ? { encoding: f.encoding } : {}),
        });
      }
      return out;
    }
    return this.renderAssetFiles(asset);
  }

  /**
   * 重算 mcp.json：从 enabled 子集生成 wrapped 配置。空集合返回 null，调用方
   * 应据此把现存 mcp.json 删除（产品决策：不留 `{mcpServers:{}}` 噪声）。
   * 仅 install 预览用——v2 reconcile 走 mcpOwnedEntries + mergeAggregate。
   */
  recomputeMcpAggregate(enabledMcps: ManifestAssetEntry[]): AdapterFile | null {
    const entries = mcpServerEntriesAll(enabledMcps);
    if (entries.length === 0) return null;
    const mcpServers: Record<string, unknown> = {};
    for (const e of entries) mcpServers[e.key] = e.value;
    return {
      path: this.mcpConfigPath(),
      content: JSON.stringify({ mcpServers }, null, 2),
      mergeStrategy: "mcp-servers",
    };
  }

  /** v2 reconcile：enabled mcp 资产 → per-key 条目（server name → def）。 */
  mcpOwnedEntries(enabledMcps: ManifestAssetEntry[]): ReconcileAggregateEntry[] {
    return mcpServerEntriesAll(enabledMcps);
  }

  /** v2 reconcile：所有受管 mcp 资产的 server key 集合（用于识别 owned 条目并删除）。 */
  mcpOwnedKeys(managedMcps: ManifestAssetEntry[]): string[] {
    const out: string[] = [];
    for (const mcp of managedMcps) out.push(...mcpServerKeysOf(mcp));
    return out;
  }

  /**
   * 重算 hooks 注册表：从 enabled 子集生成 hooks 文件（hooks.json / settings.json）。
   * 空集合返回 null，调用方应据此把现存文件删除。仅 install 预览用。
   */
  recomputeHooksAggregate(enabledHooks: ManifestAssetEntry[]): AdapterFile | null {
    if (enabledHooks.length === 0) return null;
    const tmp: AdapterFile[] = [];
    this.emitHookRegistry(enabledHooks, tmp);
    return tmp[0] ?? null;
  }

  /** v2 reconcile：enabled hook 资产 → per-event 条目（每个 asset 的 matcherEntry 一条）。 */
  hooksOwnedEntries(enabledHooks: ManifestAssetEntry[]): ReconcileAggregateEntry[] {
    const registry = this.buildHookRegistry(enabledHooks);
    const out: ReconcileAggregateEntry[] = [];
    for (const [event, entries] of Object.entries(registry)) {
      for (const entry of entries ?? []) out.push({ key: event, value: entry });
    }
    return out;
  }

  /** v2 reconcile：所有受管 hook 资产名集合（按命令路径判别 owned 条目）。 */
  hooksOwnedNames(managedHooks: ManifestAssetEntry[]): string[] {
    return managedHooks.map((h) => h.name);
  }

  /**
   * v2 reconcile 落盘：把 merge-spec 应用到现有文件内容，保留 foreign 条目。
   * - mcp：managedKey=`mcpServers`，dict 级合并（ownedKeys=server 名）。
   * - hook：managedKey=`hooks`，registry=event→array，按命令路径 `/<targetDir>/hooks/<name>/`
   *   判别 owned 条目（ownedKeys=hook 资产名），foreign entry 原样保留。
   * 全空（无 owned + 无 foreign）→ 返回 null（调用方删文件）。
   */
  mergeAggregate(
    type: "mcp" | "hook",
    path: string,
    entries: ReconcileAggregateEntry[],
    ownedKeys: string[],
    existingJson: string | null,
  ): string | null {
    const root = parseJsonObject(existingJson);
    if (type === "mcp") {
      const managedKey = "mcpServers";
      const existing = asRecord(root[managedKey]);
      const owned = new Set(ownedKeys);
      const dict: Record<string, unknown> = {};
      // 保留 foreign server（不在 ownedKeys 中的现有 key）
      for (const [k, v] of Object.entries(existing)) if (!owned.has(k)) dict[k] = v;
      // 写入 enabled owned 条目
      for (const e of entries) dict[e.key] = e.value;
      if (Object.keys(dict).length === 0) {
        delete root[managedKey];
      } else {
        root[managedKey] = dict;
      }
    } else {
      const managedKey = "hooks";
      const existingRegistry = asRecord(root[managedKey]);
      const owned = new Set(ownedKeys);
      // 新 registry：foreign entry 保留 + owned enabled entry 追加
      const newRegistry: Record<string, unknown[]> = {};
      const entriesByEvent = new Map<string, unknown[]>();
      for (const e of entries) {
        const arr = entriesByEvent.get(e.key) ?? [];
        arr.push(e.value);
        entriesByEvent.set(e.key, arr);
      }
      const allEvents = new Set<string>([
        ...Object.keys(existingRegistry),
        ...entriesByEvent.keys(),
      ]);
      for (const event of allEvents) {
        const foreign = (existingRegistry[event] as unknown[] | undefined ?? [])
          .filter((entry) => !isOwnedHookEntry(entry, owned, this.targetDir));
        const fresh = entriesByEvent.get(event) ?? [];
        const merged = [...foreign, ...fresh];
        if (merged.length > 0) newRegistry[event] = merged;
      }
      if (Object.keys(newRegistry).length === 0) {
        delete root[managedKey];
      } else {
        root[managedKey] = newRegistry;
      }
    }
    if (Object.keys(root).length === 0) return null;
    return JSON.stringify(root, null, 2);
  }

  /** 单 asset → 多 file（仅 skill/rule/command/agent）。 */
  protected renderAssetFiles(asset: ManifestAssetEntry): AdapterFile[] {
    const dir = getAssetDir(asset.type);
    const ext = getFileExtension(asset.type, this.tool);
    const out: AdapterFile[] = [];
    // Directory-layout asset: preserve the source's nested structure under
    //   <targetDir>/<typeDir>/<asset.name>/<file.path>
    // Flat-layout asset: keep the legacy behaviour — single-file assets are
    // renamed to <slugify(name)>.ext, multi-file flatten under <typeDir>.
    if (isAssetDirLayout(asset)) {
      for (const f of asset.files) {
        out.push({
          path: `${this.targetDir}/${dir}/${asset.name}/${f.path}`,
          content: f.content,
          ...(f.encoding ? { encoding: f.encoding } : {}),
        });
      }
    } else {
      for (const f of asset.files) {
        const baseName = slugify(asset.name);
        const fileName = f.path.includes("/")
          ? f.path.split("/").pop()!
          : f.path;
        const outName = asset.files.length === 1
          ? `${baseName}${ext}`
          : fileName;
        const path = `${this.targetDir}/${dir}/${outName}`;
        out.push({ path, content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) });
      }
    }
    return out;
  }

  /**
   * 把 MCP 资产数组聚合成单一 mcp 配置文件（mergeStrategy="mcp-servers"）。
   * 空集返回 null，调用方据此决定写入或删除。
   *
   * 内容形态固定为 `{ mcpServers: { <name>: <serverDef> } }`，与 Cursor /
   * Claude Code 官方一致。Adapter 子类用 `mcpConfigPath()` 决定写到哪个路径。
   */
  protected aggregateMcps(mcps: ManifestAssetEntry[]): AdapterFile | null {
    if (mcps.length === 0) return null;
    const mcpServers: Record<string, unknown> = {};
    for (const mcp of mcps) {
      const raw = mcp.files[0]?.content?.trim() ?? "";
      const def = parseServerDef(raw);
      // 以 asset.name 为 server key。容忍两种 content 形态：
      //   1) 单 server 字典本体：`{ "command": "...", "args": [...] }`     ← marketplace 提取产物
      //   2) 标准包装：`{ "mcpServers": { "<n>": <def>, ... } }`           ← 用户上传的完整配置
      if (def.kind === "wrapped") {
        for (const [k, v] of Object.entries(def.servers)) mcpServers[k] = v;
      } else if (def.kind === "single") {
        mcpServers[mcp.name] = def.value;
      } else {
        // 解析失败：保底以原始字符串挂在 name 下，让用户安装后能看到原数据排查
        mcpServers[mcp.name] = raw;
      }
    }
    return {
      path: this.mcpConfigPath(),
      content: JSON.stringify({ mcpServers }, null, 2),
      mergeStrategy: "mcp-servers",
    };
  }

  /**
   * 该 Adapter 写 MCP 配置的目标路径。默认 `<targetDir>/mcp.json`，
   * 子类按本厂商规范覆写（如 Claude Code 必须放在项目根 `.mcp.json`）。
   */
  protected mcpConfigPath(): string {
    return `${this.targetDir}/mcp.json`;
  }

  /**
   * 本 adapter 的 mcp 聚合文件路径；不支持 mcp 时返回 null。
   * 暴露给 v2 reconcile-plan，使得「该 tool 已不再有 mcp 贡献」时仍能在
   * plan.aggregates 里报出 `{ path, content: null }` 让 CLI 删文件。
   */
  mcpAggregatePath(): string | null {
    return this.supportedTypes.includes("mcp") ? this.mcpConfigPath() : null;
  }

  /**
   * 本 adapter 的 hooks 聚合文件路径；不支持 hook 时返回 null。
   * 默认 `<targetDir>/hooks/hooks.json`（子类通用回退）；各厂商按官方规范覆写——
   * Claude Code / CodeBuddy 嵌 `settings.json`、Codex / Cursor 写顶层 `hooks.json`。
   * `emitHookRegistry` 默认实现也读取此处，保证单一来源。
   */
  hooksAggregatePath(): string | null {
    return this.supportedTypes.includes("hook") ? `${this.targetDir}/hooks/hooks.json` : null;
  }

  /**
   * 把 hooks 注册项落到本厂商规定的配置文件。
   * 默认实现：写到 `hooksAggregatePath()`（hooks-registry 风格通用回退），mergeStrategy="hooks-registry"。
   * 子类按本厂商规范覆写（Claude Code / CodeBuddy 嵌 settings.json、Codex 写顶层 hooks.json 等）。
   */
  protected emitHookRegistry(
    hooks: ManifestAssetEntry[],
    files: AdapterFile[],
  ): void {
    const registry = this.buildHookRegistry(hooks);
    const path = this.hooksAggregatePath();
    if (!path) return;
    files.push({
      path,
      content: JSON.stringify({ hooks: registry }, null, 2),
      mergeStrategy: "hooks-registry",
    });
  }

  /**
   * 把内部（Claude Code 风格 PascalCase）事件名映射为该厂商的 hook 事件名。
   * 返回 null 表示该厂商不支持此事件 → 含该事件的 hook 资产整个跳过
   * （不落附属文件、不进注册表，进 skipped 供前端提示不兼容）。
   *
   * 默认原样返回：Claude Code / Codex / CodeBuddy 共用 PascalCase 命名空间。
   * Cursor 覆写为 camelCase 映射（事件集合不完全重叠）。
   */
  protected mapHookEvent(event: string): string | null {
    return event;
  }

  /**
   * 把 hook 资产数组合并成 `{ event: [{ matcher?, hooks: [...] }] }` 注册结构。
   * 子类一般用此结果作为输入，再决定写入位置和外层包装。
   */
  protected buildHookRegistry(
    hooks: ManifestAssetEntry[],
  ): Record<string, unknown[]> {
    const registry: Record<string, unknown[]> = {};
    for (const h of hooks) {
      const md = h.metadata as HookMetadata;
      if (!Array.isArray(md?.hooks) || md.hooks.length === 0) continue;
      if (md.passthrough === true && Array.isArray(md.registrations)) {
        // adopt 的 foreign hook：逐事件原样写回注册项——命令不改写（可能是 bash -c
        // 包装或扁平脚本路径），matcher/description 等全部字段保留。
        for (const reg of md.registrations) {
          const mapped = this.mapHookEvent(reg.event);
          if (mapped === null) continue;
          (registry[mapped] ||= []).push(reg.entry);
        }
        continue;
      }
      // 一个 hook 可注册多个事件：同一 matcherEntry 落到每个事件下（安装时全部注册，
      // 关闭时由 mergeAggregate 按 owned 判据从所有事件移除）。
      for (const ev of hookEventsOf(md)) {
        const mappedEvent = this.mapHookEvent(ev);
        if (mappedEvent === null) continue;
        const rewritten = md.hooks.map((entry) => this.rewriteHookEntry(h.name, entry));
        const matcherEntry: Record<string, unknown> = { hooks: rewritten };
        if (md.matcher) matcherEntry.matcher = md.matcher;
        (registry[mappedEvent] ||= []).push(matcherEntry);
      }
    }
    return registry;
  }

  /**
   * 资产声明的事件中可映射到本厂商事件空间的子集。为空 = 该 hook 在本厂商不落盘
   * （generate 的 skipped / generateForAsset 的空数组判据）。
   */
  protected registrableHookEvents(md: HookMetadata | undefined): string[] {
    return hookEventsOf(md).filter((ev) => this.mapHookEvent(ev) !== null);
  }

  /**
   * 把单条 hook entry（hook.json 中 hooks[i]）落到目标厂商时的命令路径改写。
   * 仅处理 type=command 的相对路径；占位符（${...}）或绝对路径原样保留。
   * 子类可覆写以适配各厂商的项目根占位符约定。
   */
  protected rewriteHookEntry(
    name: string,
    entry: { type: string; [k: string]: unknown },
  ): { type: string; [k: string]: unknown } {
    if (entry.type !== "command" || typeof entry.command !== "string") return entry;
    const cmd = entry.command;
    if (cmd.startsWith("/") || cmd.startsWith("~") || cmd.startsWith("$")) return entry;
    return {
      ...entry,
      command: `\${CLAUDE_PROJECT_DIR}/${this.targetDir}/hooks/${name}/${cmd}`,
    };
  }
}

// ---------------- helpers ----------------

/**
 * 算出一个 MCP asset 最终落盘到 mcp.json 的 server key 列表。
 * 与 `aggregateMcps` 的取键口径完全一致：
 *   - wrapped (`{mcpServers:{...}}`)：用 content 内部的每个 key（可能多个）。
 *   - single / 解析失败：用 `asset.name` 作为唯一 key。
 * 供 `computeInstallKey` 复用，保证“判重的 serverKey”等于“落盘的 serverKey”。
 */
export function mcpServerKeysOf(mcp: {
  name: string;
  files: { path: string; content: string }[];
}): string[] {
  return mcpServerEntries(mcp).map((e) => e.key);
}

/**
 * 把 mcp 资产数组解析成 per-key 条目（server name → def）。
 * 与 `aggregateMcps` / `mcpServerKeysOf` 共用同一取键口径：
 *   - wrapped (`{mcpServers:{...}}`)：content 内部每个 key 一条。
 *   - single (`{command,args,...}`)：以 `asset.name` 为 key。
 *   - 解析失败：以 `asset.name` 为 key，原字符串为 value。
 */
function mcpServerEntries(mcp: {
  name: string;
  files: { path: string; content: string }[];
}): ReconcileAggregateEntry[] {
  const raw = mcp.files[0]?.content?.trim() ?? "";
  const def = parseServerDef(raw);
  if (def.kind === "wrapped") {
    const entries = Object.entries(def.servers).map(([k, v]) => ({ key: k, value: v }));
    return entries.length > 0 ? entries : [{ key: mcp.name, value: raw }];
  }
  if (def.kind === "single") return [{ key: mcp.name, value: def.value }];
  return [{ key: mcp.name, value: raw }];
}

/** 把 mcp 资产数组（多资产）解析成 per-key 条目。每个条目带上所属 assetId，供 reconcile
 * 凭 assetId 回溯鉴权绑定（wrapped 资产的内层 server key ≠ 资产名，不能按名匹配）。 */
function mcpServerEntriesAll(mcps: ManifestAssetEntry[]): ReconcileAggregateEntry[] {
  const out: ReconcileAggregateEntry[] = [];
  for (const mcp of mcps) {
    for (const e of mcpServerEntries(mcp)) out.push({ ...e, assetId: mcp.assetId });
  }
  return out;
}

type ParsedServerDef =
  | { kind: "wrapped"; servers: Record<string, unknown> }
  | { kind: "single"; value: unknown }
  | { kind: "raw" };

/**
 * 解析 MCP asset content：识别 wrapped (`{mcpServers:{}}`) 与 single (`{command,args,...}`) 两种形态。
 * marketplace 的 generic-git 提取产物是 single；用户上传完整 mcp.json 是 wrapped。
 */
function parseServerDef(raw: string): ParsedServerDef {
  if (!raw) return { kind: "raw" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "raw" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "raw" };
  const obj = parsed as Record<string, unknown>;
  if (
    obj.mcpServers !== undefined &&
    typeof obj.mcpServers === "object" &&
    obj.mcpServers !== null &&
    !Array.isArray(obj.mcpServers)
  ) {
    return { kind: "wrapped", servers: obj.mcpServers as Record<string, unknown> };
  }
  return { kind: "single", value: obj };
}

// ---------------- merge-preserving helpers ----------------

/**
 * 解析聚合文件 JSON 为可变对象。
 * - null / 空 / 纯空白 → 空对象（无文件或新文件，从空起步）。
 * - 非空但解析失败（JSONC 注释、损坏等）→ **抛错**，绝不返回 {}。否则调用方会以为
 *   「existing 为空」进而用 Loom 自身内容整文件覆写，静默丢失用户手写的 foreign
 *   server / hook / settings 字段。抛错后 CLI 不写盘、报错反馈用户，文件原样保留。
 */
function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AggregateParseError(
      `聚合文件不是有效 JSON（可能含注释或损坏），已跳过以免覆写用户内容：${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // 顶层非对象（数组/字符串/数字）：同样不覆写，交给用户修正。
    throw new AggregateParseError("聚合文件顶层不是 JSON 对象，已跳过以免覆写用户内容");
  }
  return parsed as Record<string, unknown>;
}

/** 聚合文件解析失败错误；CLI 据此区分「该文件不要写盘」与普通 IO 错误。 */
export class AggregateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregateParseError";
  }
}

/** 把 unknown 收拢为 Record<string, unknown>；非对象 → 空对象。 */
function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

/**
 * 判断 hooks registry 的一条 matcherEntry 是否由 Loom 拥有（应被删除/重写）。
 * 判据：其 hooks[].command 中任一引用了 `hooks/<ownedName>/`（目录形态）或
 * `hooks/<ownedName>.`（扁平脚本形态，任意扩展名）。
 * 与 `rewriteHookEntry` 写入的命令路径 `${CLAUDE_PROJECT_DIR}/<targetDir>/hooks/<name>/`
 * 及 adopt 保留的 foreign 命令（如 `.../hooks/<name>.sh`）对齐；
 * 命令路径不含受管名的 foreign hook → 返回 false，原样保留。
 */
function isOwnedHookEntry(entry: unknown, ownedNames: Set<string>, targetDir: string): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  for (const h of hooks) {
    const cmd = (h as { command?: unknown })?.command;
    if (typeof cmd !== "string") continue;
    for (const name of ownedNames) {
      // 命中 `hooks/<name>/` 或 `hooks/<name>.` 即认定归属该受管 hook
      // （targetDir 前缀不作要求，兼容 $CWD 等占位符差异）
      if (cmd.includes(`hooks/${name}/`) || cmd.includes(`hooks/${name}.`)) return true;
    }
  }
  return false;
}
