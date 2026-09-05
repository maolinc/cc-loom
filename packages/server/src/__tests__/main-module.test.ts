import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isMainModule } from "../lib/main-module.js";

describe("isMainModule", () => {
  it("matches an npm bin symlink after resolving both entry paths", () => {
    const modulePath = resolve("fixtures/global/node_modules/@maolinc/cc-loom-server/dist/index.js");
    const binPath = resolve("fixtures/global/bin/loom-server");
    const canonicalize = vi.fn((path: string) => {
      if (path === binPath) return modulePath;
      return path;
    });

    expect(
      isMainModule(pathToFileURL(modulePath), binPath, canonicalize),
    ).toBe(true);
    expect(canonicalize).toHaveBeenCalledTimes(2);
  });

  it("does not match a different executable or a missing argv entry", () => {
    expect(
      isMainModule("file:///opt/loom/dist/index.js", "/opt/other.js", (path) => path),
    ).toBe(false);
    expect(isMainModule("file:///opt/loom/dist/index.js", undefined)).toBe(false);
  });
});
