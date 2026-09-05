import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { installRequestSchema } from "@maolinc/cc-loom-shared";
import { requireAuth } from "../lib/auth.js";
import type { LocalProjectState } from "@maolinc/cc-loom-shared";
import { getAgent, requestFromAgent } from "../ws/gateway.js";
import { maybeGcRetiredWorkspace } from "../lib/workspace-gc.js";
import { buildInstallPlan } from "../lib/reconcile.js";
import { enqueueReconcileAndWait } from "../lib/outbox-worker-v2.js";
import { ensureImplicitSubscription } from "../lib/subscriptions.js";

/**
 * /api/install/plan 与 /api/install/execute 的路由层（ADR-0006 多空间订阅）。
 *
 * - `/plan`:dry-run 预览。仍走 `buildInstallPlan`(adapter 渲染层),给 Web 看
 *   "这次操作会发生什么"，含结构化撞车清单 `conflictingAssets`（同名不同 id）。
 * - `/execute`:「添加/重装一条订阅」——写 server 端权威状态（订阅行 + 撞车跳过集）
 *   + 入队 reconcile + 同步等待结果。CLI 真正落盘走 outbox-worker-v2 + reconcile op。
 *   重装（订阅已存在）= 更新 policy/targetTools 并整组替换跳过集（可补齐此前跳过的能力）。
 */
export function installRoutes(app: FastifyInstance) {
  // 计算 plan：只查询 / 渲染 diff，不写入、不联系 agent。
  app.post("/api/install/plan", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = installRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.issues[0]?.message || "参数不正确",
      });
    }

    const result = buildInstallPlan(request.user!.userId, parsed.data);
    if ("error" in result) {
      return reply.status(result.status).send({ success: false, error: result.error });
    }
    return { success: true, data: result.plan };
  });

  // 真正执行:
  // 1. 校验入参 + 撞车裁决完整性（未裁决的撞车必须全部在 skipAssetIds 中）
  // 2. UPSERT 订阅行 + 整组替换跳过集(server 权威状态先就位)
  // 3. enqueueReconcile + 同步等待该次 reconcile 完成(或 timeout)
  // 4. 成功后 ping 一次 project:scan 让 web 缓存即时对齐(失败兜底由 fs.watch 推送)
  app.post("/api/install/execute", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = installRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: parsed.error.issues[0]?.message || "参数不正确",
      });
    }

    // 预览仍用 buildInstallPlan 校验入参(项目/工作空间/工具集是否合法)。
    // 实际落盘 plan 由 worker 在 reconcileProject 重新算,以 server 当前权威状态为准。
    const built = buildInstallPlan(request.user!.userId, parsed.data);
    if ("error" in built) {
      return reply.status(built.status).send({ success: false, error: built.error });
    }

    // 撞车裁决完整性：plan 报出的撞车必须全部被 skipAssetIds 覆盖，否则 409 要求先裁决。
    const skipSet = new Set(parsed.data.skipAssetIds ?? []);
    const undecided = (built.plan.conflictingAssets ?? []).filter(
      (c) => !skipSet.has(c.incomingAssetId),
    );
    if (undecided.length > 0) {
      return reply.status(409).send({
        success: false,
        error: `存在未裁决的同名撞车能力：${undecided.map((c) => c.name).join("、")}`,
        data: { conflictingAssets: built.plan.conflictingAssets },
      });
    }

    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(parsed.data.projectId) as any;
    const deviceId = project.device_id as string;

    if (!getAgent(deviceId)) {
      return reply.status(409).send({
        success: false,
        error: "本机 Agent 未在线，请到该项目所在机器执行 `loom start` 后重试。",
      });
    }

    // 先写 server 权威状态再入队:reconcileProject 在 worker 端读 DB 算 plan,
    // 必须读到本次 execute 的订阅与跳过集。保存旧值以便失败回滚。
    const prevSub = db.prepare(
      "SELECT sync_policy, target_tools FROM project_subscriptions WHERE project_id = ? AND workspace_id = ?",
    ).get(parsed.data.projectId, parsed.data.workspaceId) as
      | { sync_policy: string; target_tools: string | null }
      | undefined;
    const prevExcludes = (db.prepare(
      "SELECT asset_id FROM project_subscription_excludes WHERE project_id = ? AND workspace_id = ?",
    ).all(parsed.data.projectId, parsed.data.workspaceId) as { asset_id: string }[])
      .map((r) => r.asset_id);

    const now = new Date().toISOString();
    ensureImplicitSubscription(parsed.data.projectId);
    db.prepare(
      `INSERT INTO project_subscriptions (project_id, workspace_id, sync_policy, target_tools, installed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, workspace_id)
       DO UPDATE SET sync_policy = excluded.sync_policy, target_tools = excluded.target_tools`,
    ).run(
      parsed.data.projectId, parsed.data.workspaceId, parsed.data.policy,
      JSON.stringify(parsed.data.targetTools), now,
    );
    db.prepare(
      "DELETE FROM project_subscription_excludes WHERE project_id = ? AND workspace_id = ?",
    ).run(parsed.data.projectId, parsed.data.workspaceId);
    const insExclude = db.prepare(
      "INSERT OR IGNORE INTO project_subscription_excludes (project_id, workspace_id, asset_id) VALUES (?, ?, ?)",
    );
    for (const id of skipSet) insExclude.run(parsed.data.projectId, parsed.data.workspaceId, id);

    const waitResult = await enqueueReconcileAndWait(deviceId, parsed.data.projectId, { force: true });

    if (waitResult.kind !== "ok") {
      // 失败:回滚订阅与跳过集,避免下一次 reconcile 把"用户没成功安装的订阅"再次推上去。
      if (prevSub) {
        db.prepare(
          "UPDATE project_subscriptions SET sync_policy = ?, target_tools = ? WHERE project_id = ? AND workspace_id = ?",
        ).run(prevSub.sync_policy, prevSub.target_tools, parsed.data.projectId, parsed.data.workspaceId);
      } else {
        db.prepare(
          "DELETE FROM project_subscriptions WHERE project_id = ? AND workspace_id = ?",
        ).run(parsed.data.projectId, parsed.data.workspaceId);
      }
      db.prepare(
        "DELETE FROM project_subscription_excludes WHERE project_id = ? AND workspace_id = ?",
      ).run(parsed.data.projectId, parsed.data.workspaceId);
      for (const id of prevExcludes) insExclude.run(parsed.data.projectId, parsed.data.workspaceId, id);
      const detail = waitResult.kind === "fail" ? waitResult.error : `已跳过:${waitResult.reason}`;
      return reply.status(409).send({
        success: false,
        error: `安装未完成:${detail}`,
      });
    }

    // 主动 ping project:scan 让 web 缓存即时对齐(failure-bounded:fs.watch 推送兜底)。
    requestFromAgent<LocalProjectState>(deviceId, "project:scan", { projectId: parsed.data.projectId })
      .catch(() => { /* 兜底由 watcher 推送补；不影响用户 */ });

    return {
      success: true,
      data: {
        plan: built.plan,
        result: {
          success: true,
          workspaceId: parsed.data.workspaceId,
          projectId: parsed.data.projectId,
          completedAt: new Date().toISOString(),
          filesWritten: waitResult.data.filesWritten,
          errors: [],
        },
      },
    };
  });
}
