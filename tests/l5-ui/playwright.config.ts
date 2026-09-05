/**
 * Playwright 配置 — L5 UI 测试。
 *
 * webServer 自动启动 loom-server，等端口就绪后跑测试，测完自动停止。
 * 浏览器: chromium only（容器内 headless）。
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = 47474;

export default defineConfig({
  testDir: ".",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
    headless: true,
  },
  webServer: {
    command: `node ${process.env.LOOM_SERVER_BIN ?? "../../packages/server/dist/index.js"}`,
    port: PORT,
    timeout: 15000,
    reuseExistingServer: true,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      LOOM_DATA_DIR: process.env.LOOM_DATA_DIR ?? "/tmp/loom-l5-home/.loom",
      LOOM_ADMIN_EMAIL: process.env.LOOM_ADMIN_EMAIL ?? "admin@loom.test",
      LOOM_ADMIN_PASSWORD: process.env.LOOM_ADMIN_PASSWORD ?? "test-admin-password",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
