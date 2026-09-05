import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@maolinc/cc-loom-testkit": resolve(__dirname, "src/index.ts"),
      "@maolinc/cc-loom-shared": resolve(__dirname, "../shared/src/index.ts"),
      "@maolinc/cc-loom-adapter": resolve(__dirname, "../adapter/src/index.ts"),
    },
  },
  test: {
    root: resolve(__dirname, "../.."),
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 30000,
    // 串行: 单容器模式下避免多测试文件争抢端口/进程
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    // vitest 4 兼容 (poolOptions 被移除，用 fileParallelism 替代)
    fileParallelism: false,
  },
});
