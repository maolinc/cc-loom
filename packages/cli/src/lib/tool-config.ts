/**
 * 设备级 Codex / Claude Code 用户配置合并。
 *
 * 边界：路径由本模块固定到当前用户 home，server 不能指定任意路径；现有 JSON
 * 无法解析时拒绝覆盖。Codex TOML 只更新 Loom 管理的键，保留其它 section、键和注释。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexToolConfig, ClaudeCodeToolConfig, WsToolConfigApplyPayload } from "@maolinc/cc-loom-shared";

const TOML_SECTION_RE = /^\s*\[([^\]]+)]\s*(?:#.*)?$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function sectionBounds(lines: string[], section: string | null): { start: number; end: number } | null {
  if (section === null) {
    const firstSection = lines.findIndex((line) => /^\s*\[/.test(line));
    return { start: 0, end: firstSection === -1 ? lines.length : firstSection };
  }

  const header = lines.findIndex((line) => TOML_SECTION_RE.exec(line)?.[1]?.trim() === section);
  if (header === -1) return null;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return { start: header + 1, end };
}

function upsertTomlKey(lines: string[], section: string | null, key: string, value: string): void {
  let bounds = sectionBounds(lines, section);
  if (!bounds && section !== null) {
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") lines.push("");
    lines.push(`[${section}]`);
    bounds = { start: lines.length, end: lines.length };
  }
  if (!bounds) return;

  const keyRe = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`);
  for (let i = bounds.start; i < bounds.end; i += 1) {
    const match = keyRe.exec(lines[i] ?? "");
    if (match) {
      lines[i] = `${match[1] ?? ""}${key} = ${value}`;
      return;
    }
  }

  let insertAt = bounds.end;
  while (insertAt > bounds.start && lines[insertAt - 1]?.trim() === "") insertAt -= 1;
  lines.splice(insertAt, 0, `${key} = ${value}`);
}

/** 纯函数：只合并本功能负责的 Codex 键。 */
export function mergeCodexToml(existing: string, config: CodexToolConfig): string {
  const normalized = existing.replace(/\r\n/g, "\n");
  const lines = normalized.length > 0 ? normalized.replace(/\n$/, "").split("\n") : [];

  upsertTomlKey(lines, null, "model_provider", tomlString(config.modelProvider));
  upsertTomlKey(lines, null, "disable_response_storage", String(config.disableResponseStorage));
  upsertTomlKey(lines, null, "network_access", tomlString(config.networkAccess));
  upsertTomlKey(lines, null, "windows_wsl_setup_acknowledged", String(config.windowsWslSetupAcknowledged));

  const providerSection = `model_providers.${config.modelProvider}`;
  upsertTomlKey(lines, providerSection, "name", tomlString(config.modelProvider));
  upsertTomlKey(lines, providerSection, "base_url", tomlString(config.baseUrl));
  upsertTomlKey(lines, providerSection, "wire_api", tomlString(config.wireApi));
  upsertTomlKey(lines, providerSection, "requires_openai_auth", String(config.requiresOpenaiAuth));
  upsertTomlKey(lines, "features", "goals", String(config.goals));

  return `${lines.join("\n")}\n`;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`现有文件不是有效 JSON，已拒绝覆盖：${path}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`现有 JSON 顶层必须是对象，已拒绝覆盖：${path}`);
  }
  return parsed as Record<string, unknown>;
}

function writeTextAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function writeJsonAtomic(path: string, value: Record<string, unknown>): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function buildClaudeEnv(config: ClaudeCodeToolConfig, secret: string): Record<string, string> {
  const values: Record<string, string> = {
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_DEFAULT_FABLE_MODEL: config.defaultFableModel,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: config.defaultFableModelName,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.defaultHaikuModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: config.defaultHaikuModelName,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.defaultOpusModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: config.defaultOpusModelName,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.defaultSonnetModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: config.defaultSonnetModelName,
    ANTHROPIC_MODEL: config.model,
    API_TIMEOUT_MS: config.apiTimeoutMs,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: config.disableNonessentialTraffic,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: config.experimentalAgentTeams,
    ENABLE_TOOL_SEARCH: config.enableToolSearch,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
}

export interface AppliedToolConfig {
  files: string[];
}

/** 合并配置并原子写入当前用户 home；payload 中的 secret 不写日志。 */
export function applyToolConfig(payload: WsToolConfigApplyPayload): AppliedToolConfig {
  const home = homedir();
  if (payload.tool === "codex") {
    const configPath = join(home, ".codex", "config.toml");
    const authPath = join(home, ".codex", "auth.json");
    const existingToml = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const auth = readJsonObject(authPath);
    const nextToml = mergeCodexToml(existingToml, payload.config);
    const nextAuth = { ...auth, OPENAI_API_KEY: payload.secret };

    writeTextAtomic(configPath, nextToml);
    writeJsonAtomic(authPath, nextAuth);
    return { files: ["~/.codex/config.toml", "~/.codex/auth.json"] };
  }

  const settingsPath = join(home, ".claude", "settings.json");
  const statePath = join(home, ".claude.json");
  const settings = readJsonObject(settingsPath);
  const state = readJsonObject(statePath);
  const currentEnv = settings.env;
  if (currentEnv !== undefined && (!currentEnv || typeof currentEnv !== "object" || Array.isArray(currentEnv))) {
    throw new Error(`现有 env 字段不是对象，已拒绝覆盖：${settingsPath}`);
  }
  const nextSettings = {
    ...settings,
    env: {
      ...((currentEnv as Record<string, unknown> | undefined) ?? {}),
      ...buildClaudeEnv(payload.config, payload.secret),
    },
  };
  const nextState = { ...state, hasCompletedOnboarding: payload.config.hasCompletedOnboarding };

  writeJsonAtomic(settingsPath, nextSettings);
  writeJsonAtomic(statePath, nextState);
  return { files: ["~/.claude/settings.json", "~/.claude.json"] };
}
