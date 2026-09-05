import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const SSH_RE = /^git@([^:]+):(.+)$/;

export function normalizeRepoUrl(input: string): string {
  if (!input || typeof input !== "string") {
    throw new Error("Repository URL is required");
  }
  let url = input.trim();

  // Convert SSH form: git@host:path -> https://host/path
  const sshMatch = SSH_RE.exec(url);
  if (sshMatch) {
    url = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid repository URL: ${input}`);
  }

  if (parsed.protocol !== "https:") {
    // 测试专用：允许 file:// 本地 fixture 仓库（docker 测试环境才设此 env）。
    // 生产永不设置；与 marketplace pipeline 的 __setCloneOrFetchOverride 同属测试钩子。
    if (parsed.protocol === "file:" && process.env.LOOM_TEST_ALLOW_FILE_CLONE === "1") {
      return parsed.toString();
    }
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("Repository URLs must not contain credentials");
  }

  parsed.host = parsed.host.toLowerCase();
  let pathname = parsed.pathname.replace(/\.git$/, "").replace(/\/$/, "");
  parsed.pathname = pathname;
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString();
}

function isPrivateIp(address: string): boolean {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
  }

  const parts = address.split(".");
  if (parts.length !== 4) return true;

  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return true;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

/** Resolve a remote Marketplace host once and reject private-network targets. */
export async function assertPublicRepoHost(repoUrl: string): Promise<void> {
  const parsed = new URL(repoUrl);
  if (parsed.protocol === "file:") return;

  const resolved = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (resolved.length === 0 || resolved.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Repository host must resolve only to public addresses");
  }
}
