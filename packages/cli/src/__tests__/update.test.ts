import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 回归保护：`loom update` 按 npm_config_user_agent 识别包管理器
// （pnpm/yarn，否则 npm），并对各 pm 拼出正确的全局重装命令；
// 安装失败（非 0 退出）抛 CliFailure 供 runCommand 转 process.exit。

const { spawnMock, sourceMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  sourceMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// 控制安装来源探测，默认返回 null（退回 @latest + 默认 registry）
vi.mock("../lib/install-source.js", () => ({
  resolveInstallSource: sourceMock,
}));

// 屏蔽 ui 输出噪音与 color（避免 undefined 拼接干扰断言）
vi.mock("../lib/ui.js", () => ({
  ok: vi.fn(),
  info: vi.fn(),
  tip: vi.fn(),
  blank: vi.fn(),
  err: vi.fn(),
  color: { cyan: (s: string) => s, dim: (s: string) => s, green: (s: string) => s },
}));

import { updateCommand } from "../commands/update.js";
import { CliFailure } from "../lib/errors.js";

const ORIG_UA = process.env.npm_config_user_agent;

function setUA(v: string | undefined): void {
  if (v === undefined) delete process.env.npm_config_user_agent;
  else process.env.npm_config_user_agent = v;
}

/** 让 spawn 返回一个伪子进程，setImmediate 触发 close(exitCode)。 */
function childExit(exitCode: number): void {
  spawnMock.mockImplementation(() => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const child = {
      on(ev: string, cb: (...a: unknown[]) => void) { handlers[ev] = cb; return child; },
    };
    setImmediate(() => handlers["close"]?.(exitCode));
    return child;
  });
}

beforeEach(() => {
  spawnMock.mockReset();
  sourceMock.mockReset();
  sourceMock.mockReturnValue(null);
  setUA(undefined);
});

afterEach(() => { setUA(ORIG_UA); });

describe("updateCommand 包管理器检测与安装参数", () => {
  it("无 user_agent → npm install -g @maolinc/cc-loom@latest", async () => {
    childExit(0);
    await updateCommand();
    expect(spawnMock).toHaveBeenCalledWith(
      "npm", ["install", "-g", "@maolinc/cc-loom@latest"], expect.any(Object),
    );
  });

  it("pnpm user_agent → pnpm add -g @maolinc/cc-loom@latest", async () => {
    setUA("pnpm/8.15.0");
    childExit(0);
    await updateCommand();
    expect(spawnMock).toHaveBeenCalledWith(
      "pnpm", ["add", "-g", "@maolinc/cc-loom@latest"], expect.any(Object),
    );
  });

  it("yarn user_agent → yarn global add @maolinc/cc-loom@latest", async () => {
    setUA("yarn/1.22.19");
    childExit(0);
    await updateCommand();
    expect(spawnMock).toHaveBeenCalledWith(
      "yarn", ["global", "add", "@maolinc/cc-loom@latest"], expect.any(Object),
    );
  });

  it("识别到私有 registry + tag → npm 带 --registry 与 spec", async () => {
    sourceMock.mockReturnValue({
      registry: "http://registry.example.test:4873",
      tag: "dev",
      spec: "@maolinc/cc-loom@dev",
    });
    childExit(0);
    await updateCommand();
    expect(spawnMock).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@maolinc/cc-loom@dev", "--registry", "http://registry.example.test:4873"],
      expect.any(Object),
    );
  });

  it("pnpm 识别到来源 → add -g spec --registry", async () => {
    setUA("pnpm/8.15.0");
    sourceMock.mockReturnValue({
      registry: "http://h:4873", tag: "dev", spec: "@maolinc/cc-loom@dev",
    });
    childExit(0);
    await updateCommand();
    expect(spawnMock).toHaveBeenCalledWith(
      "pnpm",
      ["add", "-g", "@maolinc/cc-loom@dev", "--registry", "http://h:4873"],
      expect.any(Object),
    );
  });

  it("安装失败（非 0 退出）→ 抛 CliFailure", async () => {
    childExit(1);
    await expect(updateCommand()).rejects.toBeInstanceOf(CliFailure);
  });
});
