// 测试隔离：把 HOME 指向临时目录，让 paths.ts 的 `~/.loom` 落在沙箱里，不污
// 染开发机的真实 ~/.loom。必须在任何模块 import 前设置（paths.ts 用
// `homedir()` 在模块加载时算 LOOM_DIR）。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.LOOM_TEST_HOME_PINNED) {
  process.env.HOME = mkdtempSync(join(tmpdir(), "loom-cli-test-home-"));
  process.env.LOOM_TEST_HOME_PINNED = "1";
}
