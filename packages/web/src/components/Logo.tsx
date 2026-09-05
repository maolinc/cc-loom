/**
 * Loom 品牌 mark —— 三根经线 + 一根流动纬线，中间经线压在纬线之上，
 * 形成 over-under-over 的编织效果，呼应产品名 "Loom"（织机）：
 * 把分散的 AI 能力（skill / rule / mcp / hook / command / agent）编织成统一能力集。
 *
 * 仅渲染 mark 本体（不含底色方块）；由调用方用 `<span class="bg-brand ...">` 包裹提供 chip。
 */
export default function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" aria-hidden="true">
      <g stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round">
        {/* 两侧经线（先绘，纬线压在其上 → over） */}
        <line x1="9" y1="6.5" x2="9" y2="25.5" />
        <line x1="23" y1="6.5" x2="23" y2="25.5" />
        {/* 纬线：自左向右流动穿梭 */}
        <path d="M4 16 Q 9 8 16 16 T 28 16" opacity="0.55" />
        {/* 中间经线最后绘，压住纬线 → under，完成交替编织 */}
        <line x1="16" y1="6.5" x2="16" y2="25.5" />
      </g>
    </svg>
  );
}
