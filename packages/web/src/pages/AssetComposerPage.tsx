/**
 * 能力创建 / 编辑页面（取代原 AssetEditorDialog 弹窗）。
 *
 * 路由：
 *   - /assets/new        新建
 *   - /assets/:id/edit   编辑（fetch /assets/:id 预填）
 *
 * 布局：左侧分区表单（类型→基础信息→类型配置→兼容工具/可见性→文件），
 * 右侧 sticky 实时面板（规范说明 + 各厂商安装路径预览 + 校验清单），
 * 让六类能力「填什么、装到哪、是否合规」一目了然、闭环可上线。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, Upload, FolderUp, Info, FileJson, Pencil, Check, Sparkles, KeyRound, ExternalLink } from "lucide-react";
import {
  ASSET_TYPES,
  ASSET_TYPE_LABELS,
  ASSET_TYPE_COLORS,
  TARGET_TOOLS,
  TARGET_TOOL_LABELS,
  TARGET_DIRS,
  ADAPTER_SUPPORT,
  HOOK_EVENTS,
} from "@maolinc/cc-loom-shared";
import type { AssetType, GeneratedAssetBasicInfo, TargetTool, Visibility } from "@maolinc/cc-loom-shared";
import { api } from "../api.js";
import { useToast } from "../components/Toast.js";
import Button from "../components/Button.js";
import ToolIcon from "../components/ToolIcon.js";
import { InlineLoading, ErrorState } from "../components/PageState.js";
import {
  emptyAssetForm,
  assetToForm,
  defaultFileName,
  validateAssetForm,
  formToPayload,
  seedFiles,
  type AssetFormState,
} from "../lib/assetForm.js";
import { getSpec, slugify } from "../lib/capabilitySpec.js";
import { readFiles } from "../lib/fileUpload.js";

/** 类型选择卡片的一句话定位。 */
const TYPE_TAGLINE: Record<AssetType, string> = {
  skill: "目录式自然语言能力",
  rule: "约束 AI 行为的规范",
  mcp: "连接外部系统的服务",
  hook: "事件驱动的脚本",
  command: "斜杠命令工作流",
  agent: "独立上下文子代理",
};

export default function AssetComposerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const isEdit = !!id;

  const [form, setForm] = useState<AssetFormState>(() => emptyAssetForm());
  const [saving, setSaving] = useState(false);
  const [generatingBasicInfo, setGeneratingBasicInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 该能力是否已被能力集/本地项目引用：编辑态下为 true 时锁定「名称」（只能改别名），
  // 与后端 PUT 改名拦截保持一致；AI 生成也不得改写已锁定的名称。
  const [referenced, setReferenced] = useState(false);
  const nameLocked = isEdit && referenced;

  // 编辑态加载
  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = (signal?: AbortSignal) => {
    if (!isEdit) return;
    setLoading(true);
    setLoadError(null);
    api.get<any>(`/assets/${id}`, signal).then((res) => {
      if (signal?.aborted) return;
      setLoading(false);
      if (res.success && res.data) {
        setForm(assetToForm(res.data));
        // 服务端返回 refs: { capabilitySetRefs, installRefs, total }
        setReferenced(!!res.data.refs?.total);
      } else setLoadError(res.error || "无法加载该能力");
    });
  };
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isEdit]);

  const patch = (p: Partial<AssetFormState>) => setForm((f) => ({ ...f, ...p }));
  const spec = getSpec(form.type);

  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  };

  const handleTypeChange = (t: AssetType) =>
    setForm((f) => {
      if (f.type === t) return f;
      // 不同类型的文件语义完全不同（如 skill 的 SKILL.md ≠ rule 的 rule.md），
      // 切换时按新类型重置文件，避免上一类型内容残留。
      return {
        ...f,
        type: t,
        filesTouched: false,
        files: f.fileMode === "manual" ? seedFiles(t, f) : [],
      };
    });

  const setFileMode = (mode: "manual" | "upload") =>
    setForm((f) => {
      if (f.fileMode === mode) return f;
      if (mode === "upload") return { ...f, fileMode: mode, files: f.filesTouched ? f.files : [] };
      return { ...f, fileMode: mode, files: f.files.length ? f.files : seedFiles(f.type, f) };
    });

  const updateFile = (i: number, p: Partial<{ path: string; content: string }>) =>
    setForm((f) => ({
      ...f,
      filesTouched: true,
      files: f.files.map((file, idx) => (idx === i ? { ...file, ...p } : file)),
    }));
  const addFile = () =>
    setForm((f) => ({ ...f, filesTouched: true, files: [...f.files, { path: "", content: "" }] }));
  const removeFile = (i: number) =>
    setForm((f) => ({ ...f, filesTouched: true, files: f.files.filter((_, idx) => idx !== i) }));

  const handleUploadFolder = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const { files: read, skipped } = await readFiles(fileList);
    if (read.length === 0) {
      setError(skipped.length ? `未能导入：${skipped.map((s) => s.reason)[0]}` : "未读取到文件");
      return;
    }
    setError(null);
    setForm((f) => ({ ...f, filesTouched: true, files: read }));
    const note = skipped.length ? `，已跳过 ${skipped.length} 个（超大/无法读取）` : "";
    toast.success("已导入文件夹", `${read.length} 个文件${note}`);
  };

  const handleUploadSingle = async (fileList: FileList | null, forcePath?: string) => {
    if (!fileList || fileList.length === 0) return;
    const { files: read } = await readFiles(fileList);
    const first = read[0];
    if (!first) { setError("未读取到文件"); return; }
    setError(null);
    setForm((f) => ({
      ...f,
      filesTouched: true,
      files: [{ path: forcePath ?? first.path, content: first.content, ...(first.encoding ? { encoding: first.encoding } : {}) }],
    }));
    toast.success("已导入文件", forcePath ?? first.path);
  };

  const canGenerateBasicInfo = Boolean(
    form.name.trim()
    || form.alias.trim()
    || form.description.trim()
    || form.tags.trim()
    || (form.filesTouched && form.files.some((f) => f.path.trim() || f.content.trim())),
  );

  const handleGenerateBasicInfo = async () => {
    if (!canGenerateBasicInfo) {
      setError("请先上传文件或填写一些内容，再使用 AI 生成");
      return;
    }
    setError(null);
    setGeneratingBasicInfo(true);
    const payload = formToPayload(form, "create") as any;
    const res = await api.post<GeneratedAssetBasicInfo>("/ai/asset-basic-info", {
      type: form.type,
      name: form.name,
      description: form.description,
      tags: payload.tags,
      metadata: payload.metadata,
      files: form.files
        .filter((f) => !f.encoding && (f.path.trim() || f.content.trim()))
        .map((f) => ({ path: f.path.trim(), content: f.content })),
    });
    setGeneratingBasicInfo(false);
    if (res.success && res.data) {
      setForm((f) => ({
        ...f,
        // name 是落盘身份、由作者自填，AI 不再生成——始终保留用户已填的名称
        name: f.name,
        alias: res.data!.alias,
        tags: res.data!.tags.join(", "),
        description: res.data!.description,
        // AI 推断的鉴权声明一并回填（绑定列表）；未返回时保持原值
        ...(res.data!.auth?.bindings?.length
          ? {
              authBindings: res.data!.auth!.bindings.map((b) => ({
                credentialName: b.credentialName ?? "",
                kind: b.kind,
                envKey: b.envKey ?? "",
                path: b.path ?? "",
                authPageUrl: b.authPageUrl ?? "",
              })),
            }
          : {}),
      }));
      toast.success("已生成基础信息", "请检查后再保存");
    } else {
      setError(res.error || "生成失败");
      toast.error("生成失败", res.error || "请稍后重试");
    }
  };

  const handleSave = async () => {
    const err = validateAssetForm(form);
    if (err) { setError(err); return; }
    setError(null);
    const payload = formToPayload(form, isEdit ? "update" : "create");
    // 二进制文件以 base64 内联在 JSON 里，提交前预检总体积，超限直接提示，
    // 避免发出注定被服务端拒绝（body 上限）而表现为"卡住"的大请求。
    const bodyBytes = new Blob([JSON.stringify(payload)]).size;
    const MAX_BODY_BYTES = 60 * 1024 * 1024;
    if (bodyBytes > MAX_BODY_BYTES) {
      setError(`内容总体积约 ${(bodyBytes / 1024 / 1024).toFixed(1)}MB，超过上限，请减少文件数量或体积`);
      return;
    }
    setSaving(true);
    const res = isEdit
      ? await api.put<any>(`/assets/${id}`, payload)
      : await api.post<any>("/assets", payload);
    setSaving(false);
    if (res.success && res.data) {
      toast.success(isEdit ? "能力已更新" : "能力已创建", form.name);
      if (isEdit) goBack();
      else navigate("/");
    } else {
      setError(res.error || "保存失败");
    }
  };

  if (isEdit && loading) {
    return <div className="py-24"><InlineLoading label="加载能力…" /></div>;
  }
  if (isEdit && loadError) {
    return <ErrorState message={loadError} onRetry={load} />;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" leftIcon={<ArrowLeft size={15} />} onClick={goBack}>返回</Button>
          <h1 className="text-xl font-bold text-text-primary tracking-tight truncate">
            {isEdit ? "编辑能力" : "创建能力"}
          </h1>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {error && <span className="text-sm text-red-500 max-w-[280px] truncate">{error}</span>}
          <Button variant="secondary" onClick={goBack} disabled={saving}>取消</Button>
          <Button variant="primary" loading={saving} onClick={handleSave}>
            {isEdit ? "保存修改" : "创建能力"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        {/* ============ 左：表单 ============ */}
        <div className="space-y-5 min-w-0">
          {/* 类型 —— 创建时选择，编辑态不可改故省略（类型已在右侧面板顶部展示） */}
          {!isEdit && (
            <SectionCard title="类型" desc="选择要创建的能力类型">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ASSET_TYPES.map((t) => (
                  <TypeCard key={t} type={t} active={form.type === t} onClick={() => handleTypeChange(t)} />
                ))}
              </div>
            </SectionCard>
          )}

          {/* 基础信息 */}
          <SectionCard
            title="基础信息"
            desc="可根据已填写内容或已上传文件生成，生成结果仅回填表单。"
            action={(
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Sparkles size={13} />}
                loading={generatingBasicInfo}
                disabled={saving || !canGenerateBasicInfo}
                onClick={handleGenerateBasicInfo}
              >
                AI 生成
              </Button>
            )}
          >
            <div className="grid grid-cols-2 gap-4">
              <Field label={nameLocked ? "名称（已锁定 — 被引用时不可修改）" : "名称（英文/数字/_/-）"}>
                <input
                  value={form.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="react_component_generator"
                  className={inputCls}
                  disabled={nameLocked}
                  readOnly={nameLocked}
                  title={nameLocked ? "该能力已被能力集或本地项目引用，名称不可修改" : undefined}
                />
              </Field>
              <Field label="别名（可选，可中文）">
                <input value={form.alias} onChange={(e) => patch({ alias: e.target.value })} placeholder="React 组件生成器" className={inputCls} />
              </Field>
              <Field label="来源地址（可选）">
                <input value={form.sourceUrl} onChange={(e) => patch({ sourceUrl: e.target.value })} placeholder="https://github.com/example/repo" className={inputCls} />
              </Field>
              <Field label="标签（逗号分隔，最多 5 个）">
                <input value={form.tags} onChange={(e) => patch({ tags: e.target.value })} placeholder="前端, React, 组件生成" className={inputCls} />
              </Field>
            </div>
            <Field label="描述">
              <textarea value={form.description} onChange={(e) => patch({ description: e.target.value })} rows={2} placeholder="一句话说明这个能力的用途" className={`${inputCls} resize-none`} />
            </Field>
          </SectionCard>

          {/* 类型配置（skill / agent 无配置则不渲染） */}
          {hasTypeConfig(form.type) && (
            <SectionCard title="类型配置" desc={typeConfigDesc(form.type)}>
              <TypeMetadataFields form={form} patch={patch} />
            </SectionCard>
          )}

          {/* 兼容工具 + 可见性 */}
          <SectionCard title="兼容工具与可见性">
            <div className="grid grid-cols-2 gap-4">
              <Field label="兼容工具">
                <div className="flex flex-wrap gap-1.5">
                  {TARGET_TOOLS.map((t) => (
                    <ToolToggle
                      key={t}
                      tool={t}
                      active={form.compatibleTools.includes(t)}
                      supported={ADAPTER_SUPPORT[t].includes(form.type)}
                      onToggle={() =>
                        patch({
                          compatibleTools: form.compatibleTools.includes(t)
                            ? form.compatibleTools.filter((x) => x !== t)
                            : [...form.compatibleTools, t],
                        })
                      }
                    />
                  ))}
                </div>
              </Field>
              <Field label="可见性">
                <div className="flex gap-2">
                  {(["private", "public"] as Visibility[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => patch({ visibility: v })}
                      className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        form.visibility === v ? "bg-brand text-white" : "bg-surface-sunken text-text-secondary hover:bg-gray-200"
                      }`}
                    >
                      {v === "public" ? "公开" : "个人"}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </SectionCard>

          {/* 鉴权声明（绑定列表，ADR-0003） */}
          <SectionCard title="能力鉴权声明">
            <div className="space-y-3">
              <p className="text-xs text-text-muted leading-relaxed">
                声明本能力运行所需的凭据。每条绑定 = 一个凭据名 × 消费方式：env = 推到设备系统环境变量；
                path = 在 MCP 配置 JSON 的指定路径注入值（仅 mcp 能力）。值由用户在「设置 → 能力鉴权配置」维护并显式分发，与声明解耦。
              </p>
              {form.authBindings.map((b, i) => (
                <div key={i} className="p-3 rounded-lg border border-surface-sunken space-y-2 bg-surface-card/50">
                  <div className="flex items-center gap-2">
                    <select
                      value={b.kind}
                      onChange={(e) => {
                        const next = [...form.authBindings];
                        next[i] = { ...b, kind: e.target.value as "env" | "path" };
                        patch({ authBindings: next });
                      }}
                      className="px-2.5 py-1.5 rounded-lg border border-gray-200 text-sm bg-white"
                    >
                      <option value="env">env（系统环境变量）</option>
                      <option value="path">path（注入 MCP 配置）</option>
                    </select>
                    <button
                      onClick={() => patch({ authBindings: form.authBindings.filter((_, j) => j !== i) })}
                      className="ml-auto p-1 rounded text-text-muted hover:text-red-500 hover:bg-red-50"
                      title="移除该绑定"
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    value={b.credentialName}
                    onChange={(e) => {
                      const next = [...form.authBindings];
                      next[i] = { ...b, credentialName: e.target.value };
                      patch({ authBindings: next });
                    }}
                    placeholder="凭据名，如 GITHUB_TOKEN"
                    className={inputCls}
                  />
                  {b.kind === "env" ? (
                    <input
                      value={b.envKey}
                      onChange={(e) => {
                        const next = [...form.authBindings];
                        next[i] = { ...b, envKey: e.target.value };
                        patch({ authBindings: next });
                      }}
                      placeholder="环境变量名，如 GITHUB_TOKEN"
                      className={inputCls}
                    />
                  ) : (
                    <input
                      value={b.path}
                      onChange={(e) => {
                        const next = [...form.authBindings];
                        next[i] = { ...b, path: e.target.value };
                        patch({ authBindings: next });
                      }}
                      placeholder="注入路径，如 headers/Authorization（相对 MCP server 定义，/ 分隔）"
                      className={inputCls}
                    />
                  )}
                  <input
                    value={b.authPageUrl}
                    onChange={(e) => {
                      const next = [...form.authBindings];
                      next[i] = { ...b, authPageUrl: e.target.value };
                      patch({ authBindings: next });
                    }}
                    placeholder="获取凭据的页面地址（可选，https://...）"
                    className={inputCls}
                  />
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Plus size={15} />}
                onClick={() =>
                  patch({
                    authBindings: [...form.authBindings, { credentialName: "", kind: "env", envKey: "", path: "", authPageUrl: "" }],
                  })
                }
              >
                添加鉴权绑定
              </Button>
            </div>
          </SectionCard>

          {/* 文件 */}
          <SectionCard title="文件">
            <FilesEditor
              form={form}
              onSetMode={setFileMode}
              onUpdateFile={updateFile}
              onAddFile={addFile}
              onRemoveFile={removeFile}
              onUploadFolder={handleUploadFolder}
              onUploadSingle={handleUploadSingle}
            />
          </SectionCard>
        </div>

        {/* ============ 右：实时面板 ============ */}
        <aside className="space-y-4 lg:sticky lg:top-20">
          <div className="rounded-2xl border border-surface-sunken bg-white p-4 shadow-soft">
            <div className="flex items-center gap-2 mb-2">
              <TypeBadge type={form.type} />
            </div>
            <div className="flex items-start gap-2 text-xs text-text-secondary leading-relaxed">
              <Info size={13} className="text-brand shrink-0 mt-0.5" />
              <span>{spec.hint}</span>
            </div>
          </div>

          <BasicInfoPreview form={form} />

          <InstallPreview form={form} />

          <ChecklistCard form={form} />
        </aside>
      </div>
    </div>
  );
}

// ============ 基础信息预览（右侧实时面板） ============

function BasicInfoPreview({ form }: { form: AssetFormState }) {
  const name = form.name.trim();
  const alias = form.alias.trim();
  const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
  const description = form.description.trim();
  const bindings = form.authBindings.filter((b) => b.credentialName.trim());
  const hasAuth = bindings.length > 0;

  return (
    <div className="rounded-2xl border border-surface-sunken bg-white p-4 shadow-soft">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2.5">基础信息</h3>
      <dl className="space-y-2 text-xs">
        <PreviewRow label="名称" value={name || <span className="text-text-muted">未填写</span>} mono />
        {alias && <PreviewRow label="别名" value={alias} />}
        {tags.length > 0 && (
          <div className="flex gap-1.5">
            <dt className="text-text-muted w-12 shrink-0">标签</dt>
            <dd className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <span key={t} className="px-1.5 py-0.5 rounded bg-surface-sunken text-text-secondary">{t}</span>
              ))}
            </dd>
          </div>
        )}
        {description && (
          <div className="flex gap-1.5">
            <dt className="text-text-muted w-12 shrink-0">描述</dt>
            <dd className="text-text-secondary leading-relaxed">{description}</dd>
          </div>
        )}
        <div className="flex gap-1.5 pt-1 border-t border-gray-50">
          <dt className="text-text-muted w-12 shrink-0 flex items-center gap-1">
            <KeyRound size={11} /> 鉴权
          </dt>
          <dd className="min-w-0">
            {hasAuth ? (
              <div className="space-y-0.5">
                {bindings.map((b, i) => (
                  <div key={i} className="flex items-center gap-1.5 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${b.kind === "env" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                      {b.kind === "env" ? "环境变量" : "注入路径"}
                    </span>
                    <code className="font-mono text-text-secondary">{b.kind === "env" ? b.envKey.trim() : b.path.trim()}</code>
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-text-muted">免鉴权</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function PreviewRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-text-muted w-12 shrink-0">{label}</dt>
      <dd className={`text-text-secondary break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

// ============ 校验清单 ============

function ChecklistCard({ form }: { form: AssetFormState }) {
  const items = useMemo(() => buildChecklist(form), [form]);
  return (
    <div className="rounded-2xl border border-surface-sunken bg-white p-4 shadow-soft">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2.5">提交检查</h3>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2 text-xs">
            <span className={`w-4 h-4 rounded-full grid place-items-center shrink-0 ${it.ok ? "bg-mcp-green-bg text-mcp-green-text" : "bg-surface-sunken text-text-muted"}`}>
              {it.ok ? <Check size={11} /> : <span className="w-1 h-1 rounded-full bg-current" />}
            </span>
            <span className={it.ok ? "text-text-secondary" : "text-text-muted"}>{it.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function buildChecklist(form: AssetFormState): { label: string; ok: boolean }[] {
  const files = form.files.filter((f) => f.path.trim() && f.content.trim());
  const out: { label: string; ok: boolean }[] = [
    { label: "填写名称", ok: !!form.name.trim() },
    { label: "至少一个兼容工具", ok: form.compatibleTools.length > 0 },
    { label: "至少一个文件", ok: files.length > 0 },
  ];
  if (form.type === "skill") out.push({ label: "包含 SKILL.md", ok: files.some((f) => f.path.trim() === "SKILL.md") });
  if (form.type === "rule") out.push({ label: "填写匹配 Glob", ok: !!form.ruleGlobs.trim() });
  if (form.type === "command") out.push({ label: "填写触发词", ok: !!form.commandTrigger.trim() });
  if (form.type === "hook") out.push({ label: "选择触发事件（可多选）", ok: form.hookEvents.length > 0 });
  if (form.type === "mcp") {
    let jsonOk = false;
    try { JSON.parse(files[0]?.content ?? ""); jsonOk = files.length > 0; } catch { jsonOk = false; }
    out.push({ label: "mcp.json 为合法 JSON", ok: jsonOk });
  }
  return out;
}

// ============ 安装路径预览 ============

function InstallPreview({ form }: { form: AssetFormState }) {
  const name = form.name.trim() || "<name>";
  const slug = slugify(form.name) || "<name>";
  const tools = TARGET_TOOLS.filter((t) => form.compatibleTools.includes(t));

  return (
    <div className="rounded-2xl border border-surface-sunken bg-white p-4 shadow-soft">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2.5">安装路径预览</h3>
      {tools.length === 0 ? (
        <p className="text-xs text-text-muted">先选择兼容工具。</p>
      ) : (
        <ul className="space-y-2">
          {tools.map((t) => {
            const supported = ADAPTER_SUPPORT[t].includes(form.type);
            return (
              <li key={t} className="text-xs">
                <div className="flex items-center gap-1.5 text-text-secondary font-medium mb-0.5">
                  <ToolIcon tool={t} size={14} />
                  {supported ? (
                    <code className="text-[11px] font-mono text-text-muted break-all">{installPath(form.type, t, name, slug)}</code>
                  ) : (
                    <span className="text-[11px] text-amber-600">不支持，安装时跳过</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function installPath(type: AssetType, tool: TargetTool, name: string, slug: string): string {
  const dir = TARGET_DIRS[tool];
  switch (type) {
    case "skill": return `${dir}/skills/${name}/SKILL.md`;
    case "rule": return `${dir}/rules/${slug}.md`;
    case "command": return `${dir}/commands/${slug}.md`;
    case "agent": return `${dir}/agents/${slug}.md`;
    case "hook": return `${dir}/hooks/${name}/… + 注册表`;
    case "mcp": return tool === "claudecode" ? ".mcp.json" : `${dir}/mcp.json`;
  }
}

/** 该类型是否有「类型配置」（skill / agent 没有）。 */
function hasTypeConfig(type: AssetType): boolean {
  return type === "rule" || type === "hook" || type === "command";
}

function typeConfigDesc(type: AssetType): string {
  switch (type) {
    case "rule": return "声明该规则的匹配范围。";
    case "hook": return "声明触发事件与执行方式（写入各厂商 Hook 注册表）。";
    case "command": return "声明斜杠命令的触发词。";
    default: return "";
  }
}

// ============ 通用小组件 ============

const inputCls =
  "w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 transition-shadow";

function SectionCard({ title, desc, action, children }: { title: string; desc?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-surface-sunken bg-white p-5 shadow-soft space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          {desc && <p className="text-xs text-text-muted mt-0.5">{desc}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        {action}
      </div>
      {children}
    </div>
  );
}

function TypeBadge({ type }: { type: AssetType }) {
  const c = ASSET_TYPE_COLORS[type];
  return (
    <span className="px-2.5 py-1 rounded-lg text-xs font-semibold" style={{ backgroundColor: c.bg, color: c.text }}>
      {ASSET_TYPE_LABELS[type]}
    </span>
  );
}

function TypeCard({ type, active, onClick }: { type: AssetType; active: boolean; onClick: () => void }) {
  const c = ASSET_TYPE_COLORS[type];
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-xl border px-3 py-2.5 transition-all ${
        active ? "border-brand ring-2 ring-brand/20 bg-brand-soft/30" : "border-gray-200 hover:border-gray-300"
      }`}
    >
      <span className="inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold mb-1" style={{ backgroundColor: c.bg, color: c.text }}>
        {ASSET_TYPE_LABELS[type]}
      </span>
      <span className="block text-[11px] text-text-muted leading-snug">{TYPE_TAGLINE[type]}</span>
    </button>
  );
}

function ToolToggle({ tool, active, supported, onToggle }: { tool: TargetTool; active: boolean; supported: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={supported ? TARGET_TOOL_LABELS[tool] : `${TARGET_TOOL_LABELS[tool]} · 不支持此类型，安装时会跳过`}
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
        active ? "bg-brand-soft text-brand border-brand/20" : "border-gray-200 text-text-muted hover:border-gray-300"
      } ${!supported && active ? "opacity-60" : ""}`}
    >
      <ToolIcon tool={tool} size={16} showTooltip={false} />
      {!supported && <span className="text-[10px]">跳过</span>}
    </button>
  );
}

function TypeMetadataFields({ form, patch }: { form: AssetFormState; patch: (p: Partial<AssetFormState>) => void }) {
  const hookEvents = useMemo(() => HOOK_EVENTS, []);
  if (form.type === "rule") {
    return (
      <Field label="匹配 Glob（逗号分隔）">
        <input value={form.ruleGlobs} onChange={(e) => patch({ ruleGlobs: e.target.value })} placeholder="**/*.ts, src/**" className={inputCls} />
      </Field>
    );
  }
  if (form.type === "mcp") {
    // MCP 的传输方式 / 启动命令 / URL 全部由 mcp.json 文件内容承载，表单不另设字段
    return null;
  }
  if (form.type === "hook") {
    const toggleEvent = (ev: string) =>
      patch({
        hookEvents: form.hookEvents.includes(ev)
          ? form.hookEvents.filter((e) => e !== ev)
          : [...form.hookEvents, ev],
      });
    return (
      <div className="space-y-4">
        <Field label={`触发事件（可多选，已选 ${form.hookEvents.length} 个）`}>
          <div className="flex flex-wrap gap-1.5">
            {hookEvents.map((ev) => {
              const active = form.hookEvents.includes(ev);
              return (
                <button
                  key={ev}
                  type="button"
                  onClick={() => toggleEvent(ev)}
                  className={`px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
                    active
                      ? "bg-hook-purple-bg text-hook-purple-text border-hook-purple-text/30"
                      : "border-gray-200 text-text-muted hover:border-gray-300"
                  }`}
                >
                  {ev}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Matcher（可选，各事件共享）">
            <input value={form.hookMatcher} onChange={(e) => patch({ hookMatcher: e.target.value })} placeholder="* 或 工具名" className={inputCls} />
          </Field>
          <Field label="Hook 类型">
            <input value={form.hookType} onChange={(e) => patch({ hookType: e.target.value })} placeholder="command" className={inputCls} />
          </Field>
          <Field label="执行命令（可选）">
            <input value={form.hookCommand} onChange={(e) => patch({ hookCommand: e.target.value })} placeholder="hook.sh" className={inputCls} />
          </Field>
        </div>
      </div>
    );
  }
  if (form.type === "command") {
    return (
      <Field label="触发词">
        <input value={form.commandTrigger} onChange={(e) => patch({ commandTrigger: e.target.value })} placeholder="/review" className={inputCls} />
      </Field>
    );
  }
  // skill / agent：无额外配置（不渲染该区块）
  return null;
}

// ============ 文件区（手动 / 上传 二选一）============

function ModeToggle({ mode, onSet }: { mode: "manual" | "upload"; onSet: (m: "manual" | "upload") => void }) {
  const base = "inline-flex items-center gap-1 px-2.5 py-1 rounded-md font-medium transition-colors";
  const on = "bg-white text-text-primary shadow-sm";
  const off = "text-text-muted hover:text-text-secondary";
  return (
    <div className="inline-flex items-center rounded-lg bg-surface-sunken p-0.5 text-xs">
      <button onClick={() => onSet("manual")} className={`${base} ${mode === "manual" ? on : off}`}>
        <Pencil size={11} /> 手动编写
      </button>
      <button onClick={() => onSet("upload")} className={`${base} ${mode === "upload" ? on : off}`}>
        <Upload size={11} /> 上传
      </button>
    </div>
  );
}

function FileRow({
  file, placeholder, onPath, onContent, onRemove, required, rows, readOnly,
}: {
  file: { path: string; content: string };
  placeholder: string;
  onPath?: (v: string) => void;
  onContent?: (v: string) => void;
  onRemove?: () => void;
  required?: boolean;
  rows: number;
  readOnly?: boolean;
}) {
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 bg-surface-card border-b border-surface-sunken">
        <input
          value={file.path}
          onChange={(e) => onPath?.(e.target.value)}
          placeholder={placeholder}
          readOnly={readOnly || !onPath}
          className="flex-1 bg-transparent text-xs font-mono focus:outline-none text-text-primary"
        />
        {required ? (
          <span className="text-[10px] text-text-muted px-1">必需</span>
        ) : onRemove ? (
          <button onClick={onRemove} className="text-text-muted hover:text-red-500"><Trash2 size={13} /></button>
        ) : null}
      </div>
      <textarea
        value={file.content}
        onChange={(e) => onContent?.(e.target.value)}
        rows={rows}
        readOnly={readOnly}
        placeholder="文件内容…"
        className={`w-full px-3 py-2 text-xs font-mono resize-y focus:outline-none text-text-primary ${readOnly ? "bg-surface-card/40 text-text-secondary" : ""}`}
      />
    </div>
  );
}

function DropZone({ icon, label, hasFiles, onClick }: { icon: React.ReactNode; label: string; hasFiles: boolean; onClick: () => void }) {
  if (hasFiles) {
    return (
      <button onClick={onClick} className="inline-flex items-center gap-1 text-xs text-brand hover:underline mb-2">
        {icon} {label}
      </button>
    );
  }
  return (
    <button onClick={onClick} className="w-full rounded-xl border border-dashed border-gray-300 hover:border-brand/50 hover:bg-brand-soft/30 transition-colors px-3 py-8 grid place-items-center gap-1.5 text-text-muted">
      <span className="text-brand">{icon}</span>
      <span className="text-sm font-medium text-text-secondary">{label}</span>
    </button>
  );
}

function jsonStatus(content: string): "ok" | "err" | null {
  if (!content.trim()) return null;
  try { JSON.parse(content); return "ok"; } catch { return "err"; }
}
function JsonBadge({ status }: { status: "ok" | "err" | null }) {
  if (status === "err") return <span className="ml-auto text-[11px] text-red-500">JSON 格式错误</span>;
  if (status === "ok") return <span className="ml-auto text-[11px] text-mcp-green-text">JSON 合法</span>;
  return null;
}

function FilesEditor({
  form, onSetMode, onUpdateFile, onAddFile, onRemoveFile, onUploadFolder, onUploadSingle,
}: {
  form: AssetFormState;
  onSetMode: (m: "manual" | "upload") => void;
  onUpdateFile: (i: number, p: Partial<{ path: string; content: string }>) => void;
  onAddFile: () => void;
  onRemoveFile: (i: number) => void;
  onUploadFolder: (fl: FileList | null) => void;
  onUploadSingle: (fl: FileList | null, forcePath?: string) => void;
}) {
  const spec = getSpec(form.type);
  const manual = form.fileMode === "manual";
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const isSkill = form.type === "skill";
  const hasSkillMd = form.files.some((f) => f.path.trim() === "SKILL.md");

  const hint: React.ReactNode =
    spec.layout === "config"
      ? "MCP 为单个 JSON 配置；多个 MCP 安装时会合并进同一 mcp.json。"
      : isSkill
        ? <>Skill 是目录：必须含 <code className="font-mono">SKILL.md</code>，可附带 <code className="font-mono">scripts/run.sh</code> 等子文件/子目录。</>
        : spec.layout === "directory"
          ? <>目录形态：文件路径可含子目录，如 <code className="font-mono">scripts/run.sh</code>。</>
          : <>单文件 Markdown；文件名 / 子目录在下方路径处编辑。</>;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] text-text-muted">
          {manual ? hint : "上传后将整体作为该能力的文件；与「手动编写」二选一。"}
        </p>
        <ModeToggle mode={form.fileMode} onSet={onSetMode} />
      </div>
      {isSkill && !hasSkillMd && form.files.length > 0 && (
        <p className="text-[11px] text-red-500 mb-2">缺少 SKILL.md：请把入口文件命名为 SKILL.md。</p>
      )}

      {/* 手动 · 配置 */}
      {manual && spec.layout === "config" && (
        <>
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-card border-b border-surface-sunken">
              <span className="text-xs font-mono text-text-secondary">mcp.json</span>
              <JsonBadge status={jsonStatus(form.files[0]?.content ?? "")} />
            </div>
            <textarea
              value={form.files[0]?.content ?? ""}
              onChange={(e) => onUpdateFile(0, { path: "mcp.json", content: e.target.value })}
              rows={8}
              placeholder={'{\n  "mcpServers": { ... }\n}'}
              className="w-full px-3 py-2 text-xs font-mono resize-y focus:outline-none text-text-primary"
            />
          </div>
        </>
      )}

      {/* 手动 · 单文件 */}
      {manual && spec.layout === "single" && (
        <FileRow
          file={form.files[0] ?? { path: defaultFileName(form.type, form.name), content: "" }}
          placeholder={defaultFileName(form.type, form.name)}
          onPath={(v) => onUpdateFile(0, { path: v })}
          onContent={(v) => onUpdateFile(0, { content: v })}
          rows={10}
        />
      )}

      {/* 手动 · 目录 */}
      {manual && spec.layout === "directory" && (
        <div className="space-y-3">
          {form.files.length === 0 && (
            <div className="rounded-xl border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-text-muted">
              还没有文件，点击下方「添加文件」开始。
            </div>
          )}
          {form.files.map((file, i) => {
            const lockRow = isSkill && file.path.trim() === "SKILL.md";
            return (
              <FileRow
                key={i}
                file={file}
                placeholder={isSkill ? "SKILL.md 或 scripts/run.sh" : defaultFileName(form.type, form.name)}
                onPath={(v) => onUpdateFile(i, { path: v })}
                onContent={(v) => onUpdateFile(i, { content: v })}
                onRemove={lockRow ? undefined : () => onRemoveFile(i)}
                required={lockRow}
                rows={5}
              />
            );
          })}
          <button onClick={onAddFile} className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
            <Plus size={12} /> 添加文件
          </button>
        </div>
      )}

      {/* 上传 · 配置 */}
      {!manual && spec.layout === "config" && (
        <>
          <DropZone icon={<FileJson size={20} />} label={form.files.length ? "重新选择 JSON 文件" : "选择 mcp.json 配置文件"} hasFiles={form.files.length > 0} onClick={() => fileRef.current?.click()} />
          <input ref={fileRef} type="file" accept={spec.accept} className="hidden" onChange={(e) => { onUploadSingle(e.target.files, "mcp.json"); e.target.value = ""; }} />
          {form.files[0] && (
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-card border-b border-surface-sunken">
                <span className="text-xs font-mono text-text-secondary">mcp.json</span>
                <JsonBadge status={jsonStatus(form.files[0].content)} />
              </div>
              <textarea value={form.files[0].content} readOnly rows={8} className="w-full px-3 py-2 text-xs font-mono resize-y focus:outline-none text-text-secondary bg-surface-card/40" />
            </div>
          )}
        </>
      )}

      {/* 上传 · 单文件 */}
      {!manual && spec.layout === "single" && (
        <>
          <DropZone icon={<Upload size={20} />} label={form.files.length ? "重新选择文件" : "选择文件"} hasFiles={form.files.length > 0} onClick={() => fileRef.current?.click()} />
          <input ref={fileRef} type="file" accept={spec.accept} className="hidden" onChange={(e) => { onUploadSingle(e.target.files); e.target.value = ""; }} />
          {form.files[0] && <FileRow file={form.files[0]} placeholder="" rows={8} readOnly />}
        </>
      )}

      {/* 上传 · 目录（仅文件夹） */}
      {!manual && spec.layout === "directory" && (
        <>
          <DropZone icon={<FolderUp size={20} />} label={form.files.length ? "重新选择文件夹" : "选择文件夹整体上传"} hasFiles={form.files.length > 0} onClick={() => folderRef.current?.click()} />
          <input
            ref={folderRef}
            type="file"
            className="hidden"
            {...({ webkitdirectory: "", directory: "" } as any)}
            onChange={(e) => { onUploadFolder(e.target.files); e.target.value = ""; }}
          />
          {form.files.length > 0 && (
            <div className="rounded-xl border border-gray-200 divide-y divide-gray-100">
              <div className="px-3 py-1.5 bg-surface-card text-[11px] text-text-muted">共 {form.files.length} 个文件</div>
              {form.files.map((file, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="flex-1 text-xs font-mono text-text-secondary truncate">{file.path}</span>
                  <span className="text-[10px] text-text-muted shrink-0">
                    {file.encoding === "base64" ? "二进制" : `${file.content.split("\n").length} 行`}
                  </span>
                  <button onClick={() => onRemoveFile(i)} className="text-text-muted hover:text-red-500 shrink-0"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
