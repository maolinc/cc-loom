import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SourceProvider } from "./types.js";
import { claudeCodePluginProvider } from "./claude-code-plugin.js";
import { genericGitProvider } from "./generic-git.js";

export function pickProvider(localPath: string): SourceProvider {
  if (
    existsSync(join(localPath, ".claude-plugin", "marketplace.json")) ||
    existsSync(join(localPath, ".claude-plugin", "plugin.json"))
  ) {
    return claudeCodePluginProvider;
  }
  return genericGitProvider;
}

export const allProviders: SourceProvider[] = [claudeCodePluginProvider, genericGitProvider];
