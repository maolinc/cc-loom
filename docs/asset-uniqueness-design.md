# Loom Asset 唯一性设计方案（按厂商适配）

> 状态：设计定稿（待落地）
> 适用范围：平台注册库 + 工作空间/本地同步 + 各厂商 Adapter 投影

---

## 0. TL;DR

唯一性不是一个全局概念，而是**按作用域分层**，且在工作空间层**按厂商各算一遍**：

- **平台 / 注册库**：身份锚点是 UUID，`name` 可随意重复，随意上传同名。
- **工作空间 / 本地同步**：身份锚点是“落盘身份载体”，作用域是 `(workspace, tool)`，同身份互斥（hook 除外）。
- 厂商不支持的类型不参与该厂商唯一性；skill/rule/command/agent 按 `(tool, type, name)`、mcp 按 `(tool, 最终 serverKey)`、hook 按 `(tool, event, matcher)` 追加豁免。

---

## 1. 核心认知：唯一性作用域是 `(workspace, tool)`

`BaseAdapter.generate`（`packages/adapter/src/base.ts:50-67`）落盘前做两层过滤：

1. `asset.compatibleTools.includes(this.tool)` —— 不兼容当前工具的 asset 跳过。
2. `this.supportedTypes.includes(asset.type)` —— 该厂商不支持的类型进入 `skipped`，不落盘。

由此得出两条原则：

- 每个厂商落到各自 `targetDir`（`.cursor` / `.codebuddy` / `.claude` / `.codex`），**厂商之间天然不互撞**。
- 唯一性必须**分厂商各算一遍**：同一 workspace 内两个同名 skill，若都兼容 cursor 则在 cursor 下冲突；若一个只兼容 cursor、另一个只兼容 codex 则不冲突。

> 结论：InstallKey 的第一维永远是 `tool`。

---

## 2. 两个作用域，两套唯一性

| 作用域 | 身份锚点 | name 是否可重复 | 角色 |
|--------|---------|----------------|------|
| **平台 / 注册库** | UUID | ✅ 可随意同名 | 仓库，存候选 |
| **工作空间 / 本地同步** | 落盘身份载体（见 §4） | ❌ 同身份互斥 | 投影到真实目录 |

- 平台层：引用靠 UUID，重名无害 → 随意上传同名。
- 工作空间层：能力投影成真实文件/配置，同身份 = 同物理位置 = 必然覆盖 → 必须唯一。

---

## 3. 厂商 × 类型 支持矩阵（决定“谁参与唯一性”）

| 类型 | Cursor | CodeBuddy | Claude Code | Codex |
|------|:------:|:---------:|:-----------:|:-----:|
| skill | ✅ | ✅ | ✅ | ✅ |
| rule | ✅ | ✅ | ✅ | ✅ |
| mcp | ✅ | ✅ | ✅ | ✅ |
| command | ✅ | ✅ | ✅ | ❌ |
| agent | ❌ | ✅ | ✅ | ❌ |
| hook | ❌ | ✅ | ✅ | ✅ |

依据：

- `packages/adapter/src/cursor.ts:8` — `["skill", "rule", "mcp", "command"]`
- `packages/adapter/src/codebuddy.ts:16` — 全 6 类
- `packages/adapter/src/claudecode.ts:16` — 全 6 类
- `packages/adapter/src/codex.ts:14` — `["skill", "rule", "mcp", "hook"]`

> ❌ 的格子在该厂商下被 `skipped`（`base.ts:55`），根本不落盘 → 不参与该厂商唯一性判定。

---

## 4. 厂商 × 类型 落盘身份载体 & 唯一性维度（真实路径）

| 类型 | 身份载体形态 | Cursor | CodeBuddy | Claude Code | Codex | 唯一性维度 |
|------|------------|--------|-----------|-------------|-------|-----------|
| **skill** | 文件夹 | `.cursor/skills/<name>/` | `.codebuddy/skills/<name>/` | `.claude/skills/<name>/` | `.codex/skills/<name>/` | `(tool, type, name)` |
| **rule** | 文件夹 | `.cursor/rules/<name>/` | `.codebuddy/rules/<name>/` | `.claude/rules/<name>/` | `.codex/rules/<name>/` | `(tool, type, name)` |
| **command** | 单文件 | `.cursor/commands/<name>.md` | `.codebuddy/commands/<name>.md` | `.claude/commands/<name>.md` | — | `(tool, type, name)` |
| **agent** | 单文件 | — | `.codebuddy/agents/<name>.md` | `.claude/agents/<name>.md` | — | `(tool, type, name)` |
| **mcp** | JSON key | `.cursor/mcp.json` | `.codebuddy/mcp.json` | **项目根 `.mcp.json`** | `.codex/mcp.json` | `(tool, mcp, serverKey)` |
| **hook** | 配置注册项 | — | `.codebuddy/settings.json` → `hooks` | `.claude/settings.json` → `hooks` | `.codex/hooks.json` | `(tool, event, matcher)`，追加共存 |

### 厂商差异点（“不一样”的根源）

1. **MCP 配置文件路径厂商各异**：三家写 `<targetDir>/mcp.json`，**唯独 Claude Code 必须写项目根 `.mcp.json`**（`claudecode.ts:18` 覆写 `mcpConfigPath`，因为 Claude Code 不从 `.claude/` 或 `settings.json` 加载 MCP）。但唯一性维度统一是 `serverKey`。
2. **Hook 注册文件路径厂商各异**：CodeBuddy 嵌 `settings.json`（`settings-with-hooks`，`codebuddy.ts:18`）、Codex 写顶层 `hooks.json`（`codex.ts:16`）、Claude Code 嵌 `settings.json` 顶层 `hooks` 字段（`settings-with-hooks`，`claudecode.ts` 覆写——项目级 hook 只从 settings.json 加载，`hooks/hooks.json` 仅 plugin 包内有效）。但 hook 语义一致：按 `(event, matcher)` 追加，不互斥（`merge.ts:129` `mergeMatcherEntries`）。
3. **MCP 的 serverKey 可能藏在 content 内部**：`aggregateMcps`（`base.ts:179-202`）对 wrapped 形态取 content 里的 key，single 形态才用 `asset.name`。所以 MCP 判重要用**最终算出的 serverKey**，不能用 `asset.name`。
4. **文件夹 vs 单文件由 `isAssetDirLayout` 决定**（`packages/shared/src/layout.ts`）：skill/rule（多文件或 sourcePath 末段无扩展名）走文件夹，command/agent 单文件，hook 恒文件夹（附属脚本），mcp 不适用。

---

## 5. 统一分派函数 `computeInstallKey(asset, tool)`

```text
computeInstallKey(asset, tool):
  # 前置：tool 不支持该类型，或 asset 不兼容该 tool → 不参与唯一性
  if !adapter(tool).supportedTypes.includes(asset.type): return null
  if !asset.compatibleTools.includes(tool):              return null

  switch asset.type:
    skill | rule | command | agent:
        # 文件夹名 / 文件名
        return [ key(tool, asset.type, normalize(asset.name)) ]

    mcp:
        # 最终 JSON key，可能来自 content（wrapped 含多 server）
        return aggregateMcps([asset]).serverKeys
                 .map(k => key(tool, "mcp", k))

    hook:
        # 不参与互斥，仅按 (event, matcher) 追加；
        # 仅附属脚本目录 hooks/<name>/ 同名才冲突
        return [ key(tool, "hook-dir", asset.name) ]
```

要点：

- **skill/rule/command/agent**：维度都是 `(tool, type, name)`，但 command/agent 在不支持的厂商直接 `null`。
- **mcp**：一个 asset 可能产出多个 serverKey（wrapped 含多 server），每个都要查重。
- **hook**：默认放行追加，只有附属脚本目录 `hooks/<name>/`（`base.ts:79`）同名才拦截。
- `normalize(name)`：只做路径安全 + 大小写归一化，不做激进 slug（保留可读性）。

---

## 6. 冲突处理（三道关卡，按厂商分别判）

| 时机 | 动作 |
|------|------|
| **加入 Workspace** | 对该 asset 的**每个 compatibleTool** 各算 InstallKey，任一 tool 下撞键 → 拦截、二选一（替换 / 取消）；hook 追加豁免 |
| **安装预览 diff** | 兜底展示与本地已有文件冲突，确认覆盖（产品文档 9.8.3）；MCP 按 serverKey、hook 按 event/matcher 展示 |
| **本地同步** | Workspace 已唯一，投影自动继承；非 Loom 的外部同名文件走 diff 覆盖提示 |

---

## 7. 平台层唯一性（保持现状，不加约束）

- `id TEXT PRIMARY KEY`（UUID）保证内部引用唯一。
- `name` 不加任何 UNIQUE，public/private 都允许同名并存。
- marketplace 同步保留现有 `(source_id, source_path)` 复合唯一索引（防重复导入）。

---

## 8. 配套代码改动点

1. **新增 `computeInstallKey(asset, tool)`**（`packages/adapter`）：按 §5 分派，复用 `aggregateMcps` 得到 serverKey；文件型用 `normalize(asset.name)`。
2. **工作空间编排接口**：加入 Asset 时，对每个 `compatibleTool` 调 `computeInstallKey` 查重，撞键返回冲突信息供前端二选一；hook 放行追加。
3. **name 归一化**：路径安全（处理 `/`、空格、大小写），不做激进 slug。
4. **（可选）metadata 强类型**：把 `packages/shared/src/schemas.ts` 的 `assetMetadataSchema` 从 `z.union` 改为按 `type` 判别的 `z.discriminatedUnion("type", ...)`，杜绝 mcp 传空 metadata 蒙混。零争议纯增益。

---

## 9. 明确不做

- ❌ 不可变版本 / Asset-Version 拆表
- ❌ 内容寻址 CAS / 全局 digest 去重
- ❌ owner scope 全局坐标体系
- ❌ 平台自动判定“最佳”并删数据
- ❌ 平台层 name 全局唯一

---

## 10. 一句话总结

**UUID 管平台引用、落盘身份载体管工作空间。** 唯一性按 `(workspace, tool)` 分厂商各算一遍——厂商不支持的类型不参与；skill/rule/command/agent 按 `(tool, type, name)`、mcp 按 `(tool, 最终 serverKey)`、hook 按 `(tool, event, matcher)` 追加豁免；MCP/hook 的落盘文件路径厂商各异但唯一性维度一致。冲突在“加入工作空间”那一刻强制二选一。
