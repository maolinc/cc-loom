/**
 * `~/.loom/config.json` 强类型读写。
 *
 * 取代旧的 `src/config.ts`：
 * - 路径常量集中在 `paths.ts`。
 * - 写入采用原子 rename。
 * - 提供 `mergeConfig` 用于 `loom start` 首次绑定 deviceId 时回写。
 */
import { existsSync, unlinkSync } from "node:fs";
import type { CliConfig } from "@maolinc/cc-loom-shared";
import { CONFIG_PATH, ensureLoomDirs } from "./paths.js";
import { readJson, writeJsonAtomic } from "./atomic.js";

export function getConfig(): CliConfig | null {
  return readJson<CliConfig>(CONFIG_PATH);
}

/**
 * 返回有有效 token 的配置；token 为空（logout 后保留 deviceId 的中间态）返回 null。
 * 所有需要认证的命令用这个；login/logout 用 getConfig() 直接读原始状态。
 */
export function getValidConfig(): CliConfig | null {
  const config = getConfig();
  if (!config || !config.token) return null;
  return config;
}

export function saveConfig(config: CliConfig): void {
  ensureLoomDirs();
  writeJsonAtomic(CONFIG_PATH, config);
}

export function mergeConfig(patch: Partial<CliConfig>): CliConfig | null {
  const cur = getConfig();
  if (!cur) return null;
  const next = { ...cur, ...patch };
  saveConfig(next);
  return next;
}

/**
 * 清除 token（凭据），但保留 endpoint 和 deviceId。
 * 这样 loom login 后 loom start 能复用已有设备，已注册项目不会因 deviceId 丢失而变孤儿。
 */
export function clearCredentials(): void {
  const cur = getConfig();
  if (!cur) return;
  saveConfig({ ...cur, token: "" });
}

/** 彻底删除配置文件（仅在需要完全重置时使用）。 */
export function clearConfig(): void {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
