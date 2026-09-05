/**
 * L3 测试专用 HTTP 原语 — 用于需要断言具体 HTTP 状态码 / 原始响应头的场景。
 *
 * ApiClient 在非 2xx 时抛 ApiRequestError，便于 happy path；本模块提供不抛错的
 * 原始 fetch 包装，便于 error path 断言 res.status。两者可混用。
 */
import type { ServerHandle } from "@maolinc/cc-loom-testkit";

/** 登录并返回 session cookie 字符串（loom_session=…）。 */
export async function login(baseUrl: string, email: string, password = "test-user-password"): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login 失败: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("login 响应无 set-cookie");
  return /loom_session=[^;]+/.exec(setCookie)![0];
}

/** 登录后取该用户 CLI Bearer token。 */
export async function getCliToken(baseUrl: string, email: string): Promise<string> {
  const cookie = await login(baseUrl, email);
  const res = await fetch(`${baseUrl}/api/auth/cli-token`, { headers: { cookie } });
  if (!res.ok) throw new Error(`cli-token 失败: ${res.status}`);
  return (await res.json()).data.token;
}

/** 带 cookie 的原始请求；不抛错，返回 Response 供断言 status/body。 */
export async function request(
  baseUrl: string,
  method: string,
  path: string,
  opts: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  else if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** 便捷: 解析 JSON 响应体。 */
export async function parseJson<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** 便利: 用 server 直接构造一组带 cookie 的请求工具。 */
export function httpFor(server: ServerHandle, cookie: string) {
  return {
    request: (method: string, path: string, body?: unknown) =>
      request(server.baseUrl, method, path, { cookie, body }),
    get: (path: string) => request(server.baseUrl, "GET", path, { cookie }),
    post: (path: string, body?: unknown) => request(server.baseUrl, "POST", path, { cookie, body }),
    put: (path: string, body?: unknown) => request(server.baseUrl, "PUT", path, { cookie, body }),
    del: (path: string) => request(server.baseUrl, "DELETE", path, { cookie }),
  };
}
