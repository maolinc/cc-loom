import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

type CanonicalizePath = (path: string) => string;

export function isMainModule(
  moduleUrl: string | URL,
  argvEntry: string | undefined,
  canonicalize: CanonicalizePath = realpathSync,
): boolean {
  if (!argvEntry) return false;

  try {
    return canonicalize(fileURLToPath(moduleUrl)) === canonicalize(argvEntry);
  } catch {
    return false;
  }
}
