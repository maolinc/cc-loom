import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { api } from "../../api.js";
import Button from "../../components/Button.js";
import { useToast } from "../../components/Toast.js";
import type { AiSettings } from "@maolinc/cc-loom-shared";

const inputCls =
  "w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

export default function AiTab() {
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<AiSettings>("/settings/ai").then((res) => {
      setLoading(false);
      if (res.success && res.data) {
        setBaseUrl(res.data.baseUrl);
        setModel(res.data.model);
        setApiKeyConfigured(res.data.apiKeyConfigured);
      } else {
        setError(res.error || "加载 AI 配置失败");
      }
    });
  }, []);

  const save = async () => {
    setError("");
    if (!baseUrl.trim()) {
      setError("请填写 AI Base URL");
      return;
    }
    if (!model.trim()) {
      setError("请填写模型名称");
      return;
    }
    if (!apiKeyConfigured && !apiKey.trim()) {
      setError("请填写 API Key");
      return;
    }

    setSaving(true);
    const payload: { baseUrl: string; model: string; apiKey?: string } = {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
    };
    if (apiKey.trim()) payload.apiKey = apiKey.trim();

    const res = await api.put<AiSettings>("/settings/ai", payload);
    setSaving(false);
    if (res.success && res.data) {
      setBaseUrl(res.data.baseUrl);
      setModel(res.data.model);
      setApiKeyConfigured(res.data.apiKeyConfigured);
      setApiKey("");
      toast.success("AI 配置已保存");
    } else {
      setError(res.error || "保存失败");
    }
  };

  if (loading) return <p className="text-sm text-text-muted">加载中...</p>;

  return (
    <div className="max-w-2xl">
      <div className="mb-6 p-4 bg-white rounded-xl border border-surface-sunken flex gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-soft text-brand grid place-items-center shrink-0">
          <Bot size={18} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-text-primary mb-1">AI 基础信息生成</h3>
          <p className="text-sm text-text-secondary leading-relaxed">
            配置 OpenAI 兼容的 Chat Completions 服务后，可在能力创建/编辑页根据已填写内容和文件生成名称、标签与描述。生成结果只回填表单，点击保存或创建后才会生效。
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">AI Base URL</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={inputCls}
          />
          <p className="mt-1 text-xs text-text-muted">支持填写到 /v1；系统会自动请求 /chat/completions。</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">模型</label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            className={inputCls}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={apiKeyConfigured ? "已配置，留空则保持不变" : "请输入 API Key"}
            className={inputCls}
          />
          <p className="mt-1 text-xs text-text-muted">
            {apiKeyConfigured ? "当前已保存 API Key；如需替换，请输入新的 Key 后保存。" : "尚未保存 API Key。"}
          </p>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button variant="primary" loading={saving} onClick={save}>保存 AI 配置</Button>
          {error && <span className="text-sm text-red-500">{error}</span>}
        </div>
      </div>
    </div>
  );
}
