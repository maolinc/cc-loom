import { ASSET_TYPE_LABELS, ASSET_TYPE_COLORS, sortTargetTools } from "@maolinc/cc-loom-shared";
import type { CapabilitySet, AssetType } from "@maolinc/cc-loom-shared";
import { ArrowRight } from "lucide-react";
import ToolIcon from "./ToolIcon.js";
import { formatAuthorName } from "../lib/assetDisplay.js";
import { formatRelativeTime } from "../lib/time.js";

interface Props {
  capabilitySet: CapabilitySet & { assetIds?: string[]; assetTypes?: string[] };
  onClick: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export default function CapabilitySetCard({ capabilitySet, onClick, className, style }: Props) {
  const typeCounts: Record<string, number> = {};
  const fromSource = !!capabilitySet.sourceId || !!(capabilitySet as any).source_id;
  const importer = capabilitySet.sourceAddedBy ?? (capabilitySet as any).source_added_by;
  const author = capabilitySet.author ?? (capabilitySet as any).author;
  const sourceName = capabilitySet.sourceDisplayName ?? (capabilitySet as any).source_display_name;
  // 作者：导入的能力集显示导入者，本地创建的显示创建者。与能力市场卡片对齐。
  const displayAuthor = fromSource ? (importer ?? author) : author;
  const sourceLabel = fromSource ? truncate(sourceName ?? "第三方", 24) : null;
  const types = capabilitySet.assetTypes || [];
  for (const t of types) {
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const totalAssets = types.length;

  return (
    <div
      onClick={onClick}
      style={style}
      className={`card-bento p-5 cursor-pointer group flex flex-col ${className ?? ""}`}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <h3 className="font-semibold tracking-tight text-text-primary group-hover:text-brand transition-colors">{capabilitySet.name}</h3>
        <div className="flex items-center gap-1 shrink-0">
          {fromSource && (
            <span title={sourceName ?? undefined} className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-surface-sunken text-text-secondary">
              第三方
            </span>
          )}
          <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium ${
            capabilitySet.visibility === "public" ? "bg-mcp-green-bg text-mcp-green-text" : "bg-surface-sunken text-text-muted"
          }`}>
            {capabilitySet.visibility === "public" ? "公开" : "个人"}
          </span>
        </div>
      </div>

      {capabilitySet.description && (
        <p className="text-sm text-text-secondary line-clamp-2 mb-3 leading-relaxed">{capabilitySet.description}</p>
      )}

      <div className="flex flex-wrap gap-1.5 mb-4">
        {Object.entries(typeCounts).map(([type, count]) => {
          const c = ASSET_TYPE_COLORS[type as AssetType];
          return (
            <span
              key={type}
              className="px-2 py-0.5 rounded-full text-xs font-medium"
              style={c ? { backgroundColor: c.bg, color: c.text } : undefined}
            >
              {count} {ASSET_TYPE_LABELS[type as keyof typeof ASSET_TYPE_LABELS] || type}
            </span>
          );
        })}
        {totalAssets === 0 && <span className="text-xs text-text-muted">暂无能力</span>}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-text-muted pt-3 border-t border-surface-sunken">
        <span className="truncate min-w-0 flex-1">
          {displayAuthor ? `${formatAuthorName(displayAuthor)} · ` : ""}
          {formatRelativeTime(capabilitySet.updatedAt || capabilitySet.createdAt)}
          {sourceLabel && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-surface-sunken text-text-secondary" title={sourceName ?? undefined}>
              {sourceLabel}
            </span>
          )}
        </span>
        <span className="inline-flex items-center gap-2 shrink-0">
          <span className="flex items-center">
            {sortTargetTools(capabilitySet.targetTools).map((t) => <ToolIcon key={t} tool={t} size={14} className="ml-0.5" />)}
          </span>
          <span className="inline-flex items-center gap-1 text-brand font-medium opacity-0 group-hover:opacity-100 transition-opacity">
            查看 <ArrowRight size={12} />
          </span>
        </span>
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
