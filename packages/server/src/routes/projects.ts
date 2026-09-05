import type { FastifyInstance } from "fastify";
import type { AssetType, Device, InstallResult, LocalProjectState, Project, TargetTool } from "@maolinc/cc-loom-shared";
import { TARGET_DIRS, TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import { getAdapters } from "@maolinc/cc-loom-adapter";
import { db } from "../db/index.js";
import { generateId } from "../lib/crypto.js";
import { projectRegisterSchema } from "@maolinc/cc-loom-shared";
import { requireCliAuth, requireAnyAuth } from "../lib/auth.js";
import { maybeGcRetiredWorkspace } from "../lib/workspace-gc.js";
import { loadAssetEntries } from "../lib/asset-manifest.js";
import { syncProjectNow, syncWorkspaceMembersToProjects } from "../lib/auto-sync.js";
import { enqueueReconcileAndWait } from "../lib/outbox-worker-v2.js";
import { purgeProjectDbRows, hardDeleteProject } from "../lib/project-purge.js";
import { enrichCapabilitiesHookEvents } from "../lib/hook-events.js";
import { enrichCapabilitySources } from "../lib/capability-sources.js";
import {
  ensureImplicitSubscription,
  listProjectSubscriptions,
  listSubscriptionsByProjects,
} from "../lib/subscriptions.js";
import {
  broadcastToWebClients,
  getAgent,
  getCachedProjectState,
  requestFromAgent,
} from "../ws/gateway.js";

/**
 * SQLite 行（snake_case）→ shared `Project`（camelCase）。
 * 所有对外暴露 project 字段的入口走这一个函数，杜绝两种命名混在响应里。
 */
function rowToProject(row: any): Project {
  return {
    id: row.id,
    deviceId: row.device_id,
    userId: row.user_id,
    projectName: row.project_name,
    normalizedPath: row.normalized_path,
    registeredAt: row.registered_at,
    detectedTargets: JSON.parse(row.detected_targets || "[]"),
    defaultTargets: JSON.parse(row.default_targets || "[]"),
    subscriptions: [],
    status: row.status,
  };
}

function rowToDevice(row: any): Device {
  return {
    id: row.id,
    userId: row.user_id,
    deviceName: row.device_name,
    status: row.status,
    lastOnlineAt: row.last_online_at,
    createdAt: row.created_at,
  };
}

export function projectRoutes(app: FastifyInstance) {
  app.get("/api/projects", { preHandler: [requireAnyAuth] }, async (request) => {
    // 默认隐藏已注销项目；?includeUnregistered=1 时全量返回（管理界面/调试用）。
    const includeAll = (request.query as any)?.includeUnregistered === "1";
    const statusFilter = includeAll ? "" : "AND p.status != 'unregistered'";
    const rows = db.prepare(`
      SELECT p.*,
             d.id AS d_id, d.user_id AS d_user_id, d.device_name AS d_device_name,
             d.status AS d_status, d.last_online_at AS d_last_online_at, d.created_at AS d_created_at
      FROM projects p
      LEFT JOIN devices d ON d.id = p.device_id
      WHERE p.user_id = ? ${statusFilter}
      ORDER BY p.registered_at DESC
    `).all(request.user!.userId) as any[];

    const subsByProject = listSubscriptionsByProjects(rows.map((r) => r.id as string));
    const data = rows.map((row) => {
      const device = row.d_id
        ? { id: row.d_id, userId: row.d_user_id, deviceName: row.d_device_name, status: row.d_status, lastOnlineAt: row.d_last_online_at, createdAt: row.d_created_at }
        : null;
      return {
        ...rowToProject(row),
        device,
        subscriptions: subsByProject.get(row.id) ?? [],
      };
    });
    return { success: true, data };
  });

  app.get("/api/projects/:id", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get((request.params as any).id) as any;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }

    const deviceRow = db.prepare("SELECT * FROM devices WHERE id = ?").get(row.device_id) as any;
    const device = deviceRow ? rowToDevice(deviceRow) : null;

    return {
      success: true,
      data: { ...rowToProject(row), device, subscriptions: listProjectSubscriptions(row.id) },
    };
  });

  app.post("/api/projects/register", { preHandler: [requireCliAuth] }, async (request, reply) => {
    const parsed = projectRegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const { deviceId, projectName, normalizedPath, detectedTargets } = parsed.data;

    const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as any;
    if (!device || device.user_id !== request.user!.userId) {
      return reply.status(400).send({ success: false, error: "设备不存在" });
    }

    // 路径冲突检查必须按 (user_id, normalized_path) 复合键判定，避免不同用户同路径
    // 互相返回对方的项目记录（数据隔离 / 信息泄漏）。
    const existing = db.prepare(
      "SELECT * FROM projects WHERE user_id = ? AND normalized_path = ? AND status != 'unregistered'"
    ).get(request.user!.userId, normalizedPath) as any;
    if (existing) {
      // 项目已存在：如果 device_id 变了（例如 logout/login 导致 deviceId 丢失后重新创建），
      // 自动 rebind 到当前设备，否则 Web 端会因 deviceId 不匹配而显示 "Agent 未在线"。
      if (existing.device_id !== deviceId) {
        // rebind 时同步更新 status：rebindProjects 在 agent 认证后立即调用，
        // 此时 agent 必然在线。若不由 register 端点设置 status，auth handler 的
        // UPDATE projects SET status='online' 已在 rebind 之前执行（device_id 还没改），
        // 导致该项目 status 残留 offline，web 列表显示离线。
        const isOnline = !!getAgent(deviceId);
        db.prepare("UPDATE projects SET device_id = ?, status = ? WHERE id = ?").run(
          deviceId, isOnline ? "online" : existing.status, existing.id,
        );
        existing.device_id = deviceId;
        existing.status = isOnline ? "online" : existing.status;
      }
      return { success: true, data: rowToProject(existing) };
    }

    const now = new Date().toISOString();
    const id = generateId();
    db.prepare(
      `INSERT INTO projects (id, device_id, user_id, project_name, normalized_path, registered_at, detected_targets, default_targets, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, deviceId, request.user!.userId, projectName, normalizedPath, now,
      JSON.stringify(detectedTargets), JSON.stringify(detectedTargets), "registered");
    ensureImplicitSubscription(id);

    const created = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    const project = rowToProject(created);
    // 通知任何已连 ws 的 web 客户端：项目列表有变化（用户可立即刷新）。
    // 当前 web 端尚未接入 ws，仅用 5s 轻量轮询；此广播留作以后接 ws 客户端时直接生效。
    broadcastToWebClients("project:registered", { project });
    return { success: true, data: project };
  });

  app.put("/api/projects/:id", { preHandler: [requireCliAuth] }, async (request, reply) => {
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get((request.params as any).id) as any;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }

    const body = request.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: any[] = [];

    if (body.status) { sets.push("status = ?"); params.push(body.status); }
    if (body.defaultTargets) { sets.push("default_targets = ?"); params.push(JSON.stringify(body.defaultTargets)); }

    if (sets.length > 0) {
      params.push(row.id);
      db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    }

    return { success: true };
  });

  /**
   * POST /api/projects/:id/subscriptions/:wid/sync-policy
   * body: { policy: "auto" | "locked" }
   * 修改某条订阅的同步策略（ADR-0006：策略挂在订阅上）。wid = "implicit" 表示隐式订阅
   * （「单独添加的能力」组）。auto 时该空间/能力的后续编辑会自动回推到本项目。
   */
  app.post("/api/projects/:id/subscriptions/:wid/sync-policy", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const wid = (request.params as any).wid as string;
    const workspaceId = wid === "implicit" ? "" : wid;
    const policy = String((request.body as any)?.policy ?? "");
    if (policy !== "auto" && policy !== "locked") {
      return reply.status(400).send({ success: false, error: "policy 必须为 auto 或 locked" });
    }
    const row = db.prepare("SELECT user_id FROM projects WHERE id = ?").get(projectId) as
      | { user_id: string }
      | undefined;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }
    const sub = db.prepare(
      "SELECT 1 FROM project_subscriptions WHERE project_id = ? AND workspace_id = ?",
    ).get(projectId, workspaceId);
    if (!sub) return reply.status(404).send({ success: false, error: "订阅不存在" });
    db.prepare(
      "UPDATE project_subscriptions SET sync_policy = ? WHERE project_id = ? AND workspace_id = ?",
    ).run(policy, projectId, workspaceId);
    // 从 locked 切到 auto：立即补一次同步，让本项目追平当前最新内容。
    if (policy === "auto") syncProjectNow(projectId);
    return { success: true, data: { policy } };
  });

  /**
   * POST /api/projects/:id/subscriptions/:wid/targets
   * body: { targets: TargetTool[] }
   * 修改某条显式订阅的落盘厂商集合并立即 reconcile（ADR-0006：targetTools 挂在订阅上）。
   * 收窄厂商即按 (能力 × 厂商) 引用计数撤下该厂商的文件；共享能力在其它订阅覆盖的
   * 厂商下保留。
   */
  app.post("/api/projects/:id/subscriptions/:wid/targets", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const workspaceId = (request.params as any).wid as string;
    if (workspaceId === "implicit") {
      return reply.status(400).send({ success: false, error: "隐式订阅跟随项目厂商集合，请用 /targets 调整" });
    }
    const body = request.body as any;
    const raw: string[] = Array.isArray(body?.targets) ? body.targets.map(String) : [];
    const targets = [...new Set(raw)] as TargetTool[];
    if (targets.length === 0 || !targets.every((t) => TARGET_TOOLS.includes(t))) {
      return reply.status(400).send({ success: false, error: "targets 不合法（需为受支持厂商且非空）" });
    }
    const proj = await loadProjectForCapability(projectId, request.user!.userId, request.user!.email);
    if ("error" in proj) return reply.status(proj.status).send({ success: false, error: proj.error });
    const sub = db.prepare(
      "SELECT 1 FROM project_subscriptions WHERE project_id = ? AND workspace_id = ?",
    ).get(projectId, workspaceId);
    if (!sub) return reply.status(404).send({ success: false, error: "订阅不存在" });
    db.prepare(
      "UPDATE project_subscriptions SET target_tools = ? WHERE project_id = ? AND workspace_id = ?",
    ).run(JSON.stringify(targets), projectId, workspaceId);
    const wait = await enqueueReconcileAndWait(proj.deviceId, projectId, { force: true });
    return finalizeCapabilityResponse(reply, wait);
  });

  /**
   * DELETE /api/projects/:id/subscriptions/:wid
   * 卸载一条显式订阅：删订阅行 + 跳过集 → reconcile（removed 经账本计算，共享能力按
   * 引用计数保留）→ GC 留存空间。
   */
  app.delete("/api/projects/:id/subscriptions/:wid", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const workspaceId = (request.params as any).wid as string;
    if (workspaceId === "implicit") {
      return reply.status(400).send({ success: false, error: "隐式订阅不可整体卸载，请逐个移除能力" });
    }
    const row = db.prepare("SELECT device_id, user_id FROM projects WHERE id = ?").get(projectId) as
      | { device_id: string; user_id: string }
      | undefined;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }
    const sub = db.prepare(
      "SELECT 1 FROM project_subscriptions WHERE project_id = ? AND workspace_id = ?",
    ).get(projectId, workspaceId);
    if (!sub) return reply.status(404).send({ success: false, error: "订阅不存在" });
    if (!getAgent(row.device_id)) {
      return reply.status(409).send({ success: false, error: "Agent 未在线" });
    }
    db.prepare(
      "DELETE FROM project_subscriptions WHERE project_id = ? AND workspace_id = ?",
    ).run(projectId, workspaceId);
    db.prepare(
      "DELETE FROM project_subscription_excludes WHERE project_id = ? AND workspace_id = ?",
    ).run(projectId, workspaceId);
    const wait = await enqueueReconcileAndWait(row.device_id, projectId, { force: true });
    maybeGcRetiredWorkspace(workspaceId);
    if (wait.kind !== "ok") {
      // 订阅已删但落盘失败：不回滚（权威状态已是「未订阅」），由下次 reconcile 补齐。
      return reply.status(502).send({
        success: false,
        error: wait.kind === "fail" ? wait.error : `已跳过:${wait.reason}`,
      });
    }
    requestFromAgent<LocalProjectState>(row.device_id, "project:scan", { projectId })
      .catch(() => { /* 兜底由 watcher 推送补 */ });
    return { success: true };
  });

  app.delete("/api/projects/:id", { preHandler: [requireCliAuth] }, async (request, reply) => {
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get((request.params as any).id) as any;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }

    // 硬删除：清三张项目关联表 + 仅本项目引用的 adopt 产物 + 项目行本身。
    // CLI 的 loom unregister 会同时抹掉本机 ~/.loom 痕迹，服务端不留任何记录。
    //
    // 额外 best-effort 下发 project:purge 让在线 daemon 立即停 watcher：否则 daemon
    // 要等 30s reconcile 才发现本地记录消失，期间仍持有项目目录的文件监听句柄——
    // 在 Windows 上 fs.watch 持有的目录句柄会阻止用户重命名/删除该目录（"正在被其他
    // 程序占用"）。离线 agent 无 watcher 可停，跳过；RPC 失败也不阻塞硬删，daemon
    // 仍会在下次 reconcile 自愈。先 RPC 后删行：RPC 停 watcher + 抹本地后 agent 不再
    // 推送 project:state，避免删行期间滞后的 state 写入触发 project_installed_assets
    // 外键违例。
    const prevSubscribed = db.prepare(
      "SELECT workspace_id FROM project_subscriptions WHERE project_id = ? AND workspace_id != ''",
    ).all(row.id) as { workspace_id: string }[];
    if (getAgent(row.device_id)) {
      try {
        await requestFromAgent<{ projectId: string }>(
          row.device_id, "project:purge", { projectId: row.id },
        );
      } catch {
        /* best-effort：失败不阻塞服务端硬删 */
      }
    }
    purgeProjectDbRows(row.id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(row.id);
    for (const s of prevSubscribed) maybeGcRetiredWorkspace(s.workspace_id);
    return { success: true };
  });

  /**
   * POST /api/projects/:id/purge
   * Web 端「删除项目」：抹掉该项目全部痕迹。
   *
   * 服务端深度清理（无论 agent 是否在线都执行）：
   *   - 清 project_capabilities / project_disabled_assets / project_installed_assets
   *   - 仅本项目引用的 adopt 产物（adopted=1 的私有 asset）硬删，连带 asset_files CASCADE
   *
   * Agent 在线且 RPC 成功 → 额外下发 `project:purge` 抹掉本机 `~/.loom` 痕迹后，硬删
   * 项目行（深度清理，服务端 + 本地全消失）。Agent 离线 / RPC 失败 → 仅软删
   * （status='unregistered'），保留行以便 agent 重连时由 compensateDeviceOnConnect 补发
   * project:purge 自愈并在成功后硬删项目行——避免再次 register 出现新旧两条本地记录。
   */
  app.post("/api/projects/:id/purge", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as any;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }

    const prevSubscribed = db.prepare(
      "SELECT workspace_id FROM project_subscriptions WHERE project_id = ? AND workspace_id != ''",
    ).all(projectId) as { workspace_id: string }[];
    // 1. 服务端关联表清理（不动项目行：深度/浅度分支再决定硬删还是软删）
    purgeProjectDbRows(projectId);

    // 2. Agent 在线 → 下发 project:purge 做本地深度清理
    const online = !!getAgent(row.device_id);
    let agentCleaned = false;
    let agentError: string | undefined;
    if (online) {
      try {
        await requestFromAgent<{ projectId: string }>(
          row.device_id, "project:purge", { projectId },
        );
        agentCleaned = true;
      } catch (err: any) {
        agentError = err?.message ?? "Agent 响应失败";
      }
    }

    if (agentCleaned) {
      // 深度清理：本地已清，硬删项目行。用 hardDeleteProject 而非裸 DELETE——
      // RPC 执行期间 agent 可能推送一次滞后 project:state，重新写入 project_installed_assets，
      // 此时直接 DELETE projects 会触发 FK 违例；hardDeleteProject 先清关联表再删行。
      hardDeleteProject(projectId);
      broadcastToWebClients("web:project:state_changed", { projectId });
      return { success: true, data: { depth: "deep" as const } };
    }

    // 浅度清理：软删项目行（status=unregistered），保留以备 agent 重连自愈。
    db.prepare("UPDATE projects SET status = 'unregistered' WHERE id = ?")
      .run(projectId);
    for (const s of prevSubscribed) maybeGcRetiredWorkspace(s.workspace_id);
    broadcastToWebClients("web:project:state_changed", { projectId });
    return {
      success: true,
      data: {
        depth: "shallow" as const,
        warning: agentError
          ? `Agent 在线但本地清理失败（${agentError}），服务端记录已清除，本地痕迹待 Agent 重连自动清理`
          : "Agent 未在线，仅清理服务端记录；本地 ~/.loom 痕迹将在 Agent 上线后自动清理",
      },
    };
  });

  // ---- 本地镜像（state / scan / files / uninstall） ----------------------
  //
  // 这四条路由都是"按 projectId 找设备 → 走 ws 跟 agent 同步问答"。
  // agent 离线时返回 409 + 最后已知缓存（如有），让 web 还能渲染历史镜像。

  /**
   * GET /api/projects/:id/state
   * 缓存命中且 30s 内有效 → 直接返回；否则 await 一次 scan。
   */
  app.get("/api/projects/:id/state", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const row = db.prepare("SELECT device_id, user_id FROM projects WHERE id = ?").get(projectId) as
      | { device_id: string; user_id: string }
      | undefined;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }

    const cached = getCachedProjectState(projectId);
    const agentOnline = !!getAgent(row.device_id);

    // 缓存新鲜 + agent 在线 → 直接命中
    if (cached) {
      const age = Date.now() - new Date(cached.scannedAt).getTime();
      if (age < 30_000 && agentOnline) {
        enrichCapabilitiesHookEvents(cached);
        enrichCapabilitySources(cached);
        return { success: true, data: cached };
      }
    }

    if (!agentOnline) {
      // agent 不在线：返回最后已知缓存 + 软警告（无论缓存新鲜与否，都要显式告知）
      if (cached) {
        enrichCapabilitiesHookEvents(cached);
        enrichCapabilitySources(cached);
        return { success: true, data: cached, warning: "Agent 未在线，展示最后已知镜像" };
      }
      return reply.status(409).send({
        success: false,
        error: "Agent 未在线，本机未上报过镜像；请到该项目所在机器执行 loom start。",
      });
    }

    try {
      const state = await requestFromAgent<LocalProjectState>(row.device_id, "project:scan", { projectId });
      enrichCapabilitiesHookEvents(state);
      enrichCapabilitySources(state);
      return { success: true, data: state };
    } catch (err: any) {
      // 超时或 agent 处理失败：兜底用 cached（如有），否则原样抛错
      if (cached) {
        enrichCapabilitiesHookEvents(cached);
        enrichCapabilitySources(cached);
        return { success: true, data: cached, warning: err?.message ?? "扫描失败" };
      }
      return reply.status(502).send({ success: false, error: err?.message ?? "扫描失败" });
    }
  });

  /**
   * POST /api/projects/:id/scan
   * 强制触发一次新扫描（不读缓存），用于 web 端"刷新本地"按钮。
   */
  app.post("/api/projects/:id/scan", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const row = db.prepare("SELECT device_id, user_id FROM projects WHERE id = ?").get(projectId) as
      | { device_id: string; user_id: string }
      | undefined;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }
    if (!getAgent(row.device_id)) {
      return reply.status(409).send({ success: false, error: "Agent 未在线" });
    }
    try {
      const state = await requestFromAgent<LocalProjectState>(row.device_id, "project:scan", { projectId });
      enrichCapabilitiesHookEvents(state);
      enrichCapabilitySources(state);
      return { success: true, data: state };
    } catch (err: any) {
      return reply.status(502).send({ success: false, error: err?.message ?? "扫描失败" });
    }
  });

  /**
   * GET /api/projects/:id/files?path=<rel>
   * 通过 agent 读单个文件。path 必须是 4 个厂商目录之一开头，或者是允许的项目
   * 根白名单文件（当前仅 `.mcp.json`，与 safe-write.ts 保持一致）。agent 端
   * `readFileSafe` 会再做一次校验，server 这里仅做"明显非法"的早返回。
   */
  app.get("/api/projects/:id/files", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const path = ((request.query as any)?.path ?? "") as string;
    if (!path || path.includes("..") || path.startsWith("/")) {
      return reply.status(400).send({ success: false, error: "非法 path" });
    }
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) {
      return reply.status(400).send({ success: false, error: "非法 path" });
    }
    const top = segments[0]!;
    // 顶层文件白名单：与 safe-write.ts 的 ALLOWED_ROOT_FILES 保持一致
    const ALLOWED_ROOT_FILES = new Set([".mcp.json"]);
    const isVendorTopDir = TARGET_TOOLS.some((t: TargetTool) => TARGET_DIRS[t] === top);
    const isAllowedRootFile = segments.length === 1 && ALLOWED_ROOT_FILES.has(top);
    if (!isVendorTopDir && !isAllowedRootFile) {
      return reply.status(400).send({
        success: false,
        error: "path 顶层必须是 4 个厂商目录之一，或允许的项目根文件 (.mcp.json)",
      });
    }
    const row = db.prepare("SELECT device_id, user_id FROM projects WHERE id = ?").get(projectId) as
      | { device_id: string; user_id: string }
      | undefined;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }
    if (!getAgent(row.device_id)) {
      return reply.status(409).send({ success: false, error: "Agent 未在线" });
    }
    try {
      const data = await requestFromAgent<{ content: string | null }>(
        row.device_id, "project:read_file", { projectId, path },
      );
      return { success: true, data };
    } catch (err: any) {
      const msg = err?.message ?? "读取失败";
      // 友好化常见错误：路径是目录时 agent fs 返回 EISDIR，转 400 让 UI 不当成系统级错误
      if (typeof msg === "string" && msg.includes("EISDIR")) {
        return reply.status(400).send({ success: false, error: "该路径是目录，无法作为文件读取" });
      }
      return reply.status(502).send({ success: false, error: msg });
    }
  });

  /**
   * POST /api/projects/:id/uninstall
   * 卸载全部：让 agent 按 lock 清空已安装文件 + lock 自身，server 端删除全部显式订阅。
   * 单订阅卸载用 DELETE /api/projects/:id/subscriptions/:wid。
   */
  app.post("/api/projects/:id/uninstall", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const row = db.prepare("SELECT device_id, user_id FROM projects WHERE id = ?").get(projectId) as
      | { device_id: string; user_id: string }
      | undefined;
    if (!row || row.user_id !== request.user!.userId) {
      return reply.status(404).send({ success: false, error: "项目不存在" });
    }
    if (!getAgent(row.device_id)) {
      return reply.status(409).send({ success: false, error: "Agent 未在线" });
    }
    try {
      const result = await requestFromAgent<InstallResult>(
        row.device_id, "install:uninstall", { projectId },
      );
      if (result.success) {
        const subs = db.prepare(
          "SELECT workspace_id FROM project_subscriptions WHERE project_id = ? AND workspace_id != ''",
        ).all(projectId) as { workspace_id: string }[];
        db.prepare("DELETE FROM project_subscriptions WHERE project_id = ? AND workspace_id != ''")
          .run(projectId);
        db.prepare("DELETE FROM project_subscription_excludes WHERE project_id = ?").run(projectId);
        for (const s of subs) maybeGcRetiredWorkspace(s.workspace_id);
      }
      return { success: true, data: result };
    } catch (err: any) {
      return reply.status(502).send({ success: false, error: err?.message ?? "卸载失败" });
    }
  });

  // ---- 单项能力管理 -----------------------------------------------------
  // v2 wire 协议下,三个动作都是「写 server 权威状态 → enqueueReconcile → 等待 CLI
  // 落盘」的统一模式:
  //   - toggle  : 写/删 project_disabled_assets 表(per-project 的 toggle 权威源)
  //   - add     : 写 workspace_assets,扩展项目所在工作空间的成员
  //   - remove  : 删 workspace_assets
  // CLI 端不再直接收 capability:* RPC,统一由 outbox-worker-v2 在下一次 reconcile
  // 中通过 reconcileProject 算出最新 plan 推下去。

  /**
   * POST /api/projects/:id/capabilities/toggle
   * body: { assetId: string, tool: TargetTool, enabled: boolean }
   *
   * 注:旧版 body 的 `externalAsset` 字段在 v2 已无意义(toggle 权威源是 server 表,
   * CLI 不再侧信道注入新文件)。该字段保留接受但忽略,避免老前端报错。
   */
  app.post("/api/projects/:id/capabilities/toggle", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const body = request.body as any;
    const tool = String(body?.tool ?? "") as TargetTool;
    const enabled = !!body?.enabled;
    if (!TARGET_TOOLS.includes(tool as TargetTool)) {
      return reply.status(400).send({ success: false, error: "参数 tool 不正确" });
    }
    const proj = await loadProjectForCapability(projectId, request.user!.userId, request.user!.email);
    if ("error" in proj) return reply.status(proj.status).send({ success: false, error: proj.error });

    // 外部能力首次操作：先 adopt（读盘建 asset + 入 project_capabilities），把权威 assetId
    // 从 `external:...` 换成 server 生成的真实 id。旧版 body 的 externalAsset 字段在此复用。
    let assetId = String(body?.assetId ?? "");
    let adopted = false;
    if (assetId.startsWith("external:")) {
      const ext = body?.externalAsset;
      if (!ext?.name || !ext?.type || !Array.isArray(ext?.files) || ext.files.length === 0) {
        return reply.status(400).send({ success: false, error: "外部能力信息不完整（需 name/type/files）" });
      }
      try {
        assetId = await adoptExternalAsset(
          projectId, proj.deviceId, tool,
          { name: String(ext.name), type: ext.type as AssetType, files: ext.files.map(String) },
          request.user!.email,
        );
        adopted = true;
      } catch (e: any) {
        return reply.status(502).send({ success: false, error: `Adopt 失败: ${e?.message ?? e}` });
      }
    }
    if (!assetId) {
      return reply.status(400).send({ success: false, error: "参数 assetId 不正确" });
    }

    // 1. 写 server 权威表:enabled=true 删行(=未禁用);enabled=false 插行(=禁用)。
    const now = new Date().toISOString();
    if (enabled) {
      db.prepare(
        "DELETE FROM project_disabled_assets WHERE project_id = ? AND asset_id = ? AND tool = ?",
      ).run(projectId, assetId, tool);
    } else {
      db.prepare(
        "INSERT OR IGNORE INTO project_disabled_assets (project_id, asset_id, tool, disabled_at) VALUES (?, ?, ?, ?)",
      ).run(projectId, assetId, tool, now);
    }

    // 2. 入队并等待:CLI 落盘后才返回。adopt 时附 adoptedAssetId 供前端对齐。
    const wait = await enqueueReconcileAndWait(proj.deviceId, projectId, { force: true });
    if (wait.kind === "ok") {
      return {
        success: true,
        data: {
          filesWritten: wait.data.filesWritten,
          filesRemoved: wait.data.filesRemoved,
          ...(adopted ? { adoptedAssetId: assetId } : {}),
        },
      };
    }
    return finalizeCapabilityResponse(reply, wait);
  });

  /**
   * POST /api/projects/:id/capabilities/add
   * body: { assetIds: string[] }
   * 把若干 asset 作为「项目级直接成员」加入 project_capabilities → 触发 reconcile。
   *
   * 单独安装（type 2）统一走此路径：per-project、不写入共享 workspace_assets、不 fan-out
   * 到同 workspace 的其它项目。无论项目是否已装 workspace 都可追加。与工作空间装 / 本地
   * 外部 adopt 在 reconcile 受管集中地位等同（受管集 = workspace_assets ∪ project_capabilities）。
   */
  app.post("/api/projects/:id/capabilities/add", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const body = request.body as any;
    const assetIds: string[] = Array.isArray(body?.assetIds) ? body.assetIds.map(String) : [];
    if (assetIds.length === 0) {
      return reply.status(400).send({ success: false, error: "assetIds 为空" });
    }
    const proj = await loadProjectForCapability(projectId, request.user!.userId, request.user!.email);
    if ("error" in proj) return reply.status(proj.status).send({ success: false, error: proj.error });
    // 鉴权:确认本人可见这些 asset(loadAssetEntries 已做可见性过滤)。
    const newcomers = loadAssetEntries(assetIds, request.user!.email);
    if (newcomers.length === 0) {
      return reply.status(404).send({ success: false, error: "目标 Asset 不存在或无权限" });
    }

    // 1. 写 project_capabilities：幂等(同 (project_id, asset_id) 已存在则跳过)。
    ensureImplicitSubscription(projectId);
    const now = new Date().toISOString();
    const tx = db.transaction((rows: typeof newcomers) => {
      const ins = db.prepare(
        "INSERT OR IGNORE INTO project_capabilities (project_id, asset_id, added_at) VALUES (?, ?, ?)",
      );
      for (const a of rows) ins.run(projectId, a.assetId, now);
    });
    tx(newcomers);

    // 2. 入队并等待 self 落盘（per-project，不 fan-out）。
    const wait = await enqueueReconcileAndWait(proj.deviceId, projectId, { force: true });
    return finalizeCapabilityResponse(reply, wait);
  });

  /**
   * POST /api/projects/:id/capabilities/remove
   * body: { assetId: string, tool?: TargetTool, externalAsset?: {...} }
   * 从项目移除该能力：删 workspace_assets / project_capabilities 成员 + toggle 痕迹 → reconcile。
   *
   * - 工作空间成员：从 workspace_assets 删（共享空间，fan-out 到同空间其它项目）。
   * - 本地 adopt 能力：从 project_capabilities 删（per-project，不扇出）。
   * - 外部能力（external:*）：先 adopt 再移除。
   * 移除的磁盘文件 / 聚合条目由 reconcile `removed` 清理（plan 自带文件路径，含从未入 lock
   * 的外部能力）。adopt 产物（仅本项目引用）在 reconcile 落盘后硬删 asset 行 + asset_files。
   */
  app.post("/api/projects/:id/capabilities/remove", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const body = request.body as any;
    const tool = String(body?.tool ?? "") as TargetTool;
    const proj = await loadProjectForCapability(projectId, request.user!.userId, request.user!.email);
    if ("error" in proj) return reply.status(proj.status).send({ success: false, error: proj.error });

    let assetId = String(body?.assetId ?? "");
    if (!assetId) {
      return reply.status(400).send({ success: false, error: "缺少 assetId" });
    }

    // 外部能力：先 adopt 落到 project_capabilities（与 toggle 同口径）。
    if (assetId.startsWith("external:")) {
      const ext = body?.externalAsset;
      if (!ext?.name || !ext?.type || !Array.isArray(ext?.files) || ext.files.length === 0) {
        return reply.status(400).send({ success: false, error: "外部能力信息不完整（需 name/type/files）" });
      }
      if (!TARGET_TOOLS.includes(tool as TargetTool)) {
        return reply.status(400).send({ success: false, error: "外部能力移除需指定 tool" });
      }
      try {
        assetId = await adoptExternalAsset(
          projectId, proj.deviceId, tool,
          { name: String(ext.name), type: ext.type as AssetType, files: ext.files.map(String) },
          request.user!.email,
        );
      } catch (e: any) {
        return reply.status(502).send({ success: false, error: `Adopt 失败: ${e?.message ?? e}` });
      }
    }

    // 1. 删成员：从所有引用该 asset 的已订阅工作空间的 workspace_assets 删（共享空间，
    //    fan-out 到同空间其它项目）+ project_capabilities（若是 adopt / 单独添加能力）。
    const inCapabilities = !!db
      .prepare("SELECT 1 FROM project_capabilities WHERE project_id = ? AND asset_id = ?")
      .get(projectId, assetId);
    for (const wsId of proj.workspaceIds) {
      db.prepare(
        "DELETE FROM workspace_assets WHERE workspace_id = ? AND asset_id = ?",
      ).run(wsId, assetId);
    }
    db.prepare(
      "DELETE FROM project_capabilities WHERE project_id = ? AND asset_id = ?",
    ).run(projectId, assetId);
    // 清 toggle 痕迹，避免下次再加回来时残留 disabled 状态。
    db.prepare(
      "DELETE FROM project_disabled_assets WHERE project_id = ? AND asset_id = ?",
    ).run(projectId, assetId);

    // 2. fan-out（工作空间成员变更）+ 等待 self。reconcile 落盘后磁盘文件 / 聚合 key 被删，
    //    project_installed_assets 账本由 applySuccess 重写（removed 项被剔除）。
    for (const wsId of proj.workspaceIds) {
      syncWorkspaceMembersToProjects(wsId, [], [], false);
    }
    const wait = await enqueueReconcileAndWait(proj.deviceId, projectId, { force: true });
    // 3. adopt 产物仅本项目引用 → reconcile 落盘后硬删 asset 行（CASCADE 清 asset_files）。
    //    此时 project_capabilities / project_disabled_assets 已删，project_installed_assets
    //    由 applySuccess 清空该行，无 FK 残留引用。仅当确非共享 workspace 成员时才硬删。
    //    注意：仅 adopted=1 的 adopt 产物可硬删——经 capabilities/add 加入的库 asset
    //    只是「从项目移除」，资产本身必须保留在库中（否则移除后无法再次添加）。
    if (inCapabilities && wait.kind !== "skip") {
      const assetRow = db.prepare("SELECT adopted FROM assets WHERE id = ?").get(assetId) as
        | { adopted: number }
        | undefined;
      const stillReferenced = !!db
        .prepare("SELECT 1 FROM workspace_assets WHERE asset_id = ?")
        .get(assetId);
      if (assetRow?.adopted === 1 && !stillReferenced) {
        db.prepare("DELETE FROM project_installed_assets WHERE project_id = ? AND asset_id = ?")
          .run(projectId, assetId);
        db.prepare("DELETE FROM assets WHERE id = ?").run(assetId);
      }
    }
    return finalizeCapabilityResponse(reply, wait);
  });

  /**
   * POST /api/projects/:id/targets
   * body: { targets: TargetTool[] }
   * 更新项目的「目标厂商集合」（default_targets）并立即 reconcile。用于安装后用户
   * 新增 / 调整厂商：reconcileProject 按 default_targets ∩ workspace.targetTools 决定
   * 落盘厂商，因此新增厂商即让对应 vendor 目录被创建并写入当前工作空间能力。
   */
  app.post("/api/projects/:id/targets", { preHandler: [requireAnyAuth] }, async (request, reply) => {
    const projectId = (request.params as any).id as string;
    const body = request.body as any;
    const raw: string[] = Array.isArray(body?.targets) ? body.targets.map(String) : [];
    const targets = [...new Set(raw)] as TargetTool[];
    if (targets.length === 0 || !targets.every((t) => TARGET_TOOLS.includes(t))) {
      return reply.status(400).send({ success: false, error: "targets 不合法（需为受支持厂商且非空）" });
    }
    const proj = await loadProjectForCapability(projectId, request.user!.userId, request.user!.email);
    if ("error" in proj) return reply.status(proj.status).send({ success: false, error: proj.error });

    db.prepare("UPDATE projects SET default_targets = ? WHERE id = ?").run(
      JSON.stringify(targets), projectId,
    );
    const wait = await enqueueReconcileAndWait(proj.deviceId, projectId, { force: true });
    return finalizeCapabilityResponse(reply, wait);
  });
}

/**
 * 把 `enqueueReconcileAndWait` 的结果转成统一的 HTTP 响应。CLI 已落盘 → 200 + 文件清单;
 * 跳过(项目状态不可入队)→ 409;失败 → 502。
 */
function finalizeCapabilityResponse(
  reply: any,
  wait: Awaited<ReturnType<typeof enqueueReconcileAndWait>>,
) {
  if (wait.kind === "ok") {
    return {
      success: true,
      data: {
        filesWritten: wait.data.filesWritten,
        filesRemoved: wait.data.filesRemoved,
      },
    };
  }
  if (wait.kind === "skip") {
    return reply.status(409).send({ success: false, error: `已跳过:${wait.reason}` });
  }
  return reply.status(502).send({ success: false, error: wait.error });
}

// ---------------- capability helpers ----------------

interface CapabilityProjectCtx {
  deviceId: string;
  /** 项目当前全部显式订阅的工作空间 id（含留存空间）。 */
  workspaceIds: string[];
  targetTools: TargetTool[];
  assets: import("@maolinc/cc-loom-shared").ManifestAssetEntry[];
}

/**
 * 校验项目 + 加载 currentEnabledAssets 全集（用于 agent 端 mcp/hook aggregate 重算）。
 *
 * 注意：currentEnabledAssets 用 workspace.assets 近似 — 真实 enabled 列表只在 agent
 * 端 lock 中。capabilities 流程下两边一致；偶发偏差由 agent 兜底（按自己 lock 取真值）。
 */
async function loadProjectForCapability(
  projectId: string,
  userId: string,
  userEmail: string,
): Promise<CapabilityProjectCtx | { error: string; status: number }> {
  const row = db.prepare(
    "SELECT id, device_id, user_id FROM projects WHERE id = ?",
  ).get(projectId) as
    | { id: string; device_id: string; user_id: string }
    | undefined;
  if (!row || row.user_id !== userId) return { error: "项目不存在", status: 404 };
  if (!getAgent(row.device_id)) return { error: "Agent 未在线", status: 409 };
  // 注意：不过滤 deleted_at —— 已从库移除但仍被本项目「留存」的工作空间，
  // 仍要能解析出 targetTools / assets，保证向已安装项目添加能力不受阻碍。
  const subs = db.prepare(
    "SELECT workspace_id FROM project_subscriptions WHERE project_id = ? AND workspace_id != ''",
  ).all(projectId) as { workspace_id: string }[];
  const workspaceIds = subs.map((s) => s.workspace_id);
  let assets: import("@maolinc/cc-loom-shared").ManifestAssetEntry[] = [];
  const targetTools = new Set<TargetTool>();
  const assetIds = new Set<string>();
  for (const wsId of workspaceIds) {
    const ws = db.prepare(
      "SELECT id, target_tools FROM workspaces WHERE id = ?",
    ).get(wsId) as { id: string; target_tools: string } | undefined;
    if (!ws) continue;
    for (const t of JSON.parse(ws.target_tools || "[]") as TargetTool[]) targetTools.add(t);
    const wa = db
      .prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?")
      .all(ws.id) as { asset_id: string }[];
    for (const r of wa) assetIds.add(r.asset_id);
  }
  if (assetIds.size > 0) {
    // 解析「已安装」集合：包含留存（软删）asset，确保 mcp/hook 聚合重算拿得到内容。
    assets = loadAssetEntries([...assetIds], userEmail, true);
  }
  return {
    deviceId: row.device_id,
    workspaceIds,
    targetTools: [...targetTools],
    assets,
  };
}

/**
 * Adopt 一个本地外部能力：读盘 → 建 asset + asset_files → 加入 project_capabilities +
 * project_installed_assets，使其进入 reconcile 受管集。返回新 assetId。失败抛 Error。
 *
 * 触发场景：本地控制台对 `external:<type>:<name>` 能力做 toggle/remove。adopt 后该能力
 * 与工作空间装 / 单独装能力在 reconcile 中地位等同——三类能力控制行为一致的关键。
 *
 * 全类型支持：
 *  - mcp：从聚合文件 { mcpServers: { <name>: <def> } } 抽取单 server def（single 形态）。
 *  - skill/rule/command/agent：passthrough——asset_files.path 存精确磁盘相对路径，
 *    metadata.passthrough=true，adapter 原样写出（不做 slug/dir 变换），保证任意外部
 *    路径 round-trip（含扁平文件、任意扩展名）。
 *  - hook：从聚合 hooks 注册表反向重建 { event, matcher, hooks[] } 元数据。loom 目录形态
 *    命令剥前缀回相对、附属脚本按 hooks/<name>/<rel> 存储；foreign 形态（bash -c 包装 /
 *    扁平脚本）注册项与附属脚本路径原样保留（passthrough，与 rule/command 同语义）。
 *
 * per-tool adopt：compatibleTools=[tool]；跨厂商同名外部能力各自独立 adopt。
 * 同时写 project_installed_assets（磁盘账本）——使 adopt 后立即 remove 也能经 reconcile
 * `removed` 删掉磁盘文件 / 聚合 key（不依赖 CLI oldLock）。
 */
async function adoptExternalAsset(
  projectId: string,
  deviceId: string,
  tool: TargetTool,
  ext: { name: string; type: AssetType; files: string[] },
  authorEmail: string,
): Promise<string> {
  const { name, type, files: paths } = ext;
  if (!name || !Array.isArray(paths) || paths.length === 0) {
    throw new Error("外部能力信息不完整");
  }

  // 幂等：若本项目已 adopt 过同名同类型、且兼容该 tool 的能力，复用其 assetId。
  // 否则每次 toggle 外部能力都会 generateId() 生成新 asset 行，造成本地镜像里
  // 同名能力不断堆叠（用户每点一次开关就多出一个）。
  const candidates = db.prepare(`
    SELECT a.id AS id, a.compatible_tools AS compatible_tools
    FROM assets a
    JOIN project_capabilities pc ON pc.asset_id = a.id
    WHERE pc.project_id = ? AND a.name = ? AND a.type = ?
  `).all(projectId, name, type) as { id: string; compatible_tools: string }[];
  for (const c of candidates) {
    let tools: string[] = [];
    try { tools = JSON.parse(c.compatible_tools || "[]"); } catch { tools = []; }
    if (tools.includes(tool)) {
      // 复用既有 adopt 产物：补齐磁盘账本（reconcile removed 计算依赖它）后直接返回。
      db.prepare(
        "INSERT OR IGNORE INTO project_installed_assets (project_id, asset_id, installed_at) VALUES (?, ?, ?)",
      ).run(projectId, c.id, new Date().toISOString());
      return c.id;
    }
  }

  const targetDir = TARGET_DIRS[tool];
  const adapter = getAdapters([tool])[0];
  if (!adapter) throw new Error(`无 ${tool} adapter`);

  // 1. 逐文件读盘（复用 project:read_file op；路径在 vendor 目录或根 .mcp.json 白名单内）
  const readFile = async (p: string): Promise<string> => {
    const r = await requestFromAgent<{ content: string | null }>(
      deviceId, "project:read_file", { projectId, path: p },
    );
    if (r.content == null) throw new Error(`读取文件失败: ${p}`);
    return r.content;
  };

  const assetId = generateId();
  const now = new Date().toISOString();
  let assetFiles: { path: string; content: string }[];
  let metadata: Record<string, unknown>;
  let sourcePath: string | null = null;

  if (type === "mcp") {
    // 从聚合文件抽取单 server def（single 形态）
    const raw = await readFile(paths[0]!);
    let def: unknown = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const servers = (parsed as Record<string, unknown>).mcpServers;
        if (servers && typeof servers === "object" && !Array.isArray(servers)) {
          def = (servers as Record<string, unknown>)[name] ?? raw;
        }
      }
    } catch {
      /* 解析失败：保底用原始字符串，aggregateMcps 以 name 为 key 挂原值 */
    }
    assetFiles = [{ path: "server.json", content: typeof def === "string" ? def : JSON.stringify(def, null, 2) }];
    metadata = {};
  } else if (type === "hook") {
    // 从聚合 hooks 注册表反向重建元数据 + 读附属脚本
    const aggPath = adapter.hooksAggregatePath();
    if (!aggPath) throw new Error(`${tool} 不支持 hook`);
    const aggRaw = await readFile(aggPath);
    const reconstructed = reconstructHookMetadata(aggRaw, name, targetDir);
    if (!reconstructed) throw new Error(`聚合 ${aggPath} 未找到 hook「${name}」的注册项`);
    metadata = reconstructed.metadata;
    assetFiles = [];
    if (reconstructed.passthrough) {
      // foreign hook：附属脚本存精确磁盘路径（passthrough，与 rule/command 一致），
      // adapter 原样写回——扁平脚本 hooks/<name>.sh 等路径不被搬进 hooks/<name>/ 目录。
      for (const p of paths) {
        if (p === aggPath) continue;
        assetFiles.push({ path: p, content: await readFile(p) });
      }
    } else {
      // loom 目录形态：ext.files 是 hooks/<name>/ 下的全部文件，存相对路径
      const base = `${targetDir}/hooks/${name}/`;
      for (const p of paths) {
        if (p === aggPath) continue;
        const rel = p.startsWith(base) ? p.slice(base.length) : (p.split("/").pop() ?? p);
        assetFiles.push({ path: rel, content: await readFile(p) });
      }
    }
  } else {
    // skill/rule/command/agent：passthrough，存精确磁盘路径
    assetFiles = [];
    for (const p of paths) assetFiles.push({ path: p, content: await readFile(p) });
    metadata = { passthrough: true };
    sourcePath = paths[0] ?? null;
  }

  // 2. 落库：asset + asset_files + project_capabilities + project_installed_assets
  const tx = db.transaction(() => {
    // adopted = 1：标记为本地外部能力 adopt 产物，仅用于本地控制台/reconcile，
    // 不进入能力市场列表（见 /api/assets 的 adopted = 0 过滤）。
    db.prepare(`
      INSERT INTO assets (id, name, type, description, author, tags, compatible_tools, visibility, version, metadata, source_path, adopted, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, '[]', ?, 'private', '1.0.0', ?, ?, 1, ?, ?)
    `).run(assetId, name, type, authorEmail, JSON.stringify([tool]), JSON.stringify(metadata), sourcePath, now, now);
    const insFile = db.prepare(
      "INSERT INTO asset_files (id, asset_id, path, content, encoding, size, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
    );
    for (const f of assetFiles) insFile.run(generateId(), assetId, f.path, f.content, f.content.length, now, now);
    db.prepare(
      "INSERT OR IGNORE INTO project_capabilities (project_id, asset_id, added_at) VALUES (?, ?, ?)",
    ).run(projectId, assetId, now);
    // 磁盘账本：adopt 即代表「磁盘上已有该能力足迹」，使后续 remove 能经 reconcile removed 删除
    db.prepare(
      "INSERT OR IGNORE INTO project_installed_assets (project_id, asset_id, installed_at) VALUES (?, ?, ?)",
    ).run(projectId, assetId, now);
  });
  tx();
  return assetId;
}

/**
 * 从聚合 hooks 注册表内容反向重建指定 hook 的元数据。
 * 注册表结构（buildHookRegistry 产物 / 用户手写）：{ hooks: { <event>: [{ matcher?, hooks: [...], ... }] } }
 *
 * 命中判据：matcherEntry 的 hooks[].command 含 `hooks/<name>/`（目录形态）或
 * `hooks/<name>.`（扁平脚本形态，如 hooks/wecom-notification.sh）。
 * 一个 hook 可注册在多个事件下——收集所有事件里的匹配注册项。
 *
 * 两种形态：
 *  - loom 形态（所有事件的命令整体都是 loom 写出的命令路径）：以首个注册项为准剥前缀
 *    回相对路径存 metadata（events + 共享 matcher/hooks），adapter 写回时逐事件重新加
 *    ${CLAUDE_PROJECT_DIR}/<targetDir>/ 前缀（原 round-trip 口径）。
 *  - foreign 形态（bash -c 包装命令 / 扁平脚本 / 各事件注册项不一致）：逐事件原样保留进
 *    metadata.registrations（passthrough，命令与 matcher/description 等字段不丢），
 *    附属脚本按精确磁盘路径存储——否则剥前缀会把包装命令切碎、写回时又被改路径。
 * 返回 null = 聚合中无该 hook 的注册项。
 */
function reconstructHookMetadata(
  aggRaw: string,
  name: string,
  targetDir: string,
): { metadata: Record<string, unknown>; passthrough: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(aggRaw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const registry = (parsed as Record<string, unknown>).hooks;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return null;
  const dirNeedle = `hooks/${name}/`;
  const flatNeedle = `hooks/${name}.`;
  // loom 写出的命令路径前缀（placeholder / 相对 / ./ 相对三种形态，与各 adapter 写出口径对齐）
  const loomPrefixes = [
    `\${CLAUDE_PROJECT_DIR}/${targetDir}/hooks/${name}/`,
    `./${targetDir}/hooks/${name}/`,
    `${targetDir}/hooks/${name}/`,
  ];
  const commandOf = (h: unknown): string | null => {
    const cmd = (h as Record<string, unknown>)?.command;
    return typeof cmd === "string" ? cmd : null;
  };

  // 逐事件收集匹配注册项（owned = entry.hooks 内属于该 hook 的命令条目）
  const matched: { event: string; entry: Record<string, unknown>; owned: unknown[] }[] = [];
  for (const [event, entries] of Object.entries(registry as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const hooks = (entry as Record<string, unknown>).hooks;
      if (!Array.isArray(hooks)) continue;
      const owned = hooks.filter((h) => {
        const cmd = commandOf(h);
        return cmd !== null && (cmd.includes(dirNeedle) || cmd.includes(flatNeedle));
      });
      if (owned.length > 0) {
        matched.push({ event, entry: entry as Record<string, unknown>, owned });
      }
    }
  }
  if (matched.length === 0) return null;

  const events = [...new Set(matched.map((m) => m.event))];
  const allLoom = matched.every((m) =>
    m.owned.every((h) => loomPrefixes.some((p) => commandOf(h)!.startsWith(p))),
  );
  if (allLoom) {
    // loom 形态：以首个注册项为准剥离（同资产逐事件重建的注册项内容一致）
    const first = matched[0]!;
    const stripped = first.owned.map((h) => {
      const hh = h as Record<string, unknown>;
      const cmd = hh.command as string;
      const idx = cmd.indexOf(dirNeedle);
      return { ...hh, command: cmd.slice(idx + dirNeedle.length) };
    });
    const meta: Record<string, unknown> = { events, hooks: stripped };
    const matcher = first.entry.matcher;
    if (typeof matcher === "string") meta.matcher = matcher;
    return { metadata: meta, passthrough: false };
  }
  // foreign：逐事件原样保留注册项（hooks 收敛为属于该 hook 的条目）
  const registrations = matched.map((m) => ({
    event: m.event,
    entry: { ...m.entry, hooks: m.owned },
  }));
  return {
    metadata: { events, hooks: matched[0]!.owned, passthrough: true, registrations },
    passthrough: true,
  };
}
