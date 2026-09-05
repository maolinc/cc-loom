/**
 * @maolinc/cc-loom-testkit — Docker 化测试框架。
 *
 * 提供 L3 真实链路测试的基础设施:
 * - server-runner: 启停真实 server 进程
 * - agent-runner: 启停真实 cli agent
 * - project-sandbox: 临时项目目录
 * - api-client: HTTP API 客户端（复用 @maolinc/cc-loom-shared 类型）
 * - assertions: 磁盘 / lock 断言
 * - fixtures: fixture 加载器 + asset 构造器
 */
export { SERVER_BIN, CLI_BIN, FIXTURES_DIR, LOOM_HOME, MARKETPLACE_FIXTURES_DIR, FIXTURE_GENERIC, FIXTURE_CC_PLUGIN, FIXTURE_CC_SELF_URL, FIXTURE_EMPTY } from "./env.js";
export { startServer, stopServer, type ServerHandle } from "./server-runner.js";
export { startAgent, stopAgent, runCli, type AgentHandle } from "./agent-runner.js";
export { makeProject, cleanupProject } from "./project-sandbox.js";
export { ApiClient, ApiRequestError } from "./api-client.js";
export {
  expectFileExists,
  expectFileNotExists,
  expectFileContains,
  expectFileContent,
  expectFileSet,
  listFiles,
  readLock,
  expectLock,
  expectNoLock,
  expectLockVendorState,
  expectNoProjectTraces,
} from "./assertions.js";
export { loadSeed, loadExpected, assetBuilders, type ExpectedFile } from "./fixtures.js";
export { createGitFixture, type GitFixture } from "./git-fixture.js";
export { FakeAgent, type CapturedReq, type FakeAgentOptions } from "./fake-agent.js";
export {
  startFakeEmbedding,
  type FakeEmbeddingHandle,
  type FakeEmbeddingOptions,
  type FakeEmbeddingMode,
  type CapturedEmbeddingRequest,
} from "./fake-embedding.js";
export {
  startFakeChat,
  DEFAULT_FAKE_CHAT_CONTENT,
  type FakeChatHandle,
  type FakeChatOptions,
  type FakeChatMode,
  type CapturedChatRequest,
} from "./fake-ai-chat.js";
