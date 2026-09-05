import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";

/**
 * KeepAlive —— 轻量页面缓存。
 *
 * 首次激活后挂载子树，之后切走仅以 display:none 隐藏、不卸载，
 * 从而保留组件状态、滚动位置与已拉取的数据，避免来回切换导航时
 * 重新渲染 / 重新请求。
 *
 * 懒挂载：未访问过的页面不会提前挂载（避免无谓的轮询 / WebSocket）。
 */
export const ActiveContext = createContext(true);

export default function KeepAlive({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const everActive = useRef(active);
  if (active) everActive.current = true;
  if (!everActive.current) return null;
  return (
    <div style={{ display: active ? undefined : "none" }}>
      <ActiveContext.Provider value={active}>{children}</ActiveContext.Provider>
    </div>
  );
}

/**
 * 当所在的 KeepAlive 页面从隐藏切回可见时触发回调（典型用于后台静默刷新）。
 * 页面保持挂载、不会闪烁，仅在数据回来后原地更新。
 */
export function useRevalidateOnActive(fn: () => void) {
  const active = useContext(ActiveContext);
  const prev = useRef(active);
  useEffect(() => {
    if (active && !prev.current) fn();
    prev.current = active;
    // 仅在 active 变化时判断；fn 由调用方用 useCallback 稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
