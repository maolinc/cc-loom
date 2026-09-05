import { useState, useMemo } from "react";
import { ChevronRight, ChevronDown, X, Folder, File, Eye } from "lucide-react";
import type { Asset, TargetTool, Visibility } from "@maolinc/cc-loom-shared";
import { ASSET_TYPE_DIRS, ASSET_TYPE_LABELS, ASSET_TYPES, TARGET_TOOLS, isAssetDirLayout } from "@maolinc/cc-loom-shared";
import type { AssetType } from "@maolinc/cc-loom-shared";
import FileTree from "./FileTree.js";
import ToolIcon from "./ToolIcon.js";

/**
 * Visible label for an asset-type group in the workspace tree.
 * MCP has no own subdirectory (ASSET_TYPE_DIRS.mcp === "") because installs
 * merge all MCP entries into a single mcp.json. Fall back to the type label
 * so the group header doesn't render blank.
 */
function typeGroupLabel(type: AssetType): string {
  return ASSET_TYPE_DIRS[type] || ASSET_TYPE_LABELS[type];
}

interface Props {
  name: string;
  onNameChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  targetTools: TargetTool[];
  onTargetToolsChange: (tools: TargetTool[]) => void;
  visibility: Visibility;
  onVisibilityChange: (v: Visibility) => void;
  selected: Asset[];
  onRemove: (id: string) => void;
  onPreview?: (id: string) => void;
}

export default function WorkspaceCanvas({
  name, onNameChange,
  description, onDescriptionChange,
  targetTools, onTargetToolsChange,
  visibility, onVisibilityChange,
  selected, onRemove, onPreview,
}: Props) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, Asset[]>();
    for (const a of selected) {
      const list = map.get(a.type) || [];
      list.push(a);
      map.set(a.type, list);
    }
    // Stable display order: sort assets within each type by name
    // (case-insensitive), then emit groups in canonical ASSET_TYPES order.
    for (const list of map.values()) {
      list.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }));
    }
    const ordered = new Map<string, Asset[]>();
    for (const t of ASSET_TYPES) {
      const list = map.get(t);
      if (list && list.length > 0) ordered.set(t, list);
    }
    return ordered;
  }, [selected]);

  const toggleGroup = (type: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleAsset = (id: string) => {
    setExpandedAsset((prev) => prev === id ? null : id);
  };

  const toggleTool = (t: TargetTool) => {
    onTargetToolsChange(
      targetTools.includes(t) ? targetTools.filter((x) => x !== t) : [...targetTools, t]
    );
  };

  const dirPreview = useMemo(() => {
    // Path rule: defer to `isAssetDirLayout` (single source of truth shared
    // with the adapter and DetailPanel). Directory-layout assets keep their
    // <asset.name>/ wrapper even with a single file; flat-layout single-file
    // assets install as <typeDir>/<file.path> with no wrapper.
    const files: { id: string; path: string; content?: string }[] = [];
    for (const a of selected) {
      const typeSubDir = ASSET_TYPE_DIRS[a.type as keyof typeof ASSET_TYPE_DIRS];
      const assetFiles = a.files || [];
      const wrapInNameFolder = isAssetDirLayout(a);
      for (const f of assetFiles) {
        const parts: string[] = [];
        if (typeSubDir) parts.push(typeSubDir);
        if (wrapInNameFolder && a.name) parts.push(a.name);
        parts.push(f.path);
        files.push({ id: f.id, path: parts.join("/"), content: f.content });
      }
    }
    return files;
  }, [selected]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Basic info */}
      <section className="bg-surface-card rounded-xl p-4">
        <h3 className="text-sm font-semibold text-text-primary mb-3">基本信息</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">名称</label>
            <input
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="工作空间名称"
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-brand bg-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">描述</label>
            <textarea
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="描述这个工作空间的用途"
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-brand resize-none bg-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">目标工具</label>
            <div className="flex flex-wrap gap-1.5">
              {TARGET_TOOLS.map((t) => (
                <button
                  key={t}
                  onClick={() => toggleTool(t)}
                  className={`inline-flex items-center justify-center px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    targetTools.includes(t)
                      ? "bg-brand-soft text-brand border-brand/20"
                      : "border-gray-200 text-text-muted hover:border-gray-300 bg-white"
                  }`}
                >
                  <ToolIcon tool={t} size={16} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">可见性</label>
            <div className="flex gap-2">
              {(["private", "public"] as Visibility[]).map((v) => (
                <button
                  key={v}
                  onClick={() => onVisibilityChange(v)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    visibility === v
                      ? "bg-brand text-white"
                      : "bg-gray-200 text-text-secondary hover:bg-gray-300"
                  }`}
                >
                  {v === "public" ? "公开" : "个人"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Selected assets tree */}
      <section>
        <h3 className="text-sm font-semibold text-text-primary mb-3">
          能力 ({selected.length})
        </h3>
        {selected.length === 0 ? (
          <p className="text-sm text-text-muted bg-surface-card rounded-xl p-4 text-center">
            从左侧浏览器点击添加能力
          </p>
        ) : (
          <div>
            {[...groups.entries()].map(([type, assets]) => {
              const isCollapsed = collapsedGroups.has(type);

              return (
                <div key={type}>
                  {/* Group header — level 0 */}
                  <button
                    onClick={() => toggleGroup(type)}
                    className="w-full flex items-center gap-1 py-1 hover:bg-surface-card rounded transition-colors"
                  >
                    {isCollapsed ? <ChevronRight size={12} className="text-text-muted shrink-0" /> : <ChevronDown size={12} className="text-text-muted shrink-0" />}
                    <Folder size={14} className="text-text-muted shrink-0" />
                    <span className="text-sm text-text-primary">{typeGroupLabel(type as AssetType)}</span>
                    <span className="text-xs text-text-muted">({assets.length})</span>
                  </button>

                  {/* Assets — level 1 */}
                  {!isCollapsed &&
                    assets.map((a) => {
                      const isExpanded = expandedAsset === a.id;
                      const assetFiles = a.files || [];
                      // Directory-shaped asset (per source layout) renders as
                      // an expandable folder, even when it contains a single
                      // file (e.g. `skills/foo/SKILL.md`).
                      const isDir = isAssetDirLayout(a);

                      return (
                        <div key={a.id} style={{ paddingLeft: 20 }}>
                          <div className="flex items-center gap-1 group/asset">
                            <button
                              onClick={() => isDir && toggleAsset(a.id)}
                              className="flex items-center gap-1 flex-1 min-w-0 py-1 hover:bg-surface-card rounded transition-colors"
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
                              <span className="text-sm text-text-primary truncate">{a.name}</span>
                              {a.alias?.trim() && (
                                <span className="text-[11px] text-text-muted truncate shrink-0 max-w-[40%]">{a.alias.trim()}</span>
                              )}
                            </button>
                            {onPreview && (
                              <button
                                onClick={(e) => { e.stopPropagation(); onPreview(a.id); }}
                                title="查看详情"
                                className="text-text-muted hover:text-brand transition-colors opacity-0 group-hover/asset:opacity-100 shrink-0 py-1"
                              >
                                <Eye size={12} />
                              </button>
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); onRemove(a.id); }}
                              title="移除"
                              className="text-text-muted hover:text-red-500 transition-colors opacity-0 group-hover/asset:opacity-100 shrink-0 py-1"
                            >
                              <X size={12} />
                            </button>
                          </div>

                          {/* Files — level 2 */}
                          {/* paddingLeft 4 here, parent wrapper already adds 20 → total 24
                             so FileTree depth-0 folder icon lands at 52, aligning with asset text */}
                          {isExpanded && isDir && (
                            <div style={{ paddingLeft: 4 }}>
                              <FileTree
                                files={assetFiles}
                                activePath=""
                                onSelect={() => {}}
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
        )}
      </section>

      {/* Directory preview */}
      {selected.length > 0 && targetTools.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-text-primary mb-3">目录结构预览</h3>
          <div className="rounded-xl p-4 text-xs">
            {dirPreview.length > 0 ? (
              <FileTree
                files={dirPreview}
                activePath=""
                onSelect={() => {}}
                defaultCollapsed
              />
            ) : (
              <p className="text-text-muted">暂无文件</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
