import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    setupFiles: ["./vitest.setup.ts"],
    // Each test file runs in its own fork with its own LOOM_DATA_DIR (set in
    // vitest.setup.ts), so SQLite never shares state between files. Files run
    // in parallel.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
