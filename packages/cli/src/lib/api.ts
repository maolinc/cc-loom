/**
 * 与 server 通信的 fetch 封装。
 *
 * 职责：
 * - 注入 `Authorization: Bearer <token>` 与 `Content-Type: application/json`
 * - 拆 `ApiResponse<T>` 包装
 * - 把网络错误 / 非 2xx / `success: false` 统一抛 `ApiError`
 *
 * 命令层只负责捕获 `ApiError` 并转 `program.error()`。
 */
import type { ApiResponse } from "@maolinc/cc-loom-shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "network" | "auth" | "server" | "client",
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiCreds {
  endpoint: string;
  token: string;
}

export async function api<T>(
  creds: ApiCreds,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${creds.endpoint.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.token}`,
    ...((init.headers as Record<string, string>) || {}),
  };
  if (init.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err: any) {
    throw new ApiError(0, "network", `无法连接 ${creds.endpoint}: ${err?.message || err}`);
  }

  let body: ApiResponse<T> | null = null;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    // ignore — 走 status 判定
  }

  if (res.status === 401 || res.status === 403) {
    throw new ApiError(res.status, "auth", body?.error || "认证失败，请重新登录");
  }
  if (res.status >= 500) {
    throw new ApiError(res.status, "server", body?.error || `服务端错误 (${res.status})`);
  }
  if (!res.ok) {
    throw new ApiError(res.status, "client", body?.error || `请求失败 (${res.status})`);
  }
  if (body && body.success === false) {
    throw new ApiError(res.status, "client", body.error || "请求失败");
  }
  return (body?.data ?? (undefined as unknown)) as T;
}
