import { useEffect, useState } from "react";
import { api } from "../../api.js";
import AddSourceDialog from "../../components/AddSourceDialog.js";
import DeleteSourceDialog from "../../components/DeleteSourceDialog.js";
import SyncLogPanel from "../../components/SyncLogPanel.js";
import Button from "../../components/Button.js";
import { useToast } from "../../components/Toast.js";
import { useAuth } from "../../hooks/useAuth.js";
import { formatAuthorName } from "../../lib/assetDisplay.js";
import { POLL_INTERVAL_OPTIONS } from "@maolinc/cc-loom-shared";

interface SourceRow {
  id: string;
  displayName: string;
  repoUrl: string;
  kind: string;
  addedBy: string;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  assetCount: number;
  capabilitySetCount: number;
}

function StatusDot({ status }: { status: string | null }) {
  const cls =
    status === "success" ? "bg-emerald-500"
    : status === "failed" ? "bg-red-500"
    : status === "running" ? "bg-amber-500 animate-pulse"
    : "bg-gray-300";
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}

export default function MarketplaceTab() {
  const toast = useToast();
  const { user } = useAuth();
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [pollMinutes, setPollMinutes] = useState(360);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<SourceRow | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    const [list, settings] = await Promise.all([
      api.get<SourceRow[]>("/marketplaces"),
      api.get<{ pollIntervalMinutes: number }>("/settings/marketplace"),
    ]);
    if (list.success && list.data) setSources(list.data);
    else toast.error("加载来源失败", list.error || "请稍后重试");
    if (settings.success && settings.data) setPollMinutes(settings.data.pollIntervalMinutes);
    setLoading(false);
  };

  useEffect(() => { void reload(); }, []);

  const updatePoll = async (mins: number) => {
    const prev = pollMinutes;
    setPollMinutes(mins);
    const res = await api.put<any>("/settings/marketplace", { pollIntervalMinutes: mins });
    if (res.success) {
      toast.success("已更新同步频率");
    } else {
      setPollMinutes(prev);
      toast.error("更新失败", res.error || "请稍后重试");
    }
  };

  const refresh = async (id: string, name: string) => {
    setRefreshing(id);
    const res = await api.post<any>(`/marketplaces/${id}/refresh`);
    setRefreshing(null);
    if (res.success) {
      toast.success("已触发同步", name);
      void reload();
    } else {
      toast.error("同步失败", res.error || "请稍后重试");
    }
  };

  const formatInterval = (m: number) => {
    if (m < 60) return `${m} 分钟`;
    if (m < 1440) return `${m / 60} 小时`;
    return `${m / 1440} 天`;
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-text-secondary">自动同步：每</span>
          <select
            value={pollMinutes}
            onChange={(e) => updatePoll(parseInt(e.target.value, 10))}
            className="px-2 py-1.5 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          >
            {POLL_INTERVAL_OPTIONS.map((m) => (
              <option key={m} value={m}>{formatInterval(m)}</option>
            ))}
          </select>
          <span className="text-text-secondary">拉取一次</span>
        </div>
        <Button variant="primary" size="sm" onClick={() => setAdding(true)}>+ 添加来源</Button>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">加载中…</p>
      ) : sources.length === 0 ? (
        <div className="p-8 text-center text-sm text-text-muted bg-white border border-surface-sunken rounded-xl">
          还没有添加任何来源。点击「添加来源」开始。
        </div>
      ) : (
        <div className="space-y-2">
          {sources.map((s) => {
            // 仅导入者本人或管理员可删除；其他人看不到删除按钮。
            const canDelete = !!user && (s.addedBy === user.email || user.role === "admin");
            return (
            <div key={s.id} className="p-4 bg-white border border-surface-sunken rounded-xl hover:border-gray-200 transition-colors">
              <div className="flex items-start justify-between mb-2">
                <div className="min-w-0">
                  <div className="font-medium text-text-primary flex items-center gap-2">
                    <StatusDot status={s.lastSyncStatus} /> {s.displayName}
                  </div>
                  <div className="text-xs text-text-muted truncate">{s.repoUrl}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button variant="secondary" size="sm" loading={refreshing === s.id} onClick={() => refresh(s.id, s.displayName)}>
                    刷新
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setLogsFor(s.id)}>日志</Button>
                  {canDelete && (
                    <Button variant="secondary" size="sm" className="!text-red-500 hover:!bg-red-50" onClick={() => setDeleting(s)}>删除</Button>
                  )}
                </div>
              </div>
              <div className="text-xs text-text-secondary">
                由 <span className="text-text-primary font-medium">{formatAuthorName(s.addedBy)}</span> 导入
                {" · "}{s.assetCount} 个能力{s.capabilitySetCount > 0 ? ` · ${s.capabilitySetCount} 个能力集` : ""}
                {s.lastSyncAt && ` · 上次同步 ${new Date(s.lastSyncAt).toLocaleString("zh-CN")}`}
              </div>
              {s.lastSyncStatus === "failed" && s.lastError && (
                <div className="mt-2 text-xs text-red-500 line-clamp-2">{s.lastError}</div>
              )}
            </div>
            );
          })}
        </div>
      )}

      {adding && <AddSourceDialog onClose={() => setAdding(false)} onAdded={reload} />}
      {deleting && <DeleteSourceDialog source={deleting} onClose={() => setDeleting(null)} onRemoved={reload} />}
      {logsFor && <SyncLogPanel sourceId={logsFor} onClose={() => setLogsFor(null)} />}
    </div>
  );
}
