/**
 * `loom version` —— 打印当前 CLI 版本号。
 *
 * 与 `loom --version`（Commander 内置 flag）输出一致，提供子命令形式更易记忆。
 */
import { getCliVersion } from "../lib/version.js";

export async function versionCommand(): Promise<void> {
  console.log(`loom ${getCliVersion()}`);
}
