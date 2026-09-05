import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 回归保护：Windows 上没有 /proc 也没有 ps，进程扫描必须走 PowerShell。
// 未修复代码不区分平台、直接读 /proc（返回真实进程表），mock 数据永远进不来 →
// 断言 [1234, 5678] 失败；修复后走 powershell.exe 分支命中 mock。

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execMock }));

import { findLikelyLoomAgentPids } from "../lib/pidfile.js";

const ORIGINAL_PLATFORM = process.platform;

function stubPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("findLikelyLoomAgentPids (Windows)", () => {
  beforeEach(() => {
    execMock.mockReset();
    stubPlatform("win32");
  });

  afterEach(() => {
    stubPlatform(ORIGINAL_PLATFORM);
  });

  it("通过 PowerShell 进程表找回 loom start 进程（反斜杠路径）", () => {
    // 模拟 `Get-CimInstance | ForEach { '{0} {1}' -f pid, command }` 的输出：
    // 两个真 Agent + 一个 stop 子命令 + 一个无关进程 + CommandLine 为 null 的空行。
    execMock.mockReturnValue(
      [
        '1234 node "C:\\Users\\foo\\AppData\\Roaming\\npm\\node_modules\\loom\\dist\\index.js" start',
        "5678 node D:\\dev\\loom\\packages\\cli\\dist\\index.js start",
        '9999 node "C:\\Users\\foo\\AppData\\Roaming\\npm\\node_modules\\loom\\dist\\index.js" stop',
        "7777 explorer.exe",
        "8888 ",
        "",
      ].join("\n"),
    );

    const pids = findLikelyLoomAgentPids();
    expect(execMock).toHaveBeenCalledOnce();
    expect(execMock.mock.calls[0]![0]).toBe("powershell.exe");
    expect(pids).toEqual([1234, 5678]);
  });

  it("排除指定 pid", () => {
    execMock.mockReturnValue(
      "1234 node C:\\Users\\foo\\node_modules\\loom\\dist\\index.js start\n" +
        "5678 node D:\\dev\\loom\\packages\\cli\\dist\\index.js start\n",
    );
    expect(findLikelyLoomAgentPids([1234])).toEqual([5678]);
  });

  it("PowerShell 不可用时回退空数组，不抛错", () => {
    execMock.mockImplementation(() => {
      throw new Error("command not found");
    });
    expect(findLikelyLoomAgentPids()).toEqual([]);
  });
});
