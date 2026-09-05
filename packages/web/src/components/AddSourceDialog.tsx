import { useState } from "react";
import { Info } from "lucide-react";
import { api } from "../api.js";
import { useToast } from "./Toast.js";
import Modal from "./Modal.js";
import Button from "./Button.js";
import { ASSET_TYPES, ASSET_TYPE_LABELS, ASSET_TYPE_COLORS, type AssetType } from "@maolinc/cc-loom-shared";

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

export default function AddSourceDialog({ onClose, onAdded }: Props) {
  const toast = useToast();
  const [repoUrl, setRepoUrl] = useState("");
  const [ref, setRef] = useState("");
  // 默认全选；至少保留一项，避免导入 0 能力。
  const [selectedTypes, setSelectedTypes] = useState<Set<AssetType>>(
    () => new Set(ASSET_TYPES),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleType = (t: AssetType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        // 不允许取消最后一项
        if (next.size === 1) return prev;
        next.delete(t);
      } else {
        next.add(t);
      }
      return next;
    });
  };

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    // 全选 → 不传 assetTypes（服务端规范化为 null = 全部）；子集 → 传数组。
    const assetTypes =
      selectedTypes.size === ASSET_TYPES.length ? undefined : [...selectedTypes];
    const res = await api.post<any>("/marketplaces", { repoUrl, ref: ref || undefined, assetTypes });
    setSubmitting(false);
    if (res.success) {
      toast.success("已添加来源", "正在后台拉取能力…");
      onAdded();
      onClose();
    } else {
      setError(res.error ?? "添加失败");
    }
  };

  return (
    <Modal
      title="添加来源"
      subtitle="从 Git 仓库或 Claude Code Marketplace 同步能力。"
      onClose={onClose}
      busy={submitting}
      footer={
        <>
          <Button variant="secondary" size="sm" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={submitting} disabled={!repoUrl} onClick={submit}>
            添加并拉取
          </Button>
        </>
      }
    >
      <label className="block text-xs font-medium text-text-secondary mb-1">仓库地址</label>
      <input
        type="text"
        value={repoUrl}
        onChange={(e) => setRepoUrl(e.target.value)}
        placeholder="https://github.com/owner/repo"
        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 mb-3"
      />
      <label className="block text-xs font-medium text-text-secondary mb-1">分支或 Tag（可选）</label>
      <input
        type="text"
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        placeholder="留空使用默认分支"
        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 mb-3"
      />
      <div className="flex items-center justify-between mb-1">
        <label className="block text-xs font-medium text-text-secondary">导入的能力类型</label>
        <span className="text-[11px] text-text-muted">
          {selectedTypes.size === ASSET_TYPES.length ? "全部" : `已选 ${selectedTypes.size}/${ASSET_TYPES.length}`}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {ASSET_TYPES.map((t) => {
          const active = selectedTypes.has(t);
          const c = ASSET_TYPE_COLORS[t];
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleType(t)}
              className="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors"
              style={
                active
                  ? { backgroundColor: c.bg, color: c.text, borderColor: c.bg }
                  : { backgroundColor: "transparent", color: "var(--text-muted)", borderColor: "var(--border)" }
              }
              aria-pressed={active}
            >
              {ASSET_TYPE_LABELS[t]}
            </button>
          );
        })}
      </div>
      <p className="flex items-start gap-1.5 text-xs text-text-muted">
        <Info size={13} className="shrink-0 mt-0.5" />
        系统会自动判断该仓库是 Claude Code Marketplace 还是普通 Git 仓库。仅导入所选类型的能力。
      </p>
      {error && <p className="text-sm text-red-500 mt-3">{error}</p>}
    </Modal>
  );
}
