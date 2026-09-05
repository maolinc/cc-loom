import { useCallback, useEffect, useState } from "react";
import { Search, RefreshCw, RotateCcw, AlertTriangle, Sparkles } from "lucide-react";
import { api } from "../../api.js";
import Button from "../../components/Button.js";
import { useToast } from "../../components/Toast.js";
import type {
  AssetType,
  AiGenSettings,
  AiGenProvider,
  AiInfoAssetIndexItem,
  AiInfoQueueCounts,
  AiInfoQueueItem,
  AiInfoIndexStatus,
} from "@maolinc/cc-loom-shared";

const inputCls =
  "w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
const labelCls = "block text-xs font-medium text-text-secondary mb-1.5";

function formatTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN");
}

type QueueTab = "all" | "pending" | "processing" | "ready" | "failed";
const CARD_LABEL: Record<QueueTab, string> = {
  all: "全部能力",
  pending: "排队中",
  processing: "处理中",
  ready: "已生成",
  failed: "失败",
};

export default function AiInfoTab() {
  return (
    <div className="max-w-4xl space-y-6">
      <div className="p-4 bg-white rounded-xl border border-surface-sunken flex gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-soft text-brand grid place-items-center shrink-0">
          <Sparkles size={18} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-text-primary mb-1">能力信息生成</h3>
          <p className="text-sm text-text-secondary leading-relaxed">
            后台为已落库能力自动补全空缺的别名、标签、描述与鉴权声明（补缺口：只填空字段，不重算已有内容）。能力创建/编辑/导入后入队，由服务级 AI 配置驱动；导入数据源的能力同样适用。
          </p>
        </div>
      </div>
      <ConfigSection />
      <QueueSection />
    </div>
  );
}

// ============ 配置块 ============

function ConfigSection() {
  const toast = useToast();
  const [cfg, setCfg] = useState<AiGenSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await api.get<AiGenSettings>("/settings/ai-gen");
    if (res.success && res.data) setCfg(res.data);
    else setError(res.error || "加载配置失败");
  }, []);

  useEffect(() => { void load(); }, [load]);

  const switchProvider = async (provider: AiGenProvider) => {
    setSaving(true);
    const res = await api.put<AiGenSettings>("/settings/ai-gen", { provider });
    setSaving(false);
    if (res.success && res.data) {
      setCfg(res.data);
      toast.success(`已切换到 ${provider} 预设`, "默认值已带入，可再调整");
    } else {
      toast.error("切换失败", res.error || "请稍后重试");
    }
  };

  const set = <K extends keyof AiGenSettings>(k: K, v: AiGenSettings[K]) =>
    setCfg((c) => (c ? { ...c, [k]: v } : c));

  const save = async () => {
    if (!cfg) return;
    setError("");
    setSaving(true);
    const payload: Record<string, unknown> = {
      enabled: cfg.enabled,
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      overwrite: cfg.overwrite,
      concurrency: cfg.concurrency,
      minIntervalMs: cfg.minIntervalMs,
      maxAttempts: cfg.maxAttempts,
      backoffBaseMs: cfg.backoffBaseMs,
    };
    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    const res = await api.put<AiGenSettings>("/settings/ai-gen", payload);
    setSaving(false);
    if (res.success && res.data) {
      setCfg(res.data);
      setApiKey("");
      toast.success("配置已保存");
    } else {
      setError(res.error || "保存失败");
    }
  };

  if (!cfg) return <p className="text-sm text-text-muted">加载中...</p>;

  return (
    <div className="p-5 bg-white rounded-xl border border-surface-sunken space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">生成配置</h3>
        <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
            className="rounded border-gray-300 text-brand focus:ring-brand"
          />
          启用后台生成（关闭后 worker 停止消费、写入不再入队）
        </label>
      </div>

      {!cfg.apiKeyConfigured && (
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>未配置 API Key，生成不可用。填入 Key 并保存后生效。</span>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>提供商预设</label>
          <select
            value={cfg.provider}
            onChange={(e) => void switchProvider(e.target.value as AiGenProvider)}
            className={inputCls}
            disabled={saving}
          >
            <option value="openai">OpenAI 兼容（默认）</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>模型名</label>
          <input value={cfg.model} onChange={(e) => set("model", e.target.value)} className={inputCls} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>Base URL</label>
          <input value={cfg.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>
            API Key {cfg.apiKeyConfigured && <span className="text-text-muted">（已配置，留空保持不变）</span>}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={cfg.apiKeyConfigured ? "••••••••" : "填写 API Key"}
            className={inputCls}
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div>
          <label className={labelCls}>并发数</label>
          <input type="number" value={cfg.concurrency} onChange={(e) => set("concurrency", parseInt(e.target.value, 10) || 1)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>最小间隔(ms)</label>
          <input type="number" value={cfg.minIntervalMs} onChange={(e) => set("minIntervalMs", parseInt(e.target.value, 10) || 0)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>最大尝试次数</label>
          <input type="number" value={cfg.maxAttempts} onChange={(e) => set("maxAttempts", parseInt(e.target.value, 10) || 1)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>退避基数(ms)</label>
          <input type="number" value={cfg.backoffBaseMs} onChange={(e) => set("backoffBaseMs", parseInt(e.target.value, 10) || 0)} className={inputCls} />
        </div>
      </div>

      <div className="pt-3 border-t border-surface-sunken">
        <label className="flex items-start gap-2 text-sm text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={cfg.overwrite}
            onChange={(e) => set("overwrite", e.target.checked)}
            className="mt-0.5 rounded border-gray-300 text-brand focus:ring-brand"
          />
          <span>
            <span className="font-medium text-text-primary">直接覆盖原字段</span>
            <span className="block text-xs text-text-muted mt-0.5">
              打开后，worker 处理时无条件覆盖别名/标签/描述/鉴权声明（含新建能力首次处理、含 auth.bindings），而非补缺口。配合「全部重新入队」可用更好模型/提示重算全部能力。注意：会覆盖人工已填内容，鉴权声明也会被重建（可能删去人工加的绑定或重加人工删的）。
            </span>
          </span>
        </label>
      </div>
      <p className="text-xs text-text-muted">
        服务级配置（仅管理员），供后台队列使用；与编辑页「AI 生成」按钮的每用户配置相互独立。并发默认 1 规避接口限频。
      </p>

      <div className="flex justify-end pt-2">
        <Button variant="primary" loading={saving} onClick={save}>保存配置</Button>
      </div>
    </div>
  );
}

// ============ 队列管理块 ============

function QueueSection() {
  const toast = useToast();
  const [counts, setCounts] = useState<AiInfoQueueCounts | null>(null);
  const [tab, setTab] = useState<QueueTab>("all");
  const [items, setItems] = useState<AiInfoQueueItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const pageSize = 20;

  const loadCounts = useCallback(async () => {
    const res = await api.get<AiInfoQueueCounts>("/settings/ai-gen/queue");
    if (res.success && res.data) setCounts(res.data);
  }, []);

  const loadItems = useCallback(async (status: QueueTab, p: number) => {
    setLoading(true);
    const res = await api.get<{ items: AiInfoQueueItem[]; total: number }>(
      `/settings/ai-gen/queue/items?status=${status}&page=${p}&pageSize=${pageSize}`,
    );
    setLoading(false);
    if (res.success && res.data) {
      setItems(res.data.items);
      setTotal(res.data.total);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await loadCounts();
    if (tab !== "all") await loadItems(tab, page);
    else setRefreshTick((t) => t + 1);
  }, [loadCounts, loadItems, tab, page]);

  useEffect(() => { void loadCounts(); }, [loadCounts]);
  useEffect(() => { if (tab !== "all") void loadItems(tab, page); }, [tab, page, loadItems]);

  const requeueAll = async () => {
    setActing(true);
    const res = await api.post<{ requeued: number }>("/settings/ai-gen/requeue", { all: true });
    setActing(false);
    if (res.success && res.data) {
      toast.success(`已重新入队 ${res.data.requeued} 项`, "重扫所有能力的空缺字段");
      void refreshAll();
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const retryFailed = async () => {
    setActing(true);
    const res = await api.post<{ retried: number }>("/settings/ai-gen/retry-failed", {});
    setActing(false);
    if (res.success && res.data) {
      toast.success(`已重试 ${res.data.retried} 项失败任务`);
      void refreshAll();
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const requeueOne = async (assetId: string) => {
    const res = await api.post<{ requeued: number }>("/settings/ai-gen/requeue", { assetIds: [assetId] });
    if (res.success) {
      toast.success("已重新入队");
      void refreshAll();
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const totalPages = Math.ceil(total / pageSize) || 1;
  const cards: { key: QueueTab; color: string }[] = [
    { key: "all", color: "text-text-primary" },
    { key: "pending", color: "text-text-primary" },
    { key: "processing", color: "text-blue-600" },
    { key: "ready", color: "text-green-600" },
    { key: "failed", color: "text-red-600" },
  ];
  const countOf = (k: QueueTab): number | undefined =>
    k === "all" ? counts?.assets : counts?.[k];

  return (
    <div className="p-5 bg-white rounded-xl border border-surface-sunken">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">生成管理</h3>
        <div className="flex gap-2">
          <Button variant="subtle" size="sm" leftIcon={<RefreshCw size={14} />} onClick={() => void refreshAll()}>刷新</Button>
          <Button variant="secondary" size="sm" onClick={() => void requeueAll()} loading={acting}>全部重新入队</Button>
          <Button variant="secondary" size="sm" leftIcon={<RotateCcw size={14} />} onClick={() => void retryFailed()}>重试失败</Button>
        </div>
      </div>

      {/* 状态卡片（唯一导航） */}
      <div className="grid grid-cols-5 gap-3 mb-5">
        {cards.map((c) => (
          <button
            key={c.key}
            onClick={() => { setTab(c.key); setPage(1); }}
            className={`p-3 rounded-lg border text-center transition-colors ${
              tab === c.key ? "border-brand bg-brand-soft" : "border-surface-sunken hover:border-gray-200"
            }`}
          >
            <div className={`text-xl font-semibold ${counts ? c.color : "text-text-muted"}`}>
              {counts ? countOf(c.key) : "—"}
            </div>
            <div className="text-xs text-text-muted mt-0.5">{CARD_LABEL[c.key]}</div>
          </button>
        ))}
      </div>

      {/* 列表 */}
      {tab === "all" ? (
        <AllAssetsView refreshTick={refreshTick} onMutate={() => void loadCounts()} />
      ) : loading ? (
        <div className="py-10 text-center text-sm text-text-muted">加载中...</div>
      ) : items.length === 0 ? (
        <div className="py-10 text-center text-sm text-text-muted">
          {tab === "ready" ? "所有能力已生成" : "暂无项目"}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-surface-sunken">
                <th className="py-2 font-medium">能力</th>
                <th className="py-2 font-medium">类型</th>
                <th className="py-2 font-medium">{tab === "ready" ? "完成时间" : "入队时间"}</th>
                <th className="py-2 font-medium">尝试</th>
                <th className="py-2 font-medium">{tab === "failed" ? "失败原因" : "模型"}</th>
                <th className="py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const time = tab === "ready" ? (it.processedAt ?? it.queuedAt) : it.queuedAt;
                return (
                <tr key={it.assetId} className="border-b border-gray-50">
                  <td className="py-2 text-text-primary">{it.name}</td>
                  <td className="py-2 text-text-secondary">{it.type}</td>
                  <td className="py-2 text-text-muted text-xs">{formatTime(time)}</td>
                  <td className="py-2 text-text-secondary">{it.attempts}</td>
                  <td className="py-2 text-text-muted text-xs max-w-xs truncate">
                    {tab === "failed" ? (it.lastError ?? "—") : (it.genModel ?? "—")}
                  </td>
                  <td className="py-2 text-right">
                    {tab !== "processing" && (
                      <Button variant="ghost" size="sm" onClick={() => void requeueOne(it.assetId)}>
                        {tab === "failed" ? "重试" : "重新入队"}
                      </Button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页 */}
      {tab !== "all" && total > pageSize && (
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
          <span className="text-xs text-text-muted">{page} / {totalPages}</span>
          <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      )}
    </div>
  );
}

// ============ 全部能力生成视图 ============

const STATUS_META: Record<AiInfoIndexStatus, { label: string; cls: string }> = {
  ready: { label: "已生成", cls: "text-green-700 bg-green-50" },
  pending: { label: "排队中", cls: "text-amber-700 bg-amber-50" },
  processing: { label: "处理中", cls: "text-blue-700 bg-blue-50" },
  failed: { label: "失败", cls: "text-red-700 bg-red-50" },
  unindexed: { label: "未入队", cls: "text-text-muted bg-surface-card" },
};

const TYPE_LABEL: Record<AssetType, string> = {
  skill: "Skill", rule: "Rule", mcp: "MCP", hook: "Hook", command: "Command", agent: "Agent",
};

/** 待补字段标签：展示该能力当前哪些字段为空（worker 会补的缺口）。 */
function EmptyFields({ it }: { it: AiInfoAssetIndexItem }) {
  const fields: string[] = [];
  if (it.aliasEmpty) fields.push("别名");
  if (it.tagsEmpty) fields.push("标签");
  if (it.descriptionEmpty) fields.push("描述");
  if (it.authEmpty) fields.push("鉴权");
  if (fields.length === 0) return <span className="text-xs text-text-muted">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {fields.map((f) => (
        <span key={f} className="inline-block px-1.5 py-0.5 rounded text-xs bg-amber-50 text-amber-700">{f}</span>
      ))}
    </div>
  );
}

function AllAssetsView({ refreshTick, onMutate }: { refreshTick: number; onMutate: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AiInfoAssetIndexItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const pageSize = 20;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), order });
    if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
    const res = await api.get<{ items: AiInfoAssetIndexItem[]; total: number }>(
      `/settings/ai-gen/assets?${params.toString()}`,
    );
    setLoading(false);
    if (res.success && res.data) {
      setItems(res.data.items);
      setTotal(res.data.total);
    }
  }, [page, order, debouncedQ]);

  useEffect(() => { void load(); }, [load, refreshTick]);

  const regenOne = async (it: AiInfoAssetIndexItem) => {
    setActingId(it.assetId);
    const res = await api.post<{ requeued: number }>("/settings/ai-gen/requeue", { assetIds: [it.assetId] });
    setActingId(null);
    if (res.success) {
      toast.success(`已重新生成「${it.name}」`, "已入队，重扫空缺字段");
      void load();
      onMutate();
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const totalPages = Math.ceil(total / pageSize) || 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="按能力名搜索"
            className={inputCls + " pl-9"}
          />
        </div>
        <Button
          variant="subtle"
          size="sm"
          onClick={() => { setOrder((o) => (o === "desc" ? "asc" : "desc")); setPage(1); }}
        >
          生成时间 {order === "desc" ? "最新优先 ↓" : "最早优先 ↑"}
        </Button>
        <span className="text-xs text-text-muted ml-auto">
          共 <span className="font-medium text-text-secondary">{total}</span> 个能力
        </span>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-text-muted">加载中...</div>
      ) : items.length === 0 ? (
        <div className="py-10 text-center text-sm text-text-muted">
          {debouncedQ.trim() ? "无匹配能力" : "暂无能力"}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted border-b border-surface-sunken">
                <th className="py-2 font-medium">能力</th>
                <th className="py-2 font-medium">类型</th>
                <th className="py-2 font-medium">生成状态</th>
                <th className="py-2 font-medium">待补字段</th>
                <th className="py-2 font-medium">最近生成时间</th>
                <th className="py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const meta = STATUS_META[it.status];
                return (
                  <tr key={it.assetId} className="border-b border-gray-50">
                    <td className="py-2 text-text-primary">{it.name}</td>
                    <td className="py-2 text-text-secondary">{TYPE_LABEL[it.type]}</td>
                    <td className="py-2">
                      <span
                        title={it.status === "failed" ? it.lastError ?? undefined : undefined}
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${meta.cls}`}
                      >
                        {meta.label}
                      </span>
                    </td>
                    <td className="py-2"><EmptyFields it={it} /></td>
                    <td className="py-2 text-text-muted text-xs">{formatTime(it.processedAt)}</td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={actingId === it.assetId}
                        onClick={() => void regenOne(it)}
                      >
                        重新生成
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > pageSize && (
        <div className="flex items-center justify-end gap-3">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
          <span className="text-xs text-text-muted">{page} / {totalPages}</span>
          <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      )}
    </div>
  );
}
