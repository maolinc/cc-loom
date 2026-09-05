import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pidfileMock = vi.hoisted(() => ({
  readPidFile: vi.fn(),
  removePidFile: vi.fn(),
  isPidAlive: vi.fn(),
  isLikelyLoomAgentPid: vi.fn(),
  findLikelyLoomAgentPids: vi.fn(),
}));

const uiMock = vi.hoisted(() => ({
  ok: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  color: { cyan: (value: string) => value },
}));

vi.mock("../lib/pidfile.js", () => pidfileMock);
vi.mock("../lib/ui.js", () => uiMock);
vi.mock("../lib/errors.js", () => ({
  fail: (message: string) => {
    throw new Error(message);
  },
}));

import { stopAgent, stopCommand } from "../commands/stop.js";

describe("stop command recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pidfile 丢失时，回退到进程扫描结果并优雅停止", async () => {
    pidfileMock.readPidFile.mockReturnValue(null);
    pidfileMock.findLikelyLoomAgentPids.mockReturnValue([4321]);

    let alive = true;
    pidfileMock.isPidAlive.mockImplementation((pid: number) => pid === 4321 && alive);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      if (pid === 4321 && signal === "SIGTERM") alive = false;
      return true;
    }) as typeof process.kill);

    await expect(stopAgent()).resolves.toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4321, "SIGTERM");
  });

  it("pidfile 指向非 loom 进程时，不误杀并清理 stale pidfile", async () => {
    pidfileMock.readPidFile.mockReturnValue({ pid: 321, startedAt: "2026-07-01T15:00:00.000Z" });
    pidfileMock.isPidAlive.mockReturnValue(true);
    pidfileMock.isLikelyLoomAgentPid.mockReturnValue(false);
    pidfileMock.findLikelyLoomAgentPids.mockReturnValue([]);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((() => true)) as typeof process.kill);

    await expect(stopAgent()).resolves.toBe(false);
    expect(pidfileMock.removePidFile).toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("无 pidfile 且扫描出多个候选进程时，全部停止", async () => {
    pidfileMock.readPidFile.mockReturnValue(null);
    pidfileMock.findLikelyLoomAgentPids.mockReturnValue([1001, 1002]);

    const alive = new Set<number>([1001, 1002]);
    pidfileMock.isPidAlive.mockImplementation((pid: number) => alive.has(pid));

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      if (signal === "SIGTERM") alive.delete(pid);
      return true;
    }) as typeof process.kill);

    await stopCommand();
    expect(killSpy).toHaveBeenCalledWith(1001, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(1002, "SIGTERM");
    expect(uiMock.warn).toHaveBeenCalledWith(expect.stringContaining("1001, 1002"));
    expect(uiMock.ok).toHaveBeenCalledWith(expect.stringContaining("已停止 2 个 Agent 进程"));
  });

  it("stopAgent 在多个候选进程时保持谨慎不停止", async () => {
    pidfileMock.readPidFile.mockReturnValue(null);
    pidfileMock.findLikelyLoomAgentPids.mockReturnValue([1001, 1002]);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((() => true)) as typeof process.kill);

    await expect(stopAgent()).resolves.toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
