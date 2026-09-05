import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { lockFile, ensureLoomDirs } from "../lib/paths.js";
import { readLock, removeLock, writeLock } from "../lib/locks.js";

const PROJECT_ID = "legacy-workspace-lock";

describe("capability set lock migration", () => {
  afterEach(() => removeLock(PROJECT_ID));

  it("normalizes legacy workspace keys and writes only capability set keys", () => {
    ensureLoomDirs();
    writeFileSync(lockFile(PROJECT_ID), JSON.stringify({
      workspaceId: "legacy-set",
      policy: "locked",
      version: "1",
      assets: {},
    }));

    const lock = readLock(PROJECT_ID);
    expect(lock?.subscriptions).toEqual([{
      capabilitySetId: "legacy-set",
      capabilitySetName: null,
      syncPolicy: "locked",
      targetTools: null,
      installedAt: "",
    }]);

    writeLock(PROJECT_ID, lock!);
    const persisted = JSON.parse(readFileSync(lockFile(PROJECT_ID), "utf8")) as Record<string, unknown>;
    expect(persisted.workspaceId).toBeUndefined();
    expect(persisted.capabilitySetId).toBeUndefined();
    expect(persisted.subscriptions).toEqual(lock!.subscriptions);
  });
});
