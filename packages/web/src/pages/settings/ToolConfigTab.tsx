import { useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle2, Code2, Monitor, Plus, RefreshCw, Send, ShieldCheck, Trash2 } from "lucide-react";
import type {
  ClaudeCodeToolConfig,
  CodexToolConfig,
  Device,
  ToolConfigDistribution,
  ToolConfigProfile,
  ToolConfigTool,
} from "@maolinc/cc-loom-shared";
import { api } from "../../api.js";
import Button from "../../components/Button.js";
import Modal from "../../components/Modal.js";
import { useToast } from "../../components/Toast.js";

const inputCls =
  "w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

const DEFAULT_CODEX: CodexToolConfig = {
  modelProvider: "OpenAI",
  disableResponseStorage: true,
  networkAccess: "enabled",
  windowsWslSetupAcknowledged: true,
  baseUrl: "",
  wireApi: "responses",
  requiresOpenaiAuth: true,
  goals: true,
};

const DEFAULT_CLAUDE: ClaudeCodeToolConfig = {
  baseUrl: "",
  defaultFableModel: "",
  defaultFableModelName: "",
  defaultHaikuModel: "",
  defaultHaikuModelName: "",
  defaultOpusModel: "",
  defaultOpusModelName: "",
  defaultSonnetModel: "",
  defaultSonnetModelName: "",
  model: "",
  apiTimeoutMs: "",
  disableNonessentialTraffic: "",
  experimentalAgentTeams: "",
  enableToolSearch: "",
  hasCompletedOnboarding: true,
};

type DraftBase = { id?: string; name: string; secret: string; secretConfigured: boolean };
type Draft = DraftBase & (
  | { tool: "codex"; config: CodexToolConfig }
  | { tool: "claudecode"; config: ClaudeCodeToolConfig }
);

function newDraft(tool: ToolConfigTool): Draft {
  return tool === "codex"
    ? { tool, name: "", secret: "", secretConfigured: false, config: { ...DEFAULT_CODEX } }
    : { tool, name: "", secret: "", secretConfigured: false, config: { ...DEFAULT_CLAUDE } };
}

function editDraft(profile: ToolConfigProfile): Draft {
  return profile.tool === "codex"
    ? { id: profile.id, tool: "codex", name: profile.name, secret: "", secretConfigured: profile.secretConfigured, config: { ...profile.config } }
    : { id: profile.id, tool: "claudecode", name: profile.name, secret: "", secretConfigured: profile.secretConfigured, config: { ...profile.config } };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1.5">{label}</span>
      {children}
      {hint && <span className="block mt-1 whitespace-nowrap text-[11px] text-text-muted">{hint}</span>}
    </label>
  );
}

function Toggle({ checked, onChange, label, detail }: { checked: boolean; onChange: (value: boolean) => void; label: string; detail: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-full flex items-center gap-3 rounded-xl border border-surface-sunken bg-surface-card/60 px-3 py-2.5 text-left hover:bg-surface-sunken/70 transition-colors"
    >
      <span className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-brand" : "bg-gray-300"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-text-primary">{label}</span>
        <span className="block whitespace-nowrap text-[11px] text-text-muted">{detail}</span>
      </span>
    </button>
  );
}

export default function ToolConfigTab() {
  const toast = useToast();
  const [profiles, setProfiles] = useState<ToolConfigProfile[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [distributions, setDistributions] = useState<ToolConfigDistribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState<{ profile: ToolConfigProfile; selected: Set<string> } | null>(null);
  const [pushing, setPushing] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError("");
    const [profileRes, deviceRes, distributionRes] = await Promise.all([
      api.get<ToolConfigProfile[]>("/tool-config-profiles"),
      api.get<Device[]>("/devices"),
      api.get<ToolConfigDistribution[]>("/tool-config-profiles/distributions"),
    ]);
    setLoading(false);
    if (profileRes.success) setProfiles(profileRes.data ?? []);
    else setError(profileRes.error ?? "加载工具配置失败");
    if (deviceRes.success) setDevices(deviceRes.data ?? []);
    if (distributionRes.success) setDistributions(distributionRes.data ?? []);
  };

  useEffect(() => { void refresh(); }, []);

  const onlineDevices = useMemo(() => devices.filter((device) => device.status === "online"), [devices]);

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) { setError("请填写配置名称"); return; }
    if (!draft.config.baseUrl.trim()) { setError("请填写 Base URL"); return; }
    if (!draft.secretConfigured && !draft.secret.trim()) {
      setError(draft.tool === "codex" ? "请填写 API Key" : "请填写 Auth Token");
      return;
    }
    setSaving(true);
    setError("");
    const body = {
      name: draft.name.trim(),
      tool: draft.tool,
      config: draft.config,
      ...(draft.secret.trim() ? { secret: draft.secret.trim() } : {}),
    };
    const res = draft.id
      ? await api.put<ToolConfigProfile>(`/tool-config-profiles/${draft.id}`, body)
      : await api.post<ToolConfigProfile>("/tool-config-profiles", body);
    setSaving(false);
    if (!res.success) { setError(res.error ?? "保存失败"); return; }
    toast.success(draft.id ? "配置档已更新" : "配置档已创建", "凭据已加密保存，尚未自动下发");
    setDraft(null);
    void refresh();
  };

  const remove = async (profile: ToolConfigProfile) => {
    if (!confirm(`删除配置档「${profile.name}」？设备上的现有配置文件不会被删除。`)) return;
    const res = await api.delete(`/tool-config-profiles/${profile.id}`);
    if (res.success) {
      toast.success("配置档已删除", "设备上已下发的配置保持不变");
      void refresh();
    } else toast.error("删除失败", res.error ?? "");
  };

  const distribute = async () => {
    if (!sending || sending.selected.size === 0) return;
    setPushing(true);
    const res = await api.post<{ pushed: string[]; skipped: { deviceId: string; reason: string }[] }>(
      `/tool-config-profiles/${sending.profile.id}/distribute`,
      { deviceIds: [...sending.selected] },
    );
    setPushing(false);
    if (!res.success || !res.data) {
      toast.error("下发失败", res.error ?? "");
      return;
    }
    if (res.data.pushed.length > 0) toast.success(`已下发到 ${res.data.pushed.length} 台设备`, "对应字段已合并，其他本地配置保持不变");
    if (res.data.skipped.length > 0) toast.error(`${res.data.skipped.length} 台设备未处理`, res.data.skipped.map((item) => item.reason).join("；"));
    setSending(null);
    void refresh();
  };

  if (loading) return <p className="text-sm text-text-muted">加载中...</p>;

  return (
    <div className="max-w-5xl">
      <div className="mb-7 overflow-hidden rounded-2xl border border-brand/10 bg-white shadow-soft">
        <div className="grid gap-5 p-5 md:grid-cols-[1fr_auto] md:items-center">
          <div className="flex gap-3.5">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand"><Code2 size={20} /></div>
            <div>
              <h3 className="text-base font-semibold tracking-tight text-text-primary">AI 工具配置下发</h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
                保存多套 Codex 与 Claude Code 配置，并按需切换到在线设备。API Key / Token 加密存储且不会在页面回显；本地仅合并本模块负责的字段。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <Button variant="secondary" size="sm" leftIcon={<RefreshCw size={14} />} onClick={refresh}>刷新</Button>
            <Button variant="secondary" size="sm" leftIcon={<Plus size={14} />} onClick={() => { setError(""); setDraft(newDraft("codex")); }}>Codex 配置</Button>
            <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={() => { setError(""); setDraft(newDraft("claudecode")); }}>Claude 配置</Button>
          </div>
        </div>
        <div className="grid border-t border-surface-sunken bg-surface-card/70 sm:grid-cols-3">
          <div className="px-5 py-3 text-xs text-text-muted"><ShieldCheck size={14} className="mr-1.5 inline text-emerald-600" />凭据仅在下发时解密</div>
          <div className="border-surface-sunken px-5 py-3 text-xs text-text-muted sm:border-l"><Monitor size={14} className="mr-1.5 inline" />仅可选择在线设备</div>
          <div className="border-surface-sunken px-5 py-3 text-xs text-text-muted sm:border-l"><CheckCircle2 size={14} className="mr-1.5 inline" />重复下发即切换配置</div>
        </div>
      </div>

      {error && !draft && <p className="mb-4 text-sm text-red-500">{error}</p>}

      {profiles.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center">
          <Bot size={34} className="mx-auto mb-3 text-text-muted opacity-45" />
          <p className="text-sm font-medium text-text-primary">还没有工具配置档</p>
          <p className="mt-1 text-xs text-text-muted">创建一套配置后，选择在线设备即可下发。</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {profiles.map((profile) => {
            const deployed = distributions.filter((item) => item.profileId === profile.id);
            return (
              <article key={profile.id} className="rounded-2xl border border-surface-sunken bg-white p-5 shadow-soft transition-shadow hover:shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${profile.tool === "codex" ? "bg-brand-soft text-brand" : "bg-orange-50 text-orange-700"}`}>
                        {profile.tool === "codex" ? "CODEX" : "CLAUDE CODE"}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700"><ShieldCheck size={12} />已加密</span>
                    </div>
                    <h4 className="mt-2 truncate text-base font-semibold text-text-primary">{profile.name}</h4>
                    <p className="mt-1 truncate font-mono text-xs text-text-muted" title={profile.config.baseUrl}>{profile.config.baseUrl}</p>
                  </div>
                  <button type="button" onClick={() => remove(profile)} className="rounded-lg p-1.5 text-text-muted hover:bg-red-50 hover:text-red-500" aria-label={`删除 ${profile.name}`}><Trash2 size={15} /></button>
                </div>

                <div className="mt-4 min-h-8">
                  {deployed.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {deployed.map((item) => <span key={item.deviceId} className="inline-flex items-center gap-1 rounded-lg bg-surface-card px-2 py-1 text-[11px] text-text-secondary"><Monitor size={11} />{item.deviceName}</span>)}
                    </div>
                  ) : <p className="text-xs text-text-muted">尚未下发到设备</p>}
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-surface-sunken pt-3">
                  <p className="text-[11px] text-text-muted">{profile.lastPushedAt ? `最近下发 ${new Date(profile.lastPushedAt).toLocaleString()}` : "保存后不会自动下发"}</p>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => { setError(""); setDraft(editDraft(profile)); }}>编辑</Button>
                    <Button variant="primary" size="sm" leftIcon={<Send size={13} />} onClick={() => setSending({ profile, selected: new Set() })}>下发</Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {draft && (
        <Modal
          title={`${draft.id ? "编辑" : "新建"} ${draft.tool === "codex" ? "Codex" : "Claude Code"} 配置`}
          subtitle="留空密钥表示保持已保存值；修改配置后仍需手动选择设备下发。"
          width="w-[760px]"
          busy={saving}
          onClose={() => { setDraft(null); setError(""); }}
          footer={<><Button variant="secondary" onClick={() => setDraft(null)} disabled={saving}>取消</Button><Button variant="primary" loading={saving} onClick={save}>保存配置档</Button></>}
        >
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="配置名称"><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputCls} placeholder="如 公司中转 / 个人备用" /></Field>
              <Field
                label={draft.tool === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_AUTH_TOKEN"}
                hint={`${draft.tool === "codex" ? "写入 ~/.codex/auth.json" : "写入 ~/.claude/settings.json env"}；${draft.secretConfigured ? "留空保留原凭据。" : "加密保存，不回显。"}`}
              >
                <input type="password" value={draft.secret} onChange={(e) => setDraft({ ...draft, secret: e.target.value })} className={inputCls} placeholder={draft.secretConfigured ? "已配置，留空保持" : "请输入凭据"} autoComplete="new-password" />
              </Field>
            </div>

            {draft.tool === "codex" ? (
              <CodexFields draft={draft} onChange={setDraft} />
            ) : (
              <ClaudeFields draft={draft} onChange={setDraft} />
            )}
            {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
          </div>
        </Modal>
      )}

      {sending && (
        <Modal
          title={`下发「${sending.profile.name}」`}
          subtitle="将合并写入所选设备的用户级配置；同一工具之前下发的配置档会被本次替换。"
          busy={pushing}
          onClose={() => setSending(null)}
          footer={<><Button variant="secondary" onClick={() => setSending(null)} disabled={pushing}>取消</Button><Button variant="primary" loading={pushing} disabled={sending.selected.size === 0} onClick={distribute}>下发到 {sending.selected.size} 台设备</Button></>}
        >
          {onlineDevices.length === 0 ? <p className="py-8 text-center text-sm text-text-muted">暂无在线设备，请先在目标设备运行 loom start。</p> : (
            <div className="space-y-2">
              {onlineDevices.map((device) => {
                const checked = sending.selected.has(device.id);
                const current = distributions.find((item) => item.deviceId === device.id && item.tool === sending.profile.tool);
                return (
                  <label key={device.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-surface-sunken p-3 hover:bg-surface-card">
                    <input type="checkbox" className="accent-brand" checked={checked} onChange={() => {
                      const selected = new Set(sending.selected);
                      if (checked) selected.delete(device.id); else selected.add(device.id);
                      setSending({ ...sending, selected });
                    }} />
                    <span className="grid h-8 w-8 place-items-center rounded-lg bg-surface-sunken text-text-muted"><Monitor size={15} /></span>
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-text-primary">{device.deviceName}</span><span className="block text-xs text-text-muted">在线 · {current ? "将替换当前配置" : "首次下发此工具"}</span></span>
                    {current?.profileId === sending.profile.id && <span className="text-[11px] text-brand">已是当前配置</span>}
                  </label>
                );
              })}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function CodexFields({ draft, onChange }: { draft: Extract<Draft, { tool: "codex" }>; onChange: (draft: Draft) => void }) {
  const update = <K extends keyof CodexToolConfig>(key: K, value: CodexToolConfig[K]) => onChange({ ...draft, config: { ...draft.config, [key]: value } });
  return (
    <>
      <div className="border-t border-surface-sunken pt-5">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-text-muted">配置文件</h4>
          <code className="text-xs font-medium text-brand">~/.codex/config.toml</code>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="model_provider / Provider name" hint="同时写入 model_provider、section 与 name。">
            <input value={draft.config.modelProvider} onChange={(e) => update("modelProvider", e.target.value)} className={inputCls} placeholder="如 OpenAI 或 CompanyGateway" />
          </Field>
          <Field label="base_url" hint="Provider 的 API 地址，通常以 /v1 结尾。">
            <input value={draft.config.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} className={inputCls} placeholder="如 https://api.example.com/v1" />
          </Field>
          <Field label="wire_api" hint="通信协议，当前仅支持 Responses API。">
            <input value="responses" disabled className={`${inputCls} bg-surface-card text-text-muted`} />
          </Field>
          <Field label="network_access" hint="任务网络权限：enabled 允许，disabled 禁止。">
            <select value={draft.config.networkAccess} onChange={(e) => update("networkAccess", e.target.value as "enabled" | "disabled")} className={inputCls}><option value="enabled">enabled</option><option value="disabled">disabled</option></select>
          </Field>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Toggle checked={draft.config.disableResponseStorage} onChange={(v) => update("disableResponseStorage", v)} label="disable_response_storage" detail="禁止服务端保存响应内容" />
          <Toggle checked={draft.config.windowsWslSetupAcknowledged} onChange={(v) => update("windowsWslSetupAcknowledged", v)} label="windows_wsl_setup_acknowledged" detail="确认已完成 Windows / WSL 初始化" />
          <Toggle checked={draft.config.requiresOpenaiAuth} onChange={(v) => update("requiresOpenaiAuth", v)} label="requires_openai_auth" detail="从 ~/.codex/auth.json 读取 API Key" />
          <Toggle checked={draft.config.goals} onChange={(v) => update("goals", v)} label="features.goals" detail="启用持久目标" />
        </div>
      </div>
    </>
  );
}

function ClaudeFields({ draft, onChange }: { draft: Extract<Draft, { tool: "claudecode" }>; onChange: (draft: Draft) => void }) {
  const update = <K extends keyof ClaudeCodeToolConfig>(key: K, value: ClaudeCodeToolConfig[K]) => onChange({ ...draft, config: { ...draft.config, [key]: value } });
  const fields: Array<[keyof ClaudeCodeToolConfig, string, string]> = [
    ["defaultFableModel", "ANTHROPIC_DEFAULT_FABLE_MODEL", "Fable 档位使用的模型 ID（可选），如 k3[1M]"],
    ["defaultFableModelName", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", "Fable 档位显示名（可选），如 k3"],
    ["defaultHaikuModel", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "Haiku 档位使用的模型 ID（可选），如 k3"],
    ["defaultHaikuModelName", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", "Haiku 档位显示名（可选），如 k3"],
    ["defaultOpusModel", "ANTHROPIC_DEFAULT_OPUS_MODEL", "Opus 档位使用的模型 ID（可选），如 k3[1M]"],
    ["defaultOpusModelName", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", "Opus 档位显示名（可选），如 k3"],
    ["defaultSonnetModel", "ANTHROPIC_DEFAULT_SONNET_MODEL", "Sonnet 档位使用的模型 ID（可选），如 glm-5.2[1M]"],
    ["defaultSonnetModelName", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", "Sonnet 档位显示名（可选），如 glm-5.2"],
    ["model", "ANTHROPIC_MODEL", "未指定档位时使用的主模型 ID（可选），如 k3"],
    ["apiTimeoutMs", "API_TIMEOUT_MS", "请求超时毫秒数（可选），如 3000000"],
    ["disableNonessentialTraffic", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1=禁用非必要流量；留空不修改"],
    ["experimentalAgentTeams", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1=启用实验性 Agent Teams；留空不修改"],
    ["enableToolSearch", "ENABLE_TOOL_SEARCH", "true=启用工具搜索；留空不修改"],
  ];
  return (
    <div className="border-t border-surface-sunken pt-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-text-muted">配置文件</h4>
        <code className="text-xs font-medium text-brand">~/.claude/settings.json</code>
        <span className="text-[11px] text-text-muted">env 字段</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="ANTHROPIC_BASE_URL" hint="Claude Code 使用的 API 地址。"><input value={draft.config.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} className={inputCls} placeholder="如 https://api.example.com" /></Field>
        {fields.map(([key, label, placeholder]) => (
          <Field key={key} label={label}><input value={String(draft.config[key])} onChange={(e) => update(key, e.target.value as never)} className={inputCls} placeholder={placeholder} /></Field>
        ))}
      </div>
      <div className="mt-4">
        <Toggle checked={draft.config.hasCompletedOnboarding} onChange={(v) => update("hasCompletedOnboarding", v)} label="~/.claude.json · hasCompletedOnboarding" detail="默认 true，仅更新此字段" />
      </div>
    </div>
  );
}
