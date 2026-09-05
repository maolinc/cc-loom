import { useCallback, useEffect, useState } from "react";
import { Search, RefreshCw, RotateCcw, AlertTriangle } from "lucide-react";
import { api } from "../../api.js";
import Button from "../../components/Button.js";
import { useToast } from "../../components/Toast.js";
import type {
  AssetIndexStatus,
  EmbeddingSettings,
  EmbeddingProvider,
  SearchAssetIndexItem,
  SearchQueueCounts,
  SearchQueueItem,
} from "@maolinc/cc-loom-shared";

const inputCls =
  "w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";
const labelCls = "block text-xs font-medium text-text-secondary mb-1.5";

/** 统一时间格式（ISO → zh-CN 本地串；空→—）。 */
function formatTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN");
}

/** 字节数 → 人类可读（B/KB/MB）；0→—。 */
function formatBytes(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

type QueueTab = "all" | "pending" | "processing" | "ready" | "failed";
// 卡片即唯一导航（无重复文字 tab 栏）；卡片 label 与 STATUS_META 统一用「已索引」。
const CARD_LABEL: Record<QueueTab, string> = {
  all: "全部能力",
  pending: "排队中",
  processing: "处理中",
  ready: "已索引",
  failed: "失败",
};

export default function SearchTab() {
  return (
    <div className="max-w-4xl space-y-6">
      <div className="p-4 bg-white rounded-xl border border-surface-sunken flex gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-soft text-brand grid place-items-center shrink-0">
          <Search size={18} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-text-primary mb-1">语义搜索</h3>
          <p className="text-sm text-text-secondary leading-relaxed">
            为能力市场提供检索（FTS5 词法 + sqlite-vec 语义，可在「搜索模式」中按需开关、α 融合）。embedding 由服务端预计算，对匿名用户同样可用；语义不可用时自动降级为词法匹配。
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
  const [cfg, setCfg] = useState<EmbeddingSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [extraBodyText, setExtraBodyText] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await api.get<EmbeddingSettings>("/settings/search");
    if (res.success && res.data) {
      setCfg(res.data);
      setExtraBodyText(JSON.stringify(res.data.extraBody ?? {}, null, 2));
    } else {
      setError(res.error || "加载配置失败");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 切换 provider：服务端自动带出对应预设默认值
  const switchProvider = async (provider: EmbeddingProvider) => {
    setSaving(true);
    const res = await api.put<EmbeddingSettings>("/settings/search", { provider });
    setSaving(false);
    if (res.success && res.data) {
      setCfg(res.data);
      setExtraBodyText(JSON.stringify(res.data.extraBody ?? {}, null, 2));
      toast.success(`已切换到 ${provider} 预设`, "默认值已带入，可再调整");
    } else {
      toast.error("切换失败", res.error || "请稍后重试");
    }
  };

  const set = <K extends keyof EmbeddingSettings>(k: K, v: EmbeddingSettings[K]) =>
    setCfg((c) => (c ? { ...c, [k]: v } : c));

  const save = async () => {
    if (!cfg) return;
    setError("");
    let extraBody: Record<string, unknown>;
    try {
      extraBody = JSON.parse(extraBodyText || "{}");
    } catch {
      setError("额外请求体字段不是合法 JSON");
      return;
    }
    setSaving(true);
    const payload: Record<string, unknown> = {
      enabled: cfg.enabled,
      useLexical: cfg.useLexical,
      useSemantic: cfg.useSemantic,
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      dim: cfg.dim,
      passageInputType: cfg.passageInputType,
      queryInputType: cfg.queryInputType,
      extraBody,
      weights: cfg.weights,
      alpha: cfg.alpha,
      simThreshold: cfg.simThreshold,
      batchSize: cfg.batchSize,
      concurrency: cfg.concurrency,
      minIntervalMs: cfg.minIntervalMs,
      maxAttempts: cfg.maxAttempts,
      backoffBaseMs: cfg.backoffBaseMs,
    };
    if (apiKey.trim()) payload.apiKey = apiKey.trim();
    const res = await api.put<EmbeddingSettings>("/settings/search", payload);
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
    <div className="space-y-4">
      {/* 搜索模式：独立于 Embedding 配置，决定搜索走词法 / 语义 / 混合 */}
      <div className="p-5 bg-white rounded-xl border border-surface-sunken space-y-4">
        <h3 className="text-sm font-semibold text-text-primary">搜索模式</h3>
        <div>
          <p className="text-xs font-medium text-text-secondary mb-2">检索通路（至少保留一种）</p>
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={cfg.useLexical}
                onChange={(e) => {
                  // 不允许把最后一种模式也关掉（另一路已关时，本次保持勾选）
                  if (!e.target.checked && !cfg.useSemantic) return;
                  set("useLexical", e.target.checked);
                }}
                className="rounded border-gray-300 text-brand focus:ring-brand"
              />
              词法（FTS5 字面匹配）
            </label>
            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={cfg.useSemantic}
                onChange={(e) => {
                  if (!e.target.checked && !cfg.useLexical) return;
                  set("useSemantic", e.target.checked);
                }}
                className="rounded border-gray-300 text-brand focus:ring-brand"
              />
              语义（向量近义）
            </label>
          </div>
          <p className="text-xs text-text-muted mt-1.5">
            选择搜索时走哪条路；两者都选为混合（α 融合）。语义需先在下方启用向量存储并配置可用凭据，否则该路自动跳过、降级词法。
          </p>
        </div>
        <div>
          <label className={labelCls}>
            融合比 α{!(cfg.useLexical && cfg.useSemantic) && <span className="text-text-muted">（仅混合模式生效）</span>}
          </label>
          <input
            type="number"
            step="0.05"
            value={cfg.alpha}
            onChange={(e) => set("alpha", parseFloat(e.target.value) || 0)}
            className={inputCls}
            disabled={!(cfg.useLexical && cfg.useSemantic)}
          />
          <p className="text-xs text-text-muted mt-1.5">
            词法与语义的混合权重：finalScore = α×词法 + (1−α)×语义。仅在两种模式都启用时生效；调高→字面命中优先，调低→语义近义优先。
          </p>
        </div>

        <div className="pt-2 border-t border-surface-sunken space-y-3">
          <p className="text-xs font-medium text-text-secondary">
            语义路打分与召回{!cfg.useSemantic && <span className="text-text-muted">（仅启用语义路时生效）</span>}
          </p>
          <div>
            <p className="text-xs font-medium text-text-secondary mb-2">字段权重（归一化和≈1）</p>
            <div className="grid grid-cols-3 gap-4">
              {(["name", "tags", "description"] as const).map((f) => (
                <div key={f}>
                  <label className={labelCls}>{f}</label>
                  <input
                    type="number"
                    step="0.05"
                    value={cfg.weights[f]}
                    onChange={(e) =>
                      set("weights", { ...cfg.weights, [f]: parseFloat(e.target.value) || 0 })
                    }
                    className={inputCls}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-1.5">
              各字段向量化分数的权重；name 命中通常比 description 重要，可调高。
            </p>
          </div>

          <div>
            <label className={labelCls}>相似度阈值</label>
            <input
              type="number"
              step="0.05"
              value={cfg.simThreshold}
              onChange={(e) => set("simThreshold", parseFloat(e.target.value) || 0)}
              className={inputCls}
            />
            <p className="text-xs text-text-muted mt-1.5">
              语义召回门槛：cosine similarity 下限，低于此值的弱匹配不召回。调高更聚焦、调低更宽；0=不过滤。
            </p>
          </div>
        </div>
      </div>

      {/* Embedding 配置：向量存储与索引；并发 / 间隔 / 批量 / 重试等索引调度参数同属此处 */}
      <div className="p-5 bg-white rounded-xl border border-surface-sunken space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Embedding 配置</h3>
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
              className="rounded border-gray-300 text-brand focus:ring-brand"
            />
            启用向量存储（控制索引/存储，不决定搜索走哪条路）
          </label>
        </div>

        {!cfg.apiKeyConfigured && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>未配置 API Key，语义路不可用（词法路不受影响）。填入 Key 并保存后生效。</span>
          </div>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>提供商预设</label>
            <select
              value={cfg.provider}
              onChange={(e) => void switchProvider(e.target.value as EmbeddingProvider)}
              className={inputCls}
              disabled={saving}
            >
              <option value="nvidia">NVIDIA（默认免费）</option>
              <option value="openai">OpenAI 原生</option>
              <option value="custom">自定义</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>向量维度</label>
            <input
              type="number"
              value={cfg.dim}
              onChange={(e) => set("dim", parseInt(e.target.value, 10) || 0)}
              className={inputCls}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Base URL</label>
            <input value={cfg.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>模型名</label>
            <input value={cfg.model} onChange={(e) => set("model", e.target.value)} className={inputCls} />
          </div>
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

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>索引时 input_type（空=不发）</label>
            <input value={cfg.passageInputType} onChange={(e) => set("passageInputType", e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>查询时 input_type（空=不发）</label>
            <input value={cfg.queryInputType} onChange={(e) => set("queryInputType", e.target.value)} className={inputCls} />
          </div>
        </div>

        <div>
          <label className={labelCls}>额外请求体字段（JSON，如 NVIDIA 的 truncate）</label>
          <textarea
            value={extraBodyText}
            onChange={(e) => setExtraBodyText(e.target.value)}
            rows={3}
            className={inputCls + " font-mono"}
          />
        </div>

        <div className="grid grid-cols-5 gap-4">
          <div>
            <label className={labelCls}>并发数</label>
            <input type="number" value={cfg.concurrency} onChange={(e) => set("concurrency", parseInt(e.target.value, 10) || 1)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>最小间隔(ms)</label>
            <input type="number" value={cfg.minIntervalMs} onChange={(e) => set("minIntervalMs", parseInt(e.target.value, 10) || 0)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>批量大小</label>
            <input type="number" value={cfg.batchSize} onChange={(e) => set("batchSize", parseInt(e.target.value, 10) || 1)} className={inputCls} />
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

        <div className="flex justify-end pt-2">
          <Button variant="primary" loading={saving} onClick={save}>保存配置</Button>
        </div>
      </div>
    </div>
  );
}

// ============ 索引管理块 ============

function QueueSection() {
  const toast = useToast();
  const [counts, setCounts] = useState<SearchQueueCounts | null>(null);
  const [tab, setTab] = useState<QueueTab>("all");
  const [items, setItems] = useState<SearchQueueItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const pageSize = 20;

  const loadCounts = useCallback(async () => {
    const res = await api.get<SearchQueueCounts>("/settings/search/queue");
    if (res.success && res.data) setCounts(res.data);
  }, []);

  const loadItems = useCallback(async (status: QueueTab, p: number) => {
    setLoading(true);
    const res = await api.get<{ items: SearchQueueItem[]; total: number }>(
      `/settings/search/queue/items?status=${status}&page=${p}&pageSize=${pageSize}`,
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
  // 「全部能力」tab 走独立视图，无需加载队列项
  useEffect(() => { if (tab !== "all") void loadItems(tab, page); }, [tab, page, loadItems]);

  const requeueAll = async () => {
    setActing(true);
    const res = await api.post<{ requeued: number }>("/settings/search/requeue", { all: true });
    setActing(false);
    if (res.success && res.data) {
      toast.success(`已重新入队 ${res.data.requeued} 项`, "全部能力刷新，搜索不受影响");
      void refreshAll();
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const retryFailed = async () => {
    setActing(true);
    const res = await api.post<{ retried: number }>("/settings/search/retry-failed", {});
    setActing(false);
    if (res.success && res.data) {
      toast.success(`已重试 ${res.data.retried} 项失败任务`);
      void refreshAll();
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const requeueOne = async (assetId: string) => {
    const res = await api.post<{ requeued: number }>("/settings/search/requeue", { assetIds: [assetId] });
    if (res.success) {
      toast.success("已重新入队");
      void refreshAll();
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const rebuild = async () => {
    if (!window.confirm("重建将清空全部向量并按当前模型重新生成，期间搜索降级为词法模式。确认继续？")) return;
    setActing(true);
    const res = await api.post<{ queued: number }>("/settings/search/rebuild", { confirm: true });
    setActing(false);
    if (res.success && res.data) {
      toast.success(`已触发重建`, `入队 ${res.data.queued} 项，期间词法降级`);
      void refreshAll();
    } else {
      toast.error("重建失败", res.error || "请稍后重试");
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
        <h3 className="text-sm font-semibold text-text-primary">索引管理</h3>
        <div className="flex gap-2">
          <Button variant="subtle" size="sm" leftIcon={<RefreshCw size={14} />} onClick={() => void refreshAll()}>刷新</Button>
          <Button variant="secondary" size="sm" onClick={() => void requeueAll()} loading={acting} disabled={!!counts?.rebuilding}>全部重新入队</Button>
          <Button variant="secondary" size="sm" leftIcon={<RotateCcw size={14} />} onClick={() => void retryFailed()}>重试失败</Button>
          <Button variant="danger" size="sm" onClick={() => void rebuild()} loading={acting}>重建索引</Button>
        </div>
      </div>

      {counts?.rebuilding && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          <AlertTriangle size={14} className="shrink-0" />
          <span>
            重建中（搜索已降级为词法模式）：已重建 {counts.ready} / {counts.total}
          </span>
        </div>
      )}

      {/* 状态卡片（唯一导航，无重复文字 tab 栏） */}
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
          {tab === "ready" ? "所有能力已索引" : "暂无项目"}
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
                    {tab === "failed" ? (it.lastError ?? "—") : (it.embedModel ?? "—")}
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

// ============ 全部能力索引视图 ============

const STATUS_META: Record<AssetIndexStatus, { label: string; cls: string }> = {
  ready: { label: "已索引", cls: "text-green-700 bg-green-50" },
  pending: { label: "排队中", cls: "text-amber-700 bg-amber-50" },
  processing: { label: "处理中", cls: "text-blue-700 bg-blue-50" },
  failed: { label: "失败", cls: "text-red-700 bg-red-50" },
  unindexed: { label: "未索引", cls: "text-text-muted bg-surface-card" },
};

/**
 * 全部能力索引视图（「全部能力」tab）。
 * 列出全部可见能力（含未索引项），按 name 搜索、按最近成功构建时间排序，
 * 逐能力可「重新构建」。已软删/adopted 不出现（后端已过滤）。
 */
function AllAssetsView({ refreshTick, onMutate }: { refreshTick: number; onMutate: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<SearchAssetIndexItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalSize, setTotalSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const pageSize = 20;

  // name 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), order });
    if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
    const res = await api.get<{ items: SearchAssetIndexItem[]; total: number; totalSizeBytes: number }>(
      `/settings/search/assets?${params.toString()}`,
    );
    setLoading(false);
    if (res.success && res.data) {
      setItems(res.data.items);
      setTotal(res.data.total);
      setTotalSize(res.data.totalSizeBytes);
    }
  }, [page, order, debouncedQ]);

  useEffect(() => { void load(); }, [load, refreshTick]);

  const rebuildOne = async (it: SearchAssetIndexItem) => {
    setActingId(it.assetId);
    const res = await api.post<{ requeued: number }>("/settings/search/requeue", { assetIds: [it.assetId] });
    setActingId(null);
    if (res.success) {
      toast.success(`已重新构建「${it.name}」`, "已入队，旧向量继续服务");
      void load();
      onMutate();
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const totalPages = Math.ceil(total / pageSize) || 1;

  return (
    <div className="space-y-3">
      {/* 工具栏：搜索 + 排序 + 汇总 */}
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
          构建时间 {order === "desc" ? "最新优先 ↓" : "最早优先 ↑"}
        </Button>
        <span className="text-xs text-text-muted ml-auto">
          索引汇总（全部能力）：<span className="font-medium text-text-secondary">{formatBytes(totalSize)}</span>
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
                <th className="py-2 font-medium">索引状态</th>
                <th className="py-2 font-medium">索引大小</th>
                <th className="py-2 font-medium">最近成功构建时间</th>
                <th className="py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const meta = STATUS_META[it.status];
                return (
                  <tr key={it.assetId} className="border-b border-gray-50">
                    <td className="py-2 text-text-primary">{it.name}</td>
                    <td className="py-2 text-text-secondary">{it.type}</td>
                    <td className="py-2">
                      <span
                        title={it.status === "failed" ? it.lastError ?? undefined : undefined}
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${meta.cls}`}
                      >
                        {meta.label}
                      </span>
                    </td>
                    <td className="py-2 text-text-muted text-xs">{formatBytes(it.indexSizeBytes)}</td>
                    <td className="py-2 text-text-muted text-xs">{formatTime(it.processedAt)}</td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={actingId === it.assetId}
                        onClick={() => void rebuildOne(it)}
                      >
                        重新构建
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
