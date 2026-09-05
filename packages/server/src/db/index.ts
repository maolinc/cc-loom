import Database, { type Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLoadablePath } from "sqlite-vec";

/**
 * Data directory. Override via LOOM_DATA_DIR env var (used by tests to point
 * at a temp directory and avoid mutating the user's real ~/.loom/loom.db).
 */
const DATA_DIR = process.env.LOOM_DATA_DIR || join(homedir(), ".loom");
/**
 * DB directory. 所有 SQLite 文件（loom.db、loom.db-wal、loom.db-shm）集中在此，
 * 与 ~/.loom 下的其余数据（marketplaces/、master.key 等）隔离，便于备份/迁移。
 */
const DB_DIR = join(DATA_DIR, "db");
const DB_PATH = join(DB_DIR, "loom.db");

if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

const sqlite: DatabaseType = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

/**
 * sqlite-vec 向量扩展加载状态。
 *
 * 加载失败不致命（预编译二进制缺失/平台不支持/better-sqlite3 被编译为禁用
 * load_extension）：asset_vec 虚拟表跳过创建，语义搜索降级为纯词法
 * （FTS5/LIKE），服务仍可启动。见 docs/sqlite-vec-search-design.md §3.3。
 */
let vecExtensionLoaded = false;
try {
  sqlite.loadExtension(getLoadablePath());
  vecExtensionLoaded = true;
  console.log("[db] sqlite-vec 扩展加载成功");
} catch (err) {
  console.warn(
    `[db] sqlite-vec 扩展加载失败，语义搜索将降级为词法模式: ${err instanceof Error ? err.message : err}`,
  );
}

export const db = sqlite;
export const dataDir = DATA_DIR;
export const dbDir = DB_DIR;
/** sqlite-vec 是否可用（扩展加载成功）。asset_vec 表仅在此为 true 时创建。 */
export const vecAvailable = (): boolean => vecExtensionLoaded;
