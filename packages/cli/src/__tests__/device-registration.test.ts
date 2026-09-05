/**
 * ensureDeviceRegistered 自愈逻辑回归测试。
 *
 * 背景：服务端 devices 表丢失记录（DB 重建 / 数据丢失）而 CLI token 仍有效时，
 * 旧实现只在 deviceId 为空时注册设备 —— agent 带着失效 deviceId 连上 WS
 * （服务端 UPDATE 0 行静默通过，呈"假在线"），之后 loom register 被服务端
 * 以"设备不存在"拒绝。修复后启动时校验服务端记录，缺失则自动重建。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliConfig, Device } from "@maolinc/cc-loom-shared";

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
const configMock = vi.hoisted(() => ({ mergeConfig: vi.fn() }));

vi.mock("../lib/api.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api.js")>();
  return { ...original, api: apiMock.api };
});
vi.mock("../lib/config.js", () => configMock);

import { ensureDeviceRegistered } from "../lib/device-registration.js";
import { ApiError } from "../lib/api.js";

const baseConfig: CliConfig = {
  endpoint: "http://localhost:47474",
  token: "prsm_test",
  deviceId: "stale-device-id",
};

function device(id: string): Device {
  return {
    id,
    userId: "u1",
    deviceName: "host",
    status: "online",
    lastOnlineAt: "2026-07-20T00:00:00.000Z",
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("ensureDeviceRegistered", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deviceId 为空：直接注册新设备并回写 config", async () => {
    apiMock.api.mockResolvedValueOnce(device("new-id"));

    const result = await ensureDeviceRegistered({ ...baseConfig, deviceId: "" }, () => {});

    expect(apiMock.api).toHaveBeenCalledTimes(1);
    expect(apiMock.api).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: baseConfig.endpoint }),
      "/api/devices/register",
      expect.objectContaining({ method: "POST" }),
    );
    expect(configMock.mergeConfig).toHaveBeenCalledWith({ deviceId: "new-id" });
    expect(result?.deviceId).toBe("new-id");
  });

  it("deviceId 存在且服务端有记录：原样返回，不重复注册", async () => {
    apiMock.api.mockResolvedValueOnce([device("stale-device-id")]);

    const result = await ensureDeviceRegistered(baseConfig, () => {});

    expect(apiMock.api).toHaveBeenCalledTimes(1); // 只查列表，不发注册
    expect(result).toBe(baseConfig);
    expect(configMock.mergeConfig).not.toHaveBeenCalled();
  });

  it("回归：deviceId 存在但服务端无记录 → 自动重新注册并回写新 deviceId", async () => {
    const notify = vi.fn();
    apiMock.api
      .mockResolvedValueOnce([]) // GET /api/devices → 空
      .mockResolvedValueOnce(device("fresh-id")); // POST /api/devices/register

    const result = await ensureDeviceRegistered(baseConfig, notify);

    expect(apiMock.api).toHaveBeenCalledTimes(2);
    expect(apiMock.api).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "/api/devices/register",
      expect.objectContaining({ method: "POST" }),
    );
    expect(configMock.mergeConfig).toHaveBeenCalledWith({ deviceId: "fresh-id" });
    expect(result?.deviceId).toBe("fresh-id");
    expect(notify).toHaveBeenCalledWith("warn", expect.stringContaining("重新注册"));
  });

  it("设备列表查询失败（网络/鉴权）：保留原 deviceId，不误清绑定", async () => {
    apiMock.api.mockRejectedValueOnce(new ApiError(0, "network", "无法连接"));

    const result = await ensureDeviceRegistered(baseConfig, () => {});

    expect(apiMock.api).toHaveBeenCalledTimes(1); // 不发注册请求
    expect(result).toBe(baseConfig);
    expect(configMock.mergeConfig).not.toHaveBeenCalled();
  });

  it("注册接口失败：返回 null 并上报 error", async () => {
    const notify = vi.fn();
    apiMock.api
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new ApiError(500, "server", "服务端错误"));

    const result = await ensureDeviceRegistered(baseConfig, notify);

    expect(result).toBeNull();
    expect(notify).toHaveBeenCalledWith("error", expect.stringContaining("设备注册失败"));
    expect(configMock.mergeConfig).not.toHaveBeenCalled();
  });
});
