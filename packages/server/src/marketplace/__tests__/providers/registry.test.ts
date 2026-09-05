import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickProvider } from "../../providers/registry.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("pickProvider", () => {
  it("picks claude-code-plugin for a marketplace dir", () => {
    const p = pickProvider(join(__dirname, "../fixtures/cc-marketplace"));
    expect(p.kind).toBe("claude-code-plugin");
  });

  it("picks claude-code-plugin for a plugin dir", () => {
    const p = pickProvider(join(__dirname, "../fixtures/cc-plugin"));
    expect(p.kind).toBe("claude-code-plugin");
  });

  it("picks generic-git for a dir with no claude-plugin manifest", () => {
    const p = pickProvider(join(__dirname, "../fixtures/generic-skills"));
    expect(p.kind).toBe("generic-git");
  });
});
