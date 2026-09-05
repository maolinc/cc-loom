import { describe, expect, it } from "vitest";
import { runBestEffortCleanupSteps } from "../lib/shutdown.js";

describe("runBestEffortCleanupSteps", () => {
  it("前一步抛错时仍继续执行后续 cleanup", async () => {
    const calls: string[] = [];
    const errors: string[] = [];

    await runBestEffortCleanupSteps(
      [
        { label: "first", run: () => { calls.push("first"); } },
        { label: "broken", run: () => { calls.push("broken"); throw new Error("boom"); } },
        { label: "last", run: () => { calls.push("last"); } },
      ],
      {
        perStepTimeoutMs: 20,
        onError: (label, err) => errors.push(`${label}:${(err as Error).message}`),
      },
    );

    expect(calls).toEqual(["first", "broken", "last"]);
    expect(errors).toEqual(["broken:boom"]);
  });

  it("单步卡住超时时，不会阻断后续 cleanup", async () => {
    const calls: string[] = [];
    const errors: string[] = [];

    await runBestEffortCleanupSteps(
      [
        { label: "stuck", run: async () => { calls.push("stuck"); await new Promise(() => {}); } },
        { label: "after", run: () => { calls.push("after"); } },
      ],
      {
        perStepTimeoutMs: 20,
        onError: (label, err) => errors.push(`${label}:${(err as Error).message}`),
      },
    );

    expect(calls).toEqual(["stuck", "after"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("stuck");
    expect(errors[0]).toContain("20ms");
  });
});
