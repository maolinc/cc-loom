import { useState, useEffect, useRef, type ReactNode } from "react";
import { X, Search } from "lucide-react";
import { ASSET_TYPES, ASSET_TYPE_LABELS } from "@maolinc/cc-loom-shared";
import Button from "./Button.js";

interface SearchInputProps {
  query: string;
  onQueryChange: (q: string) => void;
  typeFilter?: string;
  typeFilters?: string[];
  onTypeFilterChange?: (type: string) => void;
  onTypeFiltersChange?: (types: string[]) => void;
  placeholder?: string;
  showTypes?: boolean;
  multiType?: boolean;
  extraFilters?: ReactNode;
  /** 主操作区（如「创建能力」按钮），仅在 stacked 布局中渲染在搜索框右侧。 */
  actions?: ReactNode;
  /**
   * 两行布局：搜索框独占一行（右侧可放 actions），类型与附加筛选置于第二行。
   * 用于筛选项较多、单行会拥挤的页面（如能力市场）。默认单行。
   */
  stacked?: boolean;
  /**
   * 手动提交模式：输入不再自动触发搜索，改为按 Enter 或点击搜索按钮时才提交。
   * 启用后渲染内置搜索按钮，占据 actions 位置。用于能力市场 / 能力集列表。
   */
  manualSubmit?: boolean;
  /** 搜索进行中：搜索按钮转圈并禁用，避免重复提交。 */
  loading?: boolean;
}

export default function SearchInput({
  query,
  onQueryChange,
  typeFilter,
  typeFilters,
  onTypeFilterChange,
  onTypeFiltersChange,
  placeholder = "搜索...",
  showTypes = true,
  multiType = false,
  extraFilters,
  actions,
  stacked = false,
  manualSubmit = false,
  loading = false,
}: SearchInputProps) {
  const [localQuery, setLocalQuery] = useState(query);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  const handleChange = (value: string) => {
    setLocalQuery(value);
    if (manualSubmit) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onQueryChange(value);
    }, 300);
  };

  const handleSubmit = () => {
    clearTimeout(timerRef.current);
    onQueryChange(localQuery);
  };

  const handleClear = () => {
    setLocalQuery("");
    clearTimeout(timerRef.current);
    onQueryChange("");
  };

  const selectedTypes = multiType
    ? (typeFilters ?? [])
    : (typeFilter ? [typeFilter] : []);
  const activeType = multiType ? null : (typeFilter ?? "");

  const toggleType = (t: string) => {
    if (multiType && onTypeFiltersChange) {
      // "全部" (t === "") clears the filter set; never store "" as a real filter.
      if (t === "") {
        onTypeFiltersChange([]);
        return;
      }
      const next = selectedTypes.includes(t)
        ? selectedTypes.filter((x) => x !== t)
        : [...selectedTypes, t];
      onTypeFiltersChange(next);
    } else if (!multiType && onTypeFilterChange) {
      onTypeFilterChange(activeType === t ? "" : t);
    }
  };

  const searchBox = (
    <div className={`relative ${stacked ? "flex-1 min-w-0" : "flex-1 min-w-[200px] max-w-md"}`}>
      <Search
        size={stacked ? 16 : 14}
        className={`absolute ${stacked ? "left-3.5" : "left-3"} top-1/2 -translate-y-1/2 text-text-muted pointer-events-none`}
      />
      <input
        type="text"
        value={localQuery}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={manualSubmit ? (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSubmit();
          }
        } : undefined}
        placeholder={placeholder}
        className={
          stacked
            ? "w-full pl-10 pr-9 py-2.5 rounded-xl border border-gray-200 bg-white text-sm placeholder:text-text-muted transition-all focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
            : "w-full pl-9 pr-8 py-2 rounded-xl border border-gray-200 bg-white text-sm placeholder:text-text-muted transition-all focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
        }
      />
      {localQuery && (
        <button
          onClick={handleClear}
          aria-label="清除搜索"
          className={`absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary ${
            stacked ? "w-5 h-5 flex items-center justify-center rounded-full hover:bg-surface-sunken transition-colors" : ""
          }`}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );

  const typePills = showTypes ? (
    <div className="flex gap-1.5 flex-wrap">
      {["", ...ASSET_TYPES].map((t) => {
        const isActive = multiType
          ? (t === "" ? selectedTypes.length === 0 : selectedTypes.includes(t))
          : activeType === t;
        return (
          <button
            key={t}
            onClick={() => toggleType(t)}
            className={`px-3.5 h-7 rounded-full text-xs font-medium transition-colors ${
              isActive
                ? "bg-brand text-white shadow-sm shadow-brand/25"
                : "bg-surface-sunken text-text-secondary hover:bg-gray-200 hover:text-text-primary"
            }`}
          >
            {t ? ASSET_TYPE_LABELS[t as keyof typeof ASSET_TYPE_LABELS] : "全部"}
          </button>
        );
      })}
    </div>
  ) : null;

  const searchButton = manualSubmit ? (
    <Button variant="primary" leftIcon={<Search size={16} />} loading={loading} onClick={handleSubmit}>
      搜索
    </Button>
  ) : null;

  // 两行布局：搜索框 + 主操作在上，类型与附加筛选在下（筛选项多时避免拥挤）。
  if (stacked) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          {searchBox}
          {searchButton && <div className="shrink-0">{searchButton}</div>}
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
        {(showTypes || extraFilters) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {typePills}
            {extraFilters && <div className="flex items-center gap-2 ml-auto">{extraFilters}</div>}
          </div>
        )}
      </div>
    );
  }

  // 默认单行布局。
  return (
    <div className="flex flex-wrap items-center gap-2">
      {searchBox}
      {searchButton}
      {typePills}
      {extraFilters}
      {actions}
    </div>
  );
}
