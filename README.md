# Loom

> 面向 AI 编程工具的能力管理平台：在 Web 上统一管理 Skill / Rule / MCP / Hook / Command / Agent 六类能力，组合成工作空间，一键安装到本地的 Cursor、CodeBuddy、Codex、Claude Code 项目。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen)](./package.json)
[![pnpm workspace](https://img.shields.io/badge/monorepo-pnpm%20workspace-f69220)](./pnpm-workspace.yaml)

## 解决什么问题

用 AI 编程工具时，你会在项目里积累大量 `SKILL.md`、规则文件、MCP 配置、Hook 脚本……这些能力散落在各个项目的 `.cursor/`、`.claude/` 等目录里，难以复用、难以同步、难以在团队间共享。

Loom 把它们变成可注册、可组合、可安装的能力单元：

- **一处管理，多端复用** —— 在 Web 上维护能力的源文件，按需组合安装到任意本地项目。
- **多工具适配** —— 同一份能力，自动转换写入 Cursor / CodeBuddy / Codex / Claude Code 各自的目录结构与配置格式。
- **本地安全写入** —— 文件由你本机运行的 Agent 写入，服务端不直接触碰你的项目目录。
- **变更自动同步** —— 能力或工作空间更新后，auto 策略的订阅会尽力推送到在线项目。
- **双向流动** —— `loom push` 把本地厂商目录反向发布到平台；Marketplace 定时从外部 Git 仓库导入能力。

## 工作原理

```
浏览器 (React SPA)
    │  HTTP REST
    ▼
Fastify Server  ─── SQLite (loom.db)        ← 平台保存「清单」：能力内容 + 工作空间组合
    │  WebSocket
    ▼
CLI Agent (loom start)                       ← 本机负责写文件
    │  文件读写（仅限已注册项目）
    ▼
本地项目目录 (.cursor/ .codebuddy/ .codex/ .claude/)
```

服务端只保存清单；真正给 AI 工具使用的文件由本机 Agent 落盘。Web 中的本地控制台（`/console`）展示 Agent 扫描后的真实磁盘镜像：哪些是 Loom 管理的文件、哪些是外部文件、哪些缺失。

## 核心概念

| 概念 | 说明 |
|------|------|
| **能力（Asset）** | 最小可复用单元，分六类：Skill、Rule、MCP、Hook、Command、Agent。每个能力包含若干文件和元信息。 |
| **工作空间（Workspace）** | 多个能力的组合，是安装的单位。一个项目可同时安装多个工作空间，能力叠加生效。 |
| **订阅（Subscription）** | 项目与工作空间之间的安装关系，携带独立的同步策略与目标工具。 |
| **目标工具（Target Tool）** | 能力最终写入的 AI 工具目录：Cursor、CodeBuddy、Codex、Claude Code。 |
| **项目（Project）** | 通过 `loom register` 注册的本地项目目录。Agent 只能操作已注册项目。 |
| **设备（Device）** | 运行 `loom start` 的本机。Web 通过 WebSocket 与设备上的 Agent 通信。 |

## 快速开始

需要 Node.js ≥ 20。

### 1. 安装并启动服务端

```bash
npm install --global @maolinc/cc-loom-server

LOOM_ADMIN_EMAIL=admin@example.com \
LOOM_ADMIN_PASSWORD='replace-with-a-long-unique-password' \
loom-server
```

服务端默认仅监听 `http://127.0.0.1:47474`，首次启动自动创建 SQLite 数据库和上面指定的管理员，并托管 Web 控制台。密码要求 6–128 位；代码中不含默认账号或密码。管理员创建后，后续启动可不再提供这两个变量。

服务端包的命令是 `loom-server`；可用 `PORT` / `HOST` 环境变量改监听地址。也可以用 `npx @maolinc/cc-loom-server` 临时运行。

### 2. 登录 Web

先使用启动时指定的管理员邮箱和密码登录。其他新邮箱仍可自动注册，但会直接使用登录表单中提交的 6–128 位密码；公开部署前建议管理员开启注册白名单或用户上限。

### 3. 安装 CLI 并登录本机

在 Web「设置 → 账号」里获取 CLI Token（格式 `prsm_...`），然后在本地终端：

```bash
npm install --global @maolinc/cc-loom
loom login --endpoint http://localhost:47474 --token <你的 token>
```

凭据写入 `~/.loom/config.json`。Token 可在 Web 上重新生成（旧 token 随即失效）。

### 4. 注册项目并启动 Agent

进入你的项目目录：

```bash
cd ~/my-project
loom register        # 注册当前目录为 Loom 项目
loom start           # 启动本地 Agent（默认后台运行，-f 前台实时显示连接状态）
```

`loom register` 会自动检测项目里已有的 `.cursor/` / `.codebuddy/` / `.codex/` / `.claude/` 目录作为默认目标工具。

### 5. 在 Web 上组合能力并安装

1. 在「能力」页面创建或导入能力（支持手动编辑、上传文件 / 文件夹、MCP JSON 模板，也可调用 AI 辅助生成别名 / 标签 / 描述）。
2. 在「工作空间」页面把若干能力组合成一个工作空间。
3. 在「项目」页面对已注册项目执行安装，选择目标工具与同步策略。

安装完成后，对应能力文件会出现在项目的 `.cursor/`、`.claude/` 等目录中，立即生效。

## 能力类型 × 目标工具

| 能力类型 | 用途 | Cursor | CodeBuddy | Codex | Claude Code |
|----------|------|:------:|:---------:|:-----:|:-----------:|
| Skill | 目录型自然语言能力 | ✅ | ✅ | ✅ | ✅ |
| Rule | AI 行为 / 代码规范约束 | ✅ | ✅ | ✅ | ✅ |
| MCP | MCP 服务配置 | ✅ | ✅ | ✅ | ✅¹ |
| Hook | 事件驱动脚本 | ✅² | ✅ | ✅ | ✅ |
| Command | 斜杠命令工作流 | ✅ | ✅ | ❌³ | ✅ |
| Agent | 子代理说明文件 | ✅ | ✅ | ✅⁴ | ✅ |

¹ Claude Code 的 MCP 写到项目根 `.mcp.json`，其余厂商写各自目录内的 `mcp.json`。
² Cursor 的 Hook 事件名为 camelCase，Loom 落盘时自动从 Claude Code 的 PascalCase 映射；无对应事件的 Hook 不分发到 Cursor。
³ Codex 的 prompts 位于用户级 `~/.codex/prompts/`，超出项目级安全边界，不分发。
⁴ Codex 子代理落盘为 TOML（`.codex/agents/<name>.toml`），Markdown 指令正文自动转写。

不兼容的能力类型在生成安装计划时自动跳过，不会导致整次安装失败。

## 工作空间与订阅

- **多空间叠加** —— 一个项目可同时安装多个工作空间，能力取并集生效；同一能力被多个空间引用时共享单例，卸载时按引用计数撤文件。
- **逐订阅策略** —— 每条订阅独立选择 `auto`（跟随平台更新）或 `locked`（保持本地不变），互不影响。
- **冲突可裁决** —— 同名不同内容的能力落盘路径必然撞车：安装计划会返回结构化的冲突清单，逐条选择「跳过」后执行，未裁决的撞车不会静默覆盖。
- **单独添加能力** —— 不必为了装一个能力而创建工作空间：可以直接把单项能力添加到项目（隐式订阅），同步策略独立可调。
- **本机也能看到全貌** —— 本地控制台按订阅展示每条空间卡片，能力矩阵标注每项能力的来源空间，支持单能力开关 / 移除。

## 同步策略

| 策略 | 行为 |
|------|------|
| `auto` | 能力内容或工作空间成员变化后，服务端对订阅了它且在线的项目尽力推送最新内容。 |
| `locked` | 跳过自动同步，保持本地不变，直到手动重装或切回 `auto`。 |

Agent 重连时，会对有任一 `auto` 订阅的项目重推当前成员状态。本地改动的对账方向是单向的：Agent 上报真实磁盘状态，服务端据此刷新缓存与安装引用计数，不会从本地侧反向新增订阅。

## 常用 CLI 命令

| 命令 | 作用 |
|------|------|
| `loom login` | 用 token + endpoint 登录，写本地配置 |
| `loom logout` | 清除本地凭据（不影响服务端 token） |
| `loom register` | 在当前目录注册一个 Loom 项目 |
| `loom unregister` | 注销当前目录的 Loom 项目 |
| `loom start` | 启动本地 Agent（默认后台守护进程，`-f` 前台实时显示连接状态） |
| `loom stop` | 停止本机后台 Agent |
| `loom status` | 查看连接、设备、项目状态（离线可用，`--json` 便于脚本化） |
| `loom push` | 把本地厂商目录内容推送到平台，创建或覆盖一个工作空间 |
| `loom version` | 查看当前 CLI 版本 |
| `loom update` | 更新 CLI 到最新版本 |

`loom push` 支持 `--tool` 指定厂商、`--name` 自定义工作空间名称（默认 `用户名/项目目录名`）、`--visibility` 控制可见性（默认 private）。它与 Marketplace Git 导入共用同一套解析逻辑，同一份能力无论从哪条路径进入平台，身份都一致。

## 本地数据位置

| 路径 | 内容 |
|------|------|
| `~/.loom/config.json` | endpoint、token、设备 ID |
| `~/.loom/projects/<id>.json` | 本机已注册项目记录 |
| `~/.loom/locks/<projectId>.json` | 安装账本（Loom 管理的文件、能力开关、聚合贡献、订阅快照） |
| `~/.loom/logs/agent.log` | 后台 Agent 日志 |
| `~/.loom/disabled/<projectId>/...` | 被关闭能力的隔离副本（不放入项目目录） |
| `~/.loom/agent.pid` | 后台 Agent pidfile |

卸载 Loom 不会自动删除 `~/.loom/`，可手动清理。

## Marketplace：从外部 Git 仓库导入能力

管理员可在 Web「设置 → 数据来源」添加 Git 仓库地址，Loom 会定期 clone / fetch 并解析其中的能力与 plugin 工作空间，自动 upsert 到平台。支持三种来源类型：`claude-code-marketplace`、`claude-code-plugin`、`generic-git`。

安全边界：远程地址仅接受不含凭据的 HTTPS（`git@host:path` 会规范化为 HTTPS），且域名必须只解析到公网地址，Server 在 clone / fetch 前拒绝任一私网、回环或保留地址。

## 密钥与 AI 工具配置下发

**环境变量密钥。** 部分能力（如调用 GitHub API 的 MCP）需要鉴权。能力编辑页可声明鉴权方式（免鉴权 / 环境变量），Web「设置 → 环境变量」中维护 key→value 密钥对——AES-256-GCM 加密存储，REST 永不返回明文。下发时选择在线设备，服务端解密后经 WebSocket 实时推送，Agent 写入系统环境变量（Linux `~/.bashrc` / macOS `~/.zshrc` / Windows `setx`）。仅在线设备可下发 / 回收；正在运行的 IDE 需重启才能读到新变量，新开 shell 立即生效。

**Codex / Claude Code 配置档。** 「设置 → AI 工具配置」可维护多套用户级配置档（加密凭据 + Base URL + 模型映射等），选择在线设备一键下发：Codex 写 `~/.codex/config.toml` 与 `auth.json`，Claude Code 写 `~/.claude/settings.json` 与 `~/.claude.json`。对已存在的配置文件做字段级合并，无法解析时拒绝覆盖，不破坏用户既有配置。

## 部署与安全配置

默认配置面向单机本地使用。对外提供服务时应放在 HTTPS 反向代理后，并显式配置：

| 变量 | 说明 |
|------|------|
| `LOOM_ADMIN_EMAIL` / `LOOM_ADMIN_PASSWORD` | 首次启动时成对设置，用于创建管理员；密码 6–128 位。 |
| `HOST` / `PORT` | 默认 `127.0.0.1:47474`；容器或远程监听通常将 `HOST` 设为 `0.0.0.0`。 |
| `LOOM_EXTERNAL_URL` | 服务端对外地址，用于文档页生成可复制的 `loom login` 命令。 |
| `LOOM_CORS_ORIGINS` | 允许跨域访问的完整 origin，多个值用逗号分隔，例如 `https://loom.example.com`。 |
| `LOOM_COOKIE_SECURE` | 是否只通过 HTTPS 发送会话 cookie；未设置时在 `NODE_ENV=production` 中默认开启。 |
| `LOOM_DATA_DIR` | SQLite、主密钥和同步状态目录；必须持久化并限制文件系统访问。 |

Docker 示例：

```bash
docker build -f docker/Dockerfile -t loom-server .
docker run --rm -p 47474:47474 -v loom-data:/data \
  -e LOOM_ADMIN_EMAIL=admin@example.com \
  -e LOOM_ADMIN_PASSWORD='replace-with-a-long-unique-password' \
  -e LOOM_COOKIE_SECURE=false \
  loom-server
```

上例仅用于本机 HTTP 试用。公网部署应使用 HTTPS、移除 `LOOM_COOKIE_SECURE=false`，并设置 `LOOM_CORS_ORIGINS`。安全问题请按 [`SECURITY.md`](./SECURITY.md) 私下报告。

## 常见问题

**Q：服务端要单独装数据库吗？**
不用。Loom 用 SQLite，`@maolinc/cc-loom-server` 首次启动自动建库；首次启动只需显式提供管理员凭据。

**Q：我的项目文件会被覆盖吗？**
Loom 只写自己管理的能力文件到厂商目录，通过安装账本精确跟踪。本地控制台会清楚区分 Loom 管理文件、外部文件、缺失文件。同名不同内容的撞车能力必须显式裁决，不会静默覆盖。

**Q：支持哪些 AI 工具？**
目前支持 Cursor、CodeBuddy、Codex、Claude Code 四种，能力类型兼容性见上表。新增厂商的改动清单见 [`docs/code-guide/adding-a-vendor.md`](./docs/code-guide/adding-a-vendor.md)。

**Q：能力名称有什么规则？**
`(类型, 名称)` 是能力的落盘身份——同一目标工具下两个同名能力会写到相同路径。`name` 只能含英文、数字、`_`、`-`；展示用 `alias` 可用中文。已被工作空间或项目引用的能力不能改 `name`，只能改 `alias`。

**Q：离线时安装会怎样？**
Agent 离线时不接收推送。重新连接后，`auto` 策略的订阅会自动追上当前工作空间的成员状态。

**Q：不想跑 CLI，能直接拿到能力文件吗？**
可以。能力和工作空间详情页都提供 zip 下载；工作空间 zip 还可按目标工具生成安装结构（`?tool=cursor,claudecode`），手动放进项目目录即可。

## 面向开发者

Loom 是 TypeScript monorepo（pnpm workspace）：

| 包 | 说明 |
|----|------|
| `@maolinc/cc-loom-shared` | 类型定义与校验规则的唯一来源 |
| `@maolinc/cc-loom-server` | Fastify 服务端 + 静态文件托管 |
| `@maolinc/cc-loom-web` | React + Vite SPA，构建后由 server 托管 |
| `@maolinc/cc-loom` | CLI + WebSocket 客户端（本地 Agent） |
| `@maolinc/cc-loom-adapter` | 适配器引擎，纯函数，两端复用 |

开发与构建命令通过 [`justfile`](./justfile) 统一管理，运行 `just` 列出全部。常用：

```bash
just install      # 安装依赖
just dev          # 启动 shared/adapter/server/web 并行开发
just build        # 编译所有包
just test         # 运行单元测试
```

更详细的文档：

- 产品功能边界：[`product-functional-doc.md`](./product-functional-doc.md)
- UI 设计规范：[`ui-design-spec.md`](./ui-design-spec.md)
- 代码指南：[`docs/code-guide/README.md`](./docs/code-guide/README.md)
- 新增厂商改动清单：[`docs/code-guide/adding-a-vendor.md`](./docs/code-guide/adding-a-vendor.md)
- 测试体系：[`docs/testing/principles.md`](./docs/testing/principles.md)

贡献说明见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)，社区行为规范见 [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)。

## License

[MIT](./LICENSE)。第三方产品名称仅用于兼容性说明，详见 [`TRADEMARKS.md`](./TRADEMARKS.md)。
