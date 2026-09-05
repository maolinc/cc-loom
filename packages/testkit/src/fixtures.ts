/**
 * Fixture 加载器 — 从 LOOM_FIXTURES_DIR 读取 seed / 模板 / 期望快照。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR } from "./env.js";
import type { AssetCreateInput } from "@maolinc/cc-loom-shared";

/** 读取 seed JSON。 */
export function loadSeed<T>(name: string): T {
  const p = join(FIXTURES_DIR, "seed", `${name}.json`);
  if (!existsSync(p)) throw new Error(`seed 不存在: ${name} (${p})`);
  return JSON.parse(readFileSync(p, "utf-8")) as T;
}

/** 读取期望磁盘快照目录下的文件列表 + 内容。 */
export interface ExpectedFile {
  path: string;
  content?: string; // 不提供时只校验存在性
}

export function loadExpected(scenario: string): ExpectedFile[] {
  const dir = join(FIXTURES_DIR, "expected", scenario);
  if (!existsSync(dir)) throw new Error(`期望快照不存在: ${scenario} (${dir})`);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`快照 manifest 不存在: ${manifestPath}`);
  return JSON.parse(readFileSync(manifestPath, "utf-8")) as ExpectedFile[];
}

/** 六类 asset 的便捷构造器（供用例直接调用，减少重复模板代码）。 */
export const assetBuilders = {
  skill(name: string, tools: string[] = ["cursor"]): AssetCreateInput {
    return {
      name,
      type: "skill",
      description: `test skill ${name}`,
      tags: ["test"],
      files: [{ path: "SKILL.md", content: `# ${name}\n\nTest skill.` }],
      compatibleTools: tools as any,
      visibility: "public",
      metadata: {},
    };
  },
  rule(name: string, globs: string[] = ["**/*.ts"], tools: string[] = ["cursor"]): AssetCreateInput {
    return {
      name,
      type: "rule",
      description: `test rule ${name}`,
      tags: ["test"],
      files: [{ path: `${name}.md`, content: `# ${name}\n\nAlways use strict types.` }],
      compatibleTools: tools as any,
      visibility: "public",
      metadata: { globs },
    };
  },
  mcp(name: string, command: string, tools: string[] = ["cursor"]): AssetCreateInput {
    return {
      name,
      type: "mcp",
      description: `test mcp ${name}`,
      tags: ["test"],
      files: [{ path: "config.json", content: JSON.stringify({ command, args: [] }) }],
      compatibleTools: tools as any,
      visibility: "public",
      metadata: { transport: "stdio" as const, command },
    };
  },
  hook(name: string, event: string, tools: string[] = ["codebuddy"]): AssetCreateInput {
    return {
      name,
      type: "hook",
      description: `test hook ${name}`,
      tags: ["test"],
      files: [{ path: `${name}.sh`, content: "#!/bin/sh\necho hook" }],
      compatibleTools: tools as any,
      visibility: "public",
      metadata: { event, hooks: [{ type: "command", command: `./${name}.sh` }] },
    };
  },
  command(name: string, trigger: string, tools: string[] = ["cursor"]): AssetCreateInput {
    return {
      name,
      type: "command",
      description: `test command ${name}`,
      tags: ["test"],
      files: [{ path: `${name}.md`, content: `# ${name}\n\nTrigger: ${trigger}` }],
      compatibleTools: tools as any,
      visibility: "public",
      metadata: { trigger },
    };
  },
  agent(name: string, tools: string[] = ["codebuddy"]): AssetCreateInput {
    return {
      name,
      type: "agent",
      description: `test agent ${name}`,
      tags: ["test"],
      files: [{ path: `${name}.md`, content: `# ${name}\n\nTest agent.` }],
      compatibleTools: tools as any,
      visibility: "public",
      metadata: {},
    };
  },
};
