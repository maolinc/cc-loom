import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResponse } from "@maolinc/cc-loom-shared";

/**
 * 页面级异步数据状态小工具。
 *
 * 统一 loading / error / data / reload 四件套，避免每个页面手写一遍
 * useState + useEffect + try/catch。配合 `api.*`（已不抛异常、返回
 * ApiResponse）使用：
 *
 *   const { data, loading, error, reload } = useAsyncState(
 *     () => api.get<Asset[]>("/assets"),
 *     [],
 *   );
 *
 * - 首次挂载与依赖变化时自动拉取。
 * - `reload()` 手动重试（错误块的「重试」按钮使用）。
 * - 组件卸载后丢弃迟到响应，避免 setState 警告。
 */
export function useAsyncState<T>(
  fetcher: () => Promise<ApiResponse<T>>,
  deps: unknown[],
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetcher();
    if (!aliveRef.current) return;
    setLoading(false);
    if (res.success) {
      setData((res.data ?? null) as T | null);
    } else {
      setError(res.error || "加载失败，请重试");
    }
    // fetcher 由调用方用 deps 控制刷新时机
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    aliveRef.current = true;
    void run();
    return () => {
      aliveRef.current = false;
    };
  }, [run]);

  return { data, loading, error, reload: run, setData };
}
