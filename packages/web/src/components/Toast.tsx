/**
 * Toast 系统：取代 LocalConsolePage 等页面里"单字符串 statusMsg"的反馈方式。
 *
 * 用法：
 *   const toast = useToast();
 *   toast.success("已开启 react-gen", "Cursor · 已写入 ...");
 *
 * 设计要点：
 *  - Provider 挂在 main.tsx，Portal 渲染到 fixed 右下角；
 *  - 5s 自动消失；可手动关闭；
 *  - aria-live="polite" 给 screen reader。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, Info, X, AlertTriangle } from "lucide-react";

type ToastKind = "success" | "info" | "error";

interface ToastEntry {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

interface ToastApi {
  success: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS = 5_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: ToastKind, title: string, body?: string) => {
    const id = ++idRef.current;
    setList((prev) => [...prev, { id, kind, title, body }]);
    window.setTimeout(() => {
      setList((prev) => prev.filter((t) => t.id !== id));
    }, AUTO_DISMISS_MS);
  }, []);

  const api: ToastApi = {
    success: (t, b) => push("success", t, b),
    info: (t, b) => push("info", t, b),
    error: (t, b) => push("error", t, b),
  };

  const dismiss = (id: number) => setList((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        className="fixed bottom-6 right-6 z-[60] flex flex-col-reverse gap-2.5 pointer-events-none w-[360px] max-w-[calc(100vw-3rem)]"
        aria-live="polite"
        aria-atomic="false"
      >
        {list.map((t) => (
          <ToastCard key={t.id} entry={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastCard({ entry, onClose }: { entry: ToastEntry; onClose: () => void }) {
  const [closing, setClosing] = useState(false);
  const handleClose = () => {
    setClosing(true);
    window.setTimeout(onClose, 180);
  };
  const cfg = ICONS[entry.kind];
  return (
    <div
      role="status"
      className={`pointer-events-auto bg-white border border-surface-sunken rounded-xl shadow-lift p-3.5 flex gap-3 transition-all duration-200 ${
        closing ? "opacity-0 translate-y-2" : "opacity-100 translate-y-0 animate-toast-in"
      }`}
    >
      <div className={`shrink-0 w-9 h-9 rounded-lg grid place-items-center ${cfg.bg} ${cfg.color}`}>
        {cfg.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-text-primary leading-tight">{entry.title}</div>
        {entry.body && (
          <div className="text-xs text-text-secondary mt-0.5 leading-relaxed">{entry.body}</div>
        )}
      </div>
      <button
        type="button"
        onClick={handleClose}
        aria-label="关闭通知"
        className="shrink-0 w-6 h-6 grid place-items-center -m-1 rounded-md text-text-muted hover:bg-surface-sunken hover:text-text-primary"
      >
        <X size={14} />
      </button>
    </div>
  );
}

const ICONS: Record<ToastKind, { bg: string; color: string; icon: ReactNode }> = {
  success: { bg: "bg-emerald-50", color: "text-emerald-600", icon: <Check size={16} strokeWidth={2.5} /> },
  info: { bg: "bg-brand-soft", color: "text-brand", icon: <Info size={16} strokeWidth={2.2} /> },
  error: { bg: "bg-red-50", color: "text-red-600", icon: <AlertTriangle size={16} strokeWidth={2.2} /> },
};

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    // 允许在 Provider 外调用时静默 fallback 到 console，避免组件单测/Storybook 报错
    return {
      success: (t, b) => console.info("[toast:success]", t, b ?? ""),
      info: (t, b) => console.info("[toast:info]", t, b ?? ""),
      error: (t, b) => console.warn("[toast:error]", t, b ?? ""),
    };
  }
  return ctx;
}

/**
 * 顶部 toast 进入动画（与 ToastCard 配套使用）。
 * 使用 useEffect 注入一次性 keyframes，避免改 tailwind 配置。
 */
export function useInjectToastAnim() {
  useEffect(() => {
    const id = "loom-toast-anim";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      @keyframes toast-in {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .animate-toast-in { animation: toast-in 220ms cubic-bezier(0.32,0.72,0,1); }
    `;
    document.head.appendChild(style);
  }, []);
}
