/**
 * 安装流程胶水层（Workspace 安装）：生成计划预览 → 执行。
 *
 * 单 Asset 安装（type 2）已统一走 `POST /projects/:id/capabilities/add`（加入
 * project_capabilities，per-project），不再经此管线——见 DetailPanel / AddCapabilityDialog。
 * 此处仅服务 Workspace 安装的「计划预览 → 确认执行」闭环。
 */
import type { InstallPlan, InstallResult, SyncPolicy, TargetTool } from "@maolinc/cc-loom-shared";
import { api } from "../api.js";

export interface InstallParams {
  projectId: string;
  workspaceId: string;
  targetTools: TargetTool[];
  policy: SyncPolicy;
}

/** 生成 Workspace 安装计划。成功返回 plan，失败返回可展示错误。 */
export async function generateInstallPlan(
  params: InstallParams,
): Promise<{ plan: InstallPlan } | { error: string }> {
  const res = await api.post<InstallPlan>("/install/plan", {
    projectId: params.projectId,
    workspaceId: params.workspaceId,
    targetTools: params.targetTools,
    policy: params.policy,
  });
  if (!res.success || !res.data) return { error: res.error || "生成安装计划失败" };
  return { plan: res.data };
}

/**
 * 执行 Workspace 安装（语义 = 添加/重装一条空间订阅，ADR-0006）。
 * skipAssetIds 为撞车裁决结果：plan 报出的撞车项必须全部跳过（未裁决 server 返回 409）。
 */
export async function executeInstall(
  params: InstallParams & { skipAssetIds?: string[] },
): Promise<{ result: InstallResult } | { error: string }> {
  const res = await api.post<{ result: InstallResult }>("/install/execute", {
    projectId: params.projectId,
    workspaceId: params.workspaceId,
    targetTools: params.targetTools,
    policy: params.policy,
    ...(params.skipAssetIds?.length ? { skipAssetIds: params.skipAssetIds } : {}),
  });
  if (!res.success || !res.data) return { error: res.error || "安装失败" };
  if (!res.data.result.success) {
    return { error: `安装失败：${res.data.result.errors.join("; ") || "未知错误"}` };
  }
  return { result: res.data.result };
}
