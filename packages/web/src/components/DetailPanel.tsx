import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { X, ChevronDown, ChevronRight, ChevronLeft, Folder, File, Pencil, Trash2, Check, Download } from "lucide-react";
import { api } from "../api.js";
import type { Asset, TargetTool, AssetType } from "@maolinc/cc-loom-shared";
import { ASSET_TYPE_LABELS, ASSET_TYPE_DIRS, ASSET_TYPES, TARGET_TOOLS, TARGET_TOOL_LABELS, ADAPTER_SUPPORT, sortTargetTools, isAssetDirLayout } from "@maolinc/cc-loom-shared";
import { useAuth } from "../hooks/useAuth.js";
import { useToast } from "./Toast.js";
import ConfirmDialog from "./ConfirmDialog.js";
import Button from "./Button.js";
import ToolIcon from "./ToolIcon.js";
import { formatAuthorName } from "../lib/assetDisplay.js";
import FileTree from "./FileTree.js";
import ContentViewer from "./ContentViewer.js";
import AssetMeta, { AssetMetaSkeleton, MetaRow, SourceLink } from "./AssetMeta.js";
import InstallSection from "./InstallSection.js";

/** MCP has no subdir; fall back to the type label so headers don't render blank. */
function typeGroupLabel(type: AssetType): string {
  return ASSET_TYPE_DIRS[type] || ASSET_TYPE_LABELS[type];
}

interface Props {
  type: "asset" | "workspace";
  id: string;
  onClose: () => void;
}

export default function DetailPanel({ type, id, onClose }: Props) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeAssetId, setActiveAssetId] = useState<string>("");
  const [activeFilePath, setActiveFilePath] = useState<string>("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedAssets, setExpandedAssets] = useState<Set<string>>(new Set());
  const [leftPanelWidth, setLeftPanelWidth] = useState(240);
  const resizing = useRef(false);
  // Workspace mode: file `content` is NOT included in the detail payload (the
  // server only returns path + size). We fetch each file's content on demand
  // and cache it per `assetId::path` for the lifetime of this panel instance.
  const fileCacheRef = useRef<Map<string, string>>(new Map());
  const [fileTick, setFileTick] = useState(0);
  const [fileLoading, setFileLoading] = useState(false);
  // 详情数据重载计数：编辑保存后自增以刷新当前面板内容。
  const [reloadTick, setReloadTick] = useState(0);
  // 右栏视图（仅 workspace 模式）：点行选中能力后右栏整体切换为该能力的信息视图
  // （对齐能力市场预览），顶部返回链接回到工作空间信息；树的展开/折叠不影响选中。
  const [rightView, setRightView] = useState<"workspace" | "asset">("workspace");
  // 选中能力的完整详情按需拉取（与文件内容同一按需模式），面板生命周期内缓存。
  // 缺失 = 未加载；"error" = 拉取失败（已下架留存 / 私有无权 / 网络）→ 回退子集渲染。
  const assetInfoCacheRef = useRef<Map<string, Asset | "error">>(new Map());
  const [, setAssetInfoTick] = useState(0);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      setLeftPanelWidth((w) => Math.max(180, Math.min(500, w + ev.movementX)));
    };
    const onUp = () => {
      resizing.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    // AbortController：组件卸载或依赖变化（含 StrictMode 重挂）时中止在途请求，
    // 避免重复请求落到服务端 / 结果写回已卸载组件。
    const controller = new AbortController();
    setLoading(true);
    setActiveAssetId("");
    setActiveFilePath("");
    setExpandedAssets(new Set());
    setCollapsedGroups(new Set());
    fileCacheRef.current = new Map();
    setFileTick(0);
    setFileLoading(false);
    setRightView("workspace");
    assetInfoCacheRef.current = new Map();
    setAssetInfoTick(0);
    const endpoint = type === "asset" ? `/assets/${id}?lite=1` : `/workspaces/${id}`;
    api.get<any>(endpoint, controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      if (res.success && res.data) {
        setData(res.data);
        if (type === "asset") {
          const asset = res.data as Asset;
          const defaultFile = (res.data as any).defaultFile as
            | { path: string; content?: string }
            | undefined;
          if (asset.files?.length > 0) {
            // 详情 lite 响应内联了默认文件内容：直接写入缓存，首屏无需再发一次
            // /file 请求。defaultFile 缺省（默认文件过大）时退回按需加载。
            const primaryPath = defaultFile?.path ?? asset.files[0]!.path;
            if (defaultFile?.content !== undefined) {
              fileCacheRef.current.set(`${id}::${primaryPath}`, defaultFile.content);
              setFileTick((n) => n + 1);
            }
            setActiveFilePath(primaryPath);
          }
        } else {
          // Workspace: keep the tree fully collapsed on open. The user explicitly
          // expands what they want to inspect — no auto-selected asset, no
          // pre-expanded type group.
          const ws = res.data;
          const types = new Set<string>((ws.assets ?? []).map((a: Asset) => a.type));
          setCollapsedGroups(types);
        }
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [type, id, reloadTick]);

  // Derived data (hooks must be before any conditional return)
  const isAsset = type === "asset";
  const allAssets: Asset[] = useMemo(() => {
    if (!data || isAsset) return [];
    return (data as any).assets || [];
  }, [data, isAsset]);

  const assetGroups = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const a of allAssets) {
      const list = map.get(a.type) || [];
      list.push(a);
      map.set(a.type, list);
    }
    // Sort assets within each group by name (case-insensitive dictionary
    // order). Groups themselves are emitted in canonical ASSET_TYPES order so
    // the UI is stable regardless of DB row order.
    for (const list of map.values()) {
      list.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }));
    }
    const ordered = new Map<string, Asset[]>();
    for (const t of ASSET_TYPES) {
      const list = map.get(t);
      if (list && list.length > 0) ordered.set(t, list);
    }
    return ordered;
  }, [allAssets]);

  const activeAsset: Asset | null = isAsset
    ? (data as Asset)
    : (allAssets.find((a) => a.id === activeAssetId) || allAssets[0] || null);
  const files = activeAsset?.files || [];
  const activeFile = files.find((f) => f.path === activeFilePath) || files[0];
  const showFileTree = files.length > 1;

  // Build the full install path for the active file (e.g. "skills/testing-anti-patterns/testing-anti-patterns.md")
  // Hooks must run before any conditional return — keep this above loading/!data branches.
  //
  // Path rule: defer to `isAssetDirLayout` so UI matches the adapter's real
  // install path. Directory-layout assets keep their <name>/ wrapper even when
  // they happen to contain a single file (preserves source structure).
  const activeFileFullPath = useMemo(() => {
    if (!activeFile || !activeAsset) return activeFile?.path || "";
    const typeDir = ASSET_TYPE_DIRS[activeAsset.type as keyof typeof ASSET_TYPE_DIRS] || "";
    const wrapInNameFolder = isAssetDirLayout(activeAsset);
    const parts: string[] = [];
    if (typeDir) parts.push(typeDir);
    if (wrapInNameFolder && activeAsset.name) parts.push(activeAsset.name);
    parts.push(activeFile.path);
    return parts.join("/");
  }, [activeFile, activeAsset]);

  // 文件内容按需加载：详情 payload 只带文件元信息（asset 模式走 ?lite=1，
  // workspace 详情本就只返回 path/size），content 在用户查看某个文件时才
  // 通过 /api/assets/:id/file 拉取并缓存。asset 模式用当前能力 id，workspace
  // 模式用选中的子能力 id。若详情已内联 content（非 lite 场景）则直接使用。
  const currentAssetId = isAsset ? id : activeAssetId;
  const activeFileContent = activeFile?.content;
  const fileKey = currentAssetId && activeFilePath ? `${currentAssetId}::${activeFilePath}` : "";
  useEffect(() => {
    if (!currentAssetId || !activeFilePath) return;
    if (activeFileContent !== undefined) return;
    const key = `${currentAssetId}::${activeFilePath}`;
    if (fileCacheRef.current.has(key)) return;
    const controller = new AbortController();
    setFileLoading(true);
    api
      .get<{ path: string; content: string }>(
        `/assets/${currentAssetId}/file?path=${encodeURIComponent(activeFilePath)}`,
        controller.signal,
      )
      .then((res) => {
        if (controller.signal.aborted) return;
        setFileLoading(false);
        if (res.success && res.data) {
          fileCacheRef.current.set(key, res.data.content);
          setFileTick((n) => n + 1);
        }
      });
    return () => controller.abort();
  }, [currentAssetId, activeFilePath, activeFileContent]);

  // 能力信息视图（workspace 模式）：选中成员能力的完整详情按需拉取并缓存。
  // lite=1 只要元信息（文件内容走上面的按需通道）。失败记 "error"，
  // UI 回退用工作空间 payload 子集做 limited 渲染。
  const infoAssetId = !isAsset && rightView === "asset" ? activeAssetId : "";
  useEffect(() => {
    if (!infoAssetId) return;
    if (assetInfoCacheRef.current.has(infoAssetId)) return;
    const controller = new AbortController();
    api.get<Asset>(`/assets/${infoAssetId}?lite=1`, controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      assetInfoCacheRef.current.set(infoAssetId, res.success && res.data ? res.data : "error");
      setAssetInfoTick((n) => n + 1);
    });
    return () => controller.abort();
  }, [infoAssetId]);

  const displayContent = useMemo(() => {
    if (activeFileContent !== undefined) return activeFileContent;
    return fileCacheRef.current.get(fileKey) ?? "";
    // fileTick is intentionally a dep: bumped after an async cache write so
    // the memo recomputes and React re-renders with the freshly-loaded content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileContent, fileKey, fileTick]);

  const isContentLoading =
    activeFileContent === undefined && fileLoading && !fileCacheRef.current.has(fileKey);

  const toggleGroup = (type: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  if (loading) {
    return (
      <PanelShell onClose={onClose}>
        <div className="flex items-center justify-center h-full text-text-muted">加载中...</div>
      </PanelShell>
    );
  }

  if (!data) {
    return (
      <PanelShell onClose={onClose}>
        <div className="flex items-center justify-center h-full text-text-muted">未找到数据</div>
      </PanelShell>
    );
  }

  const asset = isAsset ? (data as Asset) : null;
  const workspace = !isAsset ? data : null;

  // 能力信息视图数据：完整详情（按需缓存）→ 失败回退工作空间 payload 子集 → 加载中骨架。
  const showAssetInfo = !isAsset && rightView === "asset";
  const infoEntry = showAssetInfo ? assetInfoCacheRef.current.get(activeAssetId) : undefined;
  const infoAsset = infoEntry && infoEntry !== "error" ? infoEntry : null;
  const infoFailed = infoEntry === "error";
  const infoSubset = showAssetInfo ? allAssets.find((a) => a.id === activeAssetId) ?? null : null;
  // 安装区：能力视图且完整详情已加载 → 单能力安装（对齐市场）；工作空间视图 → 工作空间安装。
  // limited 回退（留存/无权）不渲染安装区——这些操作对该能力必然失败。
  const installAssetId = isAsset ? asset?.id : rightView === "asset" ? infoAsset?.id : undefined;
  const installWorkspaceId = !isAsset && rightView === "workspace" ? workspace?.id : undefined;

  const handleAssetSelect = (assetId: string) => {
    const wasExpanded = expandedAssets.has(assetId);
    // Toggle expand/collapse
    setExpandedAssets((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
    // Only update active selection when EXPANDING; collapsing keeps previous content visible
    if (!wasExpanded) {
      setActiveAssetId(assetId);
      setRightView("asset");
      const a = allAssets.find((x) => x.id === assetId);
      if (a?.files?.length) {
        setActiveFilePath(a.files[0]!.path);
      } else {
        setActiveFilePath("");
      }
    }
  };

  return (
    <PanelShell onClose={onClose}>
      <div className="flex h-full">
        {/* Left: asset tree grouped by type */}
        {!isAsset && allAssets.length > 0 && (
          <div className="shrink-0 border-r border-surface-sunken overflow-y-auto bg-surface-card/30 flex" style={{ width: leftPanelWidth }}>
            <div className="flex-1 min-w-0">
              <div className="px-3 py-2 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                能力 ({allAssets.length})
              </div>
              {[...assetGroups.entries()].map(([type, assets]) => {
                const isCollapsed = collapsedGroups.has(type);

                return (
                  <div key={type}>
                    {/* Group header — level 0 */}
                    <button
                      onClick={() => toggleGroup(type)}
                      className="w-full flex items-center gap-1 py-1 px-3 text-left hover:bg-surface-sunken transition-colors"
                    >
                      {isCollapsed ? <ChevronRight size={12} className="text-text-muted shrink-0" /> : <ChevronDown size={12} className="text-text-muted shrink-0" />}
                      <Folder size={14} className="text-text-muted shrink-0" />
                      <span className="text-xs text-text-primary">{typeGroupLabel(type as AssetType)}</span>
                      <span className="text-[10px] text-text-muted">({assets.length})</span>
                    </button>

                    {/* Assets — level 1 */}
                    {!isCollapsed &&
                      assets.map((a) => {
                        const isActive = a.id === activeAssetId;
                        const isExpanded = expandedAssets.has(a.id);
                        const assetFiles = a.files || [];
                        // Directory-shaped asset (per source layout) renders
                        // as an expandable folder, even when it contains a
                        // single file (e.g. `skills/foo/SKILL.md`).
                        const isDir = isAssetDirLayout(a);

                        return (
                          <div key={a.id}>
                            <button
                              onClick={() => handleAssetSelect(a.id)}
                              className={`w-full flex items-center gap-1 py-1 text-left hover:bg-surface-sunken transition-colors ${
                                isActive ? "bg-brand-soft/30 text-brand font-medium" : "text-text-secondary"
                              }`}
                              style={{ paddingLeft: 32 }}
                            >
                              {isDir ? (
                                isExpanded ? <ChevronDown size={10} className="text-text-muted shrink-0" /> : <ChevronRight size={10} className="text-text-muted shrink-0" />
                              ) : (
                                <span className="w-[10px] shrink-0" />
                              )}
                              {isDir ? (
                                <Folder size={14} className="text-text-muted shrink-0" />
                              ) : (
                                <File size={14} className="text-text-muted shrink-0" />
                              )}
                              <span className="text-xs truncate">{a.name}</span>
                              {a.alias?.trim() && (
                                <span className="text-[10px] text-text-muted truncate shrink-0 max-w-[40%]">{a.alias.trim()}</span>
                              )}
                            </button>
                            {/* Files — level 2 */}
                            {isExpanded && isDir && (
                              <div style={{ paddingLeft: 36 }}>
                                <FileTree
                                  files={assetFiles}
                                  activePath={isActive ? activeFilePath : ""}
                                  onSelect={(p) => {
                                    setActiveAssetId(a.id);
                                    setActiveFilePath(p);
                                    setRightView("asset");
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
            {/* Resize handle */}
            <div
              onMouseDown={onResizeStart}
              className="w-1 cursor-col-resize hover:bg-brand/30 active:bg-brand/50 transition-colors shrink-0 select-none"
            />
          </div>
        )}

        {isAsset && showFileTree && (
          <div className="w-[200px] shrink-0 border-r border-surface-sunken overflow-y-auto bg-surface-card/30">
            <div className="px-3 py-2 text-[10px] font-semibold text-text-muted uppercase tracking-wider">
              文件
            </div>
            <FileTree
              files={files}
              activePath={activeFilePath}
              onSelect={setActiveFilePath}
            />
          </div>
        )}

        {/* Center: Content viewer */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
          {activeFile ? (
            <ContentViewer
              content={displayContent}
              fileName={activeFileFullPath}
              loading={isContentLoading}
              language={activeFile.path.endsWith(".json") ? "json" : undefined}
            />
          ) : activeAsset ? (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              该能力暂无文件内容
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              选择左侧能力查看内容
            </div>
          )}
        </div>

        {/* Right: Metadata + Install */}
        <div className="w-[280px] shrink-0 border-l border-surface-sunken overflow-y-auto">
          <div className="p-4">
            {asset && <AssetMeta asset={asset} onClose={onClose} onChanged={() => setReloadTick((n) => n + 1)} />}
            {workspace && rightView === "workspace" && <WorkspaceMeta workspace={workspace} onClose={onClose} />}
            {workspace && rightView === "asset" && (
              <div>
                <button
                  onClick={() => setRightView("workspace")}
                  className="flex items-center gap-0.5 text-xs text-text-muted hover:text-brand transition-colors mb-3"
                >
                  <ChevronLeft size={12} />
                  返回工作空间信息
                </button>
                {infoAsset ? (
                  <AssetMeta asset={infoAsset} onClose={onClose} onChanged={() => setReloadTick((n) => n + 1)} />
                ) : infoFailed && infoSubset ? (
                  // 完整详情不可得（已下架留存 / 私有无权）：子集 limited 渲染，抑制必败操作
                  <AssetMeta
                    asset={infoSubset}
                    mode="limited"
                    notice={(infoSubset as { retained?: boolean }).retained ? "已下架（留存）" : "私有能力，仅作者可见完整信息"}
                    onClose={onClose}
                    onChanged={() => setReloadTick((n) => n + 1)}
                  />
                ) : infoFailed ? (
                  <div className="text-sm text-text-muted">无法加载能力信息</div>
                ) : (
                  <AssetMetaSkeleton />
                )}
              </div>
            )}
            {(installAssetId || installWorkspaceId) && (
              <div className="border-t border-surface-sunken mt-4 pt-4">
                <InstallSection assetId={installAssetId} workspaceId={installWorkspaceId} />
              </div>
            )}
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

function PanelShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 bg-black/30 backdrop-blur-[2px] z-50 animate-fade-in" onClick={onClose} />
      <div className="fixed inset-y-0 left-0 z-50 w-[90vw] max-w-[1200px] bg-white shadow-panel animate-slide-in flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-full hover:bg-surface-sunken flex items-center justify-center text-text-muted hover:text-text-primary transition-colors z-10"
        >
          <X size={18} />
        </button>
        {children}
      </div>
    </>
  );
}

function WorkspaceMeta({ workspace, onClose }: { workspace: any; onClose: () => void }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fromSource = !!(workspace.sourceId ?? workspace.source_id);
  const sourceName = workspace.sourceDisplayName ?? workspace.source_display_name;
  const sourceAddedBy = workspace.sourceAddedBy ?? workspace.source_added_by;
  const sourceUrl = workspace.sourceUrl ?? workspace.source_url ?? workspace.source_repo_url;
  const author = workspace.author;
  // 作者：导入的工作空间显示导入者，本地创建的显示创建者。与能力详情面板对齐。
  const displayAuthor = fromSource ? (sourceAddedBy ?? author) : author;
  const isAdmin = !!user && user.role === "admin";
  const canEdit = !!user && (isAdmin || workspace.user_id === user.userId);
  const canDelete = canEdit && (!fromSource || isAdmin);

  const onEdit = () => {
    onClose();
    navigate(`/workspaces/${workspace.id}/edit`);
  };

  const onDelete = async () => {
    setDeleting(true);
    const res = await api.delete<unknown>(`/workspaces/${workspace.id}`);
    setDeleting(false);
    setConfirmDelete(false);
    if (res.success) {
      toast.success("工作空间已删除", workspace.name);
      onClose();
    } else {
      toast.error("删除失败", res.error ?? "请稍后重试");
    }
  };

  return (
    <div>
      {/* Title row only holds the visibility badge — the panel-level close X
         (absolute top-4 right-4) overlaps the right ~32px of this column, so
         action buttons must live in their own row below. */}
      <div className="mb-2 flex items-center gap-1">
        {fromSource && (
          <span title={sourceName ?? undefined} className="px-2 py-0.5 rounded-full text-xs font-medium bg-surface-sunken text-text-secondary">
            第三方
          </span>
        )}
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
          workspace.visibility === "public" ? "bg-mcp-green-bg text-mcp-green-text" : "bg-surface-sunken text-text-muted"
        }`}>
          {workspace.visibility === "public" ? "公开" : "个人"}
        </span>
      </div>
      <h2 className="text-lg font-bold text-text-primary mb-1 pr-8">{workspace.name}</h2>
      <p className="text-sm text-text-secondary mb-3">{workspace.description}</p>

      <div className="mb-3">
        <div className="text-xs font-semibold text-text-primary mb-1.5">目标工具</div>
        <div className="flex flex-wrap gap-1.5">
          {sortTargetTools(workspace.targetTools || []).map((t: TargetTool) => (
            <span key={t} className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-brand-soft">
              <ToolIcon tool={t} size={16} />
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-2 text-sm">
        {displayAuthor && <MetaRow label={fromSource ? "导入人" : "作者"} value={formatAuthorName(displayAuthor)} />}
        {fromSource && sourceName && <MetaRow label="来源" value={<SourceLink name={sourceName} url={sourceUrl} />} />}
        <MetaRow label="能力数" value={`${workspace.assets?.length || 0}`} />
      </div>

      <WorkspaceDownloadSection
        workspaceId={workspace.id}
        assets={(workspace.assets || []) as Asset[]}
        defaultTools={(workspace.targetTools || []) as TargetTool[]}
      />

      {(canEdit || canDelete) && (
        <div className="grid grid-cols-2 gap-2 mt-4">
          {canEdit && (
            <Button variant="secondary" size="sm" leftIcon={<Pencil size={12} />} onClick={onEdit}>
              编辑
            </Button>
          )}
          {canDelete && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Trash2 size={12} />}
              className="!text-red-600 !border-red-100 hover:!bg-red-50 hover:!border-red-200"
              onClick={() => setConfirmDelete(true)}
            >
              删除
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        kind="danger"
        title={`删除工作空间「${workspace.name}」`}
        description="此操作不可撤销。已安装到本地项目的内容不会自动移除。"
        confirmLabel="删除"
        confirmingLabel="删除中…"
        busy={deleting}
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/**
 * 工作空间下载：可选厂商多选。
 *  - 不选厂商（默认）：按预览结构下载，所有成员能力完整包含。
 *  - 选厂商：走厂商安装结构，不兼容类型被排除；勾选后实时提示哪些能力会被排除。
 */
function WorkspaceDownloadSection({
  workspaceId,
  assets,
  defaultTools,
}: {
  workspaceId: string;
  assets: Asset[];
  defaultTools: TargetTool[];
}) {
  const toast = useToast();
  const [selectedTools, setSelectedTools] = useState<TargetTool[]>([]);
  const [downloading, setDownloading] = useState(false);

  const toggleTool = (t: TargetTool) => {
    setSelectedTools((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };

  // 勾选厂商后，被全部已选厂商排除的能力名（用于提示「不少东西」之外的不兼容排除）。
  const excludedNames = useMemo(() => {
    if (selectedTools.length === 0) return [] as string[];
    const names = new Set<string>();
    for (const a of assets) {
      // 该能力不被任何已选厂商支持 → 排除
      const supported = selectedTools.some((t) => (ADAPTER_SUPPORT[t] as readonly AssetType[]).includes(a.type));
      if (!supported) names.add(a.name);
    }
    return [...names];
  }, [selectedTools, assets]);

  const onDownload = async () => {
    setDownloading(true);
    const params = new URLSearchParams();
    if (selectedTools.length > 0) params.set("tool", selectedTools.join(","));
    const url = `/api/workspaces/${workspaceId}/download${params.toString() ? `?${params}` : ""}`;
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        toast.error("下载失败", res.status === 404 ? "工作空间不存在" : "请稍后重试");
        return;
      }
      // 厂商模式下读取被跳过清单，提示用户哪些能力因不兼容未包含。
      const skippedHeader = res.headers.get("X-Loom-Skipped");
      if (skippedHeader) {
        try {
          const skipped = JSON.parse(decodeURIComponent(skippedHeader)) as { assetName: string; type: AssetType; tool: TargetTool }[];
          const names = [...new Set(skipped.map((s) => s.assetName))];
          if (names.length > 0) {
            toast.info("部分能力已排除", `${names.join("、")} 不支持所选厂商，未包含在 zip 中`);
          }
        } catch { /* ignore parse error */ }
      }
      const blob = await res.blob();
      const disp = res.headers.get("Content-Disposition") || "";
      const filename = /filename="([^"]+)"/.exec(disp)?.[1] || "workspace.zip";
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch {
      toast.error("下载失败", "网络连接失败，请稍后重试");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="mt-4 group relative">
      <Button
        variant="secondary"
        size="sm"
        fullWidth
        loading={downloading}
        leftIcon={<Download size={12} />}
        onClick={onDownload}
        title="悬停可选择厂商；不选则按预览结构下载"
      >
        下载 zip
      </Button>
      {/* 悬停下载按钮才弹出的厂商选择浮层。默认不展示选项，避免拥挤。 */}
      <div className="hidden group-hover:block absolute left-0 right-0 top-full z-20 bg-white border border-gray-200 rounded-xl shadow-lg p-3">
        <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-2">厂商（可选）</div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {sortTargetTools(TARGET_TOOLS as readonly TargetTool[] as TargetTool[]).map((t) => {
            const active = selectedTools.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleTool(t)}
                className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium border transition-colors ${
                  active
                    ? "bg-brand-soft text-brand border-brand/20"
                    : "border-gray-200 text-text-muted hover:border-gray-300"
                }`}
                title={active ? "已选该厂商" : "按该厂商安装结构下载"}
              >
                <ToolIcon tool={t} size={14} showTooltip={false} />
                {TARGET_TOOL_LABELS[t]}
                {active && <Check size={11} />}
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-text-muted leading-relaxed">
          {selectedTools.length === 0
            ? "不选厂商则按预览结构下载，包含全部能力。"
            : excludedNames.length > 0
              ? `按所选厂商安装结构下载；以下能力不支持将被排除：${excludedNames.join("、")}`
              : "按所选厂商安装结构下载，全部能力均兼容。"}
        </p>
      </div>
    </div>
  );
}
