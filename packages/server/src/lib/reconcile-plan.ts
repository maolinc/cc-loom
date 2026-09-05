/**
 * Wire 协议 v2 的服务端原语：把"项目当前 DB 状态"提炼成单一可直接落盘的
 * `ReconcilePlan`。CLI 端 `handleReconcile` 仅消费此结果，不再做 asset→file 渲染。
 *
 * 见 docs/refactor/wire-protocol-unification.md §3.2。
 *
 * 设计：
 *  - 纯读侧：只查 DB + 调 @maolinc/cc-loom-adapter 渲染，不写任何表，不联系 CLI。
 *    调用方负责入队 / 投递 / 写账本。
 *  - 受管集 = ∪（每条活跃显式订阅的 capability_set_assets − 撞车跳过集） ∪ project_capabilities
 *    （ADR-0006 多能力集订阅）。同一 asset id 跨订阅共享单例，按 (能力 × 厂商) 引用计数：
 *    某 (asset, tool) 仅当仍有订阅覆盖该 tool 时才渲染。project_capabilities 来自本地
 *    控制台 adopt / 单独添加（per-project、不扇出，工具集跟随项目有效工具）。
 *  - `removed`：以 `project_installed_assets` 为"上次 plan asset 全集"账本。
 *    本次 plan 计算出 enabled ∪ disabled 的 assetId 集后取差集即可。
 *  - 聚合文件（mcp/hook）走 merge-preserving：server 产出 entries（enabled 渲染）+
 *    ownedKeys（enabled+disabled+removed 的 key/name），CLI read-modify-write 保留
 *    foreign 条目。避免整文件重算抹掉用户手写配置。
 *  - 可见性过滤口径与 lib/reconcile.ts:buildInstallPlan / asset-manifest.loadAssetEntries
 *    保持一致：private asset 仅当 author === project owner email 时放行。
 *  - 能力集为空 / 已软删时：capability_set_assets 不计入，但 project_capabilities 仍生效；
 *    若两者皆空则进入清空状态（removed = 上次账本全集，聚合 entries 为空）。
 */
import type {
  AssetType,
  AssetAuthBinding,
  ManifestAssetEntry,
  ReconcileAggregate,
  ReconcileAggregateEntry,
  ReconcileAsset,
  ReconcileAssetVendor,
  ReconcileFile,
  ReconcilePlan,
  SyncPolicy,
  TargetTool,
} from "@maolinc/cc-loom-shared";
import { TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import type { Adapter, AdapterFile } from "@maolinc/cc-loom-adapter";
import { getAdapters, listAdapters } from "@maolinc/cc-loom-adapter";
import { db } from "../db/index.js";
import { loadAssetEntries } from "./asset-manifest.js";
import { applyPathBindings, loadAuthBindings, loadDistributedCredentials } from "./credential-inject.js";
import {
  IMPLICIT_CAPABILITY_SET_ID,
  loadExcludes,
  loadSubscriptionRows,
  projectEffectiveTools,
} from "./subscriptions.js";

export type ReconcileProjectOk = {
  plan: ReconcilePlan;
  /** 显式订阅快照（含名称富化），写入 CLI lock 与 op 请求。 */
  subscriptions: import("@maolinc/cc-loom-shared").CapabilitySetSubscription[];
  targetTools: TargetTool[];
};
export type ReconcileProjectErr = { error: string; status: 404 };
export type ReconcileProjectResult = ReconcileProjectOk | ReconcileProjectErr;

interface ProjectRow {
  id: string;
  device_id: string;
  user_id: string;
  detected_targets: string;
  default_targets: string;
  status: string;
}

/** 项目所有者 email（visibility 过滤口径）。空 = 严格按"非作者"看待。 */
function ownerEmail(userId: string): string {
  const u = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as
    | { email: string }
    | undefined;
  return u?.email ?? "";
}

/** AdapterFile → ReconcileFile，仅保留 path/content/encoding（去掉 mergeStrategy）。 */
function toReconcileFile(f: AdapterFile): ReconcileFile {
  return f.encoding
    ? { path: f.path, content: f.content, encoding: f.encoding }
    : { path: f.path, content: f.content };
}

/**
 * 加载项目受管 asset 全集与 (asset → 渲染工具集) 归属（ADR-0006 多订阅模型）。
 *
 * 受管集 = ∪（每条活跃显式订阅的 capability_set_assets − 撞车跳过集） ∪ project_capabilities
 * （隐式订阅）。同一 asset id 跨订阅共享单例：assetTools 取各订阅覆盖工具的并集。
 *
 * - 显式订阅的渲染工具 = 订阅 target_tools ∩ 能力集当前声明 target_tools
 *   （尊重能力集作者后续收窄厂商）；能力集已软删 → 该订阅不活跃，成员不计入。
 * - 隐式订阅（project_capabilities）的渲染工具 = 项目有效工具集合。
 * - 含留存（软删）asset，保证 mcp/hook 聚合重算拿得到内容；可见性由 loadAssetEntries 过滤。
 */
function loadManaged(
  projectId: string,
  project: ProjectRow,
  email: string,
): {
  entries: ManifestAssetEntry[];
  assetTools: Map<string, Set<TargetTool>>;
  effectiveTools: TargetTool[];
  subscriptions: import("@maolinc/cc-loom-shared").CapabilitySetSubscription[];
} {
  const projectTools = projectEffectiveTools(project);
  const assetTools = new Map<string, Set<TargetTool>>();
  const addTools = (assetId: string, tools: TargetTool[]) => {
    const set = assetTools.get(assetId) ?? new Set<TargetTool>();
    for (const t of tools) set.add(t);
    assetTools.set(assetId, set);
  };

  const subscriptions: import("@maolinc/cc-loom-shared").CapabilitySetSubscription[] = [];
  for (const sub of loadSubscriptionRows(projectId)) {
    if (sub.capability_set_id === IMPLICIT_CAPABILITY_SET_ID) continue; // 隐式订阅不进快照
    const capabilitySet = db
      .prepare("SELECT id, name, deleted_at, target_tools FROM capability_sets WHERE id = ?")
      .get(sub.capability_set_id) as
      | { id: string; name: string; deleted_at: string | null; target_tools: string }
      | undefined;
    if (!capabilitySet) continue; // 能力集行已不存在（GC 后悬挂订阅）：视为不活跃
    subscriptions.push({
      capabilitySetId: capabilitySet.id,
      capabilitySetName: capabilitySet.name,
      syncPolicy: (sub.sync_policy === "locked" ? "locked" : "auto") as SyncPolicy,
      targetTools: sub.target_tools ? (JSON.parse(sub.target_tools) as TargetTool[]) : null,
      installedAt: sub.installed_at,
      ...(capabilitySet.deleted_at ? { retained: true } : {}),
    });
    if (capabilitySet.deleted_at) continue; // 留存能力集：成员不计入受管集
    const subTools = sub.target_tools ? (JSON.parse(sub.target_tools) as TargetTool[]) : projectTools;
    const capabilitySetTools = JSON.parse(capabilitySet.target_tools || "[]") as TargetTool[];
    const tools = subTools.filter((t) => capabilitySetTools.includes(t));
    if (tools.length === 0) continue;
    const excludes = loadExcludes(projectId, capabilitySet.id);
    const rows = db
      .prepare("SELECT asset_id FROM capability_set_assets WHERE capability_set_id = ?")
      .all(capabilitySet.id) as { asset_id: string }[];
    for (const r of rows) {
      if (excludes.has(r.asset_id)) continue;
      addTools(r.asset_id, tools);
    }
  }

  const caps = db
    .prepare("SELECT asset_id FROM project_capabilities WHERE project_id = ?")
    .all(projectId) as { asset_id: string }[];
  for (const r of caps) addTools(r.asset_id, projectTools);

  const entries = loadAssetEntries([...assetTools.keys()], email, true);
  const effectiveTools = [...new Set([...assetTools.values()].flatMap((s) => [...s]))];
  return { entries, assetTools, effectiveTools, subscriptions };
}

/**
 * 构造所有 (tool, type) 的聚合 merge-spec。
 *
 * 覆盖**全部厂商**（不只是 effectiveTools）：当某厂商从 effectiveTools 退出（切到
 * 不声明该厂商的能力集 / 项目 targets 变化）时，该厂商此前写进聚合文件的 owned
 * 条目必须被清掉、foreign 用户内容必须保留。若只为 effectiveTools 算聚合，dropped
 * 厂商的聚合文件不会出现在 plan.aggregates 里，CLI orphan 阶段会整文件删除——丢失
 * 用户手写配置。故对 dropped 厂商也 emit（entries 空、ownedKeys=该厂商受管∪移除的
 * key/name），让 CLI mergeAggregate 清 owned、留 foreign。
 *
 * - managed = 当前受管（capability_set_assets ∪ project_capabilities）的 mcp/hook；
 *   removed = 上次账本中已移除的 mcp/hook。两者并集决定 ownedKeys。
 * - effective 厂商：entries = enabled 渲染（+path 鉴权注入）；contributingAssetIds = enabled。
 * - dropped 厂商：entries = []（不写任何条目，仅按 ownedKeys 清旧 owned）。
 * - 仅当 Loom 对该 (tool,type) 有事可做（ownedKeys/entries/contributing 任一非空）才 emit：
 *   从未管理过的厂商 → 不 emit，避免触碰用户从未交给 Loom 的聚合文件。
 * - mcp entries 渲染后应用 path 鉴权绑定注入（ADR-0003）：仅当本项目已显式分发该凭据时
 *   字面替换值；否则保留作者原始叶子。注入失败（非字符串叶子/遍历冲突）→ 该 entry 标记
 *   error，调用方据 failure 短路报错。
 */
function buildAggregates(
  allAdapters: Adapter[],
  effectiveToolSet: Set<TargetTool>,
  manifestEntries: ManifestAssetEntry[],
  removedEntries: ManifestAssetEntry[],
  disabledSet: Set<string>,
  bindingsByAsset: Map<string, AssetAuthBinding[]>,
  credValues: Map<string, string>,
  injectErrors: string[],
): ReconcileAggregate[] {
  const out: ReconcileAggregate[] = [];
  for (const adapter of allAdapters) {
    const isEffective = effectiveToolSet.has(adapter.tool);
    const mcpPath = adapter.mcpAggregatePath();
    if (mcpPath) {
      const managed = manifestEntries.filter(
        (a) => a.type === "mcp" && a.compatibleTools.includes(adapter.tool),
      );
      const removedMcp = removedEntries.filter(
        (a) => a.type === "mcp" && a.compatibleTools.includes(adapter.tool),
      );
      const ownedKeys = adapter.mcpOwnedKeys([...managed, ...removedMcp]);
      let entries: ReconcileAggregateEntry[] = [];
      let contributingAssetIds: string[] = [];
      if (isEffective) {
        const enabled = managed.filter((a) => !disabledSet.has(`${a.assetId}::${adapter.tool}`));
        entries = adapter.mcpOwnedEntries(enabled).map((e) => {
          // wrapped MCP 资产的内层 server key 可能与资产名不同，凭 assetId 回溯绑定，
          // 不再用 a.name === e.key 匹配（会漏掉 wrapped 资产，导致凭据不注入）。
          const asset = e.assetId ? enabled.find((a) => a.assetId === e.assetId) : enabled.find((a) => a.name === e.key);
          if (!asset) return e;
          const bindings = bindingsByAsset.get(asset.assetId);
          if (!bindings || bindings.length === 0) return e;
          try {
            return { ...e, value: applyPathBindings(e.value, bindings, credValues) };
          } catch (err) {
            injectErrors.push(`${asset.name}: ${(err as Error).message}`);
            return e; // 保留原始 entry，但已记错；调用方将整体短路
          }
        });
        contributingAssetIds = enabled.map((a) => a.assetId);
      }
      if (ownedKeys.length > 0 || entries.length > 0 || contributingAssetIds.length > 0) {
        out.push({
          tool: adapter.tool,
          type: "mcp",
          path: mcpPath,
          entries,
          ownedKeys,
          contributingAssetIds,
        });
      }
    }
    const hookPath = adapter.hooksAggregatePath();
    if (hookPath) {
      const managed = manifestEntries.filter(
        (a) => a.type === "hook" && a.compatibleTools.includes(adapter.tool),
      );
      const removedHook = removedEntries.filter(
        (a) => a.type === "hook" && a.compatibleTools.includes(adapter.tool),
      );
      const ownedKeys = adapter.hooksOwnedNames([...managed, ...removedHook]);
      let entries: ReconcileAggregateEntry[] = [];
      let contributingAssetIds: string[] = [];
      if (isEffective) {
        const enabled = managed.filter((a) => !disabledSet.has(`${a.assetId}::${adapter.tool}`));
        entries = adapter.hooksOwnedEntries(enabled);
        contributingAssetIds = enabled.map((a) => a.assetId);
      }
      if (ownedKeys.length > 0 || entries.length > 0 || contributingAssetIds.length > 0) {
        out.push({
          tool: adapter.tool,
          type: "hook",
          path: hookPath,
          entries,
          ownedKeys,
          contributingAssetIds,
        });
      }
    }
  }
  return out;
}

/**
 * 把已移除的 asset 渲染成 ReconcileAsset[]（带 vendors/files），让 CLI 直接按磁盘路径删除，
 * 不依赖 oldLock——从未入 lock 的外部能力（adopt 后立即 remove）也能被删干净。
 *
 * 渲染口径与 enabled/disabled 一致：按 asset.compatibleTools 各起 adapter，mcp 无 per-asset
 * 文件（其聚合 key 由 ownedKeys 删除），hook 取 accessory，其余取 generateForAsset。
 * vendors[].enabled=false（语义：这些文件应被删除）。文件不存在时 CLI 删除为 no-op。
 */
function buildRemovedAssets(removedEntries: ManifestAssetEntry[]): ReconcileAsset[] {
  const out: ReconcileAsset[] = [];
  for (const asset of removedEntries) {
    const tools = asset.compatibleTools.filter((t) => TARGET_TOOLS.includes(t));
    const adapters = tools.length > 0 ? getAdapters(tools as TargetTool[]) : [];
    const vendors: ReconcileAssetVendor[] = [];
    for (const adapter of adapters) {
      if (!adapter.supportedTypes.includes(asset.type)) continue;
      let files: ReconcileFile[];
      if (asset.type === "mcp") {
        files = [];
      } else if (asset.type === "hook") {
        files = adapter.generateForAsset(asset).map(toReconcileFile);
      } else {
        files = adapter.generateForAsset(asset).map(toReconcileFile);
      }
      vendors.push({ tool: adapter.tool, enabled: false, files });
    }
    out.push({
      assetId: asset.assetId,
      name: asset.name,
      type: asset.type,
      version: asset.version,
      vendors,
    });
  }
  return out;
}

/** 计算项目当前期望的 ReconcilePlan。 */
export function reconcileProject(projectId: string): ReconcileProjectResult {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  if (!project) return { error: "项目不存在", status: 404 };

  const email = ownerEmail(project.user_id);

  // 上次 plan 的 asset 全集——计算 `removed` 用。
  const previousAssetIds = new Set(
    (db.prepare("SELECT asset_id FROM project_installed_assets WHERE project_id = ?")
      .all(projectId) as { asset_id: string }[]).map((r) => r.asset_id),
  );

  // 受管 asset 全集 + (asset → 渲染工具集)（多订阅并集，已做可见性 + 软删过滤）
  const { entries: manifestEntries, assetTools, effectiveTools, subscriptions } =
    loadManaged(projectId, project, email);

  // 项目 disabled 集合：(assetId, tool) → true
  const disabledRows = db.prepare(
    "SELECT asset_id, tool FROM project_disabled_assets WHERE project_id = ?",
  ).all(projectId) as { asset_id: string; tool: string }[];
  const disabledSet = new Set(disabledRows.map((r) => `${r.asset_id}::${r.tool}`));

  // effectiveTools 可能为空（无任何活跃订阅且未单独添加能力）。
  // 此时 enabled/disabled 为空，但仍要算 removed + 聚合清理（dropped 厂商清 owned、留 foreign），
  // 故不再 early-return；下方 general flow 用 effectiveAdapters=[] 自然产出空 vendors，
  // buildAggregates 用全量 adapter 对 dropped 厂商 emit 清理聚合。
  const effectiveAdapters = getAdapters(effectiveTools);
  const effectiveToolSet = new Set(effectiveTools);
  const allAdapters = listAdapters();

  // assetId → 累积的 vendors。保持 manifestEntries 顺序（稳定输出）。
  type VendorBuild = { assetId: string; vendor: ReconcileAssetVendor };
  const vendorBuilds: VendorBuild[] = [];
  const perAssetMeta = new Map<string, { name: string; type: AssetType; version: string }>();
  for (const a of manifestEntries) {
    perAssetMeta.set(a.assetId, { name: a.name, type: a.type, version: a.version });
  }

  for (const adapter of effectiveAdapters) {
    for (const asset of manifestEntries) {
      if (!asset.compatibleTools.includes(adapter.tool)) continue;
      if (!adapter.supportedTypes.includes(asset.type)) continue;
      // (asset, tool) 引用计数：仅当仍有订阅覆盖该工具时渲染（ADR-0006）。
      if (!assetTools.get(asset.assetId)?.has(adapter.tool)) continue;

      const isDisabled = disabledSet.has(`${asset.assetId}::${adapter.tool}`);
      let files: ReconcileFile[];

      if (asset.type === "mcp") {
        // mcp 单 asset 不产 per-asset 文件，仅在 aggregate 中体现。
        files = [];
      } else if (asset.type === "hook") {
        // hook 附属脚本（per-asset）+ 注册项（aggregate）；同 v1 拆分。
        const accessory = adapter.generateForAsset(asset);
        files = accessory.map(toReconcileFile);
      } else {
        const rendered = adapter.generateForAsset(asset);
        files = rendered.map(toReconcileFile);
      }

      vendorBuilds.push({
        assetId: asset.assetId,
        vendor: { tool: adapter.tool, enabled: !isDisabled, files },
      });
    }
  }

  // 聚合文件（merge-preserving）+ path 鉴权注入（ADR-0003）
  const currentAssetIds = new Set<string>();
  for (const a of manifestEntries) currentAssetIds.add(a.assetId);
  const removedIds = [...previousAssetIds].filter((id) => !currentAssetIds.has(id));
  const removedEntries = loadAssetEntries(removedIds, email, true);
  const bindingsByAsset = loadAuthBindings(manifestEntries.map((a) => a.assetId));
  const credValues = loadDistributedCredentials(project.user_id, projectId);
  const injectErrors: string[] = [];
  const aggregates = buildAggregates(
    allAdapters, effectiveToolSet, manifestEntries, removedEntries, disabledSet, bindingsByAsset, credValues, injectErrors,
  );
  if (injectErrors.length > 0) {
    // 注入失败（非字符串叶子/遍历冲突）→ reconcile 失败，不写盘（ADR 决策 6）。
    return {
      error: `鉴权注入失败：${injectErrors.join("; ")}`,
      status: 404,
    };
  }

  // assetId → vendors[]（保持原顺序：按 manifestEntries × adapters）
  const vendorsByAsset = new Map<string, ReconcileAssetVendor[]>();
  for (const { assetId, vendor } of vendorBuilds) {
    const arr = vendorsByAsset.get(assetId) ?? [];
    arr.push(vendor);
    vendorsByAsset.set(assetId, arr);
  }

  // 分桶：任一 vendor enabled → enabled bucket；全 disabled → disabled bucket。
  // 完全不适用任何 effectiveTool（vendors 为空）的 asset 直接跳过——既不算 enabled
  // 也不算 disabled；它会自然落入 `removed` 计算（若上次账本里有）。
  const enabled: ReconcileAsset[] = [];
  const disabled: ReconcileAsset[] = [];
  for (const a of manifestEntries) {
    const vendors = vendorsByAsset.get(a.assetId) ?? [];
    if (vendors.length === 0) continue;
    const meta = perAssetMeta.get(a.assetId)!;
    const reconcileAsset: ReconcileAsset = {
      assetId: a.assetId,
      name: meta.name,
      type: meta.type,
      version: meta.version,
      vendors,
    };
    const anyEnabled = vendors.some((v) => v.enabled);
    (anyEnabled ? enabled : disabled).push(reconcileAsset);
  }

  // removed：上次账本 - 本次 plan 集合（带 vendors/files，CLI 直接删磁盘文件）
  const removed = buildRemovedAssets(removedEntries);

  return {
    plan: { enabled, disabled, removed, aggregates },
    subscriptions,
    targetTools: effectiveTools,
  };
}
