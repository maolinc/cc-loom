/**
 * 自动同步（policy = auto）：当工作空间成员、asset 内容、能力 toggle 被编辑，
 * 数据源导入刷新 asset 内容，或 agent 重连时，把变更入 v2 outbox（per-project 折叠）
 * 由 outbox-worker-v2 异步消费，通过 wire 协议 v2 的 `reconcile` op 推送到 CLI。
 *
 * v2 收口为「项目状态变化 → enqueueReconcile → worker 用 reconcileProject 算最新 plan」
 * 单一路径，调用方只关心"哪些项目要重新对账"，不再传 (asset_id, kind)。
 *
 * 多订阅模型（ADR-0006）：syncPolicy 挂在订阅上。入队资格按「该项目是否存在
 * 相关的 auto 订阅」判定——工作空间变更只扇出到订阅了它且为 auto 的项目；
 * 其它订阅（locked）不受影响。
 *
 * 入口约定：
 *  - locked 订阅仍在入口处过滤（不入队），与之前语义一致。
 *  - 「成员移除」不再做差集——worker 计算 plan 时 DB 反映工作空间最终成员，
 *    自然产出 add/remove 合并结果。调用方只需把变更传播到项目维度。
 */
import { db } from "../db/index.js";
import { enqueueReconcile, wakeDeviceV2 } from "./outbox-worker-v2.js";
import { getAgent, requestFromAgent } from "../ws/gateway.js";
import { hardDeleteProject } from "./project-purge.js";

interface SyncProject {
  id: string;
  device_id: string;
}

/** 把一组项目入队 reconcile，并按 device 汇总唤醒（避免重复 wake 同设备）。 */
function enqueueAndWake(projects: SyncProject[]): void {
  if (projects.length === 0) return;
  const devices = new Set<string>();
  for (const p of projects) {
    enqueueReconcile(p.device_id, p.id);
    devices.add(p.device_id);
  }
  for (const d of devices) wakeDeviceV2(d);
}

/**
 * 工作空间成员变更（增/减/重排）→ 重对账所有以 auto 订阅该空间的项目。
 *
 * v1 行为：按 toAdd/toRemove 计算差集并分别入队。v2 不需要——reconcileProject 会
 * 从最新 DB 状态推导差集；调用方只传 workspaceId。`removeMembers` 参数保留以兼容
 * 原签名（实际上 v2 下不再影响行为，always 重对账）。
 */
export function syncWorkspaceMembersToProjects(
  workspaceId: string,
  _oldAssetIds: string[],
  _newAssetIds: string[],
  _removeMembers = true,
): void {
  const rows = db.prepare(`
    SELECT p.id, p.device_id FROM projects p
    JOIN project_subscriptions s ON s.project_id = p.id
    WHERE s.workspace_id = ? AND s.sync_policy = 'auto' AND p.status != 'unregistered'
  `).all(workspaceId) as SyncProject[];
  enqueueAndWake(rows);
}

/**
 * asset 内容（文件 / 元数据 / 兼容工具 / 名称）被编辑 → 重对账所有「以 auto 途径
 * 安装了该 asset」的项目（账本以 project_installed_assets 为准）：
 *  - 经 auto 订阅的工作空间引入；或
 *  - 经 project_capabilities 单独添加 / adopt，且隐式订阅为 auto。
 */
export function syncAssetContentToProjects(assetId: string): void {
  const rows = db.prepare(`
    SELECT DISTINCT p.id, p.device_id FROM projects p
    JOIN project_installed_assets pia ON pia.project_id = p.id
    WHERE pia.asset_id = ? AND p.status != 'unregistered' AND (
      EXISTS (
        SELECT 1 FROM project_subscriptions s
        JOIN workspace_assets wa ON wa.workspace_id = s.workspace_id
        WHERE s.project_id = p.id AND s.workspace_id != '' AND s.sync_policy = 'auto'
          AND wa.asset_id = ?
      )
      OR EXISTS (
        SELECT 1 FROM project_capabilities pc
        JOIN project_subscriptions s2
          ON s2.project_id = pc.project_id AND s2.workspace_id = '' AND s2.sync_policy = 'auto'
        WHERE pc.project_id = p.id AND pc.asset_id = ?
      )
    )
  `).all(assetId, assetId, assetId) as SyncProject[];
  enqueueAndWake(rows);
}

/**
 * 离线补偿：agent 重连时，把该设备所有「有任一 auto 订阅（显式，或有能力的隐式）」
 * 的项目入队 reconcile。每项目一行（折叠），worker 拉到时用最新 DB 状态算 plan。
 *
 * 含 project_capabilities：仅 adopt 了本地外部能力、未装工作空间的项目也要重连补推，
 * 否则其能力开关状态在 agent 重连后无法自愈。
 */
export function compensateDeviceOnConnect(deviceId: string): void {
  // 离线期间若有项目被 Web 端「删除」（purge），其本地 `~/.loom` 痕迹当时无法清理。
  // agent 重连后这里补发 project:purge，抹掉本机残留，避免再次 register 出现新旧两
  // 条本地记录。fire-and-forget，不阻塞重连补偿主流程；失败则等下次重连再试。
  purgeUnregisteredProjects(deviceId);

  const rows = db.prepare(
    `SELECT p.id, p.device_id FROM projects p
     WHERE p.device_id = ?
       AND p.status != 'unregistered'
       AND EXISTS (
         SELECT 1 FROM project_subscriptions s
         WHERE s.project_id = p.id AND s.sync_policy = 'auto'
           AND (s.workspace_id != ''
                OR p.id IN (SELECT project_id FROM project_capabilities))
       )`,
  ).all(deviceId) as SyncProject[];
  enqueueAndWake(rows);
}

/**
 * 对该设备上所有 status='unregistered' 的项目补发 project:purge，清理本地痕迹。
 * RPC 成功后硬删服务端项目行——这是 Web 端离线浅度清理的「重连自愈」收尾：
 * 服务端关联表在 purge 端点已清，这里只需让 agent 抹掉本地 ~/.loom 痕迹再删掉
 * 项目行本身。失败忽略，等待下次重连再试。
 */
function purgeUnregisteredProjects(deviceId: string): void {
  if (!getAgent(deviceId)) return;
  const rows = db.prepare(
    "SELECT id FROM projects WHERE device_id = ? AND status = 'unregistered'",
  ).all(deviceId) as { id: string }[];
  for (const r of rows) {
    // 不 await：fire-and-forget，单项目超时不影响其它项目与主流程。
    requestFromAgent(deviceId, "project:purge", { projectId: r.id })
      .then(() => { hardDeleteProject(r.id); })
      .catch(() => { /* 旁路自愈，失败忽略 */ });
  }
}

/**
 * 立即同步单个项目（任一订阅 locked → auto 切换时用）。
 */
export function syncProjectNow(projectId: string): void {
  const rows = db.prepare(
    `SELECT p.id, p.device_id FROM projects p
     WHERE p.id = ?
       AND p.status != 'unregistered'
       AND EXISTS (
         SELECT 1 FROM project_subscriptions s
         WHERE s.project_id = p.id AND s.sync_policy = 'auto'
           AND (s.workspace_id != ''
                OR p.id IN (SELECT project_id FROM project_capabilities))
       )`,
  ).all(projectId) as SyncProject[];
  enqueueAndWake(rows);
}
