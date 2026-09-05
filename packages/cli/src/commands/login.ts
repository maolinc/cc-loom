/**
 * `loom login` —— 校验 token 并写本地 config。
 *
 * 行为：
 * - 校验 token 格式 `prsm_…` 并调 `/api/auth/me` 验证有效性。
 * - 如果当前已登录且 token 不同：
 *   - 先停止 Agent（避免旧 Agent 持有旧 token 维持幽灵连接）。
 *   - 用旧 token 调 `/api/auth/me` 判断是否切换了账号。
 *   - 同一账号（token 重新生成）→ 保留 deviceId。
 *   - 不同账号 → 清空 deviceId，提示需要重新 loom register。
 * - logout 后（token 为空但 deviceId 保留）login 同一 endpoint → 复用 deviceId。
 */
import { DEFAULT_ENDPOINT, type SessionUser } from "@maolinc/cc-loom-shared";
import { saveConfig, getConfig } from "../lib/config.js";
import { ApiError, api } from "../lib/api.js";
import { fail } from "../lib/errors.js";
import { ok, info, warn, kv, nextSteps, color, blank } from "../lib/ui.js";
import { stopAgent } from "./stop.js";

interface LoginOptions {
  token?: string;
  endpoint?: string;
  force?: boolean;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const token = options.token;
  const endpoint = (options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");

  if (!token) {
    fail("缺少 --token 参数。在 Web 设置页生成 CLI Token 后再试。");
  }
  if (!token.startsWith("prsm_")) {
    fail("Token 格式不正确，应以 prsm_ 开头");
  }

  const existing = getConfig();
  if (existing && !options.force && existing.token === token && existing.endpoint === endpoint) {
    info("已登录（token 与 endpoint 未变化）");
    return;
  }

  // 校验新 token
  let me: SessionUser;
  try {
    me = await api<SessionUser>({ endpoint, token }, "/api/auth/me");
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === "auth") fail("Token 无效或已过期，请到 Web 设置页重新生成");
      fail(err.message);
    }
    throw err;
  }
  if (!me?.email) {
    fail("Token 校验失败：服务端未返回用户信息");
  }

  // 判断 deviceId 保留策略
  let deviceId = "";

  if (existing?.endpoint === endpoint && existing.token && existing.token !== token) {
    // 同一 endpoint，token 变了 → 可能是 token 重新生成或账号切换
    // 先停 Agent（它持有旧 token）
    if (await stopAgent({ force: false })) {
      info("已停止当前 Agent");
      blank();
    }

    // 用旧 token 判断是否同一账号
    let sameAccount = false;
    try {
      const oldMe = await api<SessionUser>({ endpoint, token: existing.token }, "/api/auth/me");
      sameAccount = oldMe?.email === me.email;
    } catch {
      // 旧 token 已失效（被重新生成 / 被吊销）→ 无法判断，按安全策略清 deviceId
    }

    if (sameAccount) {
      deviceId = existing.deviceId;
    } else {
      warn(`检测到账号切换：旧设备 ID 已清除，需重新 loom register`);
      blank();
    }
  } else if (existing?.endpoint === endpoint) {
    // 同一 endpoint（logout 后 token 为空）→ 复用 deviceId
    deviceId = existing.deviceId;
  }

  saveConfig({ endpoint, token, deviceId });
  ok("登录成功");
  kv("Endpoint", color.cyan(endpoint));
  kv("User", me.email);
  nextSteps([
    ["loom start", "启动 Agent 并绑定设备"],
    ["cd <项目目录> && loom register", "注册项目"],
  ]);
}
