/**
 * PreviewPanel —— 通用预览面板（取代 MirrorFilePanel）。
 *
 * v3 重设计：与 DetailPanel 一致的"左侧大面板"风格 —— `fixed inset-y-0 left-0`，
 * 宽度 90vw / max 1200px，自带左侧 mirror 树 + 右侧详情。
 *
 * 支持两种 target：
 *  - { kind: "file" }：右侧拉取文件内容
 *  - { kind: "dir"  }：右侧展示目录下子项列表
 *
 * 用户可在左侧 mirror 树里点击其它文件/目录直接切换 target，无需关闭重开。
 *
 * 半透明遮罩 + slide-in-left 动画，ESC / 点击遮罩关闭。
 */
import { useEffect, useRef, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown, ExternalLink, FileText, Folder, Lock, X } from "lucide-react";
import type { AssetType, LocalFileNode, TargetTool } from "@maolinc/cc-loom-shared";
import ContentViewer from "../../components/ContentViewer.js";
import ToolIcon from "../../components/ToolIcon.js";
import { api } from "../../api.js";
import MirrorTreeView, { type MirrorTreeViewHandle } from "./MirrorTreeView.js";

const TYPE_CHIP: Record<AssetType, string> = {
  skill: "bg-skill-blue-bg text-skill-blue-text",
  rule: "bg-rule-yellow-bg text-rule-yellow-text",
  mcp: "bg-mcp-green-bg text-mcp-green-text",
  hook: "bg-hook-purple-bg text-hook-purple-text",
  command: "bg-command-cyan-bg text-command-cyan-text",
  agent: "bg-agent-coral-bg text-agent-coral-text",
};

export type PreviewTarget =
  | { kind: "file"; path: string; managed: boolean }
  | { kind: "dir"; path: string; node: LocalFileNode };

interface Props {
  projectId: string;
  target: PreviewTarget;
  /** 当前 active 厂商的根 tree（左侧导航树用）。 */
  vendorTree?: LocalFileNode[];
  /** 当前 active 厂商，用于 header 上下文展示。 */
  vendorTool?: TargetTool;
  /** assetId → type，用于在文件 header 渲染类型 chip 与左侧树着色 */
  assetTypes?: Map<string, AssetType>;
  /** assetId → 别名：左侧树/目录列表中名称后以灰色辅助展示。 */
  assetAliases?: Map<string, string>;
  /** 当前已安装 capabilitySet 的 asset 列表（用于"查看 Asset"链接） */
  capabilitySetAssets?: { id: string; name: string }[];
  /** 用户点"查看 Asset →"时由父组件接管 */
  onOpenAsset?: (assetId: string) => void;
  /** 用户在左侧树或目录预览中点击子项时回调 */
  onNavigate?: (target: PreviewTarget) => void;
  /** toggle 单 (asset, tool) — 由父组件提供，预览面板里的 toggle 才有响应 */
  onToggleCapability?: (assetId: string, tool: TargetTool, enabled: boolean) => void;
  /** 移除某能力（带 tool：外部能力 adopt 需指定厂商） */
  onRemoveCapability?: (assetId: string, tool: TargetTool) => void;
  /** legacy lock 时禁用 toggle / 移除 */
  capabilityDisabled?: boolean;
  onClose: () => void;
}

function isMcpJson(path: string): boolean {
  return path === ".mcp.json" || path.endsWith("/mcp.json");
}

function assetNameFromPath(path: string): string | null {
  const segs = path.split("/").filter(Boolean);
  if (segs.length >= 4) return segs[2] ?? null;
  if (segs.length === 3) {
    const last = segs[2] ?? "";
    return last.replace(/\.(md|sh|json)$/i, "") || null;
  }
  return null;
}

export default function PreviewPanel({
  projectId,
  target,
  vendorTree,
  vendorTool,
  assetTypes,
  assetAliases,
  capabilitySetAssets,
  onOpenAsset,
  onNavigate,
  onToggleCapability,
  onRemoveCapability,
  capabilityDisabled,
  onClose,
}: Props) {
  const treeRef = useRef<MirrorTreeViewHandle>(null);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/30 z-50 animate-pp-fade"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-label={target.kind === "file" ? "文件预览" : "目录预览"}
        className="fixed inset-y-0 left-0 z-50 w-[90vw] max-w-[1200px] bg-white shadow-2xl animate-pp-slide-in flex flex-col"
      >
        {/* 关闭按钮：浮动在右上角，不占内容流（删去原来整条 PreviewHeader） */}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭面板"
          className="absolute top-3 right-3 z-10 w-8 h-8 grid place-items-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text-primary"
        >
          <X size={16} />
        </button>

        {/* ── 主体：左 mirror tree + 右内容 ── */}
        <div className="flex-1 min-h-0 flex">
          <div className="w-[280px] shrink-0 border-r border-surface-sunken bg-surface-card/40 flex flex-col">
            <div className="px-3 py-2.5 border-b border-surface-sunken flex items-center gap-2 shrink-0">
              {vendorTool && (
                <>
                  <ToolIcon tool={vendorTool} size={18} />
                </>
              )}
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => treeRef.current?.expandAll()}
                  title="全部展开"
                  aria-label="全部展开"
                  className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-white"
                >
                  <ChevronsUpDown size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => treeRef.current?.collapseAll()}
                  title="全部折叠"
                  aria-label="全部折叠"
                  className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-white"
                >
                  <ChevronsDownUp size={12} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {vendorTree && vendorTree.length > 0 ? (
                <MirrorTreeView
                  ref={treeRef}
                  nodes={vendorTree}
                  activePath={target.path}
                  onSelect={(path, managed) =>
                    onNavigate?.({ kind: "file", path, managed })
                  }
                  onDirSelect={(path) => {
                    const node = findNodeByPath(vendorTree, path);
                    if (node) onNavigate?.({ kind: "dir", path, node });
                  }}
                  defaultCollapsed={false}
                  tool={vendorTool}
                  assetTypes={assetTypes}
                  assetAliases={assetAliases}
                  onToggleCapability={onToggleCapability}
                  onRemoveCapability={onRemoveCapability}
                  disabled={capabilityDisabled}
                />
              ) : (
                <div className="p-4 text-xs text-text-muted text-center">
                  当前厂商无可显示的镜像
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 min-w-0 flex flex-col">
            {target.kind === "file" ? (
              <FileBody
                projectId={projectId}
                path={target.path}
                managed={target.managed}
                capabilitySetAssets={capabilitySetAssets}
                assetTypes={assetTypes}
                onOpenAsset={onOpenAsset}
              />
            ) : (
              <DirBody
                node={target.node}
                assetTypes={assetTypes}
                assetAliases={assetAliases}
                onSelectChild={onNavigate}
              />
            )}
          </div>
        </div>
      </aside>

      <style>{`
        @keyframes pp-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pp-slide-in { from { transform: translateX(-100%); } to { transform: translateX(0); } }
        .animate-pp-fade     { animation: pp-fade 200ms ease-out; }
        .animate-pp-slide-in { animation: pp-slide-in 280ms cubic-bezier(0.32,0.72,0,1); }
      `}</style>
    </>
  );
}

function findNodeByPath(nodes: LocalFileNode[], path: string): LocalFileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findNodeByPath(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

// ────────────────────────────────────────────
// 右侧：文件内容
// ────────────────────────────────────────────
function FileBody({
  projectId,
  path,
  managed,
  capabilitySetAssets,
  assetTypes,
  onOpenAsset,
}: {
  projectId: string;
  path: string;
  managed: boolean;
  capabilitySetAssets?: { id: string; name: string }[];
  assetTypes?: Map<string, AssetType>;
  onOpenAsset?: (assetId: string) => void;
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<{ content: string | null }>(
        `/projects/${projectId}/files?path=${encodeURIComponent(path)}`,
      )
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) setContent(res.data.content ?? "");
        else setError(res.error || "读取失败");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  const fileName = path.split("/").pop() ?? path;
  const isMcp = isMcpJson(path);

  // 反查所属 Asset（用于 chip 类型 + 「查看 Asset」按钮）
  let assetLink: { id: string; name: string } | null = null;
  let assetType: AssetType | undefined;
  if (managed && !isMcp && capabilitySetAssets && capabilitySetAssets.length > 0) {
    const name = assetNameFromPath(path);
    if (name) {
      const hit = capabilitySetAssets.find((a) => a.name === name);
      if (hit) {
        assetLink = hit;
        assetType = assetTypes?.get(hit.id);
      }
    }
  }

  return (
    <>
      {/* 顶部主行：路径 + chips + 查看 Asset；关闭按钮浮在 aside 右上不占这条 */}
      <div className="px-6 py-3 border-b border-surface-sunken flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <code className="text-[12px] font-mono text-text-primary block truncate">{path}</code>
          <div className="flex items-center gap-1.5 mt-1.5">
            {assetType && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${TYPE_CHIP[assetType]}`}>
                {assetType.toUpperCase()}
              </span>
            )}
            {isMcp && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-mcp-green-bg text-mcp-green-text">
                MCP 聚合配置
              </span>
            )}
          </div>
        </div>
        {assetLink && (
          <button
            type="button"
            onClick={() => onOpenAsset?.(assetLink!.id)}
            disabled={!onOpenAsset}
            className="shrink-0 mr-9 inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-brand border border-brand/25 rounded-lg hover:bg-brand-soft disabled:opacity-50"
          >
            查看 Asset
            <ExternalLink size={12} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {error ? (
          <div className="p-6 text-sm text-red-600">{error}</div>
        ) : (
          <ContentViewer content={content} fileName={fileName} loading={loading} hideName />
        )}
      </div>
    </>
  );
}

// ────────────────────────────────────────────
// 右侧：目录列表
// ────────────────────────────────────────────
function DirBody({
  node,
  assetTypes,
  assetAliases,
  onSelectChild,
}: {
  node: LocalFileNode;
  assetTypes?: Map<string, AssetType>;
  assetAliases?: Map<string, string>;
  onSelectChild?: (target: PreviewTarget) => void;
}) {
  const children = node.children ?? [];

  let fileCount = 0;
  let dirCount = 0;
  for (const c of children) {
    if (c.type === "dir") dirCount++;
    else fileCount++;
  }

  return (
    <>
      {/* 顶部主行：路径主角 + 摘要副；关闭按钮浮在 aside 右上 */}
      <div className="px-6 py-3 border-b border-surface-sunken">
        <code className="text-[12px] font-mono text-text-primary block truncate">
          {node.path}/
        </code>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-text-secondary flex-wrap">
          <span>共 {children.length} 项</span>
          {dirCount > 0 && <span className="text-text-muted">· {dirCount} 个子目录</span>}
          {fileCount > 0 && <span className="text-text-muted">· {fileCount} 个文件</span>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {children.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-text-muted">该目录为空</div>
        ) : (
          <ul className="py-2">
            {children.map((c) => (
              <DirChildRow
                key={c.path}
                child={c}
                assetTypes={assetTypes}
                assetAliases={assetAliases}
                onClick={() => {
                  if (!onSelectChild) return;
                  if (c.type === "dir") onSelectChild({ kind: "dir", path: c.path, node: c });
                  else if (!c.virtual) onSelectChild({ kind: "file", path: c.path, managed: c.managed });
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function DirChildRow({
  child,
  assetAliases,
  onClick,
}: {
  child: LocalFileNode;
  /** 当前组件不再用，保留 prop 兼容父级传参 */
  assetTypes?: Map<string, AssetType>;
  assetAliases?: Map<string, string>;
  onClick: () => void;
}) {
  const isDir = child.type === "dir";
  const enabled = child.enabled !== false;
  const interactive = isDir || !child.virtual;
  const alias = child.assetId ? assetAliases?.get(child.assetId) : undefined;

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={!interactive}
        className="w-full flex items-center gap-2.5 px-6 py-2 text-left hover:bg-surface-card/70 disabled:cursor-default"
      >
        {isDir ? (
          <Folder size={14} className="text-text-muted shrink-0" />
        ) : (
          <FileText
            size={14}
            className={`shrink-0 ${child.managed && enabled ? "text-brand" : "text-text-muted"}`}
          />
        )}
        <span
          className={`text-[13px] truncate flex-1 ${
            isDir
              ? "text-text-primary font-medium"
              : !enabled
                ? "text-text-muted"
                : child.managed
                  ? "text-text-primary font-medium"
                  : "text-text-secondary"
          }`}
        >
          {child.name}
          {isDir && <span className="text-text-muted font-normal">/</span>}
        </span>
        {alias && (
          <span className="text-[11px] text-text-muted truncate shrink-0 max-w-[35%]">{alias}</span>
        )}
        {!enabled && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-sunken text-text-muted">
            已关闭
          </span>
        )}
        {/* 类型 chip 已撤除：父级目录已按类型分（agents/、commands/、...） */}
        {isDir && (
          <span className="text-[10px] text-text-muted font-mono">
            {child.children?.length ?? 0} 项
          </span>
        )}
      </button>
    </li>
  );
}
