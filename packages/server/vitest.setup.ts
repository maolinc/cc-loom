// Vitest setup — runs once per test file, BEFORE any module is imported.
// Each test file gets its own temp directory so they're fully isolated and
// can run in parallel without SQLite contention.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.LOOM_DATA_DIR) {
  process.env.LOOM_DATA_DIR = mkdtempSync(join(tmpdir(), "loom-test-"));
}
process.env.LOOM_ADMIN_EMAIL ??= "admin@loom.test";
process.env.LOOM_ADMIN_PASSWORD ??= "test-admin-password";
