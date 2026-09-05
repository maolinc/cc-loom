import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Plus } from "lucide-react";
import { api } from "../api.js";
import type { Asset } from "@maolinc/cc-loom-shared";
import AssetCard from "../components/AssetCard.js";
import DetailPanel from "../components/DetailPanel.js";
import SearchInput from "../components/SearchInput.js";
import Button from "../components/Button.js";
import { CardGridSkeleton, ErrorState, EmptyState } from "../components/PageState.js";
import { useRevalidateOnActive } from "../components/KeepAlive.js";
import { useAuth } from "../hooks/useAuth.js";

const PAGE_SIZE = 30;

interface SourceOption {
  id: string;
  displayName: string;
  count: number;
}

export default function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [visibility, setVisibility] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);

  const fetchPage = useCallback(async (nextPage: number, append: boolean, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (search) params.set("query", search);
    if (typeFilter) params.set("type", typeFilter);
    if (sourceFilter) params.set("source", sourceFilter);
    if (user && visibility) params.set("visibility", visibility);
    params.set("page", String(nextPage));
    params.set("pageSize", String(PAGE_SIZE));
    setLoading(true);
    setError(null);
    const res = await api.get<Asset[]>(`/assets?${params}`, signal);
    if (signal?.aborted) return;
    setLoading(false);
    if (!res.success || !res.data) {
      if (!append) setAssets([]);
      setError(res.error || "无法加载能力列表");
      return;
    }
    setAssets((prev) => (append ? [...prev, ...res.data!] : res.data!));
    setPage(nextPage);
    const t = (res as unknown as { total?: number }).total;
    if (typeof t === "number") setTotal(t);
  }, [search, typeFilter, sourceFilter, visibility, user]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchPage(1, false, controller.signal);
    return () => controller.abort();
  }, [fetchPage]);

  // 来源清单：随可见性（登录态）变化重新拉取，供「按来源筛选」下拉使用。
  useEffect(() => {
    const controller = new AbortController();
    api.get<SourceOption[]>("/assets/sources", controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      if (res.success && res.data) setSources(res.data);
    });
    return () => controller.abort();
  }, [user]);

  // 缓存页：从能力编辑器等页面返回时静默刷新，保证新建/编辑后的能力及时出现。
  useRevalidateOnActive(() => { void fetchPage(1, false); });

  const hasMore = assets.length < total;
  const firstLoad = loading && assets.length === 0;
  const filtering = !!search || !!typeFilter || !!sourceFilter || (!!user && !!visibility);
  const createAsset = () => navigate(user ? "/assets/new" : "/login");

  return (
    <div>
      <div className="mb-6">
        <SearchInput
          query={search}
          onQueryChange={setSearch}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          placeholder="搜索能力名称、描述或标签…"
          stacked
          manualSubmit
          loading={loading}
          extraFilters={
            <>
              {sources.length > 0 && (
                <select
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-gray-200 text-text-secondary hover:border-gray-300 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/15 cursor-pointer max-w-[180px]"
                  title="按来源筛选"
                >
                  <option value="">全部来源</option>
                  <option value="local">本地创建</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>{s.displayName} ({s.count})</option>
                  ))}
                </select>
              )}
              {user && (
                <div className="inline-flex items-center rounded-full bg-surface-sunken p-0.5">
                  {["", "public", "private"].map((v) => (
                    <button
                      key={v}
                      onClick={() => setVisibility(v)}
                      className={`px-3 h-6 rounded-full text-xs font-medium transition-colors ${
                        visibility === v ? "bg-white text-text-primary shadow-sm" : "text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      {v === "" ? "全部" : v === "public" ? "公开" : "个人"}
                    </button>
                  ))}
                </div>
              )}
            </>
          }
        />
      </div>

      {/* States */}
      {firstLoad ? (
        <CardGridSkeleton />
      ) : error && assets.length === 0 ? (
        <ErrorState message={error} onRetry={() => fetchPage(1, false)} />
      ) : assets.length === 0 ? (
        <EmptyState
          icon={<Sparkles className="w-8 h-8" />}
          title={filtering ? "没有匹配的能力" : "还没有能力"}
          description={filtering ? "试试更换关键词或清除类型筛选。" : user ? "创建你的第一个 Skill、Rule、MCP 或 Hook，开始搭建工作空间。" : "公开能力会展示在这里，登录后可以创建和管理自己的能力。"}
          action={
            filtering ? (
              <Button variant="secondary" onClick={() => { setSearch(""); setTypeFilter(""); setVisibility(""); setSourceFilter(""); }}>清除筛选</Button>
            ) : (
              <Button variant="primary" leftIcon={<Plus size={15} />} onClick={createAsset}>创建能力</Button>
            )
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 auto-rows-fr">
            {assets.map((asset, i) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                onClick={() => setSelectedAsset(asset.id)}
                className="animate-card-in"
                style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}
              />
            ))}
          </div>

          <div className="mt-8 flex flex-col items-center gap-2">
            <div className="text-xs text-text-muted tabular-nums">
              已显示 {assets.length} / {total} 个能力
            </div>
            {hasMore && (
              <Button variant="secondary" loading={loading} onClick={() => void fetchPage(page + 1, true)}>
                加载更多
              </Button>
            )}
          </div>
        </>
      )}

      {selectedAsset && (
        <DetailPanel
          type="asset"
          id={selectedAsset}
          onClose={() => {
            setSelectedAsset(null);
            void fetchPage(1, false);
          }}
        />
      )}
    </div>
  );
}
