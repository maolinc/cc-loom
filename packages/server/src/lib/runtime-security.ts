import type { FastifyRequest } from "fastify";

function configuredOrigins(): Set<string> {
  const values = (process.env.LOOM_CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const origins = new Set<string>();
  for (const value of values) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`LOOM_CORS_ORIGINS contains an invalid origin: ${value}`);
    }
    if (parsed.origin !== value) {
      throw new Error(`LOOM_CORS_ORIGINS entries must be origins without a path: ${value}`);
    }
    origins.add(value);
  }
  return origins;
}

const trustedOrigins = configuredOrigins();

export function isTrustedBrowserOrigin(origin: string | undefined, request?: FastifyRequest): boolean {
  if (!origin) return true;
  if (trustedOrigins.has(origin)) return true;

  const host = request?.headers.host;
  return host ? origin === `http://${host}` : false;
}

export function useSecureCookies(): boolean {
  const configured = process.env.LOOM_COOKIE_SECURE;
  if (configured === undefined) return process.env.NODE_ENV === "production";
  return configured === "true";
}
