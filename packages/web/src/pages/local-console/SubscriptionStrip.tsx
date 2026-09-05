/**
 * SubscriptionStrip —— 订阅条（ADR-0006 多空间订阅）。
 *
 * 取代旧的「当前工作空间卡」：每张显式订阅一张卡（名称、retained 徽标、
 * auto/locked 切换、目标厂商管理行、⋯ 菜单：编辑工作空间 / 导出 / 卸载该订阅）；
 * 若项目有「单独添加的能力」则渲染一张隐式订阅简卡（sync-policy 切换 + 项目级
 * targets 行，无卸载）；末尾「+ 添加空间」卡打开 AddWorkspaceMenu。
 *
 * 同步策略与目标厂商都挂在订阅上：
 *  - sync-policy：POST /projects/:id/subscriptions/:wid/sync-policy（隐式用 "implicit"）
 *  - targets：显式走 /projects/:id/subscriptions/:wid/targets；隐式走项目级 /targets
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Download, Eye, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import type { Project, SyncPolicy, TargetTool, WorkspaceSubscription } from "@maolinc/cc-loom-shared";
import { api } from "../../api.js";
import { useToast } from "../../components/Toast.js";
import ConfirmDialog from "../../components/ConfirmDialog.js";
import ManageTargetsRow from "./ManageTargetsRow.js";
import AddWorkspaceMenu from "./AddWorkspaceMenu.js";

/** 订阅对应工作空间的补充信息（详情接口拉取；retained 空间拉不到时缺省）。 */
export interface SubscriptionWorkspaceMeta {
  description?: string;
  targetTools?: TargetTool[];
}

interface Props {
  project: Project;
  /** workspaceId → 工作空间详情（描述 / 声明厂商），由父组件按订阅集合拉取。 */
  workspaceMeta: Map<string, SubscriptionWorkspaceMeta>;
  /** 项目是否有「单独添加的能力」（决定是否渲染隐式订阅简卡）。 */
  hasStandaloneCapabilities: boolean;
  /** legacy lock：禁用订阅级管理操作。 */
  legacyLock?: boolean;
  /** 任何订阅变更后回调：父组件刷新项目列表 + 本地镜像。 */
  onChanged: () => Promise<void> | void;
  /** 导出本地镜像清单（JSON）。 */
  onExport: () => void;
  /** 打开工作空间详情面板（复用市场/列表的同款 DetailPanel）。 */
  onOpenWorkspace?: (workspaceId: string) => void;
}

export default function SubscriptionStrip({
  project,
  workspaceMeta,
  hasStandaloneCapabilities,
  legacyLock,
  onChanged,
  onExport,
  onOpenWorkspace,
}: Props) {
  const toast = useToast();
  const navigate = useNavigate();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [moreMenuFor, setMoreMenuFor] = useState<string | null>(null);
  const [uninstallSub, setUninstallSub] = useState<WorkspaceSubscription | null>(null);
  const [uninstalling, setUninstalling] = useState(false);

  const explicitSubs = project.subscriptions.filter((s) => s.workspaceId !== null);
  const implicitSub = project.subscriptions.find((s) => s.workspaceId === null) ?? null;

  // 空间过多时默认折叠，避免把下方本地镜像区挤到很远；用户可手动展开管理。
  const [collapsed, setCollapsed] = useState(() => explicitSubs.length > 3);

  const handleSetSyncPolicy = async (sub: WorkspaceSubscription, policy: SyncPolicy) => {
    if (sub.syncPolicy === policy) return;
    const wid = sub.workspaceId ?? "implicit";
    const res = await api.post<{ policy: string }>(
      `/projects/${project.id}/subscriptions/${wid}/sync-policy`,
      { policy },
    );
    if (!res.success) {
      toast.error("操作失败", res.error || "未知错误");
      return;
    }
    await onChanged();
    toast.success(
      policy === "auto" ? "已开启自动同步" : "已锁定版本",
      policy === "auto"
        ? "该空间的后续更新将自动同步到本项目"
        : "该空间的更新不再自动同步，需手动重装",
    );
  };

  const handleUninstallConfirm = async () => {
    if (!uninstallSub?.workspaceId || uninstalling) return;
    setUninstalling(true);
    const name = uninstallSub.workspaceName ?? uninstallSub.workspaceId;
    const res = await api.delete(`/projects/${project.id}/subscriptions/${uninstallSub.workspaceId}`);
    setUninstalling(false);
    setUninstallSub(null);
    if (!res.success) {
      toast.error("卸载失败", res.error || "未知错误");
      return;
    }
    toast.success(`已卸载「${name}」`, "共享能力按引用计数保留，仅清除该订阅独占的文件");
    await onChanged();
  };

  return (
    <div className="mb-7">
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "展开空间订阅" : "折叠空间订阅"}
          aria-expanded={!collapsed}
          className="w-6 h-6 grid place-items-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text-primary transition-colors"
        >
          <ChevronDown size={16} className={`transition-transform ${collapsed ? "-rotate-90" : ""}`} />
        </button>
        <h2 className="text-base font-semibold tracking-tight text-text-primary">空间订阅</h2>
        <span className="text-[11px] text-text-muted">
          {explicitSubs.length > 0 ? `${explicitSubs.length} 个空间，能力叠加生效` : "尚未订阅空间"}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => { setCollapsed(false); setAddMenuOpen(true); }}
          className="inline-flex items-center gap-1.5 px-2.5 h-7 text-xs font-medium text-text-secondary border border-gray-200 rounded-lg bg-white hover:bg-surface-card hover:text-text-primary transition-colors"
        >
          <Plus size={13} />
          添加空间
        </button>
      </div>

      {!collapsed && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {explicitSubs.map((sub) => {
          const wid = sub.workspaceId!;
          const meta = workspaceMeta.get(wid);
          return (
            <div
              key={wid}
              className="relative bg-white rounded-2xl border border-surface-sunken shadow-card p-4 transition-shadow hover:shadow-lift"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="text-sm font-semibold text-text-primary truncate">
                      {sub.workspaceName ?? wid}
                    </h3>
                    {sub.retained && (
                      <span
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100"
                        title="该工作空间已从工作空间库移除，仅因本项目仍在使用而留存"
                      >
                        已下架 · 留存
                      </span>
                    )}
                  </div>
                  {meta?.description && (
                    <p className="text-xs text-text-secondary line-clamp-1">{meta.description}</p>
                  )}
                  <SyncPolicyToggle
                    value={sub.syncPolicy}
                    onChange={(p) => handleSetSyncPolicy(sub, p)}
                  />
                  <ManageTargetsRow
                    projectId={project.id}
                    workspaceTargets={meta?.targetTools ?? sub.targetTools ?? []}
                    activeTargets={sub.targetTools ?? []}
                    endpoint={`/projects/${project.id}/subscriptions/${wid}/targets`}
                    disabled={legacyLock}
                    onChanged={onChanged}
                  />
                </div>
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setMoreMenuFor((cur) => (cur === wid ? null : wid))}
                    aria-label="更多操作"
                    aria-haspopup="menu"
                    className="w-8 h-8 grid place-items-center text-text-muted border border-gray-200 rounded-lg bg-white hover:bg-surface-card hover:text-text-secondary"
                  >
                    <MoreHorizontal size={15} />
                  </button>
                  {moreMenuFor === wid && (
                    <div
                      className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-xl border border-surface-sunken overflow-hidden z-20"
                      onMouseLeave={() => setMoreMenuFor(null)}
                    >
                      {!sub.retained && onOpenWorkspace && (
                        <button
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-surface-card inline-flex items-center gap-2"
                          onClick={() => {
                            setMoreMenuFor(null);
                            onOpenWorkspace(wid);
                          }}
                        >
                          <Eye size={14} />
                          查看空间详情
                        </button>
                      )}
                      {!sub.retained && (
                        <button
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-surface-card inline-flex items-center gap-2"
                          onClick={() => {
                            setMoreMenuFor(null);
                            navigate(`/workspaces/${wid}/edit`);
                          }}
                        >
                          <Pencil size={14} />
                          编辑工作空间
                        </button>
                      )}
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-surface-card inline-flex items-center gap-2"
                        onClick={() => {
                          setMoreMenuFor(null);
                          onExport();
                        }}
                      >
                        <Download size={14} />
                        导出镜像清单 (JSON)
                      </button>
                      <div className="h-px bg-surface-sunken" />
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 inline-flex items-center gap-2"
                        onClick={() => {
                          setMoreMenuFor(null);
                          setUninstallSub(sub);
                        }}
                      >
                        <Trash2 size={14} />
                        卸载该订阅…
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {hasStandaloneCapabilities && (
          <div className="bg-surface-card/60 rounded-2xl border border-surface-sunken p-4">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-semibold text-text-primary">单独添加的能力</h3>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-surface-sunken text-text-muted">
                非空间
              </span>
            </div>
            <p className="text-xs text-text-muted line-clamp-1">
              通过「添加能力」逐条安装的能力，不属于任何空间。
            </p>
            <SyncPolicyToggle
              value={implicitSub?.syncPolicy ?? "auto"}
              onChange={(p) =>
                handleSetSyncPolicy(
                  implicitSub ?? {
                    workspaceId: null,
                    syncPolicy: "auto",
                    targetTools: null,
                    installedAt: "",
                  },
                  p,
                )
              }
            />
            <ManageTargetsRow
              projectId={project.id}
              workspaceTargets={[...TARGET_TOOLS]}
              activeTargets={project.defaultTargets}
              disabled={legacyLock}
              onChanged={onChanged}
            />
          </div>
        )}

        <div className="relative">
          <button
            type="button"
            onClick={() => setAddMenuOpen((v) => !v)}
            className="w-full min-h-[84px] h-full rounded-2xl border border-dashed border-gray-300 text-text-muted hover:border-brand/50 hover:text-brand hover:bg-brand-50/60 transition-colors inline-flex items-center justify-center gap-1.5 text-sm font-medium"
          >
            <Plus size={15} />
            添加空间
          </button>
          {addMenuOpen && (
            <AddWorkspaceMenu
              projectId={project.id}
              subscribedWorkspaceIds={explicitSubs.map((s) => s.workspaceId!)}
              defaultTargets={project.defaultTargets}
              onInstalled={onChanged}
              onClose={() => setAddMenuOpen(false)}
            />
          )}
        </div>
        </div>
      )}

      {/* 卸载单条订阅确认 */}
      <ConfirmDialog
        open={!!uninstallSub}
        kind="danger"
        title={`卸载订阅「${uninstallSub?.workspaceName ?? ""}」？`}
        description={
          <>
            将移除该空间订阅。被多个订阅引用的共享能力会保留，仅清除该订阅独占的能力文件
            与 lock 归属记录。此操作
            <span className="font-medium text-red-600">不可撤销</span>。
          </>
        }
        confirmLabel="确认卸载"
        confirmingLabel="卸载中…"
        busy={uninstalling}
        onConfirm={handleUninstallConfirm}
        onCancel={() => setUninstallSub(null)}
      />
    </div>
  );
}

/** 订阅级同步策略切换（auto / locked）。 */
function SyncPolicyToggle({
  value,
  onChange,
}: {
  value: SyncPolicy;
  onChange: (policy: SyncPolicy) => void;
}) {
  return (
    <div className="mt-2.5 flex items-center gap-2">
      <span className="text-[11px] text-text-muted">同步策略</span>
      <div role="radiogroup" aria-label="同步策略" className="inline-flex rounded-full bg-surface-sunken p-0.5 text-[11px] font-medium">
        <button
          type="button"
          role="radio"
          aria-checked={value === "auto"}
          onClick={() => onChange("auto")}
          className={`px-2.5 py-1 rounded-full transition ${
            value === "auto" ? "bg-white shadow-sm text-brand" : "text-text-muted hover:text-text-primary"
          }`}
        >
          自动同步
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value === "locked"}
          onClick={() => onChange("locked")}
          className={`px-2.5 py-1 rounded-full transition ${
            value === "locked" ? "bg-white shadow-sm text-text-primary" : "text-text-muted hover:text-text-primary"
          }`}
        >
          锁定
        </button>
      </div>
    </div>
  );
}
