import type { Asset, AssetMetadata, RuleMetadata, HookMetadata } from "@maolinc/cc-loom-shared";
import { ASSET_TYPE_LABELS, TARGET_TOOL_LABELS, sortTargetTools } from "@maolinc/cc-loom-shared";
import { Download, FolderGit2, Zap, Activity } from "lucide-react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { assetDisplayName, assetAliasName, formatAuthorName } from "../lib/assetDisplay.js";
import { formatRelativeTime } from "../lib/time.js";
import ToolIcon from "./ToolIcon.js";

const typeColors: Record<string, { bg: string; text: string }> = {
  skill: { bg: "bg-skill-blue-bg", text: "text-skill-blue-text" },
  rule: { bg: "bg-rule-yellow-bg", text: "text-rule-yellow-text" },
  mcp: { bg: "bg-mcp-green-bg", text: "text-mcp-green-text" },
  hook: { bg: "bg-hook-purple-bg", text: "text-hook-purple-text" },
  command: { bg: "bg-command-cyan-bg", text: "text-command-cyan-text" },
  agent: { bg: "bg-agent-coral-bg", text: "text-agent-coral-text" },
};

interface Props {
  asset: Asset;
  onClick: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export default function AssetCard({ asset, onClick, className, style }: Props) {
  const colors = typeColors[asset.type] ?? typeColors.skill!;
  const fromSource = !!asset.sourceId;
  const displayAuthor = fromSource ? (asset.sourceAddedBy ?? asset.author) : asset.author;
  const sourceLabel = fromSource ? truncate(asset.sourceDisplayName ?? "第三方", 24) : null;
  const displayName = assetDisplayName(asset);
  const aliasName = assetAliasName(asset);
  const tools = sortTargetTools(asset.compatibleTools);

  return (
    <div
      onClick={onClick}
      style={style}
      className={`card-bento p-5 cursor-pointer group flex flex-col ${className ?? ""}`}
    >
      {/* 区块 1: 类型 pill + 工具 logo chip */}
      <div className="flex items-center justify-between mb-3">
        <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold tracking-wide ${colors.bg} ${colors.text}`}>
          {ASSET_TYPE_LABELS[asset.type]}
        </span>
        <div className="flex gap-1 items-center">
          {tools.slice(0, 5).map((t) => (
            <ToolIcon key={t} tool={t} size={14} />
          ))}
          {tools.length > 5 && (
            <span
              className="text-[10px] text-text-muted bg-surface-card px-1.5 py-0.5 rounded border border-surface-sunken"
              title={tools.slice(5).map((t) => TARGET_TOOL_LABELS[t]).join("、")}
            >
              +{tools.length - 5}
            </span>
          )}
        </div>
      </div>

      {/* 区块 2: 标题 */}
      <div className="mb-1">
        <h3 className="font-semibold tracking-tight text-text-primary group-hover:text-brand transition-colors">{displayName}</h3>
        {aliasName && <p className="text-[11px] text-text-muted truncate">{aliasName}</p>}
      </div>

      {/* 区块 3: 描述 */}
      <p className="text-sm text-text-secondary line-clamp-2 mb-3 leading-relaxed">{asset.description}</p>

      {/* 区块 4: 类型特色字段 */}
      <TypeMetadataLine asset={asset} />

      {/* 区块 5: tags */}
      <TagsLine tags={asset.tags} />

      {/* 区块 6: 元信息 */}
      <div className="mt-auto flex items-center justify-between gap-2 text-xs text-text-muted pt-3 border-t border-surface-sunken">
        <span className="truncate min-w-0 flex-1">
          {formatAuthorName(displayAuthor)} · {formatRelativeTime(asset.updatedAt || asset.createdAt)}
          {sourceLabel && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-surface-sunken text-text-secondary" title={asset.sourceDisplayName ?? undefined}>
              {sourceLabel}
            </span>
          )}
        </span>
        <span className="inline-flex items-center gap-2 shrink-0">
          {(asset.invocationCount ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-1 text-text-secondary"
              title={`累计被调用 ${asset.invocationCount} 次`}
            >
              <Activity size={12} /> {formatCount(asset.invocationCount!)}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-brand font-medium opacity-0 group-hover:opacity-100 transition-opacity">
            <Download size={12} /> 安装
          </span>
        </span>
      </div>
    </div>
  );
}

function TagsLine({ tags }: { tags: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const [visibleCount, setVisibleCount] = useState(tags?.length ?? 0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const GAP = 4; // gap-1 = 0.25rem
    const compute = () => {
      const containerWidth = container.clientWidth;
      // 容器尚未布局（如父级隐藏中）：保持上一次状态，等 ResizeObserver 再算
      if (containerWidth === 0) return;

      const tagEls = measure.querySelectorAll<HTMLSpanElement>("[data-tag]");
      const widths = Array.from(tagEls, (el) => el.offsetWidth + GAP);
      const pillWidth = (pillRef.current?.offsetWidth ?? 28) + GAP;

      // 全部能放下：不显示 +N
      const total = widths.reduce((a, b) => a + b, 0);
      if (total <= containerWidth) {
        setVisibleCount(tags.length);
        return;
      }
      // 需要给 +N 留位
      const avail = containerWidth - pillWidth;
      let used = 0;
      let count = 0;
      for (let i = 0; i < widths.length; i++) {
        const w = widths[i]!;
        if (used + w > avail) break;
        used += w;
        count++;
      }
      // 至少展示 1 个，避免只剩一个孤零零的 +N
      setVisibleCount(Math.max(count, 1));
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [tags]);

  if (!tags || tags.length === 0) return null;

  const visible = tags.slice(0, visibleCount);
  const hidden = tags.slice(visibleCount);

  return (
    <div ref={containerRef} className="relative flex flex-nowrap gap-1 mb-3 overflow-hidden">
      {/* 测量层：全部标签 + 样例 +N，不可见，仅用于按实际宽度计算可放下几个 */}
      <div ref={measureRef} className="flex flex-nowrap gap-1 absolute invisible pointer-events-none" aria-hidden>
        {tags.map((t) => (
          <span key={t} data-tag className="shrink-0 px-2 py-0.5 rounded-full text-[10px] bg-surface-sunken text-text-secondary">
            {t}
          </span>
        ))}
        <span ref={pillRef} className="shrink-0 px-2 py-0.5 rounded-full text-[10px] bg-surface-sunken text-text-muted">
          +9
        </span>
      </div>
      {/* 可见层 */}
      {visible.map((t) => (
        <span key={t} className="shrink-0 px-2 py-0.5 rounded-full text-[10px] bg-surface-sunken text-text-secondary">
          {t}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          className="shrink-0 px-2 py-0.5 rounded-full text-[10px] bg-surface-sunken text-text-muted cursor-default"
          title={hidden.join("、")}
        >
          +{hidden.length}
        </span>
      )}
    </div>
  );
}

function TypeMetadataLine({ asset }: { asset: Asset }) {
  const md = asset.metadata as AssetMetadata;
  const wrap = (icon: ReactNode, text: string, title?: string) => (
    <div className="flex items-center gap-1.5 text-xs text-text-secondary mb-3 truncate" title={title ?? text}>
      <span className="text-text-muted shrink-0">{icon}</span>
      <span className="truncate">{text}</span>
    </div>
  );
  switch (asset.type) {
    case "rule": {
      const globs = (md as RuleMetadata).globs ?? [];
      if (globs.length === 0) return null;
      const head = globs.slice(0, 2).join(", ");
      const more = globs.length - 2;
      return wrap(<FolderGit2 size={12} />, `${head}${more > 0 ? ` +${more}` : ""}`, globs.join(", "));
    }
    case "mcp":
      // 传输方式 / 命令 / URL 均不在卡片上展示，详情由 mcp.json 文件内容承载
      return null;
    case "hook": {
      const h = md as HookMetadata;
      if (!h.event) return null;
      const text = `${h.event}${h.matcher ? ` · ${h.matcher}` : ""}`;
      return wrap(<Zap size={12} />, text);
    }
    // command 类型不在卡片上展示 trigger（/xxxx）——对快速识别无意义，详情页仍可见
    default:
      return null;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** 紧凑展示调用次数：≥10000 显示 1.2w，≥1000 显示 1.2k。 */
function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, "")}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
