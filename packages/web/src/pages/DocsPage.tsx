import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { ASSET_TYPE_LABELS, ASSET_TYPES, TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import type { AssetType, TargetTool } from "@maolinc/cc-loom-shared";
import ToolIcon from "../components/ToolIcon.js";

// ========== 数据：核心概念 ==========

const CONCEPTS = [
  { term: "能力（Asset）", desc: "最小可复用单元，分 Skill / Rule / MCP / Hook / Command / Agent 六类，每个能力包含若干文件和元信息。" },
  { term: "能力集（CapabilitySet）", desc: "多个能力的组合，是安装的单位。一个项目可同时安装多个能力集，能力叠加生效。" },
  { term: "订阅（Subscription）", desc: "项目与能力集之间的安装关系，每条订阅携带独立的同步策略（auto / locked）与目标工具。" },
  { term: "项目（Project）", desc: "通过 loom register 注册的本地项目目录。Agent 只能操作已注册项目，不会扫描你的整台电脑。" },
  { term: "设备（Device）", desc: "运行 loom start 的本机。Web 通过 WebSocket 与设备上的 Agent 通信。" },
  { term: "本地控制台", desc: "/console 页面，展示 Agent 扫描后的真实磁盘镜像：Loom 管理文件、外部文件、缺失文件，支持按订阅安装 / 卸载与单能力开关。" },
];

// ========== 数据：厂商目录规范 ==========

interface VendorSpec {
  tool: TargetTool;
  description: string;
  officialLinks: Array<{ label: string; url: string }>;
  tree: string;
}

const VENDOR_SPECS: VendorSpec[] = [
  {
    tool: "cursor",
    description: "项目级 .cursor/ 目录。Loom 当前分发 Skill、Rule、MCP、Command、Hook、Agent。Hook 注册表写入 .cursor/hooks.json（含 version:1，事件名映射为 Cursor camelCase）。",
    officialLinks: [
      { label: "Rules", url: "https://cursor.com/docs/rules" },
      { label: "MCP", url: "https://cursor.com/docs/mcp" },
      { label: "Hooks", url: "https://cursor.com/docs/hooks" },
      { label: "Subagents", url: "https://cursor.com/cn/docs/subagents" },
      { label: "Cursor Docs", url: "https://cursor.com/docs" },
    ],
    tree: `.cursor/
├── skills/          # 技能（每个技能是一个目录）
│   └── <name>/
│       └── SKILL.md
├── rules/           # 规则（行为约束）
│   └── <name>.md
├── commands/        # 斜杠命令（扁平，不支持子目录）
│   └── <name>.md
├── agents/          # 子代理
│   └── <name>.md
├── hooks/           # Hook 附属脚本目录
│   └── <name>/
│       └── *.sh
├── hooks.json       # Hook 注册表（含 version:1，事件名为 camelCase）
└── mcp.json         # MCP 服务配置（共享 JSON）
`,  },
  {
    tool: "codebuddy",
    description: "项目级 .codebuddy/ 目录。Loom 当前支持六类能力；Hook 注册表合并写入 settings.json。",
    officialLinks: [
      { label: "CodeBuddy 官方文档", url: "https://www.codebuddy.ai/docs/zh/ide/User-guide/Overview" },
      { label: "Rules / Skills / MCP / Hooks / Subagents / 斜杠命令", url: "https://www.codebuddy.ai/docs/zh/ide/User-guide/Overview" },
    ],
    tree: `.codebuddy/
├── skills/
│   └── <name>/
│       └── SKILL.md
├── rules/
│   └── <name>.md
├── commands/
│   └── <name>.md
├── agents/          # 子代理
│   └── <name>.md
├── hooks/           # Hook 附属脚本目录
│   └── <name>/
│       └── hook.sh
├── settings.json    # Hook 注册表
└── mcp.json`,
  },
  {
    tool: "codex",
    description: "项目级 .codex/ 目录。Loom 当前分发 Skill、Rule、MCP、Hook、Agent；Command（prompts）默认属于用户级目录，不分发。Agent 按 Codex 子代理规范落盘为 TOML。",
    officialLinks: [
      { label: "Customization", url: "https://developers.openai.ac.cn/codex/concepts/customization" },
      { label: "AGENTS.md", url: "https://developers.openai.ac.cn/codex/guides/agents-md" },
      { label: "Agents SDK / MCP", url: "https://developers.openai.ac.cn/codex/guides/agents-sdk" },
      { label: "Subagents", url: "https://developers.openai.com/codex/subagents" },
    ],
    tree: `.codex/
├── skills/
│   └── <name>/
│       └── SKILL.md
├── rules/
│   └── <name>.md
├── agents/          # 子代理（TOML）
│   └── <name>.toml
├── hooks/           # Hook 附属脚本目录
│   └── <name>/
│       └── hook.sh
├── hooks.json       # Hook 注册表
└── mcp.json

# Command（prompts）位于用户级目录
# ~/.codex/prompts/<name>.md  ← 超出项目级安全边界，不分发`,
  },
  {
    tool: "claudecode",
    description: "项目级 .claude/ 目录。Loom 当前支持六类能力；MCP 按 Claude Code 规范写到项目根 .mcp.json，而不是 .claude/ 内。",
    officialLinks: [
      { label: "扩展总览", url: "https://code.claude.com/docs/en/features-overview" },
      { label: "Skills", url: "https://code.claude.com/docs/en/skills" },
      { label: "MCP", url: "https://code.claude.com/docs/en/mcp" },
      { label: "Hooks", url: "https://code.claude.com/docs/en/hooks" },
      { label: "Subagents", url: "https://code.claude.com/docs/en/sub-agents" },
      { label: "Slash Commands", url: "https://code.claude.com/docs/en/agent-sdk/slash-commands" },
    ],
    tree: `.claude/
├── skills/
│   └── <name>/
│       └── SKILL.md
├── rules/
│   └── <name>.md
├── commands/        # 斜杠命令
│   └── <name>.md
├── agents/          # 子代理
│   └── <name>.md
└── hooks/
    ├── <name>/
    │   └── hook.sh
    └── hooks.json   # Hook 注册表

.mcp.json            # MCP 服务配置（项目根）`,
  },
];

// ========== 数据：兼容性矩阵（需与 @maolinc/cc-loom-shared ADAPTER_SUPPORT 保持一致）==========

const COMPATIBILITY: Record<AssetType, Record<TargetTool, boolean>> = {
  skill: { cursor: true, codebuddy: true, codex: true, claudecode: true },
  rule: { cursor: true, codebuddy: true, codex: true, claudecode: true },
  mcp: { cursor: true, codebuddy: true, codex: true, claudecode: true },
  hook: { cursor: true, codebuddy: true, codex: true, claudecode: true },
  command: { cursor: true, codebuddy: true, codex: false, claudecode: true },
  agent: { cursor: true, codebuddy: true, codex: true, claudecode: true },
};

// ========== 数据：安装路径表 ==========

const INSTALL_PATHS: Record<AssetType, Record<TargetTool, string>> = {
  skill: {
    cursor: ".cursor/skills/<name>/SKILL.md",
    codebuddy: ".codebuddy/skills/<name>/SKILL.md",
    codex: ".codex/skills/<name>/SKILL.md",
    claudecode: ".claude/skills/<name>/SKILL.md",
  },
  rule: {
    cursor: ".cursor/rules/<name>.md",
    codebuddy: ".codebuddy/rules/<name>.md",
    codex: ".codex/rules/<name>.md",
    claudecode: ".claude/rules/<name>.md",
  },
  mcp: {
    cursor: ".cursor/mcp.json",
    codebuddy: ".codebuddy/mcp.json",
    codex: ".codex/mcp.json",
    claudecode: ".mcp.json",
  },
  hook: {
    cursor: "—",
    codebuddy: ".codebuddy/hooks/<name>/... + .codebuddy/settings.json",
    codex: ".codex/hooks/<name>/... + .codex/hooks.json",
    claudecode: ".claude/hooks/<name>/... + .claude/hooks/hooks.json",
  },
  command: {
    cursor: ".cursor/commands/<name>.md",
    codebuddy: ".codebuddy/commands/<name>.md",
    codex: "—",
    claudecode: ".claude/commands/<name>.md",
  },
  agent: {
    cursor: ".cursor/agents/<name>.md",
    codebuddy: ".codebuddy/agents/<name>.md",
    codex: ".codex/agents/<name>.toml",
    claudecode: ".claude/agents/<name>.md",
  },
};

// ========== 数据：能力类型说明 ==========

const ASSET_DESCRIPTIONS: Record<AssetType, { summary: string; example: string }> = {
  skill: {
    summary: "面向 AI 工具的自然语言能力。每个 Skill 是一个目录，根部必须有 SKILL.md（含 name/description frontmatter），可附带脚本、参考文档等子文件/子目录，整体注入工具上下文。",
    example: "React 组件生成器、SQL 查询优化器、技术文档撰写助手。",
  },
  rule: {
    summary: "对 AI 行为的约束规范，用于固定团队风格、代码标准、安全规则等。",
    example: "TypeScript 严格模式规范、API 响应格式约束、提交信息模板。",
  },
  mcp: {
    summary: "Model Context Protocol 服务声明，让 AI 工具连接外部系统（数据库、API、文件系统等）。多个 Asset 合并写入同一个 mcp.json。",
    example: "GitHub MCP、PostgreSQL MCP、文件系统 MCP。",
  },
  hook: {
    summary: "事件驱动的可执行脚本，在工具特定事件点（PreToolUse、PostToolUse 等）自动运行。",
    example: "代码格式化 Hook、敏感命令拦截 Hook、自动测试 Hook。",
  },
  command: {
    summary: "用户显式调用的工作流模板（斜杠命令），通过 /command-name 触发，封装常用提示词和参数。",
    example: "/review、/deploy、/explain。",
  },
  agent: {
    summary: "具有独立上下文窗口和工具集的子代理，由主 AI 主动委派子任务，结果回传后不污染主会话。",
    example: "代码审查子代理、安全扫描子代理、调试子代理。",
  },
};

// ========== 数据：CLI 命令与连接步骤 ==========

/**
 * 连接步骤里的 login 命令需要带上当前服务端真实地址而不是 CLI 端的
 * `localhost:47474` 默认值——用户从远端 web 复制命令时该值才有意义。
 * 因此把命令构造放到组件里，运行时读 `window.location.origin`。
 */
function buildConnectSteps(endpoint: string) {
  return [
    { step: 1, label: "安装 CLI", cmd: "npm install -g @maolinc/cc-loom" },
    { step: 2, label: "登录（Token 在「设置 → 账号」页获取）", cmd: `loom login --endpoint ${endpoint} --token <token>` },
    { step: 3, label: "启动 Agent", cmd: "loom start" },
    { step: 4, label: "注册项目", cmd: "cd 项目目录 && loom register" },
  ];
}

const CLI_COMMANDS = [
  { cmd: "loom login", desc: "校验 Token 并写入本地配置" },
  { cmd: "loom logout", desc: "清除本地凭据（不影响服务端 Token）" },
  { cmd: "loom start", desc: "启动本地 Agent（默认后台守护进程，-f 前台实时显示连接状态）" },
  { cmd: "loom stop", desc: "停止本机正在运行的 Agent" },
  { cmd: "loom status", desc: "查看连接、设备、项目状态（离线可用，--json 便于脚本化）" },
  { cmd: "loom register", desc: "注册当前项目目录" },
  { cmd: "loom unregister", desc: "注销当前项目目录" },
  { cmd: "loom push", desc: "把本地厂商目录内容推送到平台，创建或覆盖一个能力集" },
  { cmd: "loom version", desc: "查看当前 CLI 版本" },
  { cmd: "loom update", desc: "更新 CLI 到最新版本" },
];

// ========== 目录配置 ==========

const SECTIONS = [
  { id: "quick-start", label: "快速开始" },
  { id: "concepts", label: "核心概念" },
  { id: "cli-commands", label: "CLI 命令" },
  { id: "subscriptions", label: "能力集与订阅" },
  { id: "sync-flow", label: "本地怎么同步" },
  { id: "asset-types", label: "能力类型" },
  { id: "sources", label: "能力来源" },
  { id: "env-config", label: "密钥与工具配置下发" },
  { id: "vendor-specs", label: "厂商目录规范" },
  { id: "compatibility", label: "兼容性矩阵" },
  { id: "install-paths", label: "安装路径" },
] as const;

// ========== 组件 ==========

export default function DocsPage() {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);
  const sectionsRef = useRef<Record<string, HTMLElement | null>>({});
  // endpoint 三级 fallback：
  //   1. server 启动时通过 LOOM_EXTERNAL_URL 注入的对外地址（GET /api/config）
  //   2. 浏览器当前 origin —— 同机访问时与上者重合
  //   3. CLI 默认端口 —— 仅 SSR 兜底
  const [endpoint, setEndpoint] = useState<string>(
    typeof window !== "undefined" ? window.location.origin : "http://localhost:47474",
  );
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        const url = body?.data?.externalUrl as string | null | undefined;
        if (url && typeof url === "string") setEndpoint(url);
      })
      .catch(() => {
        // 接口失败时保留 window.location.origin 兜底，无需提示
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const connectSteps = buildConnectSteps(endpoint);

  // 滚动监听：根据视口顶部最接近的 section 高亮
  useEffect(() => {
    function onScroll() {
      const offset = 120; // 顶部偏移（导航 + 一点空白）
      let current = SECTIONS[0].id as string;
      for (const s of SECTIONS) {
        const el = sectionsRef.current[s.id];
        if (!el) continue;
        if (el.getBoundingClientRect().top <= offset) {
          current = s.id;
        }
      }
      setActiveId(current);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollTo = (id: string) => {
    sectionsRef.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div>
      <header className="mb-7">
        <h1 className="text-[26px] leading-8 font-bold text-text-primary tracking-tight">文档</h1>
        <p className="text-sm text-text-muted mt-1.5">
          CLI 接入、核心概念、订阅与同步、能力来源、厂商目录规范与兼容性参考。
        </p>
      </header>
      <div className="flex gap-8">
      {/* 左侧目录 */}
      <aside className="w-56 shrink-0">
        <nav className="sticky top-20 space-y-0.5">
          <h3 className="text-xs font-semibold text-text-muted mb-2 px-3">
            目录
          </h3>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => scrollTo(s.id)}
              className={`block w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                activeId === s.id
                  ? "bg-brand-50 text-brand font-medium"
                  : "text-text-secondary hover:bg-surface-card hover:text-text-primary"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* 右侧内容 */}
      <article className="flex-1 max-w-3xl pb-32 space-y-12">
        <Section
          id="quick-start"
          title="快速开始"
          register={(el) => (sectionsRef.current["quick-start"] = el)}
        >
          <p className="text-sm text-text-secondary mb-4">
            完成下面 4 步即可把本地项目接入 Loom，安装来自能力市场的 CapabilitySet。
          </p>
          <ol className="space-y-3">
            {connectSteps.map(({ step, label, cmd }) => (
              <li key={step} className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-brand-soft text-brand text-xs flex items-center justify-center font-semibold shrink-0 mt-0.5">
                  {step}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary mb-1">{label}</p>
                  <CodeWithCopy code={cmd} />
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-6 p-3 rounded-lg bg-surface-card text-xs text-text-muted">
            当前服务端 Endpoint：<code className="text-text-secondary">{endpoint}</code>
          </div>
        </Section>

        <Section
          id="concepts"
          title="核心概念"
          register={(el) => (sectionsRef.current["concepts"] = el)}
        >
          <p className="text-sm text-text-secondary mb-4">
            理解这六个词，就看懂了 Loom 的全貌：平台保存清单，本机保存文件。
          </p>
          <table className="w-full text-xs border-collapse">
            <tbody>
              {CONCEPTS.map(({ term, desc }) => (
                <tr key={term} className="border-b border-gray-50 align-top">
                  <td className="py-2.5 pr-4 text-text-primary font-medium whitespace-nowrap">{term}</td>
                  <td className="py-2.5 text-text-secondary leading-relaxed">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section
          id="cli-commands"
          title="CLI 命令"
          register={(el) => (sectionsRef.current["cli-commands"] = el)}
        >
          <p className="text-sm text-text-secondary mb-4">
            CLI 是设备上的本地 Agent 入口，配置存放于 <code className="text-text-primary">~/.loom/</code>。
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-sunken">
                <th className="text-left py-2 pr-4 text-xs font-semibold text-text-muted uppercase">命令</th>
                <th className="text-left py-2 text-xs font-semibold text-text-muted uppercase">说明</th>
              </tr>
            </thead>
            <tbody>
              {CLI_COMMANDS.map(({ cmd, desc }) => (
                <tr key={cmd} className="border-b border-gray-50">
                  <td className="py-2 pr-4">
                    <code className="text-brand font-medium text-xs whitespace-nowrap">{cmd}</code>
                  </td>
                  <td className="py-2 text-text-secondary text-xs">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <Section
          id="subscriptions"
          title="能力集与订阅"
          register={(el) => (sectionsRef.current["subscriptions"] = el)}
        >
          <p className="text-sm text-text-secondary leading-relaxed mb-4">
            安装一个能力集，本质是在项目和它之间建立一条「订阅」。一个项目可以同时拥有多条订阅，
            能力取并集叠加生效；每条订阅的同步策略和目标工具独立可调。
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <FlowCard
              title="多能力集叠加"
              items={[
                "一个项目可同时安装多个能力集，本地控制台为每条订阅展示一张卡片。",
                "同一能力被多个能力集引用时共享单例，按 (能力 × 厂商) 引用计数。",
                "卸载某条订阅时，只有不再被任何订阅引用的能力才会撤掉文件。",
              ]}
            />
            <FlowCard
              title="逐订阅同步策略"
              items={[
                "auto：能力内容或能力集成员变化后，自动推送到在线项目。",
                "locked：保持本地文件不变，直到手动重装或切回 auto。",
                "策略挂在订阅上，切换某一条不影响项目的其它订阅。",
              ]}
            />
            <FlowCard
              title="同名撞车要裁决"
              items={[
                "同名不同内容的能力会写到相同落盘路径，Loom 不会静默覆盖。",
                "安装计划会列出冲突清单，逐条选择「跳过」后才能执行。",
                "跳过只是本次不装，之后可以重装补齐。",
              ]}
            />
            <FlowCard
              title="单独添加的能力"
              items={[
                "不必为了装一个能力而创建能力集：可直接把单项能力添加到项目。",
                "它在控制台呈现为「单独添加的能力」分组，同步策略独立可调。",
                "目标工具跟随项目的有效厂商集合。",
              ]}
            />
          </div>
        </Section>

        <Section
          id="sync-flow"
          title="平台改了，本地项目怎么跟着变？"
          register={(el) => (sectionsRef.current["sync-flow"] = el)}
        >
          <p className="text-sm text-text-secondary leading-relaxed mb-4">
            你可以把 Loom 理解成「平台保存清单，本机保存文件」。平台里的能力和能力集只是清单；
            真正给 Cursor、CodeBuddy、Codex、Claude Code 使用的文件，仍然写在你的项目目录里。
          </p>

          <div className="grid gap-3 md:grid-cols-3 mb-5">
            <SimpleStep
              step="1"
              title="平台保存清单"
              text="能力是具体内容，能力集是一组能力。你在网页上创建、编辑、组合它们。"
            />
            <SimpleStep
              step="2"
              title="本机负责写文件"
              text="运行 loom start 后，本机小助手会接收安装指令，把文件写到 .cursor、.codebuddy 等目录。"
            />
            <SimpleStep
              step="3"
              title="控制台显示结果"
              text="本地控制台看到的是本机扫描后的真实文件状态：哪些是 Loom 写的、哪些是你自己放的、哪些丢了。"
            />
          </div>

          <div className="rounded-xl border border-surface-sunken bg-surface-card p-4 mb-5 overflow-x-auto">
            <pre className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">{`最常见的一次安装：

你在网页点击「安装」
  → Loom 先列出将要写入哪些文件
  → 你确认
  → 本机小助手写入项目目录
  → 小助手重新检查本地文件
  → 本地控制台刷新显示`}</pre>
          </div>

          <div className="grid gap-3 md:grid-cols-2 mb-5">
            <FlowCard
              title="我改了一个能力，会发生什么？"
              items={[
                "如果项目对该能力所在订阅选择了「自动同步」，并且本机小助手在线，Loom 会把新内容推到本机。",
                "本机只覆盖 Loom 管理的那部分文件，不会主动删除你自己放进去的其他文件。",
                "写完后，本地控制台会自动刷新，显示最新结果。",
                "如果订阅选择了「锁定」，不会自动更新；你需要手动重新安装。",
              ]}
            />
            <FlowCard
              title="我改了一个能力集，会发生什么？"
              items={[
                "能力集可以理解成一套能力清单。",
                "你给能力集加了能力：自动同步的订阅会补上新增文件。",
                "你从能力集移除了能力：自动同步的订阅会移除 Loom 之前写入的对应文件。",
                "如果本机不在线，网页会先显示最后一次看到的状态。",
              ]}
            />
            <FlowCard
              title="本地控制台能做什么？"
              items={[
                "点「刷新本地」：让本机重新检查一次项目目录。",
                "点「+ 添加能力集」：给项目再装一套能力集，能力叠加生效。",
                "卸载某条订阅：只撤掉不再被其它订阅引用的能力文件。",
                "点「添加能力」：只给当前项目补装一个或几个能力。",
                "关闭某个能力：先临时移走它的文件；重新开启时再恢复。",
              ]}
            />
            <FlowCard
              title="本机文件被我手动改了怎么办？"
              items={[
                "本地控制台会把不是 Loom 写的文件标成「外部文件」。",
                "如果 Loom 记录中应该存在的文件被你删掉，会显示「缺失」。",
                "如果一整套 Loom 文件都没了，系统会自动认为这个项目已经失效安装，并清掉记录。",
                "这不会扫描你的整个电脑，只检查已注册项目里的 AI 工具目录。",
              ]}
            />
          </div>

          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 pr-3 font-semibold text-text-muted uppercase">控制台里的词</th>
                <th className="text-left py-2 pr-3 font-semibold text-text-muted uppercase">大白话解释</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-50">
                <td className="py-2 pr-3 text-text-primary font-medium">Loom 文件</td>
                <td className="py-2 pr-3 text-text-secondary">Loom 安装时写进去的文件，后续卸载、切换、自动同步会管理它。</td>
              </tr>
              <tr className="border-b border-gray-50">
                <td className="py-2 pr-3 text-text-primary font-medium">外部文件</td>
                <td className="py-2 pr-3 text-text-secondary">你或其他工具自己放进去的文件，Loom 只展示，不会主动删除。</td>
              </tr>
              <tr className="border-b border-gray-50">
                <td className="py-2 pr-3 text-text-primary font-medium">缺失</td>
                <td className="py-2 pr-3 text-text-secondary">Loom 记得自己写过这个文件，但现在磁盘上找不到了。</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 text-text-primary font-medium">自动同步 / 锁定</td>
                <td className="py-2 pr-3 text-text-secondary">按订阅生效：自动同步跟随平台更新；锁定保持当前本地文件，直到你手动安装。</td>
              </tr>
            </tbody>
          </table>
        </Section>

        <Section
          id="asset-types"
          title="能力类型"
          register={(el) => (sectionsRef.current["asset-types"] = el)}
        >
          <p className="text-sm text-text-secondary mb-4">
            Loom 支持 6 类核心 Asset，每一类对应 AI 工具的一种原生能力概念。
          </p>
          <div className="space-y-4">
            {ASSET_TYPES.map((type) => (
              <div key={type} className="border border-surface-sunken rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <TypeBadge type={type} />
                </div>
                <p className="text-sm text-text-secondary leading-relaxed mb-2">
                  {ASSET_DESCRIPTIONS[type].summary}
                </p>
                <p className="text-xs text-text-muted">
                  例如：{ASSET_DESCRIPTIONS[type].example}
                </p>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="sources"
          title="能力从哪来：Marketplace 与 loom push"
          register={(el) => (sectionsRef.current["sources"] = el)}
        >
          <p className="text-sm text-text-secondary leading-relaxed mb-5">
            除了手动创建，能力还有两条进入平台的路径：管理员配置的 Git 来源持续导入，
            以及任何用户把本地厂商目录反向推送上来。两条路径共用同一套解析逻辑，
            同一份能力无论从哪条路进来，身份都一致。
          </p>

          <div className="grid gap-3 md:grid-cols-2 mb-5">
            <FlowCard
              title="Marketplace：Git 来源导入（管理员）"
              items={[
                "在「设置 → 数据来源」添加 Git 仓库地址，支持 claude-code-marketplace、claude-code-plugin、generic-git 三种来源类型。",
                "服务端定期 clone / fetch，解析其中的能力和 plugin 能力集并自动更新到平台。",
                "每次同步记录日志（新增 / 更新 / 移除 / 耗时 / 错误），轮询间隔可在设置页调整。",
                "安全边界：远程地址仅接受不含凭据的 HTTPS，且域名必须只解析到公网地址。",
              ]}
            />
            <FlowCard
              title="loom push：本地反哺平台"
              items={[
                "把本地 .cursor / .codebuddy / .codex / .claude 目录的内容推送为一个能力集。",
                "默认命名为 用户名/项目目录名，可用 --name 自定义，--visibility 控制可见性（默认 private）。",
                "多厂商目录存在时交互选择，也可用 --tool 直接指定。",
                "同名能力集再次 push 即覆盖成员；来自 Marketplace 的同名能力集会被拒绝，防止误伤导入内容。",
              ]}
            />
          </div>

          <div className="rounded-xl border border-surface-sunken bg-surface-card p-4 overflow-x-auto">
            <pre className="text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">{`cd ~/my-project
loom push --tool claudecode --name my-team/backend-standards`}</pre>
          </div>
        </Section>

        <Section
          id="env-config"
          title="密钥与工具配置下发"
          register={(el) => (sectionsRef.current["env-config"] = el)}
        >
          <p className="text-sm text-text-secondary leading-relaxed mb-5">
            部分能力需要鉴权（比如调用 GitHub API 的 MCP），AI 工具本身也需要账号配置。
            Loom 把这两类敏感信息集中加密保管，按需下发到在线设备——REST 接口永不返回明文。
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <FlowCard
              title="环境变量密钥"
              items={[
                "能力编辑页声明鉴权方式（免鉴权 / 环境变量），「设置 → 环境变量」维护 key→value 密钥对。",
                "值用 AES-256-GCM 加密存储，接口只返回是否已配置。",
                "下发到在线设备：Linux 写 ~/.bashrc，macOS 写 ~/.zshrc，Windows 用 setx。",
                "支持按环境变量或按设备回收；正在运行的 IDE 需重启才能读到新变量，新开 shell 立即生效。",
              ]}
            />
            <FlowCard
              title="Codex / Claude Code 配置档"
              items={[
                "「设置 → AI 工具配置」维护多套用户级配置档（加密凭据 + Base URL + 模型映射等）。",
                "Codex 写 ~/.codex/config.toml 与 auth.json；Claude Code 写 ~/.claude/settings.json 与 ~/.claude.json。",
                "对已存在的配置文件做字段级合并，不删除未管理的字段。",
                "现有配置无法解析时拒绝覆盖，避免破坏你的既有配置。",
              ]}
            />
          </div>
          <p className="text-xs text-text-muted mt-4">
            两类下发都只处理在线设备，离线设备不会收到，也不会排队补发。
          </p>
        </Section>

        <Section
          id="vendor-specs"
          title="厂商目录规范"
          register={(el) => (sectionsRef.current["vendor-specs"] = el)}
        >
          <p className="text-sm text-text-secondary mb-4">
            Loom 通过 Adapter 将能力适配到各 AI 工具的标准目录布局，下列是当前支持的四家厂商规范。
          </p>
          <div className="space-y-6">
            {VENDOR_SPECS.map((spec) => (
              <div key={spec.tool}>
                <h3 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-1.5">
                  <ToolIcon tool={spec.tool} size={18} />
                </h3>
                <p className="text-xs text-text-muted mb-2 leading-relaxed">{spec.description}</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  {spec.officialLinks.map((link) => (
                    <a
                      key={`${spec.tool}-${link.label}`}
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:border-brand/30 hover:text-brand transition-colors"
                    >
                      {link.label}
                      <span className="ml-1 text-text-muted" aria-hidden="true">↗</span>
                    </a>
                  ))}
                </div>
                <pre className="text-xs bg-surface-card rounded-lg p-3 overflow-x-auto text-text-secondary leading-relaxed">
                  {spec.tree}
                </pre>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="compatibility"
          title="兼容性矩阵"
          register={(el) => (sectionsRef.current["compatibility"] = el)}
        >
          <p className="text-sm text-text-secondary mb-4 flex flex-wrap items-center gap-1.5">
            <Check className="w-4 h-4 text-mcp-green-text shrink-0" />
            表示该 Adapter 原生支持此类 Asset；
            <X className="w-4 h-4 text-text-muted shrink-0" />
            表示安装时跳过并在 diff 中提示，跳过不视为安装失败。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-text-muted uppercase">类型</th>
                  {TARGET_TOOLS.map((t) => (
                    <th key={t} className="text-center py-2 px-3 text-xs font-semibold text-text-muted uppercase">
                      <span className="inline-flex justify-center"><ToolIcon tool={t} size={16} /></span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ASSET_TYPES.map((type) => (
                  <tr key={type} className="border-b border-gray-50">
                    <td className="py-2 px-3">
                      <TypeBadge type={type} />
                    </td>
                    {TARGET_TOOLS.map((t) => (
                      <td key={t} className="text-center py-2 px-3">
                        {COMPATIBILITY[type][t] ? (
                          <Check className="w-4 h-4 text-mcp-green-text mx-auto" aria-label="原生支持" />
                        ) : (
                          <X className="w-4 h-4 text-text-muted mx-auto" aria-label="不支持，安装时跳过" />
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-4 space-y-1.5 text-xs text-text-secondary">
            <li>• <strong className="text-text-primary">Cursor × Hook</strong>：Cursor hook 事件名为 camelCase（与 Claude Code 的 PascalCase 不同），Loom 在落盘时映射；Claude Code 中 Cursor 无对应的事件（如 Setup、PostCompact、Notification 等）不会分发到 Cursor。</li>
            <li>• <strong className="text-text-primary">Cursor × Agent</strong>：Cursor 支持项目级子代理，落盘到 .cursor/agents/&lt;name&gt;.md（与官方 subagents 文档一致）。</li>
            <li>• <strong className="text-text-primary">Codex × Command</strong>：Codex prompts 位于用户级 <code>~/.codex/prompts/</code>，超出项目级安全边界。</li>
            <li>• <strong className="text-text-primary">Codex × Agent</strong>：Codex 子代理使用 TOML 格式（<code>.codex/agents/&lt;name&gt;.toml</code>），Loom 在落盘时把 Markdown 指令正文转写为 <code>name</code> / <code>description</code> / <code>developer_instructions</code> 三段（与官方 subagents 文档一致）。</li>
          </ul>
        </Section>

        <Section
          id="install-paths"
          title="安装路径"
          register={(el) => (sectionsRef.current["install-paths"] = el)}
        >
          <p className="text-sm text-text-secondary mb-4">
            每类 Asset 在不同目标工具下的具体写入路径。<code>—</code> 表示该组合不支持。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 font-semibold text-text-muted uppercase">类型</th>
                  {TARGET_TOOLS.map((t) => (
                    <th key={t} className="text-left py-2 px-3 font-semibold text-text-muted uppercase">
                      <ToolIcon tool={t} size={16} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ASSET_TYPES.map((type) => (
                  <tr key={type} className="border-b border-gray-50 align-top">
                    <td className="py-2 px-3">
                      <TypeBadge type={type} />
                    </td>
                    {TARGET_TOOLS.map((t) => {
                      const path = INSTALL_PATHS[type][t];
                      return (
                        <td key={t} className="py-2 px-3">
                          {path === "—" ? (
                            <span className="text-text-muted">—</span>
                          ) : (
                            <code className="text-text-secondary">{path}</code>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </article>
      </div>
    </div>
  );
}

// ========== 子组件 ==========

function FlowCard({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-surface-sunken bg-white p-4">
      <h3 className="text-sm font-semibold text-text-primary mb-2">{title}</h3>
      <ol className="space-y-1.5 text-xs text-text-secondary leading-relaxed list-decimal pl-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
    </div>
  );
}

function SimpleStep({ step, title, text }: { step: string; title: string; text: string }) {
  return (
    <div className="rounded-xl border border-surface-sunken bg-white p-4">
      <div className="w-7 h-7 rounded-full bg-brand-soft text-brand text-xs font-semibold grid place-items-center mb-3">
        {step}
      </div>
      <h3 className="text-sm font-semibold text-text-primary mb-1">{title}</h3>
      <p className="text-xs text-text-secondary leading-relaxed">{text}</p>
    </div>
  );
}

function Section({
  id,
  title,
  register,
  children,
}: {
  id: string;
  title: string;
  register: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  return (
    <section id={id} ref={register} className="scroll-mt-20">
      <h2 className="text-xl font-bold text-text-primary mb-4">{title}</h2>
      {children}
    </section>
  );
}

function TypeBadge({ type }: { type: AssetType }) {
  const colorClass: Record<AssetType, string> = {
    skill: "bg-skill-blue-bg text-skill-blue-text",
    rule: "bg-rule-yellow-bg text-rule-yellow-text",
    mcp: "bg-mcp-green-bg text-mcp-green-text",
    hook: "bg-hook-purple-bg text-hook-purple-text",
    command: "bg-command-cyan-bg text-command-cyan-text",
    agent: "bg-agent-coral-bg text-agent-coral-text",
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${colorClass[type]}`}>
      {ASSET_TYPE_LABELS[type]}
    </span>
  );
}

function CodeWithCopy({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 text-xs bg-surface-sunken px-2 py-1 rounded text-text-secondary select-all overflow-x-auto whitespace-nowrap">
        {code}
      </code>
      <button
        onClick={onCopy}
        className="text-xs text-brand hover:underline shrink-0"
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}
