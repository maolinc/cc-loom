import type { DiffEntry, LockFile } from "@maolinc/cc-loom-shared";
import type { AdapterFile } from "./types.js";

export interface ExistingFile {
  path: string;
  content: string;
}

export function generateDiff(
  incoming: AdapterFile[],
  existing: ExistingFile[],
  lockFile?: LockFile
): DiffEntry[] {
  const diff: DiffEntry[] = [];
  const existingMap = new Map(existing.map((f) => [f.path, f.content]));
  const incomingMap = new Map(incoming.map((f) => [f.path, f.content]));

  // Files in lock but not in incoming → removed
  if (lockFile) {
    const lockedFiles = new Set(
      Object.values(lockFile.assets).flatMap((a) => a.files)
    );
    for (const f of lockedFiles) {
      if (!incomingMap.has(f) && existingMap.has(f)) {
        diff.push({
          operation: "remove",
          path: f,
          type: "skill", // best effort
          assetName: f.split("/").pop()?.replace(/\.(md|sh)$/, "") ?? "",
        });
      }
    }
  }

  for (const [path, content] of incomingMap) {
    const existingContent = existingMap.get(path);
    if (existingContent === undefined) {
      diff.push({
        operation: "add",
        path,
        type: path.includes("mcp.json") ? "mcp" : "skill",
        assetName: path.split("/").pop()?.replace(/\.(md|sh|json)$/, "") ?? "",
        content,
      });
    } else if (existingContent !== content) {
      diff.push({
        operation: "modify",
        path,
        type: path.includes("mcp.json") ? "mcp" : "skill",
        assetName: path.split("/").pop()?.replace(/\.(md|sh|json)$/, "") ?? "",
        content,
      });
    }
  }

  return diff;
}

export function formatDiffForDisplay(diff: DiffEntry[]): string {
  const lines: string[] = [];
  for (const entry of diff) {
    const prefix =
      entry.operation === "add"
        ? "+"
        : entry.operation === "remove"
          ? "-"
          : "~";
    lines.push(`${prefix} ${entry.path} (${entry.assetName})`);
  }
  return lines.join("\n");
}
