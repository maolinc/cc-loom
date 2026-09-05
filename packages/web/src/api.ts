import type { ApiResponse } from "@maolinc/cc-loom-shared";

const BASE = "/api";

/**
 * 统一请求封装。
 *
 * 设计目标：页面只需关心 `{ success, data, error }` 三态，无需各自处理网络异常、
 * 非 JSON 响应、401 等情况。
 *  - 网络异常 / 超时：返回 `{ success: false, error }`，不抛出。
 *  - 非 JSON 响应（如反代返回 HTML 错误页）：归一为可读错误。
 *  - 401：触发一次全局未登录回调（由 AuthProvider 注册），并返回失败。
 *  - 已是 `{ success, error }` 形态的业务错误：透传。
 */

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** 由 AuthProvider 注册：收到 401 时清空登录态并跳转登录页。 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  onUnauthorized = handler;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  const opts: RequestInit = {
    method,
    credentials: "include",
    cache: "no-store",
  };
  if (signal) opts.signal = signal;
  if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (err) {
    // 调用方主动取消（组件卸载 / StrictMode 重挂）：静默返回，不计为网络错误。
    if (err instanceof DOMException && err.name === "AbortError") {
      return { success: false, error: "aborted" };
    }
    console.error("[api] network error", method, path, err);
    return { success: false, error: "网络连接失败，请检查服务是否在线后重试" };
  }

  // 401：登录态失效。/auth/me 是探测请求，静默处理，不触发跳转回调。
  if (res.status === 401 && path !== "/auth/me") {
    onUnauthorized?.();
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    console.error("[api] non-JSON response", method, path, res.status, err);
    return {
      success: false,
      error: `服务返回异常（HTTP ${res.status}），请稍后重试`,
    };
  }

  // 后端统一返回 ApiResponse 形态；直接透传（含业务 error）。
  if (parsed && typeof parsed === "object" && "success" in parsed) {
    return parsed as ApiResponse<T>;
  }

  // 兜底：HTTP 错误但非标准信封。
  if (!res.ok) {
    return { success: false, error: `请求失败（HTTP ${res.status}）` };
  }
  return { success: true, data: parsed as T };
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>("POST", path, body, signal),
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>("PUT", path, body, signal),
  delete: <T>(path: string, signal?: AbortSignal) => request<T>("DELETE", path, undefined, signal),
};
