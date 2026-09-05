import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

/**
 * Button —— 统一交互状态的按钮原语。
 *
 * 覆盖 hover / active / disabled / focus-visible，并内建 loading 态（禁用 +
 * 旋转图标）。仅做样式编排，不引入第三方依赖。
 *
 * variant:
 *  - primary   : 品牌实心，主操作
 *  - secondary : 描边浅底，次操作
 *  - danger    : 危险实心
 *  - ghost     : 透明，工具按钮
 *  - subtle    : 浅灰底，轻量操作
 */
export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "subtle";
export type ButtonSize = "sm" | "md" | "lg";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  fullWidth?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-white shadow-sm shadow-brand/25 hover:bg-brand-600 active:bg-brand-700 disabled:bg-brand/40 disabled:shadow-none",
  secondary:
    "bg-white text-text-secondary border border-gray-200 hover:border-gray-300 hover:text-text-primary hover:bg-surface-card active:bg-surface-sunken disabled:opacity-50",
  danger:
    "bg-red-600 text-white shadow-sm shadow-red-600/20 hover:bg-red-700 active:bg-red-800 disabled:bg-red-300 disabled:shadow-none",
  ghost:
    "bg-transparent text-text-secondary hover:bg-surface-sunken hover:text-text-primary active:bg-gray-200 disabled:opacity-40",
  subtle:
    "bg-surface-sunken text-text-secondary hover:bg-gray-200 active:bg-gray-300 disabled:opacity-50",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-9 px-4 text-sm gap-2 rounded-lg",
  lg: "h-11 px-6 text-sm gap-2 rounded-xl",
};

const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    leftIcon,
    fullWidth = false,
    disabled,
    className = "",
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      disabled={isDisabled}
      className={[
        "inline-flex items-center justify-center font-medium transition-all duration-150 select-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-1",
        isDisabled ? "cursor-not-allowed" : "cursor-pointer active:scale-[0.98]",
        fullWidth ? "w-full" : "",
        SIZE[size],
        VARIANT[variant],
        className,
      ].join(" ")}
      {...rest}
    >
      {loading ? <Loader2 size={size === "sm" ? 13 : 15} className="animate-spin" /> : leftIcon}
      {children}
    </button>
  );
});

export default Button;
