/**
 * ConfirmDialog —— 取代浏览器原生 confirm() 的 Soft Bento 风格模态框。
 *
 * 两种用法：
 *  - 普通版（kind="default"）：取消 + 确认，按钮主色为 brand。
 *  - 危险版（kind="danger"）：取消 + 危险红按钮，可选 `confirmText` 二次确认（用户必须输入指定字符串
 *    才能启用确认按钮，对应 LocalConsole 卸载能力集的场景）。
 *
 * 设计：fixed 居中 + 半透明遮罩 + backdrop-blur + scale-in；ESC 关闭；
 * 确认时回调，关闭由父组件管理。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, AlertTriangle } from "lucide-react";

interface BaseProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** 主体内容下方的自定义额外块（如影响范围明细）。 */
  extra?: ReactNode;
  cancelLabel?: string;
  confirmLabel?: string;
  /** 必须输入该字符串才能启用确认按钮，仅 danger 用。 */
  confirmText?: string;
  kind?: "default" | "danger";
  /** 异步确认期间禁用按钮，文案变成 confirmingLabel。 */
  busy?: boolean;
  confirmingLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  description,
  extra,
  cancelLabel = "取消",
  confirmLabel,
  confirmText,
  kind = "default",
  busy = false,
  confirmingLabel,
  onConfirm,
  onCancel,
}: BaseProps) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setInput("");
    const t = window.setTimeout(() => inputRef.current?.focus(), 80);
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onEsc);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open, busy, onCancel]);

  if (!open) return null;

  const danger = kind === "danger";
  const confirmEnabled = !busy && (!confirmText || input === confirmText);
  const finalConfirmLabel =
    busy && confirmingLabel ? confirmingLabel : confirmLabel ?? (danger ? "确认" : "确定");

  const confirmCls = danger
    ? "bg-red-600 hover:bg-red-700 disabled:bg-red-300"
    : "bg-brand hover:bg-brand-600 active:bg-brand-700 transition-colors disabled:opacity-50";

  return (
    <div className="fixed inset-0 z-[55]" role="dialog" aria-modal="true" aria-labelledby="cd-title">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-cd-fade"
        onClick={busy ? undefined : onCancel}
        aria-hidden="true"
      />
      <div className="absolute inset-0 grid place-items-center p-4 pointer-events-none">
        <div className="w-[460px] max-w-full bg-white rounded-2xl shadow-panel border border-surface-sunken overflow-hidden animate-cd-scale pointer-events-auto">
          <div className="p-6">
            <div className="flex items-start gap-3 mb-3">
              {danger ? (
                <div className="w-10 h-10 rounded-xl bg-red-50 grid place-items-center shrink-0">
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                </div>
              ) : null}
              <div className="flex-1 min-w-0">
                <h3 id="cd-title" className="text-base font-semibold text-text-primary leading-snug">
                  {title}
                </h3>
                {description && (
                  <div className="text-sm text-text-secondary mt-1.5 leading-relaxed">{description}</div>
                )}
              </div>
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                aria-label="关闭"
                className="shrink-0 w-8 h-8 grid place-items-center -m-1 rounded-md text-text-muted hover:bg-surface-sunken hover:text-text-primary disabled:opacity-40"
              >
                <X size={16} />
              </button>
            </div>

            {extra}

            {confirmText && (
              <label className="block mt-5">
                <span className="text-[11px] font-medium text-text-secondary">
                  输入 <code className="px-1 py-0.5 bg-surface-card rounded text-text-primary">{confirmText}</code> 以确认
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  autoComplete="off"
                  className="mt-1.5 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 bg-white"
                />
              </label>
            )}
          </div>

          <div className="px-6 py-4 bg-surface-card border-t border-surface-sunken flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium text-text-secondary border border-gray-200 rounded-lg bg-white hover:bg-surface-card disabled:opacity-50 transition-colors"
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!confirmEnabled}
              className={`px-4 py-2 text-sm font-medium text-white rounded-lg ${confirmCls} disabled:cursor-not-allowed`}
            >
              {finalConfirmLabel}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes cd-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes cd-scale { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
        .animate-cd-fade  { animation: cd-fade 200ms ease-out; }
        .animate-cd-scale { animation: cd-scale 200ms cubic-bezier(0.32,0.72,0,1); }
      `}</style>
    </div>
  );
}
