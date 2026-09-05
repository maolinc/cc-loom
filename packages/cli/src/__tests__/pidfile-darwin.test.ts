import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 回归保护：macOS 无 /proc，进程扫描走 ps；BSD ps 默认按列宽截断命令行，
// loom nvm 全局安装命令（~120 字符）会被截断 → isLikelyLoomAgentCommand 认不出。
// ps 必须带 -ww 才输出完整命令行。未修复代码不带 -ww → 断言失败。

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: execMock }));

// 让测试机上的 /proc "不存在"，强制走 ps 分支（模拟 macOS 无 /proc）。
// 其余 fs API 用空实现即可：findLikelyLoomAgentPids 只会触达 existsSync("/proc")。
vi.mock("node:fs", () => ({
  existsSync: (p: unknown) => p !== "/proc",
  readFileSync: () => "",
  readdirSync: () => [],
}));

import { findLikelyLoomAgentPids } from "../lib/pidfile.js";

const ORIGINAL_PLATFORM = process.platform;

function stubPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("findLikelyLoomAgentPids (macOS)", () => {
  beforeEach(() => {
    execMock.mockReset();
    stubPlatform("darwin");
  });

  afterEach(() => {
    stubPlatform(ORIGINAL_PLATFORM);
  });

  it("ps 带 -ww 避免截断，且能识别 nvm 全局安装的长命令行", () => {
    // 模拟 `ps -ww -eo pid=,command=` 输出（macOS 上 nvm 全局安装的真实形态）：
    execMock.mockReturnValue(
      " 1234 /Users/foo/.nvm/versions/node/v20.10.0/bin/node /Users/foo/.nvm/versions/node/v20.10.0/lib/node_modules/loom/dist/index.js start\n" +
        " 5678 /Users/foo/.nvm/versions/node/v20.10.0/bin/node /Users/foo/dev/loom/packages/cli/src/index.ts start --force\n" +
        " 9999 /Users/foo/.nvm/versions/node/v20.10.0/bin/node /Users/foo/.nvm/versions/node/v20.10.0/lib/node_modules/loom/dist/index.js stop\n",
    );

    const pids = findLikelyLoomAgentPids();
    expect(execMock).toHaveBeenCalledOnce();
    const args = execMock.mock.calls[0]![1] as string[];
    expect(args).toContain("-ww");
    expect(args.join(" ")).toMatch(/-ww/);
    expect(pids).toEqual([1234, 5678]);
  });

  it("ps 不可用时回退空数组，不抛错", () => {
    execMock.mockImplementation(() => {
      throw new Error("command not found");
    });
    expect(findLikelyLoomAgentPids()).toEqual([]);
  });
});
