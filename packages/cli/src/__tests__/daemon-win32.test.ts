import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 回归保护：Windows 上 detached spawn 默认分配新控制台 → 弹黑窗。
// windowsHide:true 让其无窗口启动；Linux/macOS 上该选项被忽略，行为不变。

const { spawnMock, readPidFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  readPidFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../lib/pidfile.js", () => ({ readPidFile: readPidFileMock }));

import { spawnDaemon } from "../lib/daemon.js";

const ORIGINAL_PLATFORM = process.platform;

function stubPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("spawnDaemon windowsHide", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    readPidFileMock.mockReset();
  });

  afterEach(() => {
    stubPlatform(ORIGINAL_PLATFORM);
  });

  it("Windows 上 detached + windowsHide:true，避免弹出控制台窗口", async () => {
    stubPlatform("win32");
    spawnMock.mockReturnValue({ pid: 4321, unref: vi.fn() });
    readPidFileMock.mockReturnValue({ pid: 4321, startedAt: "2026-01-01T00:00:00.000Z" });

    const pid = await spawnDaemon();
    expect(pid).toBe(4321);

    const opts = spawnMock.mock.calls[0]![2];
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
  });

  it("Linux 上 windowsHide 不影响 detached 行为（选项仍透传，Node 自行忽略）", async () => {
    stubPlatform("linux");
    spawnMock.mockReturnValue({ pid: 4322, unref: vi.fn() });
    readPidFileMock.mockReturnValue({ pid: 4322, startedAt: "2026-01-01T00:00:00.000Z" });

    await spawnDaemon();
    const opts = spawnMock.mock.calls[0]![2];
    expect(opts.detached).toBe(true);
    // windowsHide 在非 Windows 上由 Node 忽略；仍显式为 true，无需分支。
    expect(opts.windowsHide).toBe(true);
  });
});
