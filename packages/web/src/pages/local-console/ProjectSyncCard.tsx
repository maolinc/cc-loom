/**
 * 项目级同步队列卡片 —— 跟着选中的项目走，放在本地控制台右栏。
 *
 * 设计：
 *  - 始终轮询 stats（5s），轻量；列表仅在展开时拉取。
 *  - 折叠态只显示一行摘要（同步队列 · N 待重试 / M 退避中 / 空闲）。
 *  - dead-letter > 0 时自动展开并标红，提示人工介入。
 *  - 行操作：立即重试（attempts 归零）、丢弃；项目级 dead-letter 全部重试。
 */
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { api } from "../../api.js";
import { useToast } from "../../components/Toast.js";

interface OutboxRow {
  id: number;
  deviceId: string;
  projectId: string;
  projectName: string;
  attempts: number;
  lastError: string | null;
  scheduledAt: string;
  createdAt: string;
  deadLetter: boolean;
}

interface OutboxStats {
  ready: number;
  backoff: number;
  deadLetter: number;
}

const POLL_MS = 5_000;

export default function ProjectSyncCard({
  projectId,
  isActive,
}: {
  projectId: string;
  isActive: boolean;
}) {
  const toast = useToast();
  const [stats, setStats] = useState<OutboxStats | null>(null);
  const [rows, setRows] = useState<OutboxRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pendingRow, setPendingRow] = useState<Map<number, "retry" | "discard">>(new Map());
  const [retryingAllDead, setRetryingAllDead] = useState(false);
  const [refreshingList, setRefreshingList] = useState(false);

  const statsRef = useRef<OutboxStats | null>(null);
  statsRef.current = stats;

  // ---- 轮询 stats ----
  useEffect(() => {
    if (!isActive) return;
    let stopped = false;
    const tick = async () => {
      const res = await api.get<OutboxStats>(`/projects/${projectId}/sync-outbox/stats`);
      if (stopped) return;
      if (res.success && res.data) {
        setStats(res.data);
        setErr(null);
      } else {
        setErr(res.error || "加载同步状态失败");
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [projectId, isActive]);

  // dead-letter 出现时自动展开
  useEffect(() => {
    if (stats && stats.deadLetter > 0 && !expanded) setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats?.deadLetter]);

  // 切换项目时重置
  useEffect(() => {
    setStats(null);
    setRows(null);
    setErr(null);
    setExpanded(false);
  }, [projectId]);

  // ---- 展开时拉列表 ----
  const fetchRows = async () => {
    setRefreshingList(true);
    const res = await api.get<OutboxRow[]>(`/projects/${projectId}/sync-outbox`);
    setRefreshingList(false);
    if (res.success && res.data) {
      setRows(res.data);
      setErr(null);
    } else {
      setErr(res.error || "加载同步队列失败");
    }
  };

  useEffect(() => {
    if (expanded) void fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, projectId]);

  const markRow = (id: number, kind: "retry" | "discard" | null) => {
    setPendingRow((m) => {
      const next = new Map(m);
      if (kind) next.set(id, kind);
      else next.delete(id);
      return next;
    });
  };

  const handleRetry = async (row: OutboxRow) => {
    markRow(row.id, "retry");
    const res = await api.post<{ id: number }>(`/sync-outbox/${row.id}/retry`);
    markRow(row.id, null);
    if (!res.success) {
      toast.error("重试失败", res.error || "未知错误");
      return;
    }
    toast.success("已重置重试", row.projectName);
    void fetchRows();
  };

  const handleDiscard = async (row: OutboxRow) => {
    markRow(row.id, "discard");
    const res = await api.delete<{ id: number }>(`/sync-outbox/${row.id}`);
    markRow(row.id, null);
    if (!res.success) {
      toast.error("丢弃失败", res.error || "未知错误");
      return;
    }
    toast.info("已丢弃任务", row.projectName);
    void fetchRows();
  };

  const handleRetryAllDead = async () => {
    if (!stats || stats.deadLetter === 0) return;
    if (!window.confirm(`将复活全部 ${stats.deadLetter} 条 dead-letter 任务，确认继续？`)) return;
    setRetryingAllDead(true);
    const res = await api.post<{ revived: number }>(`/projects/${projectId}/sync-outbox/retry-dead`);
    setRetryingAllDead(false);
    if (!res.success) {
      toast.error("批量重试失败", res.error || "未知错误");
      return;
    }
    toast.success("已批量复活", `共重置 ${res.data?.revived ?? 0} 条任务`);
    void fetchRows();
  };

  const total = stats ? stats.ready + stats.backoff + stats.deadLetter : 0;
  const hasDead = (stats?.deadLetter ?? 0) > 0;
  const hasActivity = total > 0; // 有任何待处理任务才以卡片形式呈现，否则收敛为一行摘要

  // 摘要文案
  const summary = (() => {
    if (!stats) return "同步中…";
    if (total === 0) return "已同步";
    const parts: string[] = [];
    if (stats.ready) parts.push(`${stats.ready} 待重试`);
    if (stats.backoff) parts.push(`${stats.backoff} 退避中`);
    if (stats.deadLetter) parts.push(`${stats.deadLetter} 重试耗尽`);
    return parts.join(" · ");
  })();

  const statusIcon = hasDead ? (
    <AlertTriangle className="w-3.5 h-3.5 text-red-600 shrink-0" />
  ) : hasActivity ? (
    <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
  ) : (
    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
  );

  // 空闲态：一行紧凑摘要，无卡片边框/阴影/大留白，不挤压本地镜像区。
  if (!hasActivity && !expanded) {
    return (
      <div className="mb-4 flex items-center gap-1.5 text-[11px] text-text-muted">
        {statusIcon}
        <span>同步队列</span>
        <span className="text-text-secondary">{summary}</span>
      </div>
    );
  }

  return (
    <div className={`relative rounded-xl border shadow-card p-4 mb-5 ${hasDead ? "border-red-200 bg-red-50/40" : "border-surface-sunken bg-white"}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          {statusIcon}
          <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">同步队列</span>
          <span className={`text-sm truncate ${hasDead ? "text-red-600 font-medium" : "text-text-secondary"}`}>
            {summary}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasDead && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                void handleRetryAllDead();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  void handleRetryAllDead();
                }
              }}
              className="text-xs px-2 py-1 rounded-md bg-red-600 text-white hover:bg-red-700 inline-flex items-center gap-1.5"
            >
              {retryingAllDead && <Loader2 className="w-3 h-3 animate-spin" />}
              全部重试
            </span>
          )}
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-text-muted" />
          ) : (
            <ChevronRight className="w-4 h-4 text-text-muted" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-4">
          {err && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              {err}
            </div>
          )}
          {rows === null ? (
            <div className="text-sm text-text-muted py-6 text-center">加载中…</div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 py-8 text-text-muted">
              <CheckCircle2 className="w-6 h-6 text-emerald-500" />
              <p className="text-sm">队列清空，所有变更已同步</p>
            </div>
          ) : (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 bg-surface-card text-[11px] text-text-muted">
                <span>未完成任务</span>
                <button
                  type="button"
                  onClick={() => void fetchRows()}
                  disabled={refreshingList}
                  className="inline-flex items-center gap-1 hover:text-text-primary disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${refreshingList ? "animate-spin" : ""}`} />
                  刷新
                </button>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-surface-card text-text-muted text-xs">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">重试</th>
                    <th className="text-left px-3 py-2 font-medium">下次重试</th>
                    <th className="text-left px-3 py-2 font-medium">最近错误</th>
                    <th className="text-right px-3 py-2 font-medium">动作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const pending = pendingRow.get(r.id);
                    return (
                      <tr key={r.id} className="border-t border-surface-sunken">
                        <td className="px-3 py-2">
                          <span className={r.deadLetter ? "text-red-600 font-medium" : "text-text-muted"}>
                            {r.attempts}
                            {r.deadLetter ? " (dead-letter)" : ""}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-text-muted text-xs">{formatTime(r.scheduledAt)}</td>
                        <td className="px-3 py-2 text-xs text-text-muted max-w-[20em] truncate" title={r.lastError ?? ""}>
                          {r.lastError ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleRetry(r)}
                              disabled={!!pending}
                              title="立即重试（attempts 归零）"
                              className="text-xs px-2 py-1 rounded-md border border-gray-200 hover:bg-surface-card disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                            >
                              {pending === "retry" ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <RefreshCw className="w-3 h-3" />
                              )}
                              重试
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDiscard(r)}
                              disabled={!!pending}
                              title="丢弃该任务（不再尝试同步该项目）"
                              className="text-xs px-2 py-1 rounded-md border border-gray-200 text-text-muted hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                            >
                              {pending === "discard" ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <X className="w-3 h-3" />
                              )}
                              丢弃
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff > 0 ? "马上" : "刚刚";
  const mins = Math.round(abs / 60_000);
  if (mins < 60) return diff > 0 ? `${mins} 分钟后` : `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diff > 0 ? `${hours} 小时后` : `${hours} 小时前`;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
