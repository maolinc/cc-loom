/**
 * `loom status` —— 离线/在线均可输出状态摘要。
 *
 * 内容：
 * - Endpoint / DeviceId / Token（masked）
 * - 当前登录账号（向服务端 GET /api/auth/me 查询，便于比对浏览器登录用户）
 * - 本机 Agent 进程（pidfile + 探活）
 * - 服务端设备状态（GET /api/devices）
 * - 服务端项目列表（GET /api/projects），与本地缓存合并显示 lastInstalledAt
 * - 同步队列（GET /api/sync-outbox/stats）：ready / backoff / dead-letter
 * - 每个项目：本地 lock 安装 asset vs 服务端 workspace 当前成员 的 diff
 *   （应有未装 / 多装未在 workspace 内）
 *
 * 输出格式：
 *  - 默认：人类可读的色彩化文本
 *  - `--json`：结构化 JSON（StatusReport），适合脚本断言
 */
import type { Device, Project, SessionUser } from "@maolinc/cc-loom-shared";
import { getValidConfig } from "../lib/config.js";
import { api, ApiError } from "../lib/api.js";
import { listProjects, type LocalProjectRecord } from "../lib/projects.js";
import { readLock, isLegacyLock } from "../lib/locks.js";
import { findLikelyLoomAgentPids, isLikelyLoomAgentPid, isPidAlive, readPidFile } from "../lib/pidfile.js";
import { header, kv, info, tip, blank, color } from "../lib/ui.js";

interface OutboxStats {
  ready: number;
  backoff: number;
  deadLetter: number;
}

/** /api/workspaces/:id 返回的 workspace 详情中我们仅需 assets[].id / name。 */
interface WorkspaceLite {
  id: string;
  name: string;
  assets: { id: string; name: string }[];
}

interface ProjectSyncDiff {
  status:
    | "in-sync"          // lock 与 workspace 完全一致
    | "drift"            // lock 与 workspace 有差异（missing/extra > 0）
    | "no-lock"          // 项目绑定了 workspace 但本地无 lock
    | "legacy-lock"      // 旧格式 lock，需重装
    | "no-workspace"     // 项目未安装任何 workspace
    | "workspace-unreadable"; // workspace 私有或已删，无权读
  missing: { id: string; name: string }[]; // 应装未装
  extra: string[];                          // 本地多装（lock 里有但 workspace 没有）
}

interface ProjectStatusEntry {
  id: string;
  name: string;
  path: string;
  status: string;
  /** 显式订阅的工作空间 id 列表（ADR-0006 多空间）。 */
  workspaceIds: string[];
  /** 已解析的工作空间名（与 workspaceIds 对齐；读不到时为 null）。 */
  workspaceNames: (string | null)[];
  lastInstalledAt: string | null;
  sync: ProjectSyncDiff | null; // 取不到 server 状态时 null
}

interface StatusReport {
  endpoint: string;
  deviceId: string;
  tokenMasked: string;
  agent: {
    state: "not-running" | "running" | "stale-pidfile";
    pid?: number;
    startedAt?: string;
  };
  account: { email: string | null };
  server: { reachable: boolean; error: string | null };
  device: {
    found: boolean;
    online?: boolean;
    lastOnlineAt?: string;
  };
  outbox: OutboxStats | null;
  projects: ProjectStatusEntry[];
}

export interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(opts: StatusOptions = {}): Promise<void> {
  const config = getValidConfig();
  if (!config) {
    if (opts.json) {
      console.log(JSON.stringify({ loggedIn: false, hint: "loom login --endpoint <url> --token <token>" }));
      return;
    }
    info("未登录");
    tip("请执行: loom login --endpoint <url> --token <token>");
    return;
  }

  const report = await gather(config);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  renderText(report);
}

async function gather(config: { endpoint: string; token: string; deviceId: string }): Promise<StatusReport> {
  // 本机 Agent
  const pid = readPidFile();
  let agent: StatusReport["agent"];
  if (!pid) {
    const recovered = findLikelyLoomAgentPids([process.pid]);
    agent = recovered.length === 1
      ? { state: "running", pid: recovered[0] }
      : { state: "not-running" };
  } else if (!isPidAlive(pid.pid) || !isLikelyLoomAgentPid(pid.pid)) {
    agent = { state: "stale-pidfile", pid: pid.pid };
  } else {
    agent = { state: "running", pid: pid.pid, startedAt: pid.startedAt };
  }

  // 服务端拉取（任一失败都把 reachable 置 false）
  let serverDevices: Device[] | null = null;
  let serverProjects: Project[] | null = null;
  let me: SessionUser | null = null;
  let outboxStats: OutboxStats | null = null;
  let serverError: string | null = null;
  try {
    me = await api<SessionUser>(config, "/api/auth/me");
    serverDevices = await api<Device[]>(config, "/api/devices");
    serverProjects = await api<Project[]>(config, "/api/projects");
    outboxStats = await api<OutboxStats>(config, "/api/sync-outbox/stats").catch(() => null);
  } catch (err) {
    if (err instanceof ApiError) serverError = err.message;
    else serverError = (err as Error)?.message ?? String(err);
  }

  // 设备信息
  let device: StatusReport["device"] = { found: false };
  if (serverDevices && config.deviceId) {
    const my = serverDevices.find((d) => d.id === config.deviceId);
    if (my) {
      device = { found: true, online: my.status === "online", lastOnlineAt: my.lastOnlineAt };
    }
  }

  // 项目合并 + 每项目 sync diff
  // 服务端 /api/projects 返回当前账号下所有设备的项目，这里只保留本机设备注册的，
  // 避免多机器共用同一账号时 status 混入其它机器的项目。
  const localProjects = listProjects();
  const projectsById = new Map<string, { server?: Project; local?: LocalProjectRecord }>();
  for (const p of serverProjects ?? []) {
    if (p.deviceId !== config.deviceId) continue;
    projectsById.set(p.id, { server: p });
  }
  for (const p of localProjects) {
    const cur = projectsById.get(p.id) ?? {};
    projectsById.set(p.id, { ...cur, local: p });
  }

  const wsCache = new Map<string, WorkspaceLite | null>();
  const projects: ProjectStatusEntry[] = [];
  for (const { server, local } of projectsById.values()) {
    const id = (server?.id ?? local?.id)!;
    const name = server?.projectName ?? local?.projectName ?? "?";
    const path = server?.normalizedPath ?? local?.normalizedPath ?? "?";
    const status = server?.status ?? local?.status ?? "registered";
    const lock = readLock(id);
    // 多空间订阅：以 server 订阅为准，本地 lock（v3 subscriptions / 旧单值 workspaceId）兜底。
    const serverWsIds = (server?.subscriptions ?? [])
      .map((s) => s.workspaceId)
      .filter((x): x is string => !!x);
    const localWsIds = lock?.subscriptions
      ? lock.subscriptions.map((s) => s.workspaceId).filter((x): x is string => !!x)
      : (lock?.workspaceId ? [lock.workspaceId] : []);
    const wsIds = serverWsIds.length > 0 ? serverWsIds : localWsIds;
    const lastInstalledAt = local?.lastInstalledAt ?? null;

    let sync: ProjectSyncDiff | null = null;
    const workspaceNames: (string | null)[] = [];
    if (wsIds.length === 0) {
      sync = { status: "no-workspace", missing: [], extra: [] };
    } else if (!lock) {
      sync = { status: "no-lock", missing: [], extra: [] };
    } else if (isLegacyLock(lock)) {
      sync = { status: "legacy-lock", missing: [], extra: [] };
    } else if (me) {
      // 所有订阅空间的资产并集为期望集；共享能力（多空间同 id）天然去重。
      const desired = new Map<string, string>(); // assetId → name
      let unreadable = false;
      for (const wsId of wsIds) {
        const ws = await loadWorkspaceLite(config, wsId, wsCache);
        workspaceNames.push(ws?.name ?? null);
        if (!ws) { unreadable = true; continue; }
        for (const a of ws.assets) if (!desired.has(a.id)) desired.set(a.id, a.name);
      }
      if (unreadable && desired.size === 0) {
        sync = { status: "workspace-unreadable", missing: [], extra: [] };
      } else {
        const installed = new Set(Object.keys(lock.assets ?? {}));
        const missingIds = [...desired.keys()].filter((x) => !installed.has(x));
        const extra = [...installed].filter((x) => !desired.has(x));
        const missing = missingIds.map((aid) => ({
          id: aid,
          name: desired.get(aid) ?? aid.slice(0, 8),
        }));
        sync = {
          status: missing.length === 0 && extra.length === 0 ? "in-sync" : "drift",
          missing,
          extra,
        };
      }
    }

    projects.push({
      id, name, path, status, lastInstalledAt,
      workspaceIds: wsIds,
      workspaceNames,
      sync,
    });
  }

  return {
    endpoint: config.endpoint,
    deviceId: config.deviceId,
    tokenMasked: maskToken(config.token),
    agent,
    account: { email: me?.email ?? null },
    server: { reachable: serverError === null, error: serverError },
    device,
    outbox: outboxStats,
    projects,
  };
}

function renderText(r: StatusReport): void {
  header("Loom 状态");
  kv("Endpoint", color.cyan(r.endpoint));
  kv("Device ID", r.deviceId || color.dim("未绑定（执行 loom start）"));
  kv("Token", r.tokenMasked);

  // Agent
  if (r.agent.state === "not-running") {
    kv("Agent", color.dim("未运行"));
  } else if (r.agent.state === "running") {
    kv("Agent", `${color.green("运行中")} pid=${r.agent.pid}，自 ${r.agent.startedAt}`);
  } else {
    kv("Agent", `${color.yellow("pidfile 残留")} pid=${r.agent.pid} 已退出`);
    tip("建议执行 loom stop 清理");
  }

  // Server
  if (!r.server.reachable) {
    kv("服务端", `${color.red("不可达")} ${r.server.error ?? ""}`);
  }
  if (r.account.email) {
    kv("账号", color.green(r.account.email));
    tip("Web 端必须用同一邮箱登录才能看到该 CLI 注册的项目");
  }
  if (r.device.found) {
    const lbl = r.device.online ? color.green("在线") : color.gray("离线");
    kv("设备状态", `${lbl}（最近在线 ${formatRelative(r.device.lastOnlineAt)}）`);
  } else if (r.server.reachable && r.deviceId) {
    kv("设备状态", color.red("服务端无该设备记录"));
  }

  // Outbox
  if (r.outbox) {
    const parts = [
      `ready=${r.outbox.ready}`,
      `backoff=${r.outbox.backoff}`,
      r.outbox.deadLetter > 0
        ? color.red(`dead-letter=${r.outbox.deadLetter}`)
        : `dead-letter=${r.outbox.deadLetter}`,
    ];
    kv("同步队列", parts.join("  "));
    if (r.outbox.deadLetter > 0) {
      tip("有任务已耗尽 8 次重试，去 Web → 设置 → 同步队列 查看详情");
    }
  }

  blank();
  if (r.projects.length === 0) {
    info("已注册项目：无");
    return;
  }
  header("已注册项目");
  for (const p of r.projects) {
    const statusBadge = formatProjectStatus(p.status);
    console.log(`  ${color.bold(p.name)}  ${statusBadge}`);
    kv("ID", p.id);
    kv("Path", p.path);
    kv("Workspaces", p.workspaceIds.length === 0
      ? "(未安装)"
      : p.workspaceIds.map((id, i) => p.workspaceNames[i] ?? id).join(", "));
    kv("LastInstall", p.lastInstalledAt ? formatRelative(p.lastInstalledAt) : "—");

    if (p.sync) {
      switch (p.sync.status) {
        case "in-sync":
          kv("同步状态", color.green("✓ 与工作空间一致"));
          break;
        case "drift": {
          const parts: string[] = [];
          if (p.sync.missing.length > 0) parts.push(color.yellow(`应有未装 ${p.sync.missing.length}`));
          if (p.sync.extra.length > 0) parts.push(color.dim(`本地多装 ${p.sync.extra.length}`));
          kv("同步状态", parts.join("  "));
          if (p.sync.missing.length > 0) {
            const names = p.sync.missing.slice(0, 5).map((m) => m.name);
            kv("应有未装", color.yellow(names.join(", ") + (p.sync.missing.length > 5 ? "…" : "")));
          }
          break;
        }
        case "no-lock":
          kv("同步状态", color.yellow("无本地 lock，尚未安装"));
          break;
        case "legacy-lock":
          kv("同步状态", color.dim("旧格式 lock（重新安装即升级）"));
          break;
        case "workspace-unreadable":
          kv("同步状态", color.dim("工作空间不可读（已删除或无权访问）"));
          break;
        case "no-workspace":
          // 已经用 "(未安装)" 表达，不再赘述
          break;
      }
    }
    blank();
  }
}

/** 按需 GET /api/workspaces/:id，单 status 进程内缓存。私有/无权访问归一为 null。 */
async function loadWorkspaceLite(
  config: { endpoint: string; token: string; deviceId: string },
  workspaceId: string,
  cache: Map<string, WorkspaceLite | null>,
): Promise<WorkspaceLite | null> {
  if (cache.has(workspaceId)) return cache.get(workspaceId)!;
  try {
    const ws = await api<WorkspaceLite>(config, `/api/workspaces/${workspaceId}`);
    cache.set(workspaceId, ws);
    return ws;
  } catch {
    cache.set(workspaceId, null);
    return null;
  }
}

function formatProjectStatus(status: string): string {
  switch (status) {
    case "online": return color.green("[在线]");
    case "offline": return color.gray("[离线]");
    case "registered": return color.cyan("[已注册]");
    case "syncing": return color.yellow("[同步中]");
    case "dirty": return color.yellow("[有差异]");
    case "error": return color.red("[错误]");
    case "unregistered": return color.gray("[已注销]");
    default: return color.dim(`[${status}]`);
  }
}

function maskToken(t: string): string {
  if (!t) return "—";
  if (t.length <= 12) return t.slice(0, 4) + "…";
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

/** 把 ISO 时间转成"刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前"。失败时回退到原值。 */
function formatRelative(iso: string | undefined | null): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return iso; // 时钟漂移就直接显示原始时间
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}
