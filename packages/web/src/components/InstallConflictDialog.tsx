/**
 * InstallConflictDialog —— 撞车裁决弹窗（ADR-0006）。
 *
 * 安装 plan 返回 conflictingAssets（同名不同 id，落盘路径必然撞车）时，
 * 在确认安装前弹出清单让用户逐条裁决：
 *  - 逐条勾选「跳过该能力」（跳过 = 仅本次不装，非永久排除）；
 *  - 「全部跳过并继续」一键跳过全部撞车项并继续安装；
 *  - 「取消安装」放弃本次操作。
 * execute 需携带全部撞车项的 incomingAssetId 作为 skipAssetIds（未裁决会 409），
 * 因此主按钮仅在全部勾选后可点。
 */
import { useEffect, useState } from "react";
import type { InstallConflict } from "@maolinc/cc-loom-shared";
import Modal from "./Modal.js";
import Button from "./Button.js";

interface Props {
  conflicts: InstallConflict[];
  /** 能力集名，用于副标题。 */
  capabilitySetName?: string;
  busy?: boolean;
  /** 用户确认：携带跳过的 incomingAssetId 集合（恒为全部撞车项）。 */
  onConfirm: (skipAssetIds: string[]) => void;
  onCancel: () => void;
}

export default function InstallConflictDialog({
  conflicts,
  capabilitySetName,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  // 每次打开的撞车清单不同，重置勾选状态。
  useEffect(() => {
    setSkipped(new Set());
  }, [conflicts]);

  const allSkipped = skipped.size === conflicts.length;
  const toggle = (id: string) =>
    setSkipped((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirm = (ids: string[]) => onConfirm(ids);

  return (
    <Modal
      title="发现同名能力撞车"
      subtitle={`待安装${capabilitySetName ? `「${capabilitySetName}」` : "的能力集"}中有 ${conflicts.length} 项能力与项目现有能力同名但非同一份，落盘路径必然冲突。请选择跳过这些能力后继续安装；跳过仅对本次生效，之后冲突方移除可重装补齐。`}
      onClose={onCancel}
      busy={busy}
      width="w-[560px]"
      footer={
        <>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
            取消安装
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            onClick={() => confirm(conflicts.map((c) => c.incomingAssetId))}
          >
            {allSkipped ? "跳过并继续安装" : `全部跳过并继续`}
          </Button>
        </>
      }
    >
      <ul className="space-y-1.5">
        {conflicts.map((c) => {
          const on = skipped.has(c.incomingAssetId);
          return (
            <li key={c.incomingAssetId}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(c.incomingAssetId)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                  on ? "border-brand/40 bg-brand-soft/40" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <span
                  className={`shrink-0 w-4 h-4 rounded border grid place-items-center transition-colors ${
                    on ? "bg-brand border-brand" : "border-gray-300 bg-white"
                  }`}
                >
                  {on && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5">
                      <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-text-primary truncate">{c.name}</span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-surface-sunken text-text-muted uppercase">
                      {c.type}
                    </span>
                  </span>
                  <span className="block text-[11px] text-text-muted mt-0.5">
                    与项目中已存在的同名能力冲突，勾选后本次安装跳过该能力
                  </span>
                </span>
                <span className={`shrink-0 text-[11px] font-medium ${on ? "text-brand" : "text-text-muted"}`}>
                  {on ? "将跳过" : "跳过该能力"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!allSkipped && (
        <button
          type="button"
          onClick={() => setSkipped(new Set(conflicts.map((c) => c.incomingAssetId)))}
          className="mt-3 text-xs text-brand hover:underline"
        >
          全选跳过
        </button>
      )}
    </Modal>
  );
}
