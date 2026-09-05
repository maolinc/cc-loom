/**
 * 本地项目元数据存储 `~/.loom/projects/<id>.json`。
 *
 * 字段对齐 `Project`（@maolinc/cc-loom-shared），并加上本地辅助字段：
 * - `endpoint` —— 该项目当时注册到的服务端地址，用于多服务端切换场景。
 * - `lastInstalledAt` —— 最近一次成功 install 的 ISO 时间，给 `loom status` 显示。
 *
 * 设计：以 `id` 为主键存储；按 `normalizedPath` 反查（线性扫描，项目数量级 < 100）。
 */
import { readdirSync } from "node:fs";
import type { Project } from "@maolinc/cc-loom-shared";
import { PROJECTS_DIR, projectFile, ensureLoomDirs } from "./paths.js";
import { readJson, writeJsonAtomic, removeIfExists } from "./atomic.js";

export interface LocalProjectRecord extends Project {
  /** 注册时的 endpoint，便于 status 命令直接定位服务端。 */
  endpoint: string;
  /** 最近一次 install_result success 的 ISO 时间。 */
  lastInstalledAt?: string;
}

export function readProject(id: string): LocalProjectRecord | null {
  return readJson<LocalProjectRecord>(projectFile(id));
}

export function writeProject(record: LocalProjectRecord): void {
  ensureLoomDirs();
  writeJsonAtomic(projectFile(record.id), record);
}

export function removeProject(id: string): void {
  removeIfExists(projectFile(id));
}

export function listProjects(): LocalProjectRecord[] {
  ensureLoomDirs();
  const entries = readdirSync(PROJECTS_DIR);
  const out: LocalProjectRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const r = readProject(id);
    if (r) out.push(r);
  }
  return out;
}

export function findProjectByPath(normalizedPath: string): LocalProjectRecord | null {
  for (const p of listProjects()) {
    if (p.normalizedPath === normalizedPath) return p;
  }
  return null;
}

export function recordInstallSuccess(projectId: string, when: string = new Date().toISOString()): void {
  const r = readProject(projectId);
  if (!r) return;
  r.lastInstalledAt = when;
  writeProject(r);
}
