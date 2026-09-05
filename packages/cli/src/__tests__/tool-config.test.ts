import { describe, expect, it } from "vitest";
import type { ClaudeCodeToolConfig, CodexToolConfig } from "@maolinc/cc-loom-shared";
import { buildClaudeEnv, mergeCodexToml } from "../lib/tool-config.js";

const config: CodexToolConfig = {
  modelProvider: "OpenAI",
  disableResponseStorage: true,
  networkAccess: "enabled",
  windowsWslSetupAcknowledged: true,
  baseUrl: "https://gateway.example.com/v1",
  wireApi: "responses",
  requiresOpenaiAuth: true,
  goals: true,
};

describe("mergeCodexToml", () => {
  it("只替换负责的键，保留其它根键、section、注释和自定义字段", () => {
    const existing = `# user comment
model = "keep-model"
model_provider = "Legacy"
custom_root = 42

[model_providers.OpenAI]
name = "Legacy gateway"
base_url = "https://old.example.com/v1"
custom_header = "keep"

[features]
goals = false
other_feature = true

[mcp_servers.demo]
command = "keep-me"
`;
    const result = mergeCodexToml(existing, config);

    expect(result).toContain("# user comment");
    expect(result).toContain('model = "keep-model"');
    expect(result).toContain("custom_root = 42");
    expect(result).toContain('custom_header = "keep"');
    expect(result).toContain("other_feature = true");
    expect(result).toContain('[mcp_servers.demo]\ncommand = "keep-me"');
    expect(result).toContain('model_provider = "OpenAI"');
    expect(result).toContain('name = "OpenAI"');
    expect(result).toContain('base_url = "https://gateway.example.com/v1"');
    expect(result).toContain("goals = true");
    expect(result.match(/^model_provider\s*=/gm)).toHaveLength(1);
    expect(result.match(/^base_url\s*=/gm)).toHaveLength(1);
  });

  it("空文件会创建根配置、provider section 与 features section", () => {
    const result = mergeCodexToml("", config);
    expect(result).toContain('model_provider = "OpenAI"');
    expect(result).toContain("[model_providers.OpenAI]");
    expect(result).toContain('wire_api = "responses"');
    expect(result).toContain("[features]");
    expect(result).toContain("goals = true");
  });

  it("Claude 可选字段留空时不下发，避免覆盖设备现有设置", () => {
    const claude: ClaudeCodeToolConfig = {
      baseUrl: "https://gateway.example.com",
      defaultFableModel: "",
      defaultFableModelName: "",
      defaultHaikuModel: "",
      defaultHaikuModelName: "",
      defaultOpusModel: "",
      defaultOpusModelName: "",
      defaultSonnetModel: "",
      defaultSonnetModelName: "",
      model: "",
      apiTimeoutMs: "",
      disableNonessentialTraffic: "",
      experimentalAgentTeams: "",
      enableToolSearch: "",
      hasCompletedOnboarding: true,
    };
    expect(buildClaudeEnv(claude, "secret")).toEqual({
      ANTHROPIC_AUTH_TOKEN: "secret",
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
    });
  });
});
