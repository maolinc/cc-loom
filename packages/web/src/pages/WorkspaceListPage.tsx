import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Boxes, Plus } from "lucide-react";
import { api } from "../api.js";
import type { Workspace } from "@maolinc/cc-loom-shared";
import WorkspaceCard from "../components/WorkspaceCard.js";
import DetailPanel from "../components/DetailPanel.js";
import SearchInput from "../components/SearchInput.js";
import Button from "../components/Button.js";
import { CardGridSkeleton, ErrorState, EmptyState } from "../components/PageState.js";
import { useRevalidateOnActive } from "../components/KeepAlive.js";
import { useAuth } from "../hooks/useAuth.js";

type WorkspaceRow = Workspace & { assetIds?: string[]; assetTypes?: string[] };

export default function WorkspaceListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // 页面切回刷新时递增，强制 DetailPanel 重新挂载拉取最新数据（CLI push 等外部变更）。
  const [refreshKey, setRefreshKey] = useState(0);

  const fetch = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (user && visibility) params.set("visibility", visibility);
    if (search) params.set("query", search);
    params.set("pageSize", "30");
    setLoading(true);
    setError(null);
    const res = await api.get<WorkspaceRow[]>(`/workspaces?${params}`, signal);
    if (signal?.aborted) return;
    setLoading(false);
    if (res.success && res.data) {
      setWorkspaces(res.data);
    } else {
      setWorkspaces([]);
      setError(res.error || "无法加载工作空间");
    }
  }, [user, visibility, search]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(controller.signal);
    return () => controller.abort();
  }, [fetch]);

  // 缓存页：从其它导航切回时静默刷新，保证新建/编辑后的工作空间及时出现。
  // 同时递增 refreshKey，让已打开的 DetailPanel 重新挂载、拉取最新数据。
  useRevalidateOnActive(() => { void fetch(); setRefreshKey((k) => k + 1); });

  const filtering = !!search || (!!user && !!visibility);
  const createWorkspace = () => navigate(user ? "/workspaces/new" : "/login");

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <SearchInput
            query={search}
            onQueryChange={setSearch}
            showTypes={false}
            placeholder="搜索工作空间…"
            manualSubmit
            loading={loading}
            extraFilters={
              user ? (
                <div className="flex gap-1.5">
                  {["", "public", "private"].map((v) => (
                    <button
                      key={v}
                      onClick={() => setVisibility(v)}
                      className={`px-3.5 h-7 rounded-full text-xs font-medium transition-colors ${
                        visibility === v ? "bg-brand text-white shadow-sm shadow-brand/25" : "bg-surface-sunken text-text-secondary hover:bg-gray-200 hover:text-text-primary"
                      }`}
                    >
                      {v === "" ? "全部" : v === "public" ? "公开" : "个人"}
                    </button>
                  ))}
                </div>
              ) : undefined
            }
          />
        </div>
      </div>

      {loading && workspaces.length === 0 ? (
        <CardGridSkeleton count={6} />
      ) : error && workspaces.length === 0 ? (
        <ErrorState message={error} onRetry={fetch} />
      ) : workspaces.length === 0 ? (
        <EmptyState
          icon={<Boxes className="w-8 h-8" />}
          title={filtering ? "没有匹配的工作空间" : "还没有工作空间"}
          description={filtering ? "试试更换关键词或可见性筛选。" : user ? "创建一个工作空间，把常用能力组合在一起，一次性安装到项目。" : "公开工作空间会展示在这里，登录后可以创建和管理自己的空间。"}
          action={
            filtering ? (
              <Button variant="secondary" onClick={() => { setSearch(""); setVisibility(""); }}>清除筛选</Button>
            ) : (
              <Button variant="primary" leftIcon={<Plus size={15} />} onClick={createWorkspace}>新建工作空间</Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
          {workspaces.map((w, i) => (
            <WorkspaceCard
              key={w.id}
              workspace={w}
              onClick={() => setSelected(w.id)}
              className="animate-card-in"
              style={{ animationDelay: `${Math.min(i, 12) * 35}ms` }}
            />
          ))}
        </div>
      )}

      {selected && (
        <DetailPanel key={`${selected}-${refreshKey}`} type="workspace" id={selected} onClose={() => { setSelected(null); void fetch(); }} />
      )}
    </div>
  );
}
