/**
 * 原子写入辅助：先写 `<path>.tmp`，再 rename，避免崩溃留下半截文件。
 * 项目本地状态（config / projects / locks）全部走这里。
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export function writeJsonAtomic(absPath: string, value: unknown): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absPath);
}

export function readJson<T>(absPath: string): T | null {
  if (!existsSync(absPath)) return null;
  try {
    return JSON.parse(readFileSync(absPath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function removeIfExists(absPath: string): void {
  if (existsSync(absPath)) unlinkSync(absPath);
}
