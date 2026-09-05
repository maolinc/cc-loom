/**
 * 扫描某个已注册项目的本地状态，构造 `LocalProjectState` 快照。
 *
 * 输出供两条链路使用：
 *  1. `start.ts` 在 watcher 触发或收到 `project:scan` 请求时上报 server
 *  2. `install:uninstall` 完成后立即重扫确认结果
 *
 * 关键边界：
 *  - 仅扫 4 个 TARGET_DIRS 之一作为顶层（与 §9.12.2 写入边界一致），不读项目根
 *    其他文件。
 *  - 不读 file content；`size` 用 `fs.statSync(...).size` 取，足以让 UI 展示。
 *  - **drift 自动修复**：当 lock 存在且 lockedFiles 全部不在磁盘（0/N）→ 删除
 *    lock 并标 `driftCleared=true`、`installedWorkspaceId=null`；部分缺失（k/N，
 *    0<k<N）只在 `missingCount` 计数体现，不动 lock。
 *
 * Capabilities 注入（per-asset lock 路径下）：
 *  - 文件节点带上 `assetId` / `enabled`，UI 据此渲染 toggle。
 *  - mcp.json 节点解析后挂 virtual mcp-server 子节点，每个对应一个 MCP asset。
 *  - vendors[tool].enabled=false 的 asset 在文件树原位置生成占位节点。
 *  - LocalProjectState.capabilities 给出扁平视图供 UI 反查。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";
import {
  TARGET_TOOLS,
  TARGET_DIRS,
  type AssetCapability,
  type AssetCapabilityVendor,
  type AssetType,
  type LocalFileNode,
  type LocalProjectState,
  type LockFile,
  type TargetTool,
  type VendorMirror,
} from "@maolinc/cc-loom-shared";
import { listAdapters } from "@maolinc/cc-loom-adapter";
import { isLegacyLock, lockedFiles, readLock, removeLock } from "./locks.js";
import type { LocalProjectRecord } from "./projects.js";
import { getLocalSkillCounts } from "./skill-stats.js";

/**
 * 把 OS 风格分隔符规范成 POSIX 风格（lock 文件里的路径全部以 "/" 存）。
 * Windows 上 `path.join` 会产出 "\\"，统一转 "/" 才能与 lockedFiles 比对。
 */
function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * 递归列出 `<root>/<vendorDir>` 下的目录树。返回的节点 path 以 vendorDir 起头。
 * 不存在 → null；存在但空 → []。不跟随符号链接，遇到 lstat 失败的条目跳过。
 */
function listVendorTree(
  root: string,
  vendorDir: string,
  managed: Set<string>,
): { tree: LocalFileNode[]; managedHits: Set<string> } | null {
  const abs = join(root, vendorDir);
  let topStat;
  try {
    topStat = statSync(abs);
  } catch {
    return null; // 不存在
  }
  if (!topStat.isDirectory()) return null;

  // 累计 vendor 下命中的 managed 路径，供调用方比对"应在但是否在 managed 里"。
  const managedHits = new Set<string>();

  function walk(absDir: string, relDir: string): LocalFileNode[] {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return [];
    }
    // 过滤符号链接（不进入），其他类型按 file/dir 分流
    const out: LocalFileNode[] = [];
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const childAbs = join(absDir, ent.name);
      const childRelOs = relDir ? join(relDir, ent.name) : ent.name;
      const childRel = toPosix(childRelOs);
      if (ent.isDirectory()) {
        out.push({
          name: ent.name,
          path: childRel,
          type: "dir",
          managed: false,
          children: walk(childAbs, childRelOs),
        });
      } else if (ent.isFile()) {
        let size: number | undefined;
        try {
          size = statSync(childAbs).size;
        } catch {
          size = undefined;
        }
        const isManaged = managed.has(childRel);
        if (isManaged) managedHits.add(childRel);
        out.push({
          name: ent.name,
          path: childRel,
          type: "file",
          managed: isManaged,
          ...(size !== undefined ? { size } : {}),
        });
      }
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  return { tree: walk(abs, vendorDir), managedHits };
}

function countFiles(nodes: LocalFileNode[], pred: (n: LocalFileNode) => boolean): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "file" && pred(node)) n += 1;
    if (node.type === "dir" && node.children) n += countFiles(node.children, pred);
  }
  return n;
}

/**
 * 能力类型目录 → AssetType 的映射。vendor 目录下的这些子目录按能力单元分组，
 * 每个顶层文件或子目录对应一个能力最小单元。
 * 参照 vendor-reader.ts extractAssetDir 与 layout.ts isAssetDirLayout。
 */
const TYPE_DIR_TO_ASSET_TYPE: Record<string, AssetType> = {
  skills: "skill",
  rules: "rule",
  commands: "command",
  agents: "agent",
  hooks: "hook",
};

/** 节点子树内是否包含任何 managed 文件（用于判断能力单元是否被 lock 管理）。 */
function hasManagedFile(node: LocalFileNode): boolean {
  if (node.type === "file") return node.managed;
  if (node.children) {
    for (const c of node.children) {
      if (hasManagedFile(c)) return true;
    }
  }
  return false;
}

/** 收集节点子树内所有文件路径（POSIX 风格）。 */
function collectFilePaths(node: LocalFileNode): string[] {
  if (node.type === "file") return [node.path];
  const out: string[] = [];
  if (node.children) {
    for (const c of node.children) out.push(...collectFilePaths(c));
  }
  return out;
}

/** 去掉文件名扩展名（如 `no-console.mdc` → `no-console`）。 */
function stripExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

/** 外部能力单元（磁盘上存在但不在 lock 中的能力最小单元）。 */
interface ExternalUnit {
  type: AssetType;
  name: string;
  files: string[];
}

/** 文档文件判定：README / README.md / readme.txt 等（大小写不敏感）。 */
function isDocFile(name: string): boolean {
  return /^readme(\..+)?$/i.test(name);
}

/**
 * 扫描单个 vendor tree，按能力最小单元识别**非 mcp** 外部能力。
 *
 * 分组规则（参照 vendor-reader.ts extractAssetDir）：
 *  - 能力类型目录（skills/rules/commands/agents/hooks）下：每个顶层子目录或顶层文件 = 1 单元
 *  - vendor 根下不在能力类型目录内的散落文件：不视为能力单元（不计入）
 *  - 文档文件（README*，任意扩展名/大小写）不构成能力——如 hooks/README.md 是说明文档，
 *    不是一个叫 README 的 hook
 *  - hook 单元是候选：调用方（buildCells）再以聚合注册表过滤——未注册的脚本不实际触发，
 *    不构成 hook 能力（skill/rule/command/agent 入目录即生效，不过滤）
 *
 * mcp 外部单元不在此处统计——mcp server 的归属判定需要 lock.aggregates.serverKeys，
 * 由 buildCells 统一处理（见 buildMcpOwnership）。lock 管理的能力单元（子树内有 managed
 * 文件）被跳过。
 */
function scanExternalFileUnits(tree: LocalFileNode[]): ExternalUnit[] {
  const out: ExternalUnit[] = [];
  for (const node of tree) {
    if (node.type === "dir" && node.name in TYPE_DIR_TO_ASSET_TYPE) {
      const assetType = TYPE_DIR_TO_ASSET_TYPE[node.name]!;
      for (const child of node.children ?? []) {
        if (child.type === "file" && isDocFile(child.name)) continue; // 文档不是能力
        if (hasManagedFile(child)) continue; // lock 管理的能力单元，跳过
        const name = child.type === "dir" ? child.name : stripExt(child.name);
        const files = collectFilePaths(child);
        out.push({ type: assetType, name, files });
      }
    }
  }
  return out;
}

/**
 * lock 中 enabled=true 的文件集合（含 aggregates）。用于 missingCount 统计：
 * 被用户关闭（enabled=false）的能力文件会被有意从磁盘删除，属于正常状态，
 * 不应算作「意外缺失」而触发部分缺失告警。
 */
function enabledLockedFiles(lock: LockFile | null): Set<string> {
  const set = new Set<string>();
  if (!lock) return set;
  for (const entry of Object.values(lock.assets)) {
    if (!entry.vendors) {
      // legacy / 无 vendors：保留全部文件（无 enabled 维度）
      for (const f of entry.files) set.add(toPosix(f));
      continue;
    }
    for (const v of Object.values(entry.vendors)) {
      if (v?.enabled) for (const f of v.files) set.add(toPosix(f));
    }
  }
  if (lock.aggregates) {
    for (const list of Object.values(lock.aggregates)) {
      for (const agg of list ?? []) set.add(toPosix(agg.file));
    }
  }
  return set;
}

/**
 * 主入口。`project` 是本地 `~/.loom/projects/<id>.json` 已读出的记录；
 * 调用方负责保证它属于当前用户/设备。
 */
export function scanProjectState(project: LocalProjectRecord): LocalProjectState {
  const root = project.normalizedPath;

  // 1. 读 lock，归集"应在文件"集合
  const lock = readLock(project.id);
  const expectedFiles = new Set(lockedFiles(lock).map(toPosix));
  // 仅 enabled 的文件：关闭的能力文件已被删除，不应计入「缺失」。
  const enabledExpected = enabledLockedFiles(lock);

  // 2. 逐 vendor 扫描
  const vendors = {} as Record<TargetTool, VendorMirror>;
  let totalManagedHits = new Set<string>();
  for (const tool of TARGET_TOOLS) {
    const dir = TARGET_DIRS[tool];
    const scan = listVendorTree(root, dir, expectedFiles);
    if (!scan) {
      vendors[tool] = {
        tool,
        dir,
        exists: false,
        tree: [],
        managedCount: 0,
        managedAssetCount: 0,
        externalCount: 0,
        missingCount: 0,
      };
      continue;
    }
    const managedCount = countFiles(scan.tree, (n) => n.managed);
    // externalCount 推迟到 annotateNodesByLock 之后按能力最小单元统计（见下方）。
    // 该 vendor 下"lock 中 enabled + 路径以该 dir 开头"的应在文件数。
    // 用 enabledExpected：关闭的能力文件不算应在，故不会被记为缺失。
    const vendorExpectedTotal = [...enabledExpected].filter((p) => p === dir || p.startsWith(`${dir}/`)).length;
    const missingCount = Math.max(0, vendorExpectedTotal - managedCount);
    vendors[tool] = {
      tool,
      dir,
      exists: true,
      tree: scan.tree,
      managedCount,
      managedAssetCount: 0,
      externalCount: 0,
      missingCount,
    };
    for (const p of scan.managedHits) totalManagedHits.add(p);
  }

  // 2.5. claudecode 特例：项目根的 `.mcp.json` 是 ClaudeCode adapter 唯一会落到
  // 项目根的产物（其他厂商的 mcp.json 在各自 vendor 目录内）。如果不在 vendor
  // 树里特殊呈现，用户在镜像中根本看不到这个文件——这是 ECC 等含 MCP 的工作
  // 空间的盲区。把它合并到 claudecode 的 tree 顶部，并相应调整 managed/missing
  // 统计，让 lock 与 fs 的对账保持闭环。
  const mcpAbs = join(root, ".mcp.json");
  const mcpInLock = expectedFiles.has(".mcp.json");
  if (existsSync(mcpAbs)) {
    let mcpStat;
    try { mcpStat = statSync(mcpAbs); } catch { mcpStat = null; }
    if (mcpStat?.isFile()) {
      const node: LocalFileNode = {
        name: ".mcp.json",
        path: ".mcp.json",
        type: "file",
        managed: mcpInLock,
        size: mcpStat.size,
      };
      const cc = vendors.claudecode;
      // 即便 .claude/ 目录还没建（极端情况），有 .mcp.json 也认为 claudecode 痕迹存在
      cc.exists = true;
      cc.tree = [node, ...cc.tree];
      if (mcpInLock) {
        cc.managedCount += 1;
        totalManagedHits.add(".mcp.json");
      }
      // externalCount 不在此处累加：推迟到 annotateNodesByLock 之后按 MCP server 单元统计
    }
  } else if (mcpInLock) {
    // 文件被外部删除但 lock 仍记录 → 计入 claudecode 的 missing
    vendors.claudecode.missingCount += 1;
  }

  // 3. drift 检测：lock 在但所有「应在磁盘的 enabled 文件」都不在磁盘 → 自动清空。
  //    关键：以 enabledExpected（仅 enabled 文件）为准，不能用 expectedFiles（含 disabled）。
  //    否则「把能力全部关闭」时，disabled 文件被有意移入隔离区、磁盘上本就不该有，
  //    会被误判成 drift 而删掉整个 lock —— 导致禁用状态丢失、能力从镜像消失 / 开关回弹。
  //    全 disabled（enabledExpected.size===0）不是 drift：lock 需保留以维持关闭态。
  let installedWorkspaceIds: string[] = lockSubscriptionIds(lock);
  let driftCleared = false;
  if (lock && enabledExpected.size > 0 && totalManagedHits.size === 0) {
    removeLock(project.id);
    installedWorkspaceIds = [];
    driftCleared = true;
  }

  // 4. 单一真值源：算一次 cell 模型（受管 + 外部）。capabilities 与厂商树标注/计数
  //    均从它投影——能力视图与厂商视图共用同一份判定，不再各自从 lock/磁盘推导，
  //    避免「两路各算」导致开关、能力数、external 分类分叉（详见 buildCells）。
  //    legacy lock / driftCleared / 无 lock → 仅外部 cell（无受管）。
  const legacy = isLegacyLock(lock);
  const cells = buildCells(lock, vendors, root, getLocalSkillCounts(project.id), legacy, driftCleared);
  // 树标注（文件 assetId/enabled、mcp-server 虚拟子节点、disabled 占位、外部节点）从 cell 投影。
  annotateTreeFromCells(cells, vendors, root);

  // 5. 计数从 cell 投影（managedCount/missingCount 已在 step 2 按文件算好；
  //    managedAssetCount/externalCount 按能力单元算，与 capabilities 同源 → 两视图一致）。
  for (const tool of TARGET_TOOLS) {
    const vm = vendors[tool];
    if (!vm.exists) continue;
    let managedAssets = 0;
    let externals = 0;
    for (const cell of cells) {
      const cv = cell.vendors[tool];
      if (!cv) continue;
      if (cv.external) externals += 1;
      else managedAssets += 1;
    }
    vm.managedAssetCount = managedAssets;
    vm.externalCount = externals;
  }

  // capabilities 即 cell 的扁平投影（保留 mcp 的 mcp 内部字段不外泄）。
  const capabilities = cells.length > 0 ? projectCapabilitiesFromCells(cells) : undefined;

  // fallback：仅 legacy / 无 lock / driftCleared 时，cell 无受管来源，从树节点反查
  // 唯一 assetId（含外部 synthetic id）作 CountIndicator 兜底计数。
  // v2 lock 下 cell 是权威源——不跑此兜底，否则「仅外部文件的厂商」会把 external id
  // 重复计入 managedAssetCount，使 total（managedAssetCount+externalCount）双倍于能力行数，
  // 厂商视图与能力视图的「N 项」又分叉。
  for (const tool of TARGET_TOOLS) {
    if (!legacy && lock && !driftCleared) continue;
    if (!vendors[tool].exists) continue;
    const ids = new Set<string>();
    walkVendorTree(vendors[tool].tree, (node) => { if (node.assetId) ids.add(node.assetId); });
    vendors[tool].managedAssetCount = ids.size;
  }

  return {
    projectId: project.id,
    scannedAt: new Date().toISOString(),
    vendors,
    installedWorkspaceIds,
    driftCleared,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(legacy ? { legacyLock: true } : {}),
  };
}

/** lock → 显式订阅的 workspaceId 列表（兼容 v2/v1 lock 的单值 workspaceId 字段）。 */
function lockSubscriptionIds(lock: LockFile | null): string[] {
  if (!lock) return [];
  if (Array.isArray(lock.subscriptions)) {
    return lock.subscriptions
      .map((s) => s.workspaceId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return lock.workspaceId ? [lock.workspaceId] : [];
}

// ---------------------------- hook 事件扫描（聚合注册表） ----------------------------

/**
 * 各厂商 hook 聚合注册表路径（adapter 口径；不支持 hook 的厂商为 null）。
 * 注意只读 loom 管理的聚合文件（如 .claude/settings.json）；settings.local.json
 * 等非受管位置的 hook 注册不在扫描范围。
 */
function hookAggregatePathByTool(): Partial<Record<TargetTool, string>> {
  const out: Partial<Record<TargetTool, string>> = {};
  for (const a of listAdapters()) {
    const p = a.hooksAggregatePath();
    if (p) out[a.tool] = p;
  }
  return out;
}

/** 容错读 JSON 文件；失败返回 null（不阻断扫描，仅丢失 hook 事件标注）。 */
function readJsonTolerant(absPath: string): unknown | null {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 某 hook 名在聚合注册表里注册的事件列表。
 * 归属判据与 adapter isOwnedHookEntry 一致：命令含 `hooks/<name>/`（目录形态）或
 * `hooks/<name>.`（扁平脚本形态）。事件名按注册表原样返回（厂商原生词汇）。
 */
function hookEventsFromRegistry(registryRaw: unknown, name: string): string[] {
  if (!registryRaw || typeof registryRaw !== "object" || Array.isArray(registryRaw)) return [];
  const registry = (registryRaw as Record<string, unknown>).hooks;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return [];
  const dirNeedle = `hooks/${name}/`;
  const flatNeedle = `hooks/${name}.`;
  const events: string[] = [];
  for (const [event, entries] of Object.entries(registry as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const hooks = (entry as { hooks?: unknown })?.hooks;
      if (!Array.isArray(hooks)) continue;
      const hit = hooks.some((h) => {
        const cmd = (h as { command?: unknown })?.command;
        return typeof cmd === "string" && (cmd.includes(dirNeedle) || cmd.includes(flatNeedle));
      });
      if (hit && !events.includes(event)) events.push(event);
    }
  }
  return events.sort();
}

// ---------------------------- single source of truth: cell model ----------------------------

//
// 能力视图（state.capabilities）与厂商视图（state.vendors[tool].tree + 计数）共用
// 同一份 cell 模型：buildCells 算一次，projectCapabilitiesFromCells / annotateTreeFromCells
// / 计数 都是它的投影。这样「能力、能力数量、开关、external 分类」天然一致——两视图只剩
// UI 分组差异（按厂商横切 vs 按能力列表），不会再各自从 lock/磁盘推导出分叉结果。

/** cell 的单个厂商格（比对外契约 AssetCapabilityVendor 多一个 mcp 内部字段）。 */
interface CapCellVendor {
  enabled: boolean;
  files: string[];
  presentCount: number;
  assetId?: string;
  external: boolean;
  /** hook：该厂商聚合注册表里实际注册的事件（厂商原生词汇）。仅 hook 类型填。 */
  hookEvents?: string[];
  /** mcp：所属 mcp.json 文件 + 该资产在此文件里拥有的 server key。仅 mcp 受管格填。 */
  mcp?: { file: string; serverKeys: string[] };
}

/** 单条能力的完整状态（跨厂商聚合）。单一真值源。 */
interface CapCell {
  assetId: string;
  name: string;
  type: AssetType;
  external: boolean;
  invocationCount?: number;
  vendors: Partial<Record<TargetTool, CapCellVendor>>;
}

/** 判断一个文件路径是否是 mcp 配置文件（.mcp.json 或 .../mcp.json）。 */
function isMcpJsonPath(p: string): boolean {
  return p === ".mcp.json" || p.endsWith("/mcp.json");
}

/** 收集某 vendor tree 内所有 mcp.json 文件节点的路径。 */
function findMcpJsonFiles(tree: LocalFileNode[]): string[] {
  const out: string[] = [];
  walkVendorTree(tree, (n) => {
    if (n.type === "file" && isMcpJsonPath(n.path)) out.push(n.path);
  });
  return out;
}

/**
 * 某 (tool, mcp.json 文件) 的 server 归属表。
 * - diskServers：磁盘上实际存在的 server key（读 mcp.json 内容）。
 * - serverToAsset：server key → 拥有它的受管 assetId。判定口径（与 adapter aggregateMcps
 *   落盘口径一致）：
 *     1) lock.aggregates[tool].serverKeys（v2 lock 持久化的真实 key→assetId，enabled 资产）；
 *     2) 无 serverKeys 且该文件仅 1 个 contributing asset → 全部 disk server 归它（旧 lock 兜底）；
 *     3) 否则按 asset.name 匹配 disk server（single 形态 name==key；disabled 资产也按名认领残留）。
 *   未被认领的 disk server → 外部能力（buildCells 另行收集）。
 */
interface McpFileOwnership {
  file: string;
  diskServers: string[];
  serverToAsset: Map<string, string>;
}

function buildMcpOwnership(
  lock: LockFile | null,
  vendors: Record<TargetTool, VendorMirror>,
  root: string,
): Partial<Record<TargetTool, McpFileOwnership[]>> {
  const out: Partial<Record<TargetTool, McpFileOwnership[]>> = {};
  const aggByTool = lock?.aggregates ?? {};
  for (const tool of TARGET_TOOLS) {
    const vm = vendors[tool];
    if (!vm.exists) continue;
    const aggList = aggByTool[tool] ?? [];
    const list: McpFileOwnership[] = [];
    for (const file of findMcpJsonFiles(vm.tree)) {
      const diskServers = readMcpServerNames(join(root, file));
      const serverToAsset = new Map<string, string>();
      const agg = aggList.find((a) => a.file === file);
      // 1) v2 lock：显式 serverKeys
      if (agg?.serverKeys) {
        for (const [s, aid] of Object.entries(agg.serverKeys)) serverToAsset.set(s, aid);
      }
      // 2) 旧 lock 无 serverKeys：单 contributing asset → 全归它
      const remaining1 = diskServers.filter((s) => !serverToAsset.has(s));
      if (!agg?.serverKeys && agg && agg.contributingAssetIds.length === 1) {
        const sole = agg.contributingAssetIds[0]!;
        for (const s of remaining1) serverToAsset.set(s, sole);
      }
      // 3) name-based 兜底：asset.name 命中 disk server（single 形态 / disabled 残留）
      const remaining2 = diskServers.filter((s) => !serverToAsset.has(s));
      if (remaining2.length > 0 && lock) {
        for (const [aid, entry] of Object.entries(lock.assets)) {
          if (entry.type !== "mcp" || !entry.name) continue;
          const idx = remaining2.indexOf(entry.name);
          if (idx >= 0) serverToAsset.set(entry.name, aid);
        }
      }
      list.push({ file, diskServers, serverToAsset });
    }
    if (list.length > 0) out[tool] = list;
  }
  return out;
}

/**
 * 算一次 cell 模型（单一真值源）。
 * - 受管 cell：来自 lock.assets（legacy/driftCleared/无 lock 时跳过）。mcp 格的 server 归属
 *   由 buildMcpOwnership 决定，files/presentCount 据实补齐（修复历史 mcp presentCount=0）。
 * - 外部 cell：非 mcp 来自 scanExternalFileUnits；mcp 来自 disk server 中未被受管认领的。
 * - 按 (type, name) 聚合；受管优先于外部。
 */
function buildCells(
  lock: LockFile | null,
  vendors: Record<TargetTool, VendorMirror>,
  root: string,
  skillCounts: Record<string, number>,
  legacy: boolean,
  driftCleared: boolean,
): CapCell[] {
  const ownership = buildMcpOwnership(lock, vendors, root);
  // hook 聚合注册表（每厂商一份，容错读取）：hook 外部能力的判定依据 + 事件标注共用。
  // hook 与其它类型不同——脚本文件必须注册才会被工具触发，所以「在 hooks/ 目录下」
  // 不等于「是 hook 能力」；未注册的脚本只是普通文件（见 step 2a 过滤）。
  const hookAggPaths = hookAggregatePathByTool();
  const hookRegistries: Partial<Record<TargetTool, unknown>> = {};
  for (const tool of TARGET_TOOLS) {
    const p = hookAggPaths[tool];
    if (p) hookRegistries[tool] = readJsonTolerant(join(root, p));
  }
  const byKey = new Map<string, CapCell>();
  const keyOf = (t: AssetType, n: string) => `${t}:${n}`;
  const getCell = (type: AssetType, name: string, assetId: string): CapCell => {
    const key = keyOf(type, name);
    let c = byKey.get(key);
    if (!c) {
      c = { assetId, name, type, external: true, vendors: {} };
      byKey.set(key, c);
    }
    // 代表 id 优先受管（非 external:）
    if (c.assetId.startsWith("external:") && !assetId.startsWith("external:")) c.assetId = assetId;
    return c;
  };

  // 1) 受管 cell
  if (lock && !legacy && !driftCleared) {
    for (const [assetId, entry] of Object.entries(lock.assets)) {
      if (!entry.vendors || !entry.name || !entry.type) continue;
      const cell = getCell(entry.type as AssetType, entry.name, assetId);
      for (const [toolStr, v] of Object.entries(entry.vendors)) {
        if (!v) continue;
        const tool = toolStr as TargetTool;
        const cv: CapCellVendor = {
          enabled: v.enabled,
          files: [...v.files],
          presentCount: countPresent(vendors[tool], v.files),
          assetId,
          external: false,
        };
        if ((entry.type as AssetType) === "mcp") {
          // mcp：从归属表取本资产拥有的 server，补 files/presentCount（修复 presentCount=0）。
          // disabled mcp 不认领 disk server（其 server 应已移除；残留由外部路径反映，与历史一致）。
          if (v.enabled) {
            for (const fo of ownership[tool] ?? []) {
              const owned = fo.diskServers.filter((s) => fo.serverToAsset.get(s) === assetId);
              if (owned.length > 0) {
                cv.mcp = { file: fo.file, serverKeys: owned };
                cv.files = [fo.file];
                cv.presentCount = 1;
                break;
              }
            }
          }
          // disabled mcp：files 保持空（lock v.files 为空），presentCount=0
        }
        cell.vendors[tool] = cv;
      }
      if ((entry.type as AssetType) === "skill") {
        const c = skillCounts[assetId];
        if (c && c > 0) cell.invocationCount = c;
      }
    }
  }

  // 2a) 外部 cell — 非 mcp（能力类型目录扫描）
  for (const tool of TARGET_TOOLS) {
    const vm = vendors[tool];
    if (!vm.exists) continue;
    for (const unit of scanExternalFileUnits(vm.tree)) {
      // hook 以注册为准：脚本在 hooks/ 下但未在聚合注册表注册 → 不实际触发，
      // 只是普通文件，不构成 hook 能力（skill/rule/command/agent 入目录即生效，不适用此规则）。
      // 边界：只认 loom 管理的聚合文件（settings.json/hooks.json）；
      // 注册在 settings.local.json 等非受管位置的 hook 不在识别范围。
      if (unit.type === "hook") {
        const registered = hookEventsFromRegistry(hookRegistries[tool], unit.name);
        if (registered.length === 0) continue;
      }
      const cell = getCell(unit.type, unit.name, `external:${unit.type}:${unit.name}`);
      if (cell.vendors[tool] && !cell.vendors[tool]!.external) continue; // 受管优先
      cell.vendors[tool] = {
        enabled: true,
        files: unit.files,
        presentCount: unit.files.length,
        external: true,
      };
    }
  }

  // 2b) 外部 cell — mcp（disk server 未被受管认领）
  for (const tool of TARGET_TOOLS) {
    for (const fo of ownership[tool] ?? []) {
      for (const s of fo.diskServers) {
        if (fo.serverToAsset.has(s)) continue; // 受管认领
        const cell = getCell("mcp", s, `external:mcp:${s}`);
        if (cell.vendors[tool] && !cell.vendors[tool]!.external) continue; // 受管优先
        cell.vendors[tool] = {
          enabled: true,
          files: [fo.file],
          presentCount: 1,
          external: true,
        };
      }
    }
  }

  // 3) external 标记：任一厂商受管 → external=false
  for (const cell of byKey.values()) {
    cell.external = !Object.values(cell.vendors).some((v) => v && !v.external);
  }

  // 4) hook 事件标注：从各厂商聚合注册表反查每个 hook 实际注册的事件
  //   （受管 enabled + 外部均在磁盘注册表里有真实注册；disabled 受管不在注册表，
  //    其声明事件由 server 从 asset metadata enrichment 补充）。
  for (const cell of byKey.values()) {
    if (cell.type !== "hook") continue;
    for (const [toolStr, cv] of Object.entries(cell.vendors)) {
      if (!cv) continue;
      const events = hookEventsFromRegistry(hookRegistries[toolStr as TargetTool], cell.name);
      if (events.length > 0) cv.hookEvents = events;
    }
  }

  const out = [...byKey.values()];
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)));
  return out;
}

/** cell → 对外契约 AssetCapability[]（丢弃 mcp 内部字段）。 */
function projectCapabilitiesFromCells(cells: CapCell[]): AssetCapability[] {
  return cells.map((c) => {
    const vendors: Partial<Record<TargetTool, AssetCapabilityVendor>> = {};
    for (const [toolStr, cv] of Object.entries(c.vendors)) {
      if (!cv) continue;
      vendors[toolStr as TargetTool] = {
        enabled: cv.enabled,
        files: [...cv.files],
        presentCount: cv.presentCount,
        ...(cv.assetId ? { assetId: cv.assetId } : {}),
        ...(cv.external ? { external: true } : {}),
        ...(cv.hookEvents?.length ? { hookEvents: [...cv.hookEvents] } : {}),
      };
    }
    const cap: AssetCapability = {
      assetId: c.assetId,
      name: c.name,
      type: c.type,
      external: c.external,
      vendors,
    };
    if (c.invocationCount) cap.invocationCount = c.invocationCount;
    return cap;
  });
}

/**
 * 厂商树标注从 cell 投影（替换历史 annotateNodesByLock + insertDisabledPlaceholders +
 * annotateExternalNodes 三路独立推导）：
 *  - 文件节点 assetId/enabled：来自受管 cell 的非 mcp 文件；
 *  - mcp.json 虚拟 server 子节点：disk server 命中受管 cell 的 → assetId+enabled，否则无（外部）；
 *  - disabled 占位：受管 cell 的 enabled=false 文件不在磁盘 → 注入 disabled-asset 节点；
 *  - 外部文件节点：外部 cell 的非 mcp 文件 → 标 external:<type>:<name>（mcp 外部由 server 子节点呈现）。
 */
function annotateTreeFromCells(
  cells: CapCell[],
  vendors: Record<TargetTool, VendorMirror>,
  root: string,
): void {
  for (const tool of TARGET_TOOLS) {
    const vm = vendors[tool];
    if (!vm.exists) continue;

    // 受管非 mcp：path → {assetId, enabled}
    const pathToAsset = new Map<string, { assetId: string; enabled: boolean }>();
    // mcp：file → server → {assetId, enabled}（仅受管）
    const mcpServerMap = new Map<string, Map<string, { assetId: string; enabled: boolean }>>();
    // 外部非 mcp：path → external:<type>:<name>
    const externalByPath = new Map<string, string>();
    for (const cell of cells) {
      const cv = cell.vendors[tool];
      if (!cv) continue;
      if (cv.mcp) {
        const m = mcpServerMap.get(cv.mcp.file) ?? new Map();
        for (const s of cv.mcp.serverKeys) m.set(s, { assetId: cv.assetId!, enabled: cv.enabled });
        mcpServerMap.set(cv.mcp.file, m);
      } else if (!cv.external) {
        for (const f of cv.files) pathToAsset.set(f, { assetId: cv.assetId!, enabled: cv.enabled });
      } else if (cell.type !== "mcp") {
        for (const f of cv.files) externalByPath.set(f, `external:${cell.type}:${cell.name}`);
      }
    }

    walkVendorTree(vm.tree, (node) => {
      if (node.type !== "file") return;
      if (isMcpJsonPath(node.path)) {
        // mcp.json：disk server → 虚拟子节点（受管有 assetId，外部无）
        const serverNames = readMcpServerNames(join(root, node.path));
        const sm = mcpServerMap.get(node.path) ?? new Map();
        const children: LocalFileNode[] = serverNames.map((name) => {
          const hit = sm.get(name);
          return {
            name,
            // 伪路径：父文件路径 + #mcp:<name>，UI 唯一定位
            path: `${node.path}#mcp:${name}`,
            type: "file" as const,
            managed: !!hit,
            virtual: "mcp-server" as const,
            ...(hit ? { assetId: hit.assetId, enabled: hit.enabled } : {}),
          };
        });
        if (children.length > 0) node.children = children;
        return;
      }
      const hit = pathToAsset.get(node.path);
      if (hit) {
        node.assetId = hit.assetId;
        node.enabled = hit.enabled;
        return;
      }
      // 外部文件节点标注 synthetic assetId（仅未受管）
      const extId = externalByPath.get(node.path);
      if (extId && !node.assetId) {
        node.assetId = extId;
        node.enabled = true;
      }
    });

    // disabled 占位：受管 enabled=false 的非 mcp 文件不在磁盘 → 注入
    for (const cell of cells) {
      const cv = cell.vendors[tool];
      if (!cv || cv.external || cv.enabled || cv.mcp) continue;
      for (const filePath of cv.files) {
        if (findNode(vm.tree, filePath)) continue; // 真实节点优先
        injectDisabledPlaceholder(vm.tree, filePath, cv.assetId!);
      }
    }
  }
}

/** 在 vm.tree 内按路径注入 disabled-asset 占位节点（缺失的父目录懒创建）。 */
function injectDisabledPlaceholder(tree: LocalFileNode[], filePath: string, assetId: string): void {
  const segs = filePath.split("/");
  const fileName = segs.pop()!;
  let parentChildren = tree;
  let cursor = "";
  for (let i = 1; i < segs.length; i++) {
    // 第 0 段是 vendor dir 本身（如 ".cursor"），从 tree 起步
    const seg = segs[i]!;
    cursor = cursor ? `${cursor}/${seg}` : `${segs[0]}/${seg}`;
    let dir = parentChildren.find((n) => n.type === "dir" && n.name === seg);
    if (!dir) {
      dir = { name: seg, path: cursor, type: "dir", managed: false, children: [] };
      parentChildren.push(dir);
    }
    parentChildren = dir.children!;
  }
  parentChildren.push({
    name: fileName,
    path: filePath,
    type: "file",
    managed: true,
    assetId,
    enabled: false,
    virtual: "disabled-asset",
  });
  parentChildren.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function countPresent(vendor: VendorMirror | undefined, files: string[]): number {
  if (!vendor || !vendor.exists) return 0;
  let n = 0;
  const set = new Set(files);
  walkVendorTree(vendor.tree, (node) => {
    if (node.type === "file" && set.has(node.path)) n += 1;
  });
  return n;
}

function walkVendorTree(nodes: LocalFileNode[], visit: (n: LocalFileNode) => void): void {
  for (const n of nodes) {
    visit(n);
    if (n.children) walkVendorTree(n.children, visit);
  }
}

function readMcpServerNames(absPath: string): string[] {
  if (!existsSync(absPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const obj = parsed as Record<string, unknown>;
  const servers = obj.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.keys(servers as Record<string, unknown>).sort();
}

function findNode(nodes: LocalFileNode[], path: string): LocalFileNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const f = findNode(n.children, path);
      if (f) return f;
    }
  }
  return undefined;
}

// 仅供测试：`listVendorTree` 内部已经使用 join + relative，公开版本只在 scanner
// 模块内调用；测试需要时可改为 export，目前不暴露。
export { listVendorTree as _listVendorTreeForTest, toPosix as _toPosixForTest };

// posix 引入仅为类型对齐（保留一处使用，避免 unused 警告）。实际转换走 toPosix。
void posix;
