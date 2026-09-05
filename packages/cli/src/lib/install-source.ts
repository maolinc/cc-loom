/**
 * 探测当前 loom 的安装来源（registry + dist-tag）。
 *
 * 背景：`loom update` 通过包管理器全局重装 @maolinc/cc-loom。若用户当初用私有 registry
 * （如 verdaccio）+ dist-tag（如 `@dev`）安装，update 却走默认公网 registry
 * 拉 `@latest`，会把私有版替换成公网同名包、且 bin 可能对不上 → 命令丢失。
 *
 * npm 全局安装时会在包的 package.json 写入两个非标准字段：
 * - `_from`：如 `@maolinc/cc-loom@dev` / `@maolinc/cc-loom@0.1.0`
 * - `_resolved`：如 `http://host:4873/@maolinc/cc-loom/-/cli-0.1.0.tgz`
 * 从中恢复 registry origin 与 dist-tag，让 update 沿用同一来源。
 *
 * 读不到（pnpm/yarn 全局结构不同、npx 临时执行、旧版 npm 未写字段、源码开发态）
 * 时返回 null，调用方退回默认 `@latest` + 当前 registry。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface InstallSource {
  /** registry origin，如 `http://registry.example.test:4873` */
  registry: string;
  /** dist-tag，如 `dev` / `latest` */
  tag: string;
  /** 完整安装 spec，如 `@maolinc/cc-loom@dev` */
  spec: string;
}

interface PkgMeta {
  _from?: string;
  _resolved?: string;
}

/**
 * 从 `_resolved` tarball URL 截取 registry origin。
 *
 * tarball 路径形如 `<registry>/@scope/name/-/name-<ver>.tgz` 或
 * `<registry>/name/-/name-<ver>.tgz`。移除末尾包名和 `/-/`，保留 registry
 * 的可选路径前缀；匹配不到则退到 URL origin。
 */
export function parseRegistry(resolved: string): string | null {
  try {
    const u = new URL(resolved);
    const marker = "/-/";
    const idx = u.pathname.lastIndexOf(marker);
    if (idx > 0) {
      const segments = u.pathname.slice(0, idx).split("/").filter(Boolean);
      const last = segments.at(-1);
      const previous = segments.at(-2);
      const packageSegments = last?.startsWith("@") ? 1 : previous?.startsWith("@") ? 2 : 1;
      const registrySegments = segments.slice(0, -packageSegments);
      return registrySegments.length > 0 ? `${u.origin}/${registrySegments.join("/")}` : u.origin;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * 从 `_from`（如 `@maolinc/cc-loom@dev`）提取 dist-tag。
 *
 * - `name@tag` / `@scope/name@tag` → 返回 tag
 * - `name@<version>` / `name@^<range>` → 返回 null（更新时应取 @latest）
 * - `file:` / `github:` / `git+` / `https://` 等非 registry 来源 → 返回 null
 *
 * 判定规则：tag 几乎不以数字或范围符（`~^>=<`）开头，据此区分 version/range。
 */
export function parseTag(from: string): string | null {
  if (/^(file:|github:|git\+|https?:\/\/|link:)/.test(from)) return null;
  const at = from.lastIndexOf("@");
  if (at <= 0) return null;
  const ref = from.slice(at + 1);
  if (!ref) return null;
  // 以数字或范围符开头视为 version/range，更新时应取 latest
  if (/^[~^>=<\d]/.test(ref)) return null;
  return ref;
}

/**
 * 探测当前 loom 的安装来源；读不到返回 null。
 *
 * 读取本包同目录的 package.json（与 version.ts 同一路径推导），不依赖额外
 * 子进程或 `npm root -g`。
 */
export function resolveInstallSource(): InstallSource | null {
  let pkg: PkgMeta;
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PkgMeta;
  } catch {
    return null;
  }
  const registry = pkg._resolved ? parseRegistry(pkg._resolved) : null;
  const tag = pkg._from ? parseTag(pkg._from) : null;
  if (!registry || !tag) return null;
  return { registry, tag, spec: `${pkg._from!.slice(0, pkg._from!.lastIndexOf("@"))}@${tag}` };
}
