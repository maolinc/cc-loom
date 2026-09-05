import { setTimeout as delay } from "node:timers/promises";

export interface CleanupStep {
  label: string;
  run: () => void | Promise<void>;
}

export interface RunBestEffortCleanupOptions {
  perStepTimeoutMs?: number;
  onError?: (label: string, error: Error) => void;
}

const DEFAULT_STEP_TIMEOUT_MS = 1_000;

/**
 * 逐步执行 cleanup；单步抛错或卡住都只记录错误，不阻断后续步骤。
 */
export async function runBestEffortCleanupSteps(
  steps: CleanupStep[],
  options: RunBestEffortCleanupOptions = {},
): Promise<void> {
  const timeoutMs = options.perStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  for (const step of steps) {
    try {
      await Promise.race([
        Promise.resolve(step.run()),
        delay(timeoutMs).then(() => {
          throw new Error(`${step.label} 在 ${timeoutMs}ms 内未完成`);
        }),
      ]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      options.onError?.(step.label, err);
    }
  }
}
