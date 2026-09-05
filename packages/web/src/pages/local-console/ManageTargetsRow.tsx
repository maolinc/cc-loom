/**
 * ManageTargetsRow —— 已安装工作空间下的「厂商管理」行。
 *
 * 安装后用户可在此新增 / 移除落盘厂商：点击某厂商即把它加入或移出目标集合，
 * server 端重新 reconcile，新增厂商会创建对应 vendor 目录并写入能力，移除则
 * 按 (能力 × 厂商) 引用计数清理其文件。
 *
 * 约束：
 *  - 仅展示可选范围内的厂商（workspaceTargets）。
 *  - 至少保留一个启用厂商（与后端校验一致）。
 *
 * ADR-0006：目标厂商挂在订阅上。显式订阅卡传
 * endpoint=`/projects/:id/subscriptions/:wid/targets`；隐式订阅（「单独添加的
 * 能力」组）与「添加能力」场景走项目级 `/projects/:id/targets`（默认）。
 */
import { useState } from "react";
import { api } from "../../api.js";
import { sortTargetTools, TARGET_TOOL_LABELS } from "@maolinc/cc-loom-shared";
import type { TargetTool } from "@maolinc/cc-loom-shared";
import { Loader2, Plus, Check } from "lucide-react";
import { useToast } from "../../components/Toast.js";
import ToolIcon from "../../components/ToolIcon.js";

interface Props {
  projectId: string;
  /** 可选的全部厂商（工作空间声明范围 / 项目有效工具集合）。 */
  workspaceTargets: TargetTool[];
  /** 当前已启用（落盘）的厂商集合。 */
  activeTargets: TargetTool[];
  /** 变更成功后回调，父组件据此刷新项目列表 + 本地镜像。 */
  onChanged: () => Promise<void> | void;
  /** legacy lock：禁用操作。 */
  disabled?: boolean;
  /** 提交端点；缺省为项目级 `/projects/:id/targets`。 */
  endpoint?: string;
}

export default function ManageTargetsRow({
  projectId,
  workspaceTargets,
  activeTargets,
  onChanged,
  disabled,
  endpoint,
}: Props) {
  const toast = useToast();
  const [pending, setPending] = useState<TargetTool | null>(null);

  const tools = sortTargetTools(workspaceTargets);
  if (tools.length === 0) return null;

  // 当前启用集合（约束在工作空间声明范围内，避免历史脏数据）。
  const active = new Set(activeTargets.filter((t) => workspaceTargets.includes(t)));

  const apply = async (tool: TargetTool, next: boolean) => {
    if (disabled || pending) return;
    const targets = new Set(active);
    if (next) targets.add(tool);
    else targets.delete(tool);
    if (targets.size === 0) {
      toast.error("至少保留一个厂商", "如需全部移除，请直接卸载该订阅");
      return;
    }
    setPending(tool);
    try {
      const res = await api.post<{ filesWritten?: string[]; filesRemoved?: string[] }>(
        endpoint ?? `/projects/${projectId}/targets`,
        { targets: sortTargetTools([...targets]) },
      );
      if (!res.success) {
        toast.error("更新厂商失败", res.error || "请稍后重试");
        return;
      }
      const label = TARGET_TOOL_LABELS[tool];
      toast.success(
        next ? `已新增厂商 ${label}` : `已移除厂商 ${label}`,
        next
          ? `写入 ${res.data?.filesWritten?.length ?? 0} 个文件`
          : `清理 ${res.data?.filesRemoved?.length ?? 0} 个文件`,
      );
      await onChanged();
    } catch (err: any) {
      toast.error("更新厂商失败", err?.message ?? String(err));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="mt-2.5 flex items-center gap-2 flex-wrap">
      <div className="inline-flex items-center gap-1.5 flex-wrap">
        {tools.map((t) => {
          const on = active.has(t);
          const busy = pending === t;
          return (
            <button
              key={t}
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`${TARGET_TOOL_LABELS[t]}：${on ? "已启用，点击移除" : "未启用，点击新增"}`}
              disabled={disabled || !!pending}
              title={on ? `${TARGET_TOOL_LABELS[t]} · 已启用（点击移除）` : `${TARGET_TOOL_LABELS[t]} · 未启用（点击新增）`}
              onClick={() => apply(t, !on)}
              className={`relative h-7 w-7 grid place-items-center rounded-full border transition-colors disabled:opacity-60 ${
                on
                  ? "border-brand/40 bg-brand-soft/60 text-text-primary"
                  : "border-dashed border-gray-300 text-text-muted hover:border-brand/40 hover:text-text-secondary"
              }`}
            >
              <ToolIcon tool={t} size={15} />
              {busy ? (
                <Loader2 size={11} className="absolute -bottom-0.5 -right-0.5 bg-white rounded-full p-px text-brand animate-spin" />
              ) : on ? (
                <Check size={11} className="absolute -bottom-0.5 -right-0.5 bg-white rounded-full p-px text-brand" />
              ) : (
                <Plus size={11} className="absolute -bottom-0.5 -right-0.5 bg-white rounded-full p-px text-text-muted" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
