import { useEffect, useState } from "react";
import * as Select from "@radix-ui/react-select";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Eye, Check, Lock, Inbox, ChevronDown } from "lucide-react";
import type { Asset } from "@maolinc/cc-loom-shared";
import { ASSET_TYPES, ASSET_TYPE_LABELS, ASSET_TYPE_COLORS } from "@maolinc/cc-loom-shared";
import { assetDisplayName, assetAliasName } from "../lib/assetDisplay.js";
import { api } from "../api.js";
import SearchInput from "./SearchInput.js";

interface SourceOption {
  id: string;
  displayName: string;
  count: number;
}

interface Props {
  assets: Asset[];
  selectedIds: string[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onPreview?: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  typeFilter: string;
  onTypeFilterChange: (type: string) => void;
  /** 按来源筛选（可选）。传入即渲染来源下拉，与能力市场对齐。 */
  sourceFilter?: string;
  onSourceFilterChange?: (source: string) => void;
  /** 已安装（锁定）能力 id：显示为「已安装」，勾选但不可取消。 */
  lockedIds?: string[];
  /** 列表数据加载中（由父组件的服务端拉取/过滤驱动）。 */
  loading?: boolean;
}

export default function AssetBrowser({
  assets,
  selectedIds,
  onAdd,
  onRemove,
  onPreview,
  searchQuery,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  sourceFilter = "",
  onSourceFilterChange,
  lockedIds,
  loading = false,
}: Props) {
  const showSourceFilter = !!onSourceFilterChange;
  const [sources, setSources] = useState<SourceOption[]>([]);
  const lockedSet = new Set(lockedIds ?? []);

  useEffect(() => {
    if (!showSourceFilter) return;
    const controller = new AbortController();
    api.get<SourceOption[]>("/assets/sources", controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      if (res.success && res.data) setSources(res.data);
    });
    return () => controller.abort();
  }, [showSourceFilter]);

  const filtering = !!searchQuery || !!typeFilter || !!sourceFilter;

  return (
    <div className="flex flex-col h-full">
      {/* 筛选头部：搜索独占一行，类型 + 来源作为一条紧凑筛选带 */}
      <div className="px-3 pt-3 pb-2.5 border-b border-surface-sunken space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-text-primary">添加能力</div>
          <div className="text-[11px] text-text-muted tabular-nums">
            {loading ? "加载中…" : `${assets.length} 项`}
          </div>
        </div>

        <SearchInput
          query={searchQuery}
          onQueryChange={onSearchChange}
          showTypes={false}
          placeholder="搜索能力名称、描述…"
        />

        <div className="flex flex-wrap items-center gap-1.5">
          {["", ...ASSET_TYPES].map((t) => {
            const active = typeFilter === t;
            return (
              <button
                key={t || "all"}
                onClick={() => onTypeFilterChange(active ? "" : t)}
                className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  active ? "bg-brand text-white" : "bg-surface-sunken text-text-secondary hover:bg-gray-200"
                }`}
              >
                {t ? ASSET_TYPE_LABELS[t as keyof typeof ASSET_TYPE_LABELS] : "全部"}
              </button>
            );
          })}
          {showSourceFilter && sources.length > 0 && (
            <SourceSelect
              value={sourceFilter}
              onChange={onSourceFilterChange!}
              sources={sources}
            />
          )}
        </div>
      </div>

      {/* 列表 */}
      <Tooltip.Provider delayDuration={250}>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading ? (
            <SkeletonRows />
          ) : assets.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-14 px-4 text-center">
              <div className="w-11 h-11 rounded-full bg-surface-sunken flex items-center justify-center text-text-muted">
                <Inbox size={20} />
              </div>
              <p className="text-sm text-text-secondary">
                {filtering ? "没有符合条件的能力" : "暂无可添加的能力"}
              </p>
              <p className="text-xs text-text-muted">
                {filtering ? "换个关键词、类型或来源试试" : "先在能力市场创建或导入能力"}
              </p>
            </div>
          ) : (
            assets.map((a) => {
              const isLocked = lockedSet.has(a.id);
              const isSelected = isLocked || selectedIds.includes(a.id);
              const colors = ASSET_TYPE_COLORS[a.type];
              const displayName = assetDisplayName(a);
              const aliasName = assetAliasName(a);

              return (
                <Tooltip.Root key={a.id}>
                  <div className="relative group/card">
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          if (isLocked) return;
                          if (isSelected) onRemove(a.id);
                          else onAdd(a.id);
                        }}
                        aria-pressed={isSelected}
                        className={`w-full text-left pl-2.5 pr-8 py-2.5 rounded-lg border transition-colors ${
                          isLocked
                            ? "border-surface-sunken bg-surface-card/60 cursor-default"
                            : isSelected
                              ? "border-brand/40 bg-brand-soft/20 cursor-pointer"
                              : "border-surface-sunken bg-white hover:border-gray-300 hover:bg-surface-card/50 cursor-pointer"
                        }`}
                      >
                        <div className="flex items-start gap-2.5">
                          <span
                            className={`mt-[3px] shrink-0 w-[18px] h-[18px] rounded-full flex items-center justify-center transition-colors ${
                              isLocked
                                ? "bg-gray-300 text-white"
                                : isSelected
                                  ? "bg-brand text-white"
                                  : "border-2 border-gray-200 group-hover/card:border-gray-400"
                            }`}
                          >
                            {isLocked ? <Lock size={9} /> : isSelected ? <Check size={11} strokeWidth={3} /> : null}
                          </span>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0"
                                style={{ backgroundColor: colors.bg, color: colors.text }}
                              >
                                {ASSET_TYPE_LABELS[a.type]}
                              </span>
                              <span className="text-[13px] text-text-primary font-medium truncate">{displayName}</span>
                              {aliasName && (
                                <span className="text-[11px] text-text-muted truncate shrink-0 max-w-[40%]">{aliasName}</span>
                              )}
                            </div>
                            {a.description && (
                              <p className="text-xs text-text-secondary mt-0.5 line-clamp-1 leading-snug">{a.description}</p>
                            )}
                          </div>
                        </div>
                      </button>
                    </Tooltip.Trigger>

                    {onPreview && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onPreview(a.id); }}
                        title="查看详情"
                        className="absolute top-1/2 -translate-y-1/2 right-1.5 w-6 h-6 rounded-md bg-white border border-gray-200 hover:border-brand/40 hover:text-brand flex items-center justify-center opacity-0 group-hover/card:opacity-100 transition-opacity text-text-muted shadow-sm z-10"
                      >
                        <Eye size={12} />
                      </button>
                    )}
                  </div>

                  {a.description && (
                    <Tooltip.Portal>
                      <Tooltip.Content
                        side="right"
                        align="start"
                        sideOffset={8}
                        collisionPadding={12}
                        className="z-[70] max-w-[300px] rounded-lg bg-gray-900 px-3 py-2 text-white shadow-xl"
                      >
                        <div className="text-xs font-semibold mb-0.5">
                          {displayName}
                          {aliasName && <span className="ml-1.5 font-normal text-gray-400">别名 {aliasName}</span>}
                        </div>
                        <p className="text-[11px] leading-relaxed text-gray-200">{a.description}</p>
                        <Tooltip.Arrow className="fill-gray-900" />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  )}
                </Tooltip.Root>
              );
            })
          )}
        </div>
      </Tooltip.Provider>
    </div>
  );
}

/** 来源筛选下拉：Radix Select，避免原生 select 样式失控。 */
function SourceSelect({
  value,
  onChange,
  sources,
}: {
  value: string;
  onChange: (v: string) => void;
  sources: SourceOption[];
}) {
  const active = !!value;
  const options = [
    { value: "all", label: "全部来源" },
    { value: "local", label: "本地创建" },
    ...sources.map((s) => ({ value: s.id, label: `${s.displayName} (${s.count})` })),
  ];

  return (
    <Select.Root
      value={value || "all"}
      onValueChange={(v) => onChange(v === "all" ? "" : v)}
    >
      <Select.Trigger
        aria-label="按来源筛选"
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors focus:outline-none max-w-[170px] ${
          active ? "bg-brand-soft text-brand" : "bg-surface-sunken text-text-secondary hover:bg-gray-200"
        }`}
      >
        <span className="truncate">
          <Select.Value />
        </span>
        <Select.Icon asChild>
          <ChevronDown size={12} className="shrink-0 opacity-70" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={6}
          className="z-[70] min-w-[170px] rounded-lg border border-gray-200 bg-white shadow-xl overflow-hidden"
        >
          <Select.Viewport className="p-1 max-h-[320px]">
            {options.map((o) => (
              <Select.Item
                key={o.value}
                value={o.value}
                className="relative flex items-center pl-2.5 pr-7 py-1.5 rounded-md text-xs text-text-secondary select-none outline-none cursor-pointer data-[highlighted]:bg-surface-sunken data-[state=checked]:text-brand data-[state=checked]:font-medium"
              >
                <Select.ItemText>{o.label}</Select.ItemText>
                <Select.ItemIndicator className="absolute right-2">
                  <Check size={12} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

/** 加载态骨架：与真实行形状一致，避免生硬的转圈。 */
function SkeletonRows() {
  return (
    <div className="space-y-1 animate-pulse">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="pl-2.5 pr-8 py-2.5 rounded-lg border border-surface-sunken bg-white">
          <div className="flex items-start gap-2.5">
            <span className="mt-[3px] w-[18px] h-[18px] rounded-full bg-surface-sunken shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="h-4 w-9 rounded bg-surface-sunken" />
                <span className="h-3.5 w-24 rounded bg-surface-sunken" />
              </div>
              <div className="h-3 w-2/3 rounded bg-surface-sunken mt-1.5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
