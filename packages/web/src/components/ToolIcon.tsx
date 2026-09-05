/**
 * ToolIcon — 目标工具厂商 logo 图标组件。
 *
 * 图标资源来自 lobehub icons（@lobehub/icons-static-svg），本地存放于
 * src/assets/vendor-icons/，随 web 包构建内联，无运行时外链依赖。
 *
 * 用法：
 *   <ToolIcon tool="cursor" />             // 默认 16px，hover 显示厂商名
 *   <ToolIcon tool="codebuddy" size={24} /> // 24px
 *   <ToolIcon tool="codex" size={14} showTooltip={false} />
 *
 * 尺寸参考：
 *   - 卡片角标 / 内联文字：14px
 *   - 元数据行 / 切换按钮：16px
 *   - Tab / 表头：24px
 */
import { TARGET_TOOL_LABELS } from "@maolinc/cc-loom-shared";
import type { TargetTool } from "@maolinc/cc-loom-shared";
import claudecodeIcon from "../assets/vendor-icons/claude-color.svg";
import codebuddyIcon from "../assets/vendor-icons/codebuddy-color.svg";
import codexIcon from "../assets/vendor-icons/openai.svg";
import cursorIcon from "../assets/vendor-icons/cursor.svg";

const ICONS: Record<TargetTool, string> = {
  cursor: cursorIcon,
  codebuddy: codebuddyIcon,
  codex: codexIcon,
  claudecode: claudecodeIcon,
};

interface Props {
  tool: TargetTool;
  /** 图标尺寸（px），默认 16 */
  size?: number;
  className?: string;
  /** 是否在 hover 时显示厂商名 tooltip，默认 true */
  showTooltip?: boolean;
  /** 自定义 tooltip 文案，默认为厂商显示名 */
  title?: string;
}

export default function ToolIcon({
  tool,
  size = 16,
  className = "",
  showTooltip = true,
  title,
}: Props) {
  const tooltip = title ?? (showTooltip ? TARGET_TOOL_LABELS[tool] : undefined);
  return (
    <img
      src={ICONS[tool]}
      alt={TARGET_TOOL_LABELS[tool]}
      title={tooltip}
      width={size}
      height={size}
      className={`inline-block shrink-0 select-none ${className}`}
      draggable={false}
    />
  );
}
