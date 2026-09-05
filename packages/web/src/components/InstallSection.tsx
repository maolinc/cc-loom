import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { X, ChevronDown, ChevronRight, Check, Plus } from "lucide-react";
import { api } from "../api.js";
import type { InstallPlan, InstallConflict, Project, DiffEntry, TargetTool, SyncPolicy } from "@maolinc/cc-loom-shared";
import { TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import { useAuth } from "../hooks/useAuth.js";
import { useToast } from "./Toast.js";
import Button from "./Button.js";
import ToolIcon from "./ToolIcon.js";
import InstallConflictDialog from "./InstallConflictDialog.js";
import { generateInstallPlan, executeInstall } from "../lib/installFlow.js";

interface Props {
  assetId?: string;
  workspaceId?: string;
}

export default function InstallSection({ assetId, workspaceId }: Props) {
  const toast = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [targetTools, setTargetTools] = useState<TargetTool[]>([]);
  const [policy, setPolicy] = useState<SyncPolicy>("auto");
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // plan 报出撞车时弹裁决弹窗（null = 未弹）；裁决后携带 skipAssetIds 执行。
  const [conflicts, setConflicts] = useState<InstallConflict[] | null>(null);

  // 项目列表轻量轮询：CLI 端 loom register 后 5s 内 Web 自动看到。
  useEffect(() => {
    if (!user) {
      setProjects([]);
      setSelectedProject("");
      return;
    }
    const controller = new AbortController();
    const fetchProjects = () => {
      api.get<Project[]>("/projects", controller.signal).then((res) => {
        if (controller.signal.aborted || !res.success || !res.data) return;
        setProjects(res.data);
        setSelectedProject((cur) => cur || (res.data!.length > 0 ? res.data![0]!.id : ""));
      });
    };
    fetchProjects();
    const timer = setInterval(fetchProjects, 5_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [user]);

  const project = projects.find((p) => p.id === selectedProject);
  const availableTools = project?.detectedTargets || [];
  const activeTools = targetTools.length > 0 ? targetTools : availableTools;
  // 单 Asset 安装走 /capabilities/add（project_capabilities，直接安装，无预览）；
  // Workspace 安装走 installFlow（计划预览 → 确认执行）。
  const isSingleAsset = !!assetId && !workspaceId;

  // 安装参数变化 → 作废已生成的 plan，避免展示陈旧 diff 与实际执行参数不一致。
  useEffect(() => {
    setPlan(null);
    setShowDiff(false);
    setResult(null);
    setConflicts(null);
  }, [selectedProject, policy, targetTools, assetId, workspaceId]);

  const generatePlan = async () => {
    if (!selectedProject || isSingleAsset || !workspaceId) return;
    setPlanning(true);
    const res = await generateInstallPlan({
      projectId: selectedProject,
      workspaceId,
      targetTools: activeTools,
      policy,
    });
    setPlanning(false);
    if ("error" in res) {
      toast.error("生成安装计划失败", res.error);
      return;
    }
    setPlan(res.plan);
  };

  const doInstall = async (skipAssetIds?: string[]) => {
    if (!selectedProject) return;
    setInstalling(true);
    setResult(null);
    if (isSingleAsset && assetId) {
      // 单 Asset：直接加入 project_capabilities + reconcile 落盘
      const res = await api.post<{ filesWritten: string[]; filesRemoved: string[] }>(
        `/projects/${selectedProject}/capabilities/add`,
        { assetIds: [assetId] },
      );
      setInstalling(false);
      if (!res.success || !res.data) {
        setResult({ ok: false, msg: res.error || "安装失败" });
        toast.error("安装失败", res.error || "未知错误");
        return;
      }
      const msg = `已写入 ${res.data.filesWritten.length} 个文件`;
      setResult({ ok: true, msg });
      toast.success(`已安装到 ${project?.projectName || "项目"}`, msg);
      return;
    }
    if (!workspaceId) return;
    const res = await executeInstall({
      projectId: selectedProject,
      workspaceId,
      targetTools: activeTools,
      policy,
      skipAssetIds,
    });
    setInstalling(false);
    if ("error" in res) {
      setResult({ ok: false, msg: res.error });
      toast.error("安装失败", res.error);
      return;
    }
    const msg = `已写入 ${res.result.filesWritten.length} 个文件`;
    setResult({ ok: true, msg });
    toast.success(`已安装到 ${project?.projectName || "项目"}`, msg);
  };

  // 确认安装：plan 含未裁决撞车时先弹裁决弹窗，否则直接执行。
  const handleInstallClick = () => {
    if (plan?.conflictingAssets && plan.conflictingAssets.length > 0) {
      setConflicts(plan.conflictingAssets);
      return;
    }
    void doInstall();
  };

  const toggleTool = (t: TargetTool) => {
    setTargetTools((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  };

  const diffEntries = plan?.diff || [];

  if (!user) {
    return (
      <div>
        <div className="text-xs font-semibold text-text-primary mb-3">安装到本地项目</div>
        <p className="text-xs text-text-muted leading-relaxed mb-3">
          登录后可以把公开能力或工作空间安装到已注册的本地项目。
        </p>
        <Button variant="secondary" size="sm" fullWidth onClick={() => navigate("/login")}>
          登录后安装
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs font-semibold text-text-primary mb-3">安装到本地项目</div>

      {projects.length === 0 ? (
        <p className="text-xs text-text-muted leading-relaxed">
          尚未发现已注册项目。请在项目目录执行 <code className="bg-surface-sunken px-1 rounded">loom register</code> 后稍候自动出现。
        </p>
      ) : (
        <>
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-xs bg-white mb-3 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.projectName} ({p.status})
              </option>
            ))}
          </select>

          <div className="flex flex-wrap gap-1.5 mb-3">
            {TARGET_TOOLS.map((t) => {
              const active = activeTools.includes(t);
              const detected = availableTools.includes(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleTool(t)}
                  className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium border transition-colors ${
                    active
                      ? "bg-brand-soft text-brand border-brand/20"
                      : "border-gray-200 text-text-muted hover:border-gray-300"
                  }`}
                  title={detected ? "已检测到该目录" : "将新建该目录"}
                >
                  <ToolIcon tool={t} size={14} showTooltip={false} />
                  {detected ? <Check size={11} /> : <Plus size={11} />}
                </button>
              );
            })}
          </div>

          <div className="flex gap-3 mb-3 text-[11px]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="install-policy" checked={policy === "auto"} onChange={() => setPolicy("auto")} className="accent-brand" />
              自动同步
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" name="install-policy" checked={policy === "locked"} onChange={() => setPolicy("locked")} className="accent-brand" />
              锁定
            </label>
          </div>

          {isSingleAsset ? (
            <>
              <Button variant="primary" size="sm" fullWidth loading={installing} disabled={!selectedProject} onClick={() => void doInstall()}>
                {`安装到 ${project?.projectName || ""}`}
              </Button>
              <p className="text-[10px] text-text-muted mt-2 leading-relaxed">
                作为项目级能力直接安装（加入 project_capabilities），不依赖工作空间。
              </p>
              {result && (
                <p className={`text-xs mt-2 flex items-center justify-center gap-1 ${result.ok ? "text-mcp-green-text" : "text-red-500"}`}>
                  {result.ok ? <Check size={13} className="shrink-0" /> : <X size={13} className="shrink-0" />}
                  {result.msg}
                </p>
              )}
            </>
          ) : !plan ? (
            <Button variant="primary" size="sm" fullWidth loading={planning} disabled={!selectedProject} onClick={generatePlan}>
              生成安装计划
            </Button>
          ) : (
            <>
              <div className="bg-surface-card rounded-lg p-3 mb-2 text-xs">
                {diffEntries.length === 0 ? (
                  <p className="text-text-muted">无需变更：目标目录已是最新状态。</p>
                ) : (
                  <>
                    <TreeView entries={diffEntries} />
                    <button
                      onClick={() => setShowDiff(!showDiff)}
                      className="flex items-center gap-1 text-brand mt-1.5 hover:underline"
                    >
                      {showDiff ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      查看变更 ({diffEntries.length})
                    </button>
                    {showDiff && <DiffView entries={diffEntries} />}
                  </>
                )}
              </div>

              {plan.conflicts.length > 0 && (
                <div className="mb-2 p-2 bg-red-50 rounded-lg text-[10px] text-red-600">
                  {plan.conflicts.map((c, i) => <p key={i}>{c}</p>)}
                </div>
              )}

              {(plan.conflictingAssets?.length ?? 0) > 0 && (
                <div className="mb-2 p-2 bg-amber-50 rounded-lg text-[10px] text-amber-700">
                  发现 {plan.conflictingAssets!.length} 项同名撞车能力，点击安装后将逐条裁决（跳过 / 取消）。
                </div>
              )}

              <Button variant="primary" size="sm" fullWidth loading={installing} onClick={handleInstallClick}>
                {`安装到 ${project?.projectName || ""}`}
              </Button>

              {result && (
                <p className={`text-xs mt-2 flex items-center justify-center gap-1 ${result.ok ? "text-mcp-green-text" : "text-red-500"}`}>
                  {result.ok ? <Check size={13} className="shrink-0" /> : <X size={13} className="shrink-0" />}
                  {result.msg}
                </p>
              )}
            </>
          )}
        </>
      )}

      {conflicts && (
        <InstallConflictDialog
          conflicts={conflicts}
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

function TreeView({ entries }: { entries: DiffEntry[] }) {
  const dirs = new Map<string, string[]>();
  for (const e of entries) {
    const dir = e.path.split("/").slice(0, -1).join("/");
    const file = e.path.split("/").pop()!;
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(file);
  }

  if (dirs.size === 0) return <p className="text-text-muted">无变更</p>;

  return (
    <div className="font-mono text-text-secondary">
      {[...dirs.entries()].map(([dir, fileList]) => (
        <div key={dir} className="ml-1">
          <div className="flex items-center gap-1">
            <ChevronRight size={10} />
            <span>{dir}/</span>
          </div>
          {fileList.map((f) => (
            <div key={f} className="ml-4 text-text-muted">{f}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

function DiffView({ entries }: { entries: DiffEntry[] }) {
  return (
    <div className="mt-1.5 border-t border-gray-200 pt-1.5">
      {entries.map((e, i) => {
        const prefix = e.operation === "add" ? "+" : e.operation === "remove" ? "−" : "~";
        const color =
          e.operation === "add" ? "text-mcp-green-text" : e.operation === "remove" ? "text-red-500" : "text-amber-600";
        return (
          <div key={i} className={`font-mono ${color} py-0.5`}>
            {prefix} {e.path}{" "}
            <span className="text-text-muted">({e.assetName})</span>
          </div>
        );
      })}
    </div>
  );
}
