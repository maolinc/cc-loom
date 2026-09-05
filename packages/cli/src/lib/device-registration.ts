/**
 * 设备注册（loom start 启动链路的一步）。
 *
 * 本地 config 有 deviceId 不代表服务端仍有该设备记录：服务端 DB 重建 / 设备
 * 数据丢失后，WS auth 对未知 deviceId 静默通过（UPDATE 0 行），agent 呈
 * "假在线"，之后 loom register 会被服务端以"设备不存在"拒绝。因此启动时
 * 先校验服务端记录，缺失则自动重新注册并回写 config。
 */
import { hostname } from "node:os";
import type { CliConfig, Device } from "@maolinc/cc-loom-shared";
import { api } from "./api.js";
import { mergeConfig } from "./config.js";

type Notify = (level: "info" | "warn" | "error" | "success", msg: string) => void;

/**
 * 确认服务端无此设备记录时返回 true（需重新注册）。
 * 查询失败（网络/鉴权/服务端故障）返回 false，维持原行为，交给 WS 重连
 * 与报错链路处理，避免误清本地绑定。
 */
async function isDeviceMissingOnServer(config: CliConfig): Promise<boolean> {
  try {
    const devices = await api<Device[]>(config, "/api/devices");
    return !devices.some((d) => d.id === config.deviceId);
  } catch {
    return false;
  }
}

export async function ensureDeviceRegistered(
  config: CliConfig,
  notify: Notify,
): Promise<CliConfig | null> {
  if (config.deviceId && !(await isDeviceMissingOnServer(config))) {
    return config;
  }
  if (config.deviceId) {
    notify("warn", "服务端无本机设备记录，自动重新注册设备");
  }
  try {
    const dev = await api<Device>(config, "/api/devices/register", {
      method: "POST",
      body: JSON.stringify({ deviceName: hostname() || "unknown" }),
    });
    mergeConfig({ deviceId: dev.id });
    notify("success", `设备已注册 deviceId=${dev.id}`);
    return { ...config, deviceId: dev.id };
  } catch (err: any) {
    notify("error", `设备注册失败：${err?.message ?? err}`);
    return null;
  }
}
