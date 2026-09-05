import { sourceQueries } from "./db-helpers.js";
import { runImport } from "./pipeline.js";
import { marketplaceService } from "./service.js";

let timer: NodeJS.Timeout | null = null;

/**
 * One scheduling pass: import every enabled source, isolating per-source errors.
 * Exported for tests and the admin "sync now" endpoint; production code otherwise
 * only triggers it through `setInterval`.
 */
export async function tick(): Promise<void> {
  const sources = sourceQueries.listEnabled();
  for (const s of sources) {
    try {
      await runImport({ sourceId: s.id, trigger: "scheduled" });
    } catch {
      // runImport handles its own error logging; ignore so one failure doesn't block others
    }
  }
}

export function startScheduler(): void {
  if (timer) return;
  const minutes = marketplaceService.getPollIntervalMinutes();
  const intervalMs = Math.max(1, minutes) * 60 * 1000;
  // First tick after one interval, not immediately on boot, to let server settle
  timer = setInterval(() => { void tick(); }, intervalMs);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function restartScheduler(): void {
  stopScheduler();
  startScheduler();
}
