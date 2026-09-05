/**
 * AddWorkspaceMenu —— 「+ 添加空间」下拉菜单（ADR-0006 多空间订阅）。
 *
 * 语义 = 为项目新增一条空间订阅（能力叠加生效），不再是「切换工作空间」：
 *  - 候选列表过滤掉已订阅的空间（重复选择 = 重装，走订阅卡的重装路径）。
 *  - 选中候选 → 触发 plan API 预览 diff；撞车（conflictingAssets）弹
 *    InstallConflictDialog 逐条裁决，execute 携带 skipAssetIds。
 *  - 同步策略可选 auto / locked（挂在订阅上）。
 *  - popover 触发器在父组件；本组件只渲染下拉内容。
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api.js";
import type { InstallPlan, InstallConflict, Workspace, SyncPolicy, TargetTool } from "@maolinc/cc-loom-shared";
import { sortTargetTools, TARGET_TOOL_LABELS } from "@maolinc/cc-loom-shared";
import { Loader2 } from "lucide-react";
import SearchInput from "../../components/SearchInput.js";
import Button from "../../components/Button.js";
import ToolIcon from "../../components/ToolIcon.js";
import InstallConflictDialog from "../../components/InstallConflictDialog.js";
import { executeInstall } from "../../lib/installFlow.js";

interface Props {
  projectId: string;
  /** 项目已订阅的 workspaceId 集合，用于过滤候选列表。 */
  subscribedWorkspaceIds: string[];
  /** 默认目标工具集合，作为安装厂商的预选。 */
  defaultTargets: TargetTool[];
  /** 安装成功后回调，父组件应据此刷新项目镜像。 */
  onInstalled: () => void;
  onClose: () => void;
}

export default function AddWorkspaceMenu({
  projectId,
  subscribedWorkspaceIds,
  defaultTargets,
  onInstalled,
  onClose,
}: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [planning, setPlanning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 安装策略挂在订阅上：auto = 空间更新自动同步；locked = 锁定当前版本。
  const [policy, setPolicy] = useState<SyncPolicy>("auto");
  // 用户在安装时选择要落盘的厂商；选中工作空间后预选与项目 defaultTargets 的交集。
  const [selectedTools, setSelectedTools] = useState<TargetTool[]>([]);
  // plan 报出撞车时弹裁决弹窗（null = 未弹）。
  const [conflicts, setConflicts] = useState<InstallConflict[] | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selected) ?? null,
    [workspaces, selected],
  );

  // 选中工作空间时：预选 defaultTargets ∩ 工作空间声明厂商（保留用户既有选择），
  // 为空再回退全选。
  useEffect(() => {
    if (!selectedWorkspace) {
      setSelectedTools([]);
      return;
    }
    const wsTools = sortTargetTools(selectedWorkspace.targetTools);
    const preset = defaultTargets.filter((t) => selectedWorkspace.targetTools.includes(t));
    setSelectedTools(preset.length > 0 ? sortTargetTools(preset) : wsTools);
  }, [selectedWorkspace, defaultTargets]);

  // 实际安装目标 = 用户勾选集合（已约束在工作空间声明的厂商内）。
  const installTargets = useMemo<TargetTool[]>(
    () => (selectedWorkspace ? selectedTools.filter((t) => selectedWorkspace.targetTools.includes(t)) : []),
    [selectedTools, selectedWorkspace],
  );

  const toggleTool = (t: TargetTool) =>
    setSelectedTools((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : sortTargetTools([...cur, t])));

  // 搜索走服务端（/workspaces?query=），避免只在已加载的一页里过滤导致漏项。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = new URLSearchParams();
    if (searchQuery) params.set("query", searchQuery);
    params.set("pageSize", "50");
    api.get<Workspace[]>(`/workspaces?${params}`).then((res) => {
      if (!alive) return;
      if (res.success && res.data) {
        setWorkspaces(res.data.filter((w) => !subscribedWorkspaceIds.includes(w.id)));
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, [subscribedWorkspaceIds, searchQuery]);

  useEffect(() => {
    if (!selected) { setPlan(null); return; }
    if (installTargets.length === 0) {
      setPlan(null);
      setError("该工作空间没有目标工具，无法安装");
      return;
    }
    setPlanning(true);
    setError(null);
    api.post<{ plan?: InstallPlan } | InstallPlan>("/install/plan", {
      projectId,
      workspaceId: selected,
      targetTools: installTargets,
      policy,
    }).then((res) => {
      if (res.success && res.data) {
        // /install/plan 直接返回 plan；/install/execute 嵌在 .plan 里。
        const p = (res.data as any).plan ?? res.data;
        setPlan(p as InstallPlan);
      } else {
        setError(res.error || "无法生成 plan");
      }
    }).catch((err) => setError(err?.message ?? String(err)))
      .finally(() => setPlanning(false));
  }, [selected, projectId, installTargets, policy]);

  const doInstall = async (skipAssetIds?: string[]) => {
    if (!selected) return;
    setInstalling(true);
    setError(null);
    try {
      if (installTargets.length === 0) {
        setError("该工作空间没有目标工具，无法安装");
        return;
      }
      const res = await executeInstall({
        projectId, workspaceId: selected, targetTools: installTargets, policy, skipAssetIds,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      onInstalled();
      onClose();
    } finally {
      setInstalling(false);
    }
  };

  // 确认安装：有未裁决撞车先弹裁决弹窗，否则直接执行。
  const handleInstall = async () => {
    if (plan?.conflictingAssets && plan.conflictingAssets.length > 0) {
      setConflicts(plan.conflictingAssets);
      return;
    }
    await doInstall();
  };

  return (
    <div className="absolute right-0 top-full mt-2 w-[420px] bg-white rounded-xl border border-surface-sunken shadow-xl z-30 max-h-[70vh] flex flex-col">
      <div className="px-4 py-3 border-b border-surface-sunken flex items-center justify-between">
        <span className="text-sm font-semibold text-text-primary">添加空间</span>
        <button onClick={onClose} className="text-xs text-text-muted hover:text-text-primary">关闭</button>
      </div>
      <div className="px-4 pt-3 pb-2 border-b border-surface-sunken">
        <SearchInput
          query={searchQuery}
          onQueryChange={setSearchQuery}
          showTypes={false}
          placeholder="搜索工作空间名称或描述..."
        />
        {!loading && (
          <div className="mt-2 text-[11px] text-text-muted tabular-nums">
            {searchQuery ? `匹配 ${workspaces.length} 个工作空间` : `共 ${workspaces.length} 个可添加的工作空间`}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-8 text-sm text-text-muted flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" /> 加载中…
          </div>
        ) : workspaces.length === 0 ? (
          <div className="px-4 py-8 text-sm text-text-muted text-center">
            {searchQuery ? `未找到包含“${searchQuery}”的工作空间` : "暂无可添加的工作空间"}
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {workspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => setSelected(w.id === selected ? null : w.id)}
                className={`w-full text-left p-3 rounded-lg border transition-colors ${
                  selected === w.id ? "border-brand/30 bg-brand-soft/40" : "border-surface-sunken hover:border-gray-200"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text-primary">{w.name}</span>
                  <span className="text-xs text-text-muted">v{w.version}</span>
                </div>
                <p className="text-xs text-text-secondary mt-0.5 line-clamp-1">{w.description}</p>
                <div className="flex gap-1 mt-1.5">
                  {sortTargetTools(w.targetTools).map((t) => (
                    <ToolIcon key={t} tool={t} size={14} />
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <div className="border-t border-surface-sunken px-4 py-3 space-y-2.5">
          {/* 厂商选择：用户挑选本次要落盘的厂商（约束在工作空间声明的范围内） */}
          {selectedWorkspace && (
            <div>
              <div className="text-[11px] font-medium text-text-secondary mb-1.5">
                安装到厂商
                <span className="text-text-muted font-normal">（可多选，订阅后还能调整）</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {sortTargetTools(selectedWorkspace.targetTools).map((t) => {
                  const on = selectedTools.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => toggleTool(t)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs transition-colors ${
                        on
                          ? "border-brand/40 bg-brand-soft/50 text-text-primary"
                          : "border-gray-200 text-text-muted hover:border-gray-300"
                      }`}
                    >
                      <ToolIcon tool={t} size={14} />
                      {TARGET_TOOL_LABELS[t]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {/* 同步策略：挂在该订阅上 */}
          <div className="flex items-center gap-3 text-[11px]">
            <span className="font-medium text-text-secondary">同步策略</span>
            <label className="flex items-center gap-1.5 cursor-pointer text-text-secondary">
              <input type="radio" name="add-ws-policy" checked={policy === "auto"} onChange={() => setPolicy("auto")} className="accent-brand" />
              自动同步
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-text-secondary">
              <input type="radio" name="add-ws-policy" checked={policy === "locked"} onChange={() => setPolicy("locked")} className="accent-brand" />
              锁定
            </label>
          </div>
          {planning ? (
            <div className="text-xs text-text-muted flex items-center gap-2"><Loader2 size={12} className="animate-spin" />生成安装计划...</div>
          ) : plan ? (
            <div>
              <div className="text-xs text-text-secondary">
                变更预览：<span className="text-text-primary font-medium">{plan.diff.length}</span> 个文件操作
                {(plan.conflictingAssets?.length ?? 0) > 0 && (
                  <span className="text-amber-600">
                    {" · "}{plan.conflictingAssets!.length} 项同名撞车（安装前需裁决）
                  </span>
                )}
              </div>
            </div>
          ) : null}
          {error && <div className="text-xs text-red-600">{error}</div>}
          <Button
            variant="primary"
            size="sm"
            fullWidth
            loading={installing}
            disabled={!plan || planning || installTargets.length === 0}
            onClick={handleInstall}
          >
            {installTargets.length === 0 ? "请至少选择一个厂商" : "添加该空间"}
          </Button>
        </div>
      )}
      {conflicts && (
        <InstallConflictDialog
          conflicts={conflicts}
          workspaceName={selectedWorkspace?.name}
          busy={installing}
          onCancel={() => setConflicts(null)}
          onConfirm={async (skipAssetIds) => {
            setConflicts(null);
            await doInstall(skipAssetIds);
          }}
        />
      )}
    </div>
  );
}
