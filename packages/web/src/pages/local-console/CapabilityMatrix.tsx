/**
 * CapabilityMatrix —— 按能力的矩阵视图。
 *
 * 数据源：LocalProjectState.capabilities（已经按 (asset, tool) 投影好的扁平视图）。
 * 列：仅展示 vendors[tool].exists === true 的厂商；未创建厂商不出现。
 * 单元格状态：
 *   - 已开（lock 中 enabled=true）→ brand toggle
 *   - 已关（lock 中 enabled=false）→ 灰 toggle
 *   - 不支持（adapter 不处理该 type）→ 灰文 "不支持"
 *   - 未在 lock（其它能力安装到了别的 vendor，本 vendor 不在 defaultTargets）→ "—"
 *
 * 类型筛选：全部 / SKILL / RULE / MCP / HOOK / COMMAND / AGENT。计数实时显示。
 * 来源筛选（ADR-0006）：全部 / 各订阅空间 / 单独添加，按 cap.sources 过滤；
 * 名称格内在别名后渲染来源徽标（多个 = 共享能力，workspaceId=null →「单独添加」）。
 */
import { useMemo, useState } from "react";
import { ADAPTER_SUPPORT, ASSET_TYPES, TARGET_TOOLS, TARGET_TOOL_LABELS } from "@maolinc/cc-loom-shared";
import type {
  AssetCapability,
  AssetType,
  TargetTool,
  VendorMirror,
} from "@maolinc/cc-loom-shared";
import { MoreHorizontal, Search, Slash, Activity } from "lucide-react";
import { CountIndicator } from "./_vendorBadge.js";
import ToolIcon from "../../components/ToolIcon.js";

/** 「来源空间」过滤器的选项；workspaceId=null 表示「单独添加」（隐式订阅）。 */
export interface CapabilitySourceOption {
  workspaceId: string | null;
  name: string;
}

/** 过滤器内部 key：null 来源用 "implicit" 占位（避免与 "all" 混淆）。 */
const IMPLICIT_SOURCE_KEY = "implicit";
const sourceKey = (workspaceId: string | null) => workspaceId ?? IMPLICIT_SOURCE_KEY;

interface Props {
  capabilities: AssetCapability[];
  vendors: Record<TargetTool, VendorMirror>;
  /** assetId → 别名（灰色辅助展示，名称为主）。 */
  assetAliases?: Map<string, string>;
  /** assetId → 描述（hover 提示，取创建能力时的描述）。 */
  assetDescriptions?: Map<string, string>;
  /** 「来源空间」过滤器选项（项目的订阅集合，含「单独添加」）。 */
  sourceOptions?: CapabilitySourceOption[];
  onToggle: (assetId: string, tool: TargetTool, enabled: boolean) => void;
  onRemove: (assetId: string) => void;
  /** 点击能力名称 → 打开详情面板预览 */
  onPreview?: (assetId: string) => void;
  /** legacy lock：禁用 toggle/移除 */
  disabled?: boolean;
}

const TYPE_CHIP: Record<AssetType, string> = {
  skill: "bg-skill-blue-bg text-skill-blue-text border-skill-blue-text/20",
  rule: "bg-rule-yellow-bg text-rule-yellow-text border-rule-yellow-text/20",
  mcp: "bg-mcp-green-bg text-mcp-green-text border-mcp-green-text/20",
  hook: "bg-hook-purple-bg text-hook-purple-text border-hook-purple-text/20",
  command: "bg-command-cyan-bg text-command-cyan-text border-command-cyan-text/20",
  agent: "bg-agent-coral-bg text-agent-coral-text border-agent-coral-text/20",
};

export default function CapabilityMatrix({
  capabilities,
  vendors,
  assetAliases,
  assetDescriptions,
  sourceOptions,
  onToggle,
  onRemove,
  onPreview,
  disabled,
}: Props) {
  const [filter, setFilter] = useState<AssetType | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // 仅展示已创建的厂商列
  const visibleTools = useMemo(
    () => TARGET_TOOLS.filter((t) => vendors[t]?.exists),
    [vendors],
  );

  // 类型计数
  const typeCounts = useMemo(() => {
    const acc: Record<AssetType, number> = { skill: 0, rule: 0, mcp: 0, hook: 0, command: 0, agent: 0 };
    for (const c of capabilities) acc[c.type]++;
    return acc;
  }, [capabilities]);

  // 来源计数（按 cap.sources 归属；共享能力在每个来源下各计一次）
  const sourceCounts = useMemo(() => {
    const acc = new Map<string, number>();
    for (const c of capabilities) {
      for (const s of c.sources ?? []) {
        const key = sourceKey(s.workspaceId);
        acc.set(key, (acc.get(key) ?? 0) + 1);
      }
    }
    return acc;
  }, [capabilities]);

  // 「来源空间」过滤器只展示实际出现过的来源
  const visibleSources = useMemo(
    () => (sourceOptions ?? []).filter((o) => (sourceCounts.get(sourceKey(o.workspaceId)) ?? 0) > 0),
    [sourceOptions, sourceCounts],
  );

  // 过滤后的能力
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return capabilities.filter((c) => {
      if (filter !== "all" && c.type !== filter) return false;
      if (sourceFilter !== "all") {
        const wid = sourceFilter === IMPLICIT_SOURCE_KEY ? null : sourceFilter;
        if (!(c.sources ?? []).some((s) => s.workspaceId === wid)) return false;
      }
      if (q && !c.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [capabilities, filter, sourceFilter, query]);

  return (
    <div className="animate-fade-in">
      {/* ───── 工具栏 ───── */}
      <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <div role="toolbar" aria-label="类型筛选" className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10.5px] font-semibold tracking-wide text-text-muted uppercase mr-1">
              筛选
            </span>
            <FilterChip label="全部" count={capabilities.length} active={filter === "all"} onClick={() => setFilter("all")} />
            {ASSET_TYPES.map((t) => (
              <FilterChip
                key={t}
                type={t}
                label={t.toUpperCase()}
                count={typeCounts[t]}
                active={filter === t}
                onClick={() => setFilter(t)}
              />
            ))}
          </div>
          {visibleSources.length > 0 && (
            <div role="toolbar" aria-label="来源空间筛选" className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10.5px] font-semibold tracking-wide text-text-muted uppercase mr-1">
                来源空间
              </span>
              <FilterChip
                label="全部"
                count={capabilities.length}
                active={sourceFilter === "all"}
                onClick={() => setSourceFilter("all")}
              />
              {visibleSources.map((o) => (
                <FilterChip
                  key={sourceKey(o.workspaceId)}
                  label={o.workspaceId === null ? "单独添加" : o.name}
                  count={sourceCounts.get(sourceKey(o.workspaceId)) ?? 0}
                  active={sourceFilter === sourceKey(o.workspaceId)}
                  onClick={() => setSourceFilter(sourceKey(o.workspaceId))}
                />
              ))}
            </div>
          )}
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索能力..."
            aria-label="搜索能力"
            className="pl-7 pr-3 py-1.5 text-xs bg-surface-card border border-transparent rounded-md focus:outline-none focus:bg-white focus:border-brand placeholder:text-text-muted w-44"
          />
        </div>
      </div>

      {/* ───── 矩阵 ───── */}
      <div className="rounded-2xl border border-surface-sunken bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-card/70 border-b border-surface-sunken">
              <tr>
                <th className="text-left px-4 py-3 text-[10.5px] font-semibold tracking-wide text-text-muted uppercase min-w-[260px]">
                  能力
                </th>
                {visibleTools.map((t) => {
                  const m = vendors[t]!;
                  return (
                    <th key={t} className="px-3 py-2.5 align-middle whitespace-nowrap text-left">
                      <div className="inline-flex items-center gap-2">
                        <ToolIcon tool={t} size={24} />
                        <div className="flex items-center gap-1">
                          <CountIndicator mirror={m} />
                        </div>
                      </div>
                    </th>
                  );
                })}
                <th className="px-3 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={visibleTools.length + 2} className="px-4 py-12 text-center text-sm text-text-muted">
                    没有匹配的能力
                    {query && ` · 搜索 "${query}"`}
                  </td>
                </tr>
              ) : (
                filtered.map((cap) => {
                  const menuKey = `cap:${cap.assetId}`;
                  // 是否有可预览的市场 Asset（受管才有真实 assetId；纯磁盘副本无详情可看）
                  const hasAsset = !cap.assetId.startsWith("external:");
                  const alias = assetAliases?.get(cap.assetId);
                  const desc = assetDescriptions?.get(cap.assetId);
                  return (
                    <tr key={cap.assetId} className="border-t border-gray-50 transition-colors hover:bg-brand-soft/15">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {hasAsset ? (
                            <button
                              type="button"
                              onClick={() => onPreview?.(cap.assetId)}
                              title={desc || undefined}
                              className="flex items-center gap-2 hover:opacity-80 transition-opacity text-left"
                            >
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${TYPE_CHIP[cap.type]}`}>
                                {cap.type.toUpperCase()}
                              </span>
                              <span className="text-[13px] font-medium text-text-primary hover:text-brand transition-colors">{cap.name}</span>
                              {alias && <span className="text-[11px] text-text-muted truncate max-w-[160px]">{alias}</span>}
                            </button>
                          ) : (
                            <span className="flex items-center gap-2" title={desc || undefined}>
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${TYPE_CHIP[cap.type]}`}>
                                {cap.type.toUpperCase()}
                              </span>
                              <span className="text-[13px] font-medium text-text-primary">{cap.name}</span>
                              {alias && <span className="text-[11px] text-text-muted truncate max-w-[160px]">{alias}</span>}
                            </span>
                          )}
                          {cap.sources && cap.sources.length > 0 && <SourceBadges sources={cap.sources} />}
                          {cap.type === "skill" && (cap.invocationCount ?? 0) > 0 && (
                            <span
                              className="inline-flex items-center gap-1 text-[10.5px] text-text-muted bg-surface-sunken rounded-full px-1.5 py-0.5"
                              title={`本地累计被调用 ${cap.invocationCount} 次`}
                            >
                              <Activity size={10} />
                              {cap.invocationCount}
                            </span>
                          )}
                          {cap.type === "hook" && capHookEvents(cap).length > 0 && (
                            <HookEventChips events={capHookEvents(cap)} />
                          )}
                        </div>
                      </td>

                      {visibleTools.map((t) => {
                        const supports = ADAPTER_SUPPORT[t].includes(cap.type);
                        const cell = cap.vendors[t];

                        if (!supports) {
                          return (
                            <td key={t} className="text-center px-2" title={`${TARGET_TOOL_LABELS[t]} 不支持 ${cap.type.toUpperCase()} 类型`}>
                              <span className="inline-flex items-center gap-0.5 text-[10.5px] text-text-muted/70">
                                <Slash size={10} />
                                不支持
                              </span>
                            </td>
                          );
                        }
                        if (!cell) {
                          // 支持但该厂商目录里没有这份能力
                          return (
                            <td
                              key={t}
                              className="text-center px-2 text-[12px] text-text-muted/60"
                              title={`${TARGET_TOOL_LABELS[t]} · 该厂商目录下没有此能力`}
                            >
                              —
                            </td>
                          );
                        }
                        // 所见即所得：该厂商目录下有这份能力就给开关；受管/磁盘副本对用户不作区分，
                        // toggle 时内部自动决定是否 adopt。
                        const filesPart = cell.files.length > 0 ? cell.files.join("\n") : "（暂无文件）";
                        const tooltip = `${TARGET_TOOL_LABELS[t]}\n${filesPart}`;
                        return (
                          <td key={t} className="text-center px-2">
                            <CellToggle
                              enabled={cell.enabled}
                              disabled={disabled}
                              label={`${cap.name} 在 ${TARGET_TOOL_LABELS[t]}`}
                              tooltip={tooltip}
                              onClick={() => onToggle(cap.assetId, t, !cell.enabled)}
                            />
                          </td>
                        );
                      })}

                      <td className="text-center px-2 relative">
                        <button
                          type="button"
                          aria-label="更多操作"
                          disabled={disabled}
                          className="w-7 h-7 grid place-items-center text-text-muted/70 hover:text-text-secondary hover:bg-surface-sunken rounded-md mx-auto disabled:opacity-50"
                          onClick={() => setOpenMenu((cur) => (cur === menuKey ? null : menuKey))}
                        >
                          <MoreHorizontal size={14} />
                        </button>
                        {openMenu === menuKey && (
                          <div
                            className="absolute right-2 top-9 z-20 bg-white border border-surface-sunken rounded-lg shadow-lg text-xs py-1 min-w-40"
                            onMouseLeave={() => setOpenMenu(null)}
                          >
                            <button
                              type="button"
                              className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600"
                              onClick={() => {
                                setOpenMenu(null);
                                onRemove(cap.assetId);
                              }}
                            >
                              移除该能力…
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 矩阵脚注图例 */}
        <div className="px-4 py-2.5 border-t border-surface-sunken bg-surface-card/50 text-[10.5px] text-text-muted flex items-center gap-4 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-brand" />
            已启用
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-gray-300" />
            已关闭
          </span>
          <span className="inline-flex items-center gap-1">
            <Slash size={10} /> 不支持 = Adapter 不处理该类型
          </span>
          <span>— = 该厂商目录下没有此能力</span>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────
// hook 事件标识：能力级声明事件（server enrichment）优先，否则厂商扫描并集
// ────────────────────────────────────────────
function capHookEvents(cap: AssetCapability): string[] {
  if (cap.hookEvents?.length) return cap.hookEvents;
  const union = new Set<string>();
  for (const v of Object.values(cap.vendors)) {
    for (const ev of v?.hookEvents ?? []) union.add(ev);
  }
  return [...union];
}

function HookEventChips({ events }: { events: string[] }) {
  const shown = events.slice(0, 3);
  const rest = events.length - shown.length;
  return (
    <span className="inline-flex items-center gap-1 flex-wrap" title={`注册事件：${events.join(", ")}`}>
      {shown.map((e) => (
        <span
          key={e}
          className="text-[9.5px] font-medium px-1 py-px rounded bg-hook-purple-bg/60 text-hook-purple-text/80 border border-hook-purple-text/15"
        >
          {e}
        </span>
      ))}
      {rest > 0 && <span className="text-[9.5px] text-text-muted">+{rest}</span>}
    </span>
  );
}

// ────────────────────────────────────────────
// 来源空间徽标（ADR-0006）：多个 = 共享能力；workspaceId=null →「单独添加」
// ────────────────────────────────────────────
function SourceBadges({ sources }: { sources: { workspaceId: string | null; name: string }[] }) {
  return (
    <span
      className="inline-flex items-center gap-1 flex-wrap"
      title={`来源：${sources.map((s) => (s.workspaceId === null ? "单独添加" : s.name)).join("、")}`}
    >
      {sources.map((s) => (
        <span
          key={s.workspaceId ?? "implicit"}
          className={`text-[9.5px] font-medium px-1 py-px rounded border ${
            s.workspaceId === null
              ? "bg-surface-card text-text-muted border-gray-200"
              : "bg-brand-soft/50 text-brand border-brand/15"
          }`}
        >
          {s.workspaceId === null ? "单独添加" : s.name}
        </span>
      ))}
    </span>
  );
}

// ────────────────────────────────────────────
// 类型筛选 chip
// ────────────────────────────────────────────
function FilterChip({
  label,
  count,
  active,
  type,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  type?: AssetType;
  onClick: () => void;
}) {
  const base = "px-2.5 py-1 text-[11px] font-medium rounded-full border inline-flex items-center gap-1 transition-colors";
  let cls: string;
  if (type) {
    const tone = TYPE_CHIP[type];
    cls = active
      ? `${tone} font-bold ring-2 ring-current/30`
      : `${tone} hover:opacity-80`;
  } else {
    cls = active
      ? "bg-text-primary text-white border-text-primary"
      : "bg-white border-gray-200 text-text-secondary hover:bg-surface-card";
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${base} ${cls}`}
    >
      {label}
      <span className="opacity-70">{count}</span>
    </button>
  );
}

// ────────────────────────────────────────────
// 单元格 toggle（与 MirrorTreeView 保持一致的视觉）
// ────────────────────────────────────────────
function CellToggle({
  enabled,
  disabled,
  label,
  tooltip,
  onClick,
}: {
  enabled: boolean;
  disabled?: boolean;
  /** 屏幕阅读器用：能力 + 厂商。 */
  label: string;
  /** 视觉 hover 用：厂商 + 文件路径。可多行（\n 分隔）。 */
  tooltip?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={tooltip ?? label}
      disabled={disabled}
      onClick={onClick}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        enabled ? "bg-brand" : "bg-gray-300"
      } hover:shadow-[0_0_0_4px_rgba(75,90,211,0.08)] disabled:opacity-50`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
