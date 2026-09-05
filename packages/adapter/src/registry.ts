import type { TargetTool } from "@maolinc/cc-loom-shared";
import type { Adapter } from "./types.js";
import { CursorAdapter } from "./cursor.js";
import { CodeBuddyAdapter } from "./codebuddy.js";
import { ClaudeCodeAdapter } from "./claudecode.js";
import { CodexAdapter } from "./codex.js";

const adapters: Adapter[] = [
  new CursorAdapter(),
  new CodeBuddyAdapter(),
  new ClaudeCodeAdapter(),
  new CodexAdapter(),
];

const adapterMap = new Map<TargetTool, Adapter>(
  adapters.map((a) => [a.tool, a])
);

export function getAdapter(tool: TargetTool): Adapter | undefined {
  return adapterMap.get(tool);
}

export function getAdapters(tools: TargetTool[]): Adapter[] {
  return tools.map((t) => adapterMap.get(t)).filter(Boolean) as Adapter[];
}

export function listAdapters(): Adapter[] {
  return adapters;
}
