/**
 * CLI 版本号读取。
 *
 * 版本以已安装包的 package.json 为唯一来源——npm 发布时即使 `files` 只含
 * dist/，package.json 也始终随包发布。运行时按 `import.meta.url` 相对定位，
 * 避免在 index.ts 里硬编码版本号、与 package.json 脱钩。
 *
 * 容错：读不到（异常安装/文件缺失）回退 "unknown"，绝不抛错拖垮 CLI 启动。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

/** 已安装 CLI 的版本号（来自同包 package.json）。 */
export function getCliVersion(): string {
  if (cached !== null) return cached;
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cached = pkg.version ?? "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}

/** 清除缓存，强制下次 getCliVersion() 重新读盘（update 重装后用）。 */
export function clearVersionCache(): void {
  cached = null;
}
