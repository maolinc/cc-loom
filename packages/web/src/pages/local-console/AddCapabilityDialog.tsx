/**
 * 「+ 添加能力」对话框：从 Asset 库挑选若干 asset，调
 * `POST /api/projects/:id/capabilities/add` 追加到当前已安装 CapabilitySet 的本地镜像。
 *
 * 设计：复用 `AssetBrowser` 多选交互；只在弹层里壳，搜索/筛选/列表渲染全部委派。
 */
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type { Asset } from "@maolinc/cc-loom-shared";
import { api } from "../../api.js";
import AssetBrowser from "../../components/AssetBrowser.js";
import Button from "../../components/Button.js";

interface Props {
  projectId: string;
  /** 当前已安装 CapabilitySet 的 asset 集合（避免重复添加；UI 上仍然显示，但禁止再选）。 */
  alreadyInstalledIds: string[];
  onClose: () => void;
  onAdded: () => void;
  /** 标题（默认「添加能力到当前 CapabilitySet」）。 */
  title?: string;
  /** 副标题说明。 */
  subtitle?: string;
  /**
   * 自定义提交逻辑：返回错误信息字符串表示失败，返回 null 表示成功。
   * 未传时走默认的 `POST /capabilities/add`（增量添加到当前 CapabilitySet）。
   */
  submit?: (assetIds: string[]) => Promise<string | null>;
}

export default function AddCapabilityDialog({
  projectId,
  alreadyInstalledIds,
  onClose,
  onAdded,
  title = "添加能力到当前 CapabilitySet",
  subtitle = "从 Asset 库挑选若干能力，追加写入到本地厂商目录并更新 lock。",
  submit: submitOverride,
}: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 搜索/类型/来源筛选走服务端：与 CapabilitySetComposerPage 保持一致。
  // 单页 100 条 + updated_at DESC 排序下，纯客户端按 type 过滤会让排序靠后的
  // 类型“看起来为空”——这也是之前“不管点哪个 tab 都只显示 skill”的根因。
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams();
    if (searchQuery) params.set("query", searchQuery);
    if (typeFilter) params.set("type", typeFilter);
    if (sourceFilter) params.set("source", sourceFilter);
    params.set("pageSize", "100");
    api.get<Asset[]>(`/assets?${params}`, controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      if (res.success && res.data) setAssets(res.data);
      setLoading(false);
    });
    return () => controller.abort();
  }, [searchQuery, typeFilter, sourceFilter]);

  const installedSet = useMemo(() => new Set(alreadyInstalledIds), [alreadyInstalledIds]);
  // 已安装的能力交给 AssetBrowser 的 lockedIds 处理：显示为「已安装」、勾选但不可取消。
  // 本会话新选的能力用 selectedIds 表示。

  const submit = async () => {
    if (selectedIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    if (submitOverride) {
      const err = await submitOverride(selectedIds);
      setSubmitting(false);
      if (err) {
        setError(err);
        return;
      }
      onAdded();
      onClose();
      return;
    }
    const res = await api.post<{ filesWritten: string[]; filesRemoved: string[] }>(
      `/projects/${projectId}/capabilities/add`,
      { assetIds: selectedIds },
    );
    setSubmitting(false);
    if (!res.success || !res.data) {
      setError(res.error || "添加失败");
      return;
    }
    onAdded();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-panel border border-surface-sunken flex flex-col w-[860px] h-[80vh] overflow-hidden animate-scale-in">
        <div className="flex items-center justify-between px-5 py-3 border-b border-surface-sunken">
          <div>
            <h3 className="text-md font-semibold text-text-primary">{title}</h3>
            <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-sunken text-text-muted">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <AssetBrowser
            assets={assets}
            selectedIds={selectedIds}
            lockedIds={alreadyInstalledIds}
            onAdd={(id) => {
              if (installedSet.has(id)) return; // 已安装项忽略
              setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
            }}
            onRemove={(id) => {
              if (installedSet.has(id)) return; // 不允许从对话框里取消已安装
              setSelectedIds((prev) => prev.filter((x) => x !== id));
            }}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            sourceFilter={sourceFilter}
            onSourceFilterChange={setSourceFilter}
            loading={loading}
          />
        </div>
        <div className="px-5 py-3 border-t border-surface-sunken flex items-center justify-between">
          <div className="text-xs text-text-muted">
            待添加 {selectedIds.length} 项
            {error && <span className="text-red-600 ml-3">{error}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={submitting} onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={selectedIds.length === 0}
              onClick={submit}
            >
              {`添加 ${selectedIds.length} 项`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
