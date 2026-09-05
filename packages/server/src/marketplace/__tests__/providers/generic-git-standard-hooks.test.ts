import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { genericGitProvider } from "../../providers/generic-git.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const EDGE = join(__dirname, "../fixtures/standard-hooks-edge");

describe("extractStandardHooks edge cases", () => {
  it("extracts valid hook.json dirs AND the official hooks/hooks.json file", async () => {
    const result = await genericGitProvider.parse(EDGE);
    const hooks = result.assets.filter((a) => a.type === "hook");
    // `hooks/good/hook.json` (Loom-native dir bundle) + `hooks/hooks.json`
    // (official event-grouped file) are both valid and both parsed.
    expect(hooks.map((h) => h.name).sort()).toEqual(["PostToolUse", "good"]);
  });

  it("parses official hooks/hooks.json into a hook asset with event-grouped metadata", async () => {
    const result = await genericGitProvider.parse(EDGE);
    const ptu = result.assets.find((a) => a.name === "PostToolUse")!;
    expect(ptu).toBeDefined();
    expect(ptu.sourcePath).toBe("hooks/hooks.json#PostToolUse.0");
    const md = ptu.metadata as { event: string; matcher?: string; hooks: any[] };
    expect(md.event).toBe("PostToolUse");
    expect(md.matcher).toBe("Write");
    expect(md.hooks).toEqual([{ type: "command", command: "x.sh" }]);
  });

  it("passes through hooks[i] fields verbatim (command/http entries preserved)", async () => {
    const result = await genericGitProvider.parse(EDGE);
    const good = result.assets.find((a) => a.name === "good")!;
    const md = good.metadata as { events: string[]; matcher?: string; hooks: any[] };
    expect(md.events).toEqual(["PostToolUse"]);
    expect(md.matcher).toBe("Edit");
    expect(md.hooks).toEqual([
      { type: "command", command: "ok.sh" },
      { type: "http", url: "https://example.com/hook", headers: { X: "y" } },
    ]);
  });

  it("default compatibleTools for hook is [claudecode, codebuddy, codex]", async () => {
    const result = await genericGitProvider.parse(EDGE);
    const good = result.assets.find((a) => a.name === "good")!;
    expect(good.compatibleTools.sort()).toEqual(["claudecode", "codebuddy", "codex"]);
  });

  it("hook directory files are bundled into the asset", async () => {
    const result = await genericGitProvider.parse(EDGE);
    const good = result.assets.find((a) => a.name === "good")!;
    const paths = good.files.map((f) => f.path).sort();
    expect(paths).toEqual(["hook.json", "ok.sh"]);
  });
});
