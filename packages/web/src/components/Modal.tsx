/**
 * Modal —— 标准内容弹窗外壳，统一遮罩、卡片、标题栏与底部操作区。
 *
 * 与 ConfirmDialog 共享同一套视觉规范（bg-black/40 + backdrop-blur + scale-in），
 * 用于承载表单 / 列表 / 日志等内容型弹窗；纯确认场景仍用 ConfirmDialog。
 *
 * 行为：ESC 关闭、点击遮罩关闭（busy 时禁用）、内容区超高自动滚动。
 */
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** 底部操作区（通常放 Button），不传则不渲染。 */
  footer?: ReactNode;
  /** 弹窗宽度的 tailwind class，默认 480。 */
  width?: string;
  /** 提交中：禁用关闭与遮罩点击。 */
  busy?: boolean;
}

export default function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "w-[480px]",
  busy = false,
}: ModalProps) {
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [busy, onClose]);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in"
        onClick={busy ? undefined : onClose}
        aria-hidden="true"
      />
      <div className="absolute inset-0 grid place-items-center p-4 pointer-events-none">
        <div
          className={`${width} max-w-full max-h-[85vh] flex flex-col bg-white rounded-2xl shadow-panel border border-surface-sunken overflow-hidden animate-scale-in pointer-events-auto`}
        >
          <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-surface-sunken shrink-0">
            <div className="min-w-0">
              <h3 className="text-base font-semibold tracking-tight text-text-primary leading-snug">{title}</h3>
              {subtitle && <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{subtitle}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label="关闭"
              className="shrink-0 w-8 h-8 grid place-items-center rounded-md text-text-muted hover:bg-surface-sunken hover:text-text-primary disabled:opacity-40 transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          <div className="px-6 py-5 overflow-auto">{children}</div>

          {footer && (
            <div className="px-6 py-4 bg-surface-card border-t border-surface-sunken flex justify-end gap-2 shrink-0">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
