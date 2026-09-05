/**
 * 本地控制台 hook 能力的事件标注。
 *
 * 为 state.capabilities 的 hook 行补 `hookEvents`（能力级展示字段）：
 *  - 受管（含 adopt 产物）：asset metadata 声明的事件集（hookEventsOf，兼容旧 event 单值）——
 *    disabled 时也能展示「打开后会注册到哪些事件」；同一能力跨厂商各自 adopt 时取并集。
 *  - 外部（external:*）：CLI 扫描的各厂商聚合注册表事件（vendors[].hookEvents）并集——
 *    磁盘上的真实注册。
 * 在 GET /state 与 POST /scan 返回前调用（原地填充，幂等）。
 */
import { db } from "../db/index.js";
import { hookEventsOf, type LocalProjectState } from "@maolinc/cc-loom-shared";

export function enrichCapabilitiesHookEvents(state: LocalProjectState): void {
  const caps = state.capabilities;
  if (!caps) return;
  const hookCaps = caps.filter((c) => c.type === "hook");
  if (hookCaps.length === 0) return;

  // 一次取齐所有相关受管 asset 的 metadata.events
  const ids = new Set<string>();
  for (const cap of hookCaps) {
    if (!cap.assetId.startsWith("external:")) ids.add(cap.assetId);
    for (const v of Object.values(cap.vendors)) {
      if (v?.assetId && !v.assetId.startsWith("external:")) ids.add(v.assetId);
    }
  }
  const eventsByAsset = new Map<string, string[]>();
  if (ids.size > 0) {
    const stmt = db.prepare("SELECT id, metadata FROM assets WHERE id = ?");
    for (const id of ids) {
      const row = stmt.get(id) as { metadata: string } | undefined;
      if (!row) continue;
      try {
        const evs = hookEventsOf(JSON.parse(row.metadata));
        if (evs.length > 0) eventsByAsset.set(id, evs);
      } catch {
        /* metadata 解析失败：回退到厂商扫描并集 */
      }
    }
  }

  for (const cap of hookCaps) {
    const declared = new Set<string>();
    if (!cap.assetId.startsWith("external:")) {
      for (const ev of eventsByAsset.get(cap.assetId) ?? []) declared.add(ev);
    }
    for (const v of Object.values(cap.vendors)) {
      if (v?.assetId && !v.assetId.startsWith("external:")) {
        for (const ev of eventsByAsset.get(v.assetId) ?? []) declared.add(ev);
      }
    }
    if (declared.size > 0) {
      cap.hookEvents = [...declared];
      continue;
    }
    // 外部行 / metadata 缺失：磁盘注册扫描并集
    const scanned = new Set<string>();
    for (const v of Object.values(cap.vendors)) {
      for (const ev of v?.hookEvents ?? []) scanned.add(ev);
    }
    if (scanned.size > 0) cap.hookEvents = [...scanned];
  }
}
