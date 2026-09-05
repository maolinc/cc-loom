/**
 * 项目同步的服务端原语：把"工作空间期望状态 → 物理 plan"提炼成可复用函数。
 *
 * 谁在调：
 *  - /api/install/plan       /api/install/execute     —— 手动安装 / 切换工作空间
 *  - lib/auto-sync.ts        compensateDeviceOnConnect —— agent 重连补偿
 *  - lib/auto-sync.ts        syncProjectNow            —— locked→auto 立即同步
 *
 * 设计：
 *  - `buildInstallPlan(userId, input)` 输出 InstallPlan，调用方负责"是否真投递到 agent"。
 *  - 对 manifest 的 asset 子集做可见性过滤（与 loadAssetEntries 一致）：
 *    其他用户私有 asset 不应跨用户落到项目 owner 的机器上。
 *  - 一切 SQL 读裸 db；不依赖 ws/gateway，便于在 worker / route 共用。
 */
import type {
  DiffEntry,
  InstallConflict,
  InstallPlan,
  Manifest,
  ManifestAssetEntry,
  AssetAuthBinding,
} from "@maolinc/cc-loom-shared";
import { getAdapters, mcpServerKeysOf } from "@maolinc/cc-loom-adapter";
import { db } from "../db/index.js";
import { applyPathBindings, loadAuthBindings, loadDistributedCredentials } from "./credential-inject.js";

export interface PlanInput {
  projectId: string;
  workspaceId: string;
  targetTools: string[];
  policy: "auto" | "locked";
}

export type PlanOk = { plan: InstallPlan };
export type PlanErr = { error: string; status: 400 | 404 };

/**
 * 取项目所有者邮箱（用于 asset 可见性过滤口径）。空字符串 = 无法确定，
 * 严格按"非作者"看待。
 */
function ownerEmail(userId: string): string {
  const u = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as
    | { email: string }
    | undefined;
  return u?.email ?? "";
}

export function buildInstallPlan(userId: string, input: PlanInput): PlanOk | PlanErr {
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(input.projectId) as any;
  if (!project || project.user_id !== userId) {
    return { error: "项目不存在", status: 404 };
  }

  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(input.workspaceId) as any;
  if (!workspace || workspace.deleted_at) {
    return { error: "工作空间不存在", status: 404 };
  }

  const wa = db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?").all(workspace.id) as any[];
  const assetIds = wa.map((a) => a.asset_id);
  // 含留存（已软删但仍被本空间引用）成员：从库删除某 asset 不应使引用它的工作空间
  // 在安装时静默丢项；留存 asset 内容仍在，照常落盘并重新建立安装引用。
  const assetRows = assetIds.length > 0
    ? db.prepare(`SELECT * FROM assets WHERE id IN (${assetIds.map(() => "?").join(",")})`).all(...assetIds) as any[]
    : [];

  // 可见性过滤：跨用户协作时（共享 workspace）成员可能是别人创建的 private asset，
  // 项目所有者本无权拿到其内容。统一按 author===email 放行 private（与
  // asset-manifest.loadAssetEntries 同一口径），public 任意可见。
  // 此前 buildPlan 不过滤，等同于把任何 workspace 拉进来的 private asset 全文
  // 发到项目机器——既是泄露隐患，也与 auto-sync 路径行为不一致。
  const email = ownerEmail(project.user_id);
  const visibleAssets = assetRows.filter(
    (a: any) => a.visibility !== "private" || a.author === email,
  );

  const manifest: Manifest = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    version: workspace.version,
    targetTools: JSON.parse(workspace.target_tools || "[]"),
    assets: visibleAssets.map((a: any): ManifestAssetEntry => {
      const files = db.prepare(
        "SELECT path, content, encoding FROM asset_files WHERE asset_id = ? ORDER BY path"
      ).all(a.id) as any[];
      return {
        assetId: a.id,
        name: a.name,
        type: a.type,
        version: a.version,
        description: a.description,
        files: files.map((f: any) => ({ path: f.path, content: f.content, encoding: f.encoding ?? undefined })),
        compatibleTools: JSON.parse(a.compatible_tools || "[]"),
        metadata: JSON.parse(a.metadata || "{}"),
        // 关键：把 source_path 透传给 adapter，否则 isAssetDirLayout 会回退到
        // "files.length>1 才算 dir"的旧启发式，导致 marketplace 来源的 dir-layout
        // 资产（如 skills/<name>/SKILL.md）被错装成平铺文件 .cursor/skills/<name>.md。
        sourcePath: a.source_path ?? null,
      };
    }),
  };

  const effectiveTools = input.targetTools.filter((t) => manifest.targetTools.includes(t as any)) as Manifest["targetTools"];

  if (effectiveTools.length === 0) {
    return { error: "工作空间不支持所选的任何目标工具", status: 400 };
  }

  const adapters = getAdapters(effectiveTools);
  const allFiles: DiffEntry[] = [];

  for (const adapter of adapters) {
    // 逐 asset 处理，方便给 DiffEntry 挂上 assetId / tool。capabilities 流程依赖
    // 这两个字段把文件归属到 lock.assets[id].vendors[tool]，否则只能从 path
    // basename 反推（不可靠）。
    const enabledMcps: ManifestAssetEntry[] = [];
    const enabledHooks: ManifestAssetEntry[] = [];
    for (const asset of manifest.assets) {
      if (!asset.compatibleTools.includes(adapter.tool)) continue;
      if (!adapter.supportedTypes.includes(asset.type)) continue;
      if (asset.type === "mcp") {
        enabledMcps.push(asset);
        continue;
      }
      // hook 包附属文件 → per-asset；hook registry 走 aggregate
      if (asset.type === "hook") {
        enabledHooks.push(asset);
        const accessory = adapter.generateForAsset(asset);
        for (const f of accessory) {
          allFiles.push({
            operation: "add",
            path: f.path,
            type: "hook",
            assetName: asset.name,
            assetId: asset.assetId,
            tool: adapter.tool,
            content: f.content,
            ...(f.encoding ? { encoding: f.encoding } : {}),
          });
        }
        continue;
      }
      // 普通类型：直接挂 assetId / tool
      const files = adapter.generateForAsset(asset);
      for (const f of files) {
        allFiles.push({
          operation: "add",
          path: f.path,
          type: asset.type,
          assetName: asset.name,
          assetId: asset.assetId,
          tool: adapter.tool,
          content: f.content,
          ...(f.encoding ? { encoding: f.encoding } : {}),
        });
      }
    }
    // mcp 聚合 + path 鉴权注入（ADR-0003，与 reconcile-plan 保持一致）
    const mcpFile = adapter.recomputeMcpAggregate(enabledMcps);
    if (mcpFile) {
      const bindingsByAsset = loadAuthBindings(enabledMcps.map((m) => m.assetId));
      const credValues = loadDistributedCredentials(project.user_id, input.projectId);
      const injected = injectPathIntoMcpAggregate(mcpFile.content, enabledMcps, bindingsByAsset, credValues);
      allFiles.push({
        operation: "merge",
        path: mcpFile.path,
        type: "mcp",
        assetName: mcpFile.path.split("/").pop()?.replace(/\.json$/, "") ?? "mcp",
        // aggregate 不属于单个 asset，但仍须挂 tool 让 installer 写 lock.aggregates。
        tool: adapter.tool,
        content: injected,
        ...(mcpFile.mergeStrategy ? { mergeStrategy: mcpFile.mergeStrategy } : {}),
      });
    }
    // hooks 聚合
    const hooksFile = adapter.recomputeHooksAggregate(enabledHooks);
    if (hooksFile) {
      allFiles.push({
        operation: "merge",
        path: hooksFile.path,
        type: "hook",
        assetName: hooksFile.path.split("/").pop()?.replace(/\.json$/, "") ?? "hooks",
        tool: adapter.tool,
        content: hooksFile.content,
        ...(hooksFile.mergeStrategy ? { mergeStrategy: hooksFile.mergeStrategy } : {}),
      });
    }
  }

  const conflicts: string[] = [];
  // 同名不同 id 撞车检测（ADR-0006）：待装空间的 asset 与项目现有「其他来源」的受管
  // 能力（其它订阅的 workspace_assets − 跳过集 ∪ project_capabilities）同名同类型时，
  // 落盘路径必然撞车。同 id = 跨订阅共享单例，不算冲突。用户在安装流程中逐条裁决
  // （跳过 / 全部跳过 / 取消），execute 携带 skipAssetIds 生效。
  const conflictingAssets: InstallConflict[] = [];
  {
    const incoming = new Map(visibleAssets.map((a: any) => [a.id as string, a]));
    const otherIds = new Set<string>();
    const subRows = db.prepare(
      "SELECT workspace_id FROM project_subscriptions WHERE project_id = ? AND workspace_id != '' AND workspace_id != ?",
    ).all(input.projectId, workspace.id) as { workspace_id: string }[];
    for (const s of subRows) {
      const excluded = new Set(
        (db.prepare(
          "SELECT asset_id FROM project_subscription_excludes WHERE project_id = ? AND workspace_id = ?",
        ).all(input.projectId, s.workspace_id) as { asset_id: string }[]).map((r) => r.asset_id),
      );
      const wa = db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?")
        .all(s.workspace_id) as { asset_id: string }[];
      for (const r of wa) if (!excluded.has(r.asset_id)) otherIds.add(r.asset_id);
    }
    const caps = db.prepare("SELECT asset_id FROM project_capabilities WHERE project_id = ?")
      .all(input.projectId) as { asset_id: string }[];
    for (const r of caps) otherIds.add(r.asset_id);

    const otherRows = [...otherIds].length > 0
      ? db.prepare(
          `SELECT id, name, type FROM assets WHERE id IN (${[...otherIds].map(() => "?").join(",")})`,
        ).all(...otherIds) as { id: string; name: string; type: string }[]
      : [];
    const otherByNameType = new Map(otherRows.map((r) => [`${r.type}::${r.name}`, r.id]));
    for (const [id, a] of incoming) {
      const key = `${a.type}::${a.name}`;
      const existingId = otherByNameType.get(key);
      if (existingId && existingId !== id) {
        conflictingAssets.push({
          incomingAssetId: id,
          existingAssetId: existingId,
          name: a.name,
          type: a.type,
        });
      }
    }
    for (const c of conflictingAssets) {
      conflicts.push(`能力「${c.name}」(${c.type}) 与项目现有同名能力撞车，需选择跳过或取消`);
    }
  }

  const plan: InstallPlan = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    projectId: project.id,
    projectName: project.project_name,
    targetTools: effectiveTools,
    policy: input.policy,
    diff: allFiles,
    conflicts,
    ...(conflictingAssets.length > 0 ? { conflictingAssets } : {}),
  };

  return { plan };
}

/**
 * 把 path 鉴权绑定注入 mcp 聚合文件内容（install 预览路径，与 reconcile-plan 同口径）。
 *
 * 聚合内容形态：`{ mcpServers: { <name>: <def>, ... } }`（aggregateMcps 产出）。
 * 对每个 server def：若同名 asset 有 path 绑定，则按「未包装 def」注入（applyPathBindings
 * 内部识别单/多 server 包装——此处每个 server 已是单 def，直接相对其注入）。
 *
 * 注入失败（非字符串叶子/遍历冲突）在预览阶段不阻断——保留原 def 并在 conflicts 里
 * 提示，让用户在安装前看到问题。真正阻断发生在 reconcile-plan（决策 6）。
 */
function injectPathIntoMcpAggregate(
  aggregateContent: string,
  enabledMcps: ManifestAssetEntry[],
  bindingsByAsset: Map<string, AssetAuthBinding[]>,
  credValues: Map<string, string>,
): string {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(aggregateContent) as Record<string, unknown>;
  } catch {
    return aggregateContent; // 非法 JSON：原样返回，下游校验会兜底。
  }
  const mcpServers = root.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return aggregateContent;
  }
  const servers = mcpServers as Record<string, unknown>;
  for (const mcp of enabledMcps) {
    const bindings = bindingsByAsset.get(mcp.assetId);
    if (!bindings || bindings.length === 0) continue;
    // wrapped 资产的内层 server key 可能与资产名不同，按 mcpServerKeysOf 取真实落盘 key。
    for (const serverKey of mcpServerKeysOf(mcp)) {
      const def = servers[serverKey];
      if (def === undefined) continue;
      try {
        servers[serverKey] = applyPathBindings(def, bindings, credValues);
      } catch {
        // 预览阶段不阻断；reconcile 阶段会真正失败。
      }
    }
  }
  return JSON.stringify(root, null, 2);
}
