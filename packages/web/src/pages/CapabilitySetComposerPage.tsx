import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "../api.js";
import type { Asset, TargetTool, Visibility } from "@maolinc/cc-loom-shared";
import AssetBrowser from "../components/AssetBrowser.js";
import CapabilitySetCanvas from "../components/CapabilitySetCanvas.js";
import DetailPanel from "../components/DetailPanel.js";
import Button from "../components/Button.js";
import { ErrorState, InlineLoading } from "../components/PageState.js";
import { useToast } from "../components/Toast.js";

export default function CapabilitySetComposerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const isEdit = !!id;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetTools, setTargetTools] = useState<TargetTool[]>([]);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [selected, setSelected] = useState<Asset[]>([]);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 编辑态加载
  const [loadingWs, setLoadingWs] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadCapabilitySet = (signal?: AbortSignal) => {
    if (!isEdit) return;
    setLoadingWs(true);
    setLoadError(null);
    api.get<any>(`/capability-sets/${id}`, signal).then((res) => {
      if (signal?.aborted) return;
      setLoadingWs(false);
      if (res.success && res.data) {
        const d = res.data;
        setName(d.name);
        setDescription(d.description);
        setTargetTools(d.targetTools);
        setVisibility(d.visibility);
        setSelected((d.assets || []).map((a: any) => a.asset ?? a));
      } else {
        setLoadError(res.error || "无法加载能力集");
      }
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    loadCapabilitySet(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isEdit]);

  // 能力库（服务端按 search/type/source 过滤）
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (searchQuery) params.set("query", searchQuery);
    if (typeFilter) params.set("type", typeFilter);
    if (sourceFilter) params.set("source", sourceFilter);
    params.set("pageSize", "100");
    setAssetsLoading(true);
    api.get<Asset[]>(`/assets?${params}`, controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      setAssetsLoading(false);
      if (res.success && res.data) setAssets(res.data);
    });
    return () => controller.abort();
  }, [searchQuery, typeFilter, sourceFilter]);

  const selectedIds = selected.map((a) => a.id);

  const addAsset = (assetId: string) => {
    if (selectedIds.includes(assetId)) return;
    const asset = assets.find((a) => a.id === assetId);
    if (asset) setSelected((prev) => [...prev, asset]);
  };
  const removeAsset = (assetId: string) => setSelected((prev) => prev.filter((a) => a.id !== assetId));

  const handleSave = async () => {
    if (!name.trim()) { setError("请输入名称"); return; }
    if (targetTools.length === 0) { setError("请至少选择一个目标工具"); return; }
    if (selected.length === 0) { setError("请至少添加一个能力"); return; }
    setSaving(true);
    setError("");

    const body = { name, description, targetTools, visibility, assetIds: selectedIds };
    const res = isEdit ? await api.put(`/capability-sets/${id}`, body) : await api.post("/capability-sets", body);
    setSaving(false);
    if (res.success) {
      toast.success(isEdit ? "能力集已更新" : "能力集已创建", name);
      navigate("/capability-sets");
    } else {
      setError(res.error || "保存失败");
      toast.error("保存失败", res.error || "请稍后重试");
    }
  };

  if (isEdit && loadingWs) {
    return <div className="h-[calc(100vh-8rem)]"><InlineLoading label="加载能力集…" /></div>;
  }
  if (isEdit && loadError) {
    return <ErrorState message={loadError} onRetry={loadCapabilitySet} />;
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex rounded-2xl border border-surface-sunken bg-white overflow-hidden shadow-soft">
      {/* Left: Asset browser */}
      <div className="w-[420px] shrink-0 border-r border-surface-sunken flex flex-col bg-white">
        <AssetBrowser
          assets={assets}
          selectedIds={selectedIds}
          onAdd={addAsset}
          onRemove={removeAsset}
          onPreview={setPreviewAssetId}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          loading={assetsLoading}
        />
      </div>

      {/* Right: Canvas */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-between px-6 py-3 border-b border-surface-sunken bg-white">
          <Button variant="ghost" size="sm" leftIcon={<ArrowLeft size={15} />} onClick={() => navigate("/capability-sets")}>
            返回列表
          </Button>
          <div className="flex items-center gap-3">
            {error && <span className="text-sm text-red-500">{error}</span>}
            <Button variant="primary" loading={saving} onClick={handleSave}>
              {isEdit ? "保存修改" : "创建能力集"}
            </Button>
          </div>
        </div>

        <CapabilitySetCanvas
          name={name}
          onNameChange={setName}
          description={description}
          onDescriptionChange={setDescription}
          targetTools={targetTools}
          onTargetToolsChange={setTargetTools}
          visibility={visibility}
          onVisibilityChange={setVisibility}
          selected={selected}
          onRemove={removeAsset}
          onPreview={setPreviewAssetId}
        />
      </div>

      {previewAssetId && (
        <DetailPanel type="asset" id={previewAssetId} onClose={() => setPreviewAssetId(null)} />
      )}
    </div>
  );
}
