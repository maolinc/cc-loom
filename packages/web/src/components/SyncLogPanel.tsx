import { useEffect, useState } from "react";
import { api } from "../api.js";
import Modal from "./Modal.js";

interface SyncLog {
  id: string;
  trigger: string;
  status: string;
  added: number;
  updated: number;
  removed: number;
  durationMs: number;
  error: string | null;
  startedAt: string;
}

interface Props {
  sourceId: string;
  onClose: () => void;
}

function StatusBadge({ status }: { status: string }) {
  const ok = status === "success";
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${
        ok ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
      {ok ? "成功" : "失败"}
    </span>
  );
}

export default function SyncLogPanel({ sourceId, onClose }: Props) {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<SyncLog[]>(`/marketplaces/${sourceId}/logs`).then((res) => {
      if (res.success && res.data) setLogs(res.data);
      setLoading(false);
    });
  }, [sourceId]);

  return (
    <Modal title="同步日志" subtitle="最近的拉取记录与变更统计。" width="w-[640px]" onClose={onClose}>
      {loading ? (
        <p className="text-sm text-text-muted py-6 text-center">加载中…</p>
      ) : logs.length === 0 ? (
        <p className="text-sm text-text-muted py-6 text-center">暂无同步记录</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-text-muted">
            <tr className="border-b border-surface-sunken">
              <th className="text-left py-2 font-medium">时间</th>
              <th className="text-left py-2 font-medium">触发</th>
              <th className="text-left py-2 font-medium">结果</th>
              <th className="text-left py-2 font-medium">变更</th>
              <th className="text-right py-2 font-medium">耗时</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-b border-gray-50 align-top">
                <td className="py-2.5 text-text-secondary whitespace-nowrap">
                  {new Date(l.startedAt).toLocaleString("zh-CN")}
                </td>
                <td className="py-2.5 text-text-secondary">{l.trigger}</td>
                <td className="py-2.5">
                  <StatusBadge status={l.status} />
                  {l.status !== "success" && l.error && (
                    <div className="text-[11px] text-red-500 mt-1 max-w-[180px] line-clamp-2">{l.error}</div>
                  )}
                </td>
                <td className="py-2.5 text-text-secondary tabular-nums">
                  <span className="text-emerald-600">+{l.added}</span>{" "}
                  <span className="text-amber-600">~{l.updated}</span>{" "}
                  <span className="text-red-500">-{l.removed}</span>
                </td>
                <td className="py-2.5 text-right text-text-muted tabular-nums whitespace-nowrap">
                  {(l.durationMs / 1000).toFixed(1)}s
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
