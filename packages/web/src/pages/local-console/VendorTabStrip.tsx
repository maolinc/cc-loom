/**
 * VendorTabStrip —— 横向厂商 tab 条。
 *
 * 仅渲染 `mirror.exists === true` 的厂商；未创建的厂商不显示。
 * 每个 tab：
 *   ┌─[CR] Cursor──────┐
 *   │     ● Loom 5    │   active 用 brand 色下划线
 *   │     · 外部 1     │
 *   └──────────────────┘
 *
 * 顶部右侧固定一个"重新扫描该厂商"按钮，position 不随 tab 切换变化。
 */
import { useMemo } from "react";
import { TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import type { TargetTool, VendorMirror } from "@maolinc/cc-loom-shared";
import { RefreshCw } from "lucide-react";
import { CountIndicator } from "./_vendorBadge.js";
import ToolIcon from "../../components/ToolIcon.js";

interface Props {
  vendors: Record<TargetTool, VendorMirror>;
  active: TargetTool | null;
  onSelect: (tool: TargetTool) => void;
  /** 是否正在 force scan（按钮 spinner）。 */
  refreshing?: boolean;
  onRefresh: () => void;
}

export default function VendorTabStrip({ vendors, active, onSelect, refreshing, onRefresh }: Props) {
  const visible = useMemo(
    () => TARGET_TOOLS.filter((t) => vendors[t]?.exists),
    [vendors],
  );

  if (visible.length === 0) {
    return null;
  }

  return (
    <div role="tablist" aria-label="厂商目录" className="flex items-stretch gap-1 border-b border-surface-sunken mb-3 -mx-1 px-1 overflow-x-auto">
      {visible.map((tool) => {
        const m = vendors[tool]!;
        const isActive = active === tool;
        return (
          <button
            key={tool}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(tool)}
            className={`group relative px-3.5 py-2.5 flex items-center gap-2.5 border-b-2 shrink-0 -mb-px transition-colors ${
              isActive
                ? "border-brand text-text-primary"
                : "border-transparent text-text-secondary hover:text-text-primary hover:border-gray-200"
            }`}
          >
            <ToolIcon tool={tool} size={24} />
            <div className="text-left">
              <div className="flex items-center gap-1 mt-0.5">
                <CountIndicator mirror={m} />
              </div>
            </div>
          </button>
        );
      })}

      <div className="ml-auto flex items-center gap-2 px-2 shrink-0 self-center">
        {active && vendors[active]?.exists && (
          <code className="text-[11px] text-text-muted font-mono hidden lg:inline">
            {vendors[active]!.dir}/
          </code>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="重新扫描当前厂商目录"
          title="重新扫描（强制 agent 刷新缓存）"
          className="w-8 h-8 grid place-items-center rounded-md text-text-muted hover:bg-surface-card hover:text-text-secondary disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
        </button>
      </div>
    </div>
  );
}
