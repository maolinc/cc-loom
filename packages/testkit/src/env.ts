/**
 * 容器内环境变量约定 — 由 Dockerfile.test-runtime 注入。
 *
 * - LOOM_SERVER_BIN: server 入口 JS 路径
 * - LOOM_CLI_BIN:    cli 入口 JS 路径
 * - LOOM_FIXTURES_DIR: fixture 根目录
 * - LOOM_HOME:       CLI 本地数据目录（隔离的 ~/.loom）
 * - LOOM_DATA_DIR:   server DB 目录（隔离的 ~/.loom）
 */
export const SERVER_BIN = process.env.LOOM_SERVER_BIN ?? "";
export const CLI_BIN = process.env.LOOM_CLI_BIN ?? "";
export const FIXTURES_DIR = process.env.LOOM_FIXTURES_DIR ?? join(process.cwd(), "tests", "fixtures");
export const LOOM_HOME = process.env.LOOM_HOME ?? "";

/**
 * Marketplace fixture 目录（普通目录，非 git 仓库）— 与 server 的 marketplace
 * 单元测试共用同一份。createGitFixture 把它变成真 git 仓库供 L3 真 clone。
 */
export const MARKETPLACE_FIXTURES_DIR = process.env.LOOM_MARKETPLACE_FIXTURES_DIR
  ?? join(process.cwd(), "packages", "server", "src", "marketplace", "__tests__", "fixtures");
/** 标准 marketplace fixture 绝对路径。 */
export const FIXTURE_GENERIC = join(MARKETPLACE_FIXTURES_DIR, "generic-skills");
export const FIXTURE_CC_PLUGIN = join(MARKETPLACE_FIXTURES_DIR, "cc-plugin");
export const FIXTURE_CC_SELF_URL = join(MARKETPLACE_FIXTURES_DIR, "cc-self-url-marketplace");
export const FIXTURE_EMPTY = join(MARKETPLACE_FIXTURES_DIR, "empty-repo");

import { join } from "node:path";
