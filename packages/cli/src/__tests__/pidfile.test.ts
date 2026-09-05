import { describe, expect, it } from "vitest";
import { isLikelyLoomAgentCommand } from "../lib/pidfile.js";

describe("isLikelyLoomAgentCommand", () => {
  it("识别全局安装 loom 的后台 start 进程", () => {
    expect(
      isLikelyLoomAgentCommand(
        "/root/.nvm/versions/node/v24.15.0/bin/node /root/.nvm/versions/node/v24.15.0/bin/loom start",
      ),
    ).toBe(true);
  });

  it("识别 workspace 内通过 tsx 启动的 start 进程", () => {
    expect(
      isLikelyLoomAgentCommand(
        "node_modules/.bin/tsx /workspace/loom/packages/cli/src/index.ts start --force",
      ),
    ).toBe(true);
  });

  it("识别 nvm lib/node_modules 全局安装的 dist 入口", () => {
    expect(
      isLikelyLoomAgentCommand(
        "/root/.nvm/versions/node/v24.15.0/bin/node /root/.nvm/versions/node/v24.15.0/lib/node_modules/loom/dist/index.js start",
      ),
    ).toBe(true);
  });

  it("识别 Windows 反斜杠路径的 npm 全局安装（normalize 后跨平台匹配）", () => {
    expect(
      isLikelyLoomAgentCommand(
        'node "C:\\Users\\foo\\AppData\\Roaming\\npm\\node_modules\\loom\\dist\\index.js" start',
      ),
    ).toBe(true);
  });

  it("识别 Windows 反斜杠路径的 workspace dev 启动", () => {
    expect(
      isLikelyLoomAgentCommand(
        "node D:\\dev\\loom\\packages\\cli\\dist\\index.js start",
      ),
    ).toBe(true);
  });

  it("拒绝其它 loom 子命令，避免误杀", () => {
    expect(isLikelyLoomAgentCommand("/root/.nvm/versions/node/v24.15.0/bin/loom stop")).toBe(false);
    expect(isLikelyLoomAgentCommand("/root/.nvm/versions/node/v24.15.0/bin/loom status --json")).toBe(false);
    expect(isLikelyLoomAgentCommand("bash -lc just publish-local")).toBe(false);
  });
});
