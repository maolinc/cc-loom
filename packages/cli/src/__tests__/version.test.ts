import { describe, expect, it, vi } from "vitest";
import { versionCommand } from "../commands/version.js";

// 回归保护：`loom version` 输出 `loom <版本号>`，版本号来自同包 package.json
// （getCliVersion），与 `loom --version` 一致。版本号缺失时回退 "unknown"。

describe("versionCommand", () => {
  it("输出 `loom <版本号>` 格式", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await versionCommand();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatch(/^loom \d+\.\d+\.\d+/);
    spy.mockRestore();
  });
});
