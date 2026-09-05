import type { ReactNode } from "react";
import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import Button from "./Button.js";

/**
 * 页面状态组件集合 —— 统一 Loading / Error / Empty 三态呈现。
 *
 * 用法：
 *   if (loading) return <CardGridSkeleton />;
 *   if (error)   return <ErrorState message={error} onRetry={reload} />;
 *   if (empty)   return <EmptyState title="暂无能力" action={...} />;
 */

/** 卡片网格骨架屏：匹配市场 / 工作空间的 3 列网格形态。 */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-2xl border border-surface-sunken bg-white p-5 animate-pulse"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="h-5 w-16 rounded-md bg-surface-sunken" />
            <div className="h-4 w-12 rounded bg-surface-sunken" />
          </div>
          <div className="h-4 w-2/3 rounded bg-surface-sunken mb-2.5" />
          <div className="h-3 w-full rounded bg-surface-card mb-1.5" />
          <div className="h-3 w-4/5 rounded bg-surface-card mb-5" />
          <div className="flex items-center justify-between">
            <div className="h-3 w-24 rounded bg-surface-card" />
            <div className="h-3 w-10 rounded bg-surface-card" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 通用错误块，带重试。 */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-24 px-6">
      <div className="w-14 h-14 rounded-2xl bg-red-50 grid place-items-center mb-4">
        <AlertCircle className="w-7 h-7 text-red-500" />
      </div>
      <p className="text-base font-semibold text-text-primary mb-1">加载失败</p>
      <p className="text-sm text-text-muted max-w-sm mb-5">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="md" leftIcon={<RefreshCw size={14} />} onClick={onRetry}>
          重新加载
        </Button>
      )}
    </div>
  );
}

/** 空状态，提供明确下一步动作。 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-24 px-6">
      <div className="w-16 h-16 rounded-2xl bg-brand-50 grid place-items-center mb-5 text-brand">
        {icon ?? <Inbox className="w-8 h-8" />}
      </div>
      <p className="text-lg font-semibold tracking-tight text-text-primary mb-1.5">{title}</p>
      {description && <p className="text-sm text-text-muted max-w-md leading-relaxed mb-6">{description}</p>}
      {action}
    </div>
  );
}

/** 行内小型加载指示（用于面板局部）。 */
export function InlineLoading({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-text-muted text-sm">
      <RefreshCw size={14} className="animate-spin" />
      {label}
    </div>
  );
}
