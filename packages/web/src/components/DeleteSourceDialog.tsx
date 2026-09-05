import { useState } from "react";
import { api } from "../api.js";
import { useToast } from "./Toast.js";
import ConfirmDialog from "./ConfirmDialog.js";

interface Props {
  source: { id: string; displayName: string; assetCount: number; capabilitySetCount: number };
  onClose: () => void;
  onRemoved: () => void;
}

export default function DeleteSourceDialog({ source, onClose, onRemoved }: Props) {
  const toast = useToast();
  const [keepAssets, setKeepAssets] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleDelete = async () => {
    setSubmitting(true);
    const res = await api.delete<any>(
      `/marketplaces/${source.id}?keepAssets=${keepAssets ? "true" : "false"}`,
    );
    setSubmitting(false);
    if (res.success) {
      toast.success("来源已删除", source.displayName);
      onRemoved();
      onClose();
    } else {
      toast.error("删除失败", res.error ?? "请稍后重试");
    }
  };

  return (
    <ConfirmDialog
      open
      kind="danger"
      title={`删除来源「${source.displayName}」`}
      description={
        <>
          该来源下有 <span className="font-medium text-text-primary">{source.assetCount}</span> 个能力
          {source.capabilitySetCount > 0 && (
            <>
              、<span className="font-medium text-text-primary">{source.capabilitySetCount}</span> 个能力集
            </>
          )}
          。
        </>
      }
      extra={
        <div className="mt-4 rounded-lg border border-surface-sunken bg-surface-card/60 p-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!keepAssets}
              onChange={(e) => setKeepAssets(!e.target.checked)}
              className="mt-0.5 accent-red-600"
            />
            <span className="text-sm text-text-primary">同时删除该来源下的所有能力（默认）</span>
          </label>
          <p className="text-xs text-text-muted mt-2 leading-relaxed">
            {keepAssets
              ? `保留这些能力：它们会变成普通能力，作者改为「imported from ${source.displayName}」。`
              : "勾选时这些能力会被一并永久删除。"}
          </p>
        </div>
      }
      confirmLabel="确认删除"
      confirmingLabel="删除中…"
      busy={submitting}
      onConfirm={handleDelete}
      onCancel={onClose}
    />
  );
}
