/**
 * `loom logout` —— 清除本地凭据（token），保留 deviceId/endpoint。
 *
 * 行为：
 * 1. 若 Agent 仍在运行，先停止它（避免 daemon 持有旧 token 维持幽灵连接）。
 * 2. 清除 token，保留 endpoint + deviceId，使后续 loom login 能复用已有设备。
 * 3. 不调任何 server 接口：服务端 token 仍有效，吊销交给 Web 设置页。
 */
import { getConfig, clearCredentials } from "../lib/config.js";
import { ok, info, tip, blank } from "../lib/ui.js";
import { stopAgent } from "./stop.js";

export async function logoutCommand(): Promise<void> {
  const config = getConfig();
  if (!config || !config.token) {
    info("当前未登录");
    return;
  }

  // 先停止 Agent，避免它持有旧 token 维持连接（导致 web 端仍显示在线）。
  if (await stopAgent({ force: false })) {
    info("已停止当前 Agent");
    blank();
  }

  clearCredentials();
  ok("已退出登录，本地 Token 已清除");

  blank();
  tip("deviceId 和 endpoint 已保留，重新 loom login 后无需重新注册项目");
  tip("服务端 Token 仍然有效；如需吊销请到 Web 设置页 → 重新生成 Token");
}
