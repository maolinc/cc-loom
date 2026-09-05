/**
 * 共享给 VendorTabStrip 与 CapabilityMatrix 表头复用的厂商展示原语：
 *  - CountIndicator：根据 VendorMirror 的 managed/external/missing 计数渲染状态点 + 文案
 *
 * 厂商 logo 图标统一使用 ToolIcon 组件（../components/ToolIcon），
 * 此处仅保留计数指示器。
 */
import type { VendorMirror } from "@maolinc/cc-loom-shared";

export function CountIndicator({ mirror }: { mirror: VendorMirror }) {
  const { managedCount, managedAssetCount = 0, externalCount, missingCount } = mirror;
  // 所见即所得：该厂商目录下的能力总数（受管 + 磁盘副本，二者不重叠），不向用户区分来源。
  const total = managedAssetCount + externalCount;
  if (missingCount > 0 && managedCount > 0) {
    return (
      <>
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        <span className="text-[10.5px] text-amber-700">
          {total} 项 · 缺 {missingCount} 文件
        </span>
      </>
    );
  }
  if (missingCount > 0 && managedCount === 0) {
    return (
      <>
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        <span className="text-[10.5px] text-red-700">本地缺失</span>
      </>
    );
  }
  if (total > 0) {
    return (
      <>
        <span className="w-1.5 h-1.5 rounded-full bg-brand" />
        <span className="text-[10.5px] text-text-secondary">{total} 项</span>
      </>
    );
  }
  return (
    <>
      <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
      <span className="text-[10.5px] text-text-muted">空目录</span>
    </>
  );
}
