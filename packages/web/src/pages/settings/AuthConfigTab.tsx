/**
 * 设置页 —— 能力鉴权配置 Tab（ADR-0003）。
 *
 * 统一承载 env 与 path 两类鉴权的凭据值管理 + 显式分发：
 *  - 凭据列表：name（= 绑定 credentialName 链接键）、是否已配置、描述。
 *  - 使用关系：每个凭据下展示被哪些资产/项目用到（path 绑定，来自 credential_usages）。
 *  - 分发：env → 选在线设备（推系统环境变量）；path → 选项目（标记分发，下次 reconcile 注入）。
 *  - 从「未配置的 path 使用」直接创建凭据：使用记录列出声明了 path 但无对应凭据的项，
 *    用户可直接选中创建凭据值并选项目下发。
 *
 * 值加密存服务端（前端只见 hasValue），明文永不回传。与能力创建页的声明解耦。
 */
import { useEffect, useMemo, useState } from "react";
import { KeyRound, Plus, Trash2, Send, RotateCcw, RefreshCw, Monitor, FolderGit2 } from "lucide-react";
import { api } from "../../api.js";
import Button from "../../components/Button.js";
import { useToast } from "../../components/Toast.js";
import type {
  Credential,
  CredentialDistribution,
  Project,
  Device,
} from "@maolinc/cc-loom-shared";

const inputCls =
  "w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

type Axis = "env" | "path";

interface CredentialUsage {
  credentialName: string;
  projectId: string;
  projectName: string;
  assetId: string;
  assetName: string;
  assetType: string;
  path: string;
}

export default function AuthConfigTab() {
  const toast = useToast();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [distributions, setDistributions] = useState<CredentialDistribution[]>([]);
  const [usages, setUsages] = useState<CredentialUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 编辑面板（axis 仅创建时可选，编辑时只读展示）
  const [editing, setEditing] = useState<{ id?: string; name: string; axis: Axis; value: string; description: string } | null>(null);
  // 分发面板
  const [distributing, setDistributing] = useState<{ credentialId: string; name: string; axis: Axis; selected: Set<string> } | null>(null);

  const refresh = async () => {
    setLoading(true);
    const [creds, devs, projs, dists, uses] = await Promise.all([
      api.get<Credential[]>("/credentials"),
      api.get<Device[]>("/devices"),
      api.get<Project[]>("/projects"),
      api.get<CredentialDistribution[]>("/credentials/distributions"),
      api.get<CredentialUsage[]>("/credentials/usages"),
    ]);
    setLoading(false);
    if (creds.success) setCredentials(creds.data ?? []);
    if (devs.success) setDevices(devs.data ?? []);
    if (projs.success) setProjects(projs.data ?? []);
    if (dists.success) setDistributions(dists.data ?? []);
    if (uses.success) setUsages(uses.data ?? []);
    if (!creds.success) setError(creds.error || "加载失败");
  };

  useEffect(() => { void refresh(); }, []);

  const onlineDevices = useMemo(() => devices.filter((d) => d.status === "online"), [devices]);

  const saveEdit = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { setError("凭据名不能为空"); return; }
    setError("");
    const isNew = !editing.id;
    const res = isNew
      ? await api.post<Credential>("/credentials", { name: editing.name.trim(), axis: editing.axis, value: editing.value, description: editing.description.trim() })
      : await api.put<Credential>(`/credentials/${editing.id}`, {
          name: editing.name.trim(),
          description: editing.description.trim(),
          ...(editing.value ? { value: editing.value } : {}),
        });
    if (res.success) {
      setEditing(null);
      toast.success(isNew ? "凭据已创建" : "凭据已更新");
      void refresh();
    } else {
      setError(res.error || "保存失败");
    }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`删除凭据 ${name}？已分发的设备/项目会回收或回退。`)) return;
    const res = await api.delete(`/credentials/${id}`);
    if (res.success) {
      toast.success("已删除", `${name} 已回收/回退`);
      void refresh();
    } else {
      toast.error("删除失败", res.error || "");
    }
  };

  const distribute = async () => {
    if (!distributing || distributing.selected.size === 0) return;
    const res = await api.post<{ pushed: string[]; skipped: { targetId: string; reason: string }[] }>(
      `/credentials/${distributing.credentialId}/distribute`,
      { axis: distributing.axis, targetIds: [...distributing.selected] },
    );
    if (res.success && res.data) {
      const { pushed, skipped } = res.data;
      if (pushed.length > 0) {
        toast.success(
          distributing.axis === "env" ? `已下发到 ${pushed.length} 台设备` : `已分发到 ${pushed.length} 个项目`,
          distributing.axis === "env"
            ? `${distributing.name} · 新终端自动生效；已开终端需 source ~/.bashrc 或重开`
            : `${distributing.name} · 下次同步即注入到项目 MCP 配置`,
        );
      }
      if (skipped.length > 0) toast.error(`${skipped.length} 个目标未处理`, skipped.map((s) => s.reason).join("; "));
      setDistributing(null);
      void refresh();
    } else {
      toast.error("分发失败", res.error || "");
    }
  };

  const revoke = async (credentialId: string, axis: Axis, targetId: string, label: string, name: string) => {
    const res = await api.post(`/credentials/${credentialId}/revoke`, { axis, targetId });
    if (res.success) {
      toast.success("已回收", `${name} ← ${label}`);
      void refresh();
    } else {
      toast.error("回收失败", res.error || "");
    }
  };

  // 未配置凭据的 path 使用（用户可直接从这些项创建凭据 + 分发）
  const configuredNames = useMemo(() => new Set(credentials.map((c) => c.name)), [credentials]);
  const unconfiguredUsages = useMemo(
    () => usages.filter((u) => !configuredNames.has(u.credentialName)),
    [usages, configuredNames],
  );

  if (loading) return <p className="text-sm text-text-muted">加载中...</p>;

  return (
    <div className="max-w-4xl">
      <div className="mb-6 p-4 bg-white rounded-xl border border-surface-sunken flex gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-soft text-brand grid place-items-center shrink-0">
          <KeyRound size={18} />
        </div>
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary mb-1">能力鉴权凭据</h3>
            <Button variant="ghost" size="sm" leftIcon={<RefreshCw size={14} />} onClick={refresh}>刷新</Button>
          </div>
          <p className="text-sm text-text-secondary leading-relaxed">
            维护能力运行所需的凭据（token 等），加密存储。env 绑定推送到设备系统环境变量；path 绑定注入到项目 MCP 配置的指定路径。与能力创建页的鉴权声明解耦——这里只管凭据名→值与显式分发。
          </p>
          <p className="text-xs text-text-muted mt-1.5">env 下发写入设备系统环境变量文件：新开终端/SSH 自动生效；path 分发会在下次同步时把值写进项目的 .mcp.json。</p>
        </div>
      </div>

      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-semibold text-text-primary">已配置凭据</h4>
        <Button variant="primary" size="sm" leftIcon={<Plus size={15} />} onClick={() => setEditing({ name: "", axis: "env", value: "", description: "" })}>
          新建凭据
        </Button>
      </div>

      {error && <p className="text-sm text-red-500 mb-3">{error}</p>}

      {credentials.length === 0 && (
        <div className="text-center py-12 text-text-muted">
          <KeyRound size={32} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm">还没有凭据。点击「新建凭据」开始，或从下方「待配置的鉴权」直接创建。</p>
        </div>
      )}

      {(["env", "path"] as const).map((axis) => {
        const groupCreds = credentials.filter((c) => (c.axis ?? "env") === axis);
        if (groupCreds.length === 0) return null;
        return (
          <div key={axis} className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              {axis === "env" ? <Monitor size={14} className="text-text-muted" /> : <FolderGit2 size={14} className="text-text-muted" />}
              <h5 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                {axis === "env" ? "环境变量凭据" : "MCP 路径凭据"}
              </h5>
              <span className="text-xs text-text-muted">
                {axis === "env" ? "· 下发到设备系统环境变量" : "· 分发到项目 MCP 配置路径"}
              </span>
            </div>
            {groupCreds.map((cred) => {
              const envDists = distributions.filter((d) => d.credentialId === cred.id && d.axis === "env");
              const pathDists = distributions.filter((d) => d.credentialId === cred.id && d.axis === "path");
              const uses = usages.filter((u) => u.credentialName === cred.name);
              return (
                <div key={cred.id} className="mb-3 p-4 bg-white rounded-xl border border-surface-sunken">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-sm font-semibold text-text-primary">{cred.name}</code>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-mcp-green-bg text-mcp-green-text">已加密</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-surface-sunken text-text-muted">
                          {axis === "env" ? "环境变量" : "MCP 路径"}
                        </span>
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">
                        {axis === "env"
                          ? `${envDists.length} 台设备`
                          : `${pathDists.length} 个项目`}
                        {(envDists.length === 0 && pathDists.length === 0) && "未分发"}
                        {cred.lastPushedAt ? ` · 最近 ${new Date(cred.lastPushedAt).toLocaleString()}` : ""}
                      </p>
                      {cred.description && <p className="text-xs text-text-secondary mt-1">{cred.description}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {axis === "env" ? (
                        <Button variant="ghost" size="sm" leftIcon={<Send size={14} />} onClick={() => setDistributing({ credentialId: cred.id, name: cred.name, axis: "env", selected: new Set() })}>
                          下发设备
                        </Button>
                      ) : (
                        <Button variant="ghost" size="sm" leftIcon={<FolderGit2 size={14} />} onClick={() => setDistributing({ credentialId: cred.id, name: cred.name, axis: "path", selected: new Set() })}>
                          分发项目
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ id: cred.id, name: cred.name, axis, value: "", description: cred.description ?? "" })}>编辑</Button>
                      <button onClick={() => remove(cred.id, cred.name)} className="p-1.5 rounded-lg text-text-muted hover:bg-red-50 hover:text-red-500 transition-colors">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>

                  {/* 使用关系：被哪些资产/项目用到 */}
                  {uses.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-50">
                      <p className="text-xs text-text-muted mb-1.5">被以下能力使用：</p>
                      <div className="flex flex-wrap gap-1.5">
                        {uses.map((u, i) => (
                          <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-card text-xs" title={`${u.assetName} · ${u.path}`}>
                            <code className="text-text-secondary">{u.assetName}</code>
                            <span className="text-text-muted">← {u.projectName}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 已分发目标（仅本轴；跨轴记录理论上不出现，防御性展示） */}
                  {(envDists.length > 0 || pathDists.length > 0) && (
                    <div className="mt-3 pt-3 border-t border-gray-50 flex flex-wrap gap-2">
                      {envDists.map((d) => (
                        <span key={`e${d.targetId}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-card text-xs">
                          <Monitor size={12} className="text-text-muted" />
                          <span className="text-text-secondary">{d.targetName}</span>
                          <button onClick={() => revoke(cred.id, "env", d.targetId, d.targetName, cred.name)} className="text-text-muted hover:text-red-500" title="回收">
                            <RotateCcw size={12} />
                          </button>
                        </span>
                      ))}
                      {pathDists.map((d) => (
                        <span key={`p${d.targetId}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-card text-xs">
                          <FolderGit2 size={12} className="text-text-muted" />
                          <span className="text-text-secondary">{d.targetName}</span>
                          <button onClick={() => revoke(cred.id, "path", d.targetId, d.targetName, cred.name)} className="text-text-muted hover:text-red-500" title="取消分发（回退作者原始值）">
                            <RotateCcw size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* 待配置的鉴权（声明了 path 但尚无对应凭据值）—— 用户可直接从这里创建 */}
      {unconfiguredUsages.length > 0 && (
        <div className="mt-6">
          <h4 className="text-sm font-semibold text-text-primary mb-2">待配置的鉴权</h4>
          <p className="text-xs text-text-muted mb-3">以下能力声明了 path 鉴权但尚未配置凭据值。点击可创建凭据并分发到对应项目。</p>
          <div className="space-y-2">
            {unconfiguredUsages.map((u, i) => (
              <div key={i} className="p-3 rounded-xl border border-amber-100 bg-amber-50/40 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-semibold text-text-primary">{u.credentialName}</code>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">未配置</span>
                  </div>
                  <p className="text-xs text-text-muted mt-0.5 truncate">{u.assetName} · <code>{u.path}</code> ← {u.projectName}</p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Plus size={14} />}
                  onClick={() => setEditing({ name: u.credentialName, axis: "path", value: "", description: `${u.assetName} 鉴权凭据` })}
                >
                  创建并配置
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 编辑/创建弹层 */}
      {editing && (
        <Modal title={editing.id ? "编辑凭据" : "新建凭据"} onClose={() => setEditing(null)}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">凭据类型</label>
              {editing.id ? (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-card text-sm text-text-secondary">
                  {editing.axis === "env" ? <Monitor size={14} className="text-text-muted" /> : <FolderGit2 size={14} className="text-text-muted" />}
                  {editing.axis === "env" ? "环境变量（下发到设备）" : "MCP 路径（分发到项目）"}
                  <span className="text-xs text-text-muted">· 创建后不可更改</span>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing({ ...editing, axis: "env" })}
                    className={`flex items-start gap-2 p-2.5 rounded-lg border text-left transition-colors ${
                      editing.axis === "env" ? "border-brand bg-brand-soft/40" : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <Monitor size={15} className={editing.axis === "env" ? "text-brand" : "text-text-muted"} />
                    <div>
                      <div className="text-xs font-medium text-text-primary">环境变量</div>
                      <div className="text-xs text-text-muted">推送到设备系统环境变量</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing({ ...editing, axis: "path" })}
                    className={`flex items-start gap-2 p-2.5 rounded-lg border text-left transition-colors ${
                      editing.axis === "path" ? "border-brand bg-brand-soft/40" : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <FolderGit2 size={15} className={editing.axis === "path" ? "text-brand" : "text-text-muted"} />
                    <div>
                      <div className="text-xs font-medium text-text-primary">MCP 路径</div>
                      <div className="text-xs text-text-muted">注入项目 MCP 配置路径</div>
                    </div>
                  </button>
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">凭据名</label>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如 GITHUB_TOKEN" className={inputCls} disabled={!!editing.id} />
              <p className="mt-1 text-xs text-text-muted">字母/数字/下划线/连字符，不以数字开头。须与能力声明的凭据名一致。创建后不可修改。</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                值 {editing.id && <span className="text-text-muted">（留空保持不变）</span>}
              </label>
              <input type="password" value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} placeholder={editing.id ? "已配置，留空则保持不变" : "凭据值"} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">描述（可选）</label>
              <input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="说明该凭据的用途" className={inputCls} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>取消</Button>
              <Button variant="primary" onClick={saveEdit}>保存</Button>
            </div>
          </div>
        </Modal>
      )}

      {/* 分发弹层 */}
      {distributing && (
        <Modal title={`${distributing.axis === "env" ? "下发到设备" : "分发到项目"} · ${distributing.name}`} onClose={() => setDistributing(null)}>
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {distributing.axis === "env"
                ? "选择要下发的在线设备（推到系统环境变量，可多选；重复下发即更新）："
                : "选择要分发的项目（下次同步把值注入到项目 MCP 配置的对应路径，可多选）："}
            </p>
            {distributing.axis === "env" && onlineDevices.length === 0 && (
              <p className="text-sm text-text-muted py-4 text-center">暂无在线设备</p>
            )}
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {(distributing.axis === "env" ? onlineDevices : projects).map((target) => {
                const id = (target as { id: string }).id;
                const name = distributing.axis === "env" ? (target as Device).deviceName : (target as Project).projectName;
                const checked = distributing.selected.has(id);
                const already = distributions.some((d) => d.credentialId === distributing.credentialId && d.axis === distributing.axis && d.targetId === id);
                return (
                  <label key={id} className="flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-surface-card cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = new Set(distributing.selected);
                        if (checked) next.delete(id); else next.add(id);
                        setDistributing({ ...distributing, selected: next });
                      }}
                      className="accent-brand"
                    />
                    {distributing.axis === "env" ? <Monitor size={14} className="text-text-muted" /> : <FolderGit2 size={14} className="text-text-muted" />}
                    <span className="text-sm text-text-primary flex-1">{name}</span>
                    {already && <span className="text-xs text-text-muted">已分发，将更新</span>}
                  </label>
                );
              })}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setDistributing(null)}>取消</Button>
              <Button variant="primary" onClick={distribute} disabled={distributing.selected.size === 0}>
                {distributing.axis === "env" ? `下发到 ${distributing.selected.size} 台设备` : `分发到 ${distributing.selected.size} 个项目`}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-lg w-full max-w-md mx-4 p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-text-primary mb-4">{title}</h3>
        {children}
      </div>
    </div>
  );
}
