/**
 * Wire 协议 v2 的 outbox 消费 worker：消费 `sync_outbox_v2`（per-project 折叠队列），
 * 调 `reconcileProject` 算最新 plan，向 CLI 发 `reconcile` op，成功后写
 * `project_installed_assets`（v2 含义：server 期望的安装全集 = 本次 plan 的
 * enabled ∪ disabled）。
 *
 * 见 docs/refactor/wire-protocol-unification.md §3.3 / §3.5。
 *
 * 设计要点：
 *  - 入队（enqueueReconcile）只写表，不触发立即派发。调用方决定何时 wake。
 *  - per-device 串行（同 v1）。每行处理一个 projectId（无 add/remove 区分）。
 *  - 出队前校验：项目存在 + agent 在线。policy=locked 的兜底 skip 只对 auto-sync
 *    入队（force=0）生效；显式手动操作（install / capabilities add·toggle·remove）
 *    入队时带 force=1，即使项目 locked 也照常 reconcile——locked 只阻断自动同步，
 *    不阻断用户对本项目的显式操作（product-functional-doc §9.1）。入队点
 *    （routes/auto-sync）另负责"locked 不入队"的前置过滤，这里仅兜底。
 *  - 失败重试：与 v1 同退避表（1s / 5s / 30s / 2m / 10m / 30m / 1h / 4h）。
 *  - payload 不存表：worker 在 exec 时按当前 DB 状态重新计算 plan——保证发出去
 *    的总是最新内容；折叠后多次入队也只产生一次最终 plan。
 *  - migrationDisabled：CLI 在首次 v1→v2 lock 迁移时随响应捎回；server 写入
 *    `project_disabled_assets` 完成 toggle 状态收口。详见 §6.3。
 */
import type {
  ReconcilePlan,
  TargetTool,
  WsReconcileResponseData,
} from "@maolinc/cc-loom-shared";
import { db } from "../db/index.js";
import { getAgent, requestFromAgent } from "../ws/gateway.js";
import { reconcileProject } from "./reconcile-plan.js";
import { refreshCredentialUsages } from "./credential-usage-hook.js";

interface OutboxV2Row {
  id: number;
  device_id: string;
  project_id: string;
  attempts: number;
  scheduled_at: string;
  force: number;
}

/** 指数退避表（毫秒）；同 v1。 */
const BACKOFF_MS = [1_000, 5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 4 * 60 * 60_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

/** per-device 串行消费链。 */
const deviceQueue = new Map<string, Promise<void>>();
/** per-device 已挂起的延迟唤醒 timer。 */
const delayedWakeTimers = new Map<string, NodeJS.Timeout>();

/**
 * `enqueueReconcileAndWait` 等待者注册表:per-project 一组 resolver,本批次 outbox
 * 行完成(success / skip / dead-letter)时一次性触发,带回结果。
 *
 * 用途:`/api/install/execute` 这种 web 同步请求场景,需要在 HTTP 应答前知道
 * 这次 reconcile 的最终结果。普通 enqueue 不附 resolver,无副作用。
 */
type ReconcileWaitResult =
  | { kind: "ok"; data: WsReconcileResponseData }
  | { kind: "skip"; reason: string }
  | { kind: "fail"; error: string };

/**
 * 等待者：rowId 是调用方自己入队那行的 id。仅当完成行的 id >= rowId 时才触发——
 * 保证 resolve 的 reconcile 其 plan 是在调用方写完权威状态**之后**计算的。
 * 否则竞态：先前入队的行（如 path 分发触发的 reconcile）以「状态写入前」的
 * plan 完成时会提前 resolve 等待者（install 返回了但文件还没写）。
 */
const waiters = new Map<string, Array<{ rowId: number; fn: (r: ReconcileWaitResult) => void }>>();

function flushWaiters(projectId: string, result: ReconcileWaitResult, completedRowId: number): void {
  const arr = waiters.get(projectId);
  if (!arr || arr.length === 0) return;
  const ready = arr.filter((w) => completedRowId >= w.rowId);
  if (ready.length === 0) return;
  const rest = arr.filter((w) => completedRowId < w.rowId);
  if (rest.length === 0) waiters.delete(projectId);
  else waiters.set(projectId, rest);
  for (const { fn } of ready) {
    try { fn(result); } catch { /* ignore resolver error */ }
  }
}

/**
 * 入队一条 reconcile 任务。同 project 未完成项被折叠（partial unique index）。
 * 调用方负责决定何时 `wakeDeviceV2`。
 *
 * `opts.force`：显式手动操作（install / capabilities add·toggle·remove）传 true，
 * 使该行即使项目 sync_policy=locked 也照常被 worker 处理。auto-sync 不传（默认
 * false），locked 项目由 worker 兜底 skip。
 */
export function enqueueReconcile(
  deviceId: string,
  projectId: string,
  opts?: { force?: boolean },
): number {
  const now = new Date().toISOString();
  const force = opts?.force ? 1 : 0;
  let rowId = 0;
  const tx = db.transaction(() => {
    db.prepare(
      "DELETE FROM sync_outbox_v2 WHERE project_id = ? AND completed_at IS NULL",
    ).run(projectId);
    const info = db.prepare(
      `INSERT INTO sync_outbox_v2 (device_id, project_id, attempts, scheduled_at, created_at, force)
       VALUES (?, ?, 0, ?, ?, ?)`,
    ).run(deviceId, projectId, now, now, force);
    rowId = Number(info.lastInsertRowid);
  });
  tx();
  return rowId;
}

/**
 * 入队一条 reconcile 任务,并等待其完成。给 `/api/install/execute` 等需要"操作
 * 完成才回应"的 web 同步请求用。
 *
 * - 立即调 `wakeDeviceV2(deviceId)`,不要求调用方再 wake。
 * - 超时 `timeoutMs` 内若 worker 未触达结果,resolve 为 fail。注意:这不会取消
 *   后台 worker 的实际执行,只是 HTTP 调用方不再等。
 * - 多个调用方对同一 projectId 同时等,**共享一次** reconcile 结果。
 */
export function enqueueReconcileAndWait(
  deviceId: string,
  projectId: string,
  opts?: { force?: boolean; timeoutMs?: number },
): Promise<ReconcileWaitResult> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    // 先入队拿 rowId，再注册等待者：只有 id >= rowId 的完成行才能 resolve 本次等待
    // （见 waiters 注释的竞态说明）。
    const rowId = enqueueReconcile(deviceId, projectId, { force: opts?.force });
    let settled = false;
    const onResult = (r: ReconcileWaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const entry = { rowId, fn: onResult };
    const arr = waiters.get(projectId) ?? [];
    arr.push(entry);
    waiters.set(projectId, arr);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 把自己从等待表里摘掉,避免后续 worker 完成时空回调
      const cur = waiters.get(projectId);
      if (cur) {
        const next = cur.filter((f) => f !== entry);
        if (next.length === 0) waiters.delete(projectId);
        else waiters.set(projectId, next);
      }
      resolve({ kind: "fail", error: `reconcile 等待超时 (${timeoutMs}ms)` });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    wakeDeviceV2(deviceId);
  });
}

/**
 * 唤醒某设备的 v2 消费链：已有 run 则串到末尾；否则新启动一个。
 * agent 离线时立即退出，等下次 onAgentConnect 再唤醒。
 */
export function wakeDeviceV2(deviceId: string): void {
  const t = delayedWakeTimers.get(deviceId);
  if (t) {
    clearTimeout(t);
    delayedWakeTimers.delete(deviceId);
  }
  const prev = deviceQueue.get(deviceId) ?? Promise.resolve();
  const next = prev.then(() => runDevice(deviceId)).catch((e) => {
    console.warn(`[outbox-v2] runDevice 未捕获异常 device=${deviceId} err=${(e as Error)?.message ?? e}`);
  });
  deviceQueue.set(deviceId, next);
}

function scheduleDelayedWake(deviceId: string, ms: number): void {
  const old = delayedWakeTimers.get(deviceId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    delayedWakeTimers.delete(deviceId);
    wakeDeviceV2(deviceId);
  }, ms);
  if (typeof t.unref === "function") t.unref();
  delayedWakeTimers.set(deviceId, t);
}

async function runDevice(deviceId: string): Promise<void> {
  while (true) {
    if (!getAgent(deviceId)) return;

    const row = db
      .prepare(
        `SELECT id, device_id, project_id, attempts, scheduled_at, force
           FROM sync_outbox_v2
          WHERE device_id = ?
            AND completed_at IS NULL
            AND scheduled_at <= ?
            AND attempts < ?
          ORDER BY id ASC
          LIMIT 1`,
      )
      .get(deviceId, new Date().toISOString(), MAX_ATTEMPTS) as OutboxV2Row | undefined;

    if (!row) return;

    const result = await processRow(row);
    if (result.status === "ok") {
      // 成功：写账本（enabled∪disabled）+ 写迁移过来的 disabled，再标记 completed。
      applySuccess(row.project_id, result);
      db.prepare("UPDATE sync_outbox_v2 SET completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
      flushWaiters(row.project_id, { kind: "ok", data: result.response }, row.id);
    } else if (result.status === "skip") {
      db.prepare("UPDATE sync_outbox_v2 SET completed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), row.id);
      console.warn(
        `[outbox-v2] skip project=${row.project_id} reason=${result.reason ?? ""}`,
      );
      flushWaiters(row.project_id, { kind: "skip", reason: result.reason }, row.id);
    } else {
      const attempts = row.attempts + 1;
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
      const nextAt = new Date(Date.now() + delay).toISOString();
      db.prepare(
        "UPDATE sync_outbox_v2 SET attempts = attempts + 1, last_error = ?, scheduled_at = ? WHERE id = ?",
      ).run(result.error ?? null, nextAt, row.id);
      console.warn(
        `[outbox-v2] fail project=${row.project_id} attempts=${attempts} next=${nextAt} err=${result.error ?? ""}`,
      );
      if (attempts >= MAX_ATTEMPTS) {
        console.warn(`[outbox-v2] dead-letter project=${row.project_id}`);
        flushWaiters(row.project_id, { kind: "fail", error: result.error }, row.id);
        continue; // 下次循环 attempts<MAX 过滤掉
      }
      // 同步等待者不应被无限拖住:首次 fail 即 resolve,等不到下次 retry。
      // 后续 retry 仍然在后台进行,只是 HTTP 调用方先返回了。
      flushWaiters(row.project_id, { kind: "fail", error: result.error }, row.id);
      scheduleDelayedWake(deviceId, delay);
      return;
    }
  }
}

interface ProcessOk {
  status: "ok";
  plan: ReconcilePlan;
  response: WsReconcileResponseData;
}
interface ProcessSkip { status: "skip"; reason: string }
interface ProcessFail { status: "fail"; error: string }
type ProcessResult = ProcessOk | ProcessSkip | ProcessFail;

async function processRow(row: OutboxV2Row): Promise<ProcessResult> {
  const p = db.prepare("SELECT id, device_id, status FROM projects WHERE id = ?")
    .get(row.project_id) as
    | { id: string; device_id: string; status: string }
    | undefined;
  if (!p) return { status: "skip", reason: "project gone" };
  if (p.status === "unregistered") return { status: "skip", reason: "unregistered" };
  if (p.device_id !== row.device_id) return { status: "skip", reason: "device rebound" };
  // policy=locked 兜底：仅对 auto-sync 入队（force=0）跳过。显式手动操作（force=1，
  // 如 install / capabilities add·toggle·remove）即使全部订阅 locked 也照常 reconcile——
  // locked 只阻断自动同步，不阻断用户对本项目的显式操作。入队点（auto-sync）另做
  // 前置过滤，这里仅兜底。多订阅模型（ADR-0006）：任一订阅（含隐式）为 auto 即放行。
  if (!row.force) {
    const anyAuto = db.prepare(
      "SELECT 1 FROM project_subscriptions WHERE project_id = ? AND sync_policy = 'auto' LIMIT 1",
    ).get(row.project_id);
    if (!anyAuto) return { status: "skip", reason: "policy=locked" };
  }

  const built = reconcileProject(row.project_id);
  if ("error" in built) {
    // 数据层面错误（项目缺失等）—— 直接丢弃，不消耗 attempts。
    return { status: "skip", reason: built.error };
  }

  const payload = {
    projectId: row.project_id,
    subscriptions: built.subscriptions,
    targetTools: built.targetTools as TargetTool[],
    plan: built.plan,
  };

  try {
    const response = await requestFromAgent<WsReconcileResponseData>(
      row.device_id, "reconcile", payload,
    );
    return { status: "ok", plan: built.plan, response };
  } catch (e) {
    return { status: "fail", error: (e as Error)?.message ?? String(e) };
  }
}

/**
 * 成功收到 CLI 响应后的副作用：
 *  1. 重写 `project_installed_assets` = 本次 plan 的 enabled ∪ disabled assetId 集（v2 含义）。
 *  2. 若响应携带 `migrationDisabled`（CLI v1→v2 lock 首次迁移），把对应 (assetId, tool)
 *     写入 `project_disabled_assets`，完成 toggle 状态收口。
 */
function applySuccess(projectId: string, ok: ProcessOk): void {
  const now = new Date().toISOString();
  const present = new Set<string>();
  for (const a of ok.plan.enabled) present.add(a.assetId);
  for (const a of ok.plan.disabled) present.add(a.assetId);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM project_installed_assets WHERE project_id = ?").run(projectId);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO project_installed_assets (project_id, asset_id, installed_at) VALUES (?, ?, ?)",
    );
    for (const id of present) ins.run(projectId, id, now);

    // 迁移 disabled 状态：CLI 首次 v2 reconcile 时把旧 lock 中的 disabled 集合捎回。
    const mig = ok.response.migrationDisabled;
    if (Array.isArray(mig) && mig.length > 0) {
      const insD = db.prepare(
        "INSERT OR IGNORE INTO project_disabled_assets (project_id, asset_id, tool, disabled_at) VALUES (?, ?, ?, ?)",
      );
      for (const m of mig) insD.run(projectId, m.assetId, m.tool, now);
    }
  });
  tx();

  // reconcile-end 钩子（ADR-0003 决策 8）：刷新本项目的凭据使用记录。
  // 用本次 plan 的 enabled∪disabled assetId 全集 + 各自的 path 绑定，insert-only 超集 +
  // 移除已不再装的 asset 行。能力集级与能力级流程都收敛到这里，不可能漏某个路径。
  refreshCredentialUsages(projectId);
}
