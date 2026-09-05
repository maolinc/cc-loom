/**
 * L3 真实链路：工具配置档 → 指定在线设备 → WS → 用户 home 文件字段级合并。
 *
 * 不变量：
 * - Secret 明文不从列表 REST 返回；只有下发时送到 Agent。
 * - 文件不存在可创建；文件存在时 Codex TOML / JSON 与 Claude JSON 的其它字段保留。
 * - 同一设备同一工具重复下发会切换配置档，分发记录只指向最后成功的一套。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ApiClient,
  cleanupProject,
  makeProject,
  startAgent,
  startServer,
  stopAgent,
  stopServer,
  type AgentHandle,
  type ServerHandle,
} from "@maolinc/cc-loom-testkit";

const paths = [
  join(homedir(), ".codex", "config.toml"),
  join(homedir(), ".codex", "auth.json"),
  join(homedir(), ".claude", "settings.json"),
  join(homedir(), ".claude.json"),
];

const codexConfig = (baseUrl: string) => ({
  modelProvider: "OpenAI",
  disableResponseStorage: true,
  networkAccess: "enabled" as const,
  windowsWslSetupAcknowledged: true,
  baseUrl,
  wireApi: "responses" as const,
  requiresOpenaiAuth: true,
  goals: true,
});

const claudeConfig = {
  baseUrl: "https://claude-gateway.example.com",
  defaultFableModel: "k3[1M]",
  defaultFableModelName: "k3",
  defaultHaikuModel: "k3",
  defaultHaikuModelName: "k3",
  defaultOpusModel: "k3[1M]",
  defaultOpusModelName: "k3",
  defaultSonnetModel: "glm-5.2[1M]",
  defaultSonnetModelName: "glm-5.2",
  model: "k3",
  apiTimeoutMs: "3000000",
  disableNonessentialTraffic: "1",
  experimentalAgentTeams: "1",
  enableToolSearch: "true",
  hasCompletedOnboarding: true,
};

describe("L3 tool config profiles", () => {
  let server: ServerHandle;
  let agent: AgentHandle | null;
  let projectRoot: string | null;
  let backups: Map<string, Buffer | null>;

  beforeEach(() => {
    agent = null;
    projectRoot = null;
    backups = new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
  });

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
    for (const [path, backup] of backups) {
      if (backup) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, backup);
      } else if (existsSync(path)) {
        rmSync(path, { force: true });
      }
    }
  });

  it("保留未管理字段并支持 Codex 配置档切换与 Claude 配置下发", async () => {
    server = await startServer();
    const api = new ApiClient(server.baseUrl);
    await api.login("tool-config@example.com");
    const token = await api.getCliToken();
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot,
      isOnline: async () => (await api.listDevices()).some((device) => device.status === "online"),
    });
    const device = (await api.listDevices()).find((item) => item.status === "online")!;

    mkdirSync(dirname(paths[0]!), { recursive: true });
    writeFileSync(paths[0]!, `# keep-comment\nmodel = "keep-model"\nmodel_provider = "Legacy"\n\n[model_providers.OpenAI]\ncustom_header = "keep"\nbase_url = "https://old.example.com/v1"\n\n[features]\nother_feature = true\n`);
    writeFileSync(paths[1]!, JSON.stringify({ refresh_token: "keep", OPENAI_API_KEY: "old" }, null, 2));
    mkdirSync(dirname(paths[2]!), { recursive: true });
    writeFileSync(paths[2]!, JSON.stringify({ permissions: { allow: ["Bash(*)"] }, env: { KEEP_ME: "yes" } }, null, 2));
    writeFileSync(paths[3]!, JSON.stringify({ numStartups: 7, hasCompletedOnboarding: false }, null, 2));

    const first = await api.createToolConfigProfile({
      name: "Codex A", tool: "codex", config: codexConfig("https://a.example.com/v1"), secret: "sk-a-secret",
    });
    const listedText = JSON.stringify(await api.listToolConfigProfiles());
    expect(listedText).not.toContain("sk-a-secret");
    expect(first.secretConfigured).toBe(true);

    const firstPush = await api.distributeToolConfigProfile(first.id, [device.id]);
    expect(firstPush.pushed).toEqual([device.id]);
    expect(readFileSync(paths[0]!, "utf8")).toContain('base_url = "https://a.example.com/v1"');
    expect(readFileSync(paths[0]!, "utf8")).toContain('model = "keep-model"');
    expect(readFileSync(paths[0]!, "utf8")).toContain('custom_header = "keep"');
    expect(JSON.parse(readFileSync(paths[1]!, "utf8"))).toEqual({ refresh_token: "keep", OPENAI_API_KEY: "sk-a-secret" });

    const second = await api.createToolConfigProfile({
      name: "Codex B", tool: "codex", config: codexConfig("https://b.example.com/v1"), secret: "sk-b-secret",
    });
    await api.distributeToolConfigProfile(second.id, [device.id]);
    expect(readFileSync(paths[0]!, "utf8")).toContain('base_url = "https://b.example.com/v1"');
    expect(JSON.parse(readFileSync(paths[1]!, "utf8")).OPENAI_API_KEY).toBe("sk-b-secret");
    const afterSwitch = await api.listToolConfigDistributions();
    expect(afterSwitch.filter((item) => item.tool === "codex" && item.deviceId === device.id)).toEqual([
      expect.objectContaining({ profileId: second.id }),
    ]);

    const claude = await api.createToolConfigProfile({
      name: "Claude K3", tool: "claudecode", config: claudeConfig, secret: "claude-secret",
    });
    await api.distributeToolConfigProfile(claude.id, [device.id]);
    const settings = JSON.parse(readFileSync(paths[2]!, "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Bash(*)"] });
    expect(settings.env).toMatchObject({
      KEEP_ME: "yes",
      ANTHROPIC_AUTH_TOKEN: "claude-secret",
      ANTHROPIC_BASE_URL: "https://claude-gateway.example.com",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2[1M]",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    });
    expect(JSON.parse(readFileSync(paths[3]!, "utf8"))).toEqual({ numStartups: 7, hasCompletedOnboarding: true });
  });
});
