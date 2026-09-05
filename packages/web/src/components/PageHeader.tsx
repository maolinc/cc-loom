import type { ReactNode } from "react";

/**
 * PageHeader —— 列表/主功能页的统一页头：大标题 + 一句话副标题 + 右侧主操作。
 *
 * 让「这是什么页面、能做什么」在第一屏一目了然，主操作固定在右上，
 * 与下方筛选区（SearchInput）职责分离。
 */
interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export default function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-8 font-bold tracking-tight text-text-primary">{title}</h1>
        {description && <p className="text-sm text-text-muted mt-1.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
