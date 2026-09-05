import { db, vecAvailable } from "./index.js";
import { hashPassword, generateId, verifyPassword } from "../lib/crypto.js";
import { appSettings } from "../lib/app-settings.js";
import { emailSchema, passwordPolicySchema } from "@maolinc/cc-loom-shared";

function bootstrapAdmin(): void {
  const configuredEmail = process.env.LOOM_ADMIN_EMAIL?.trim();
  const configuredPassword = process.env.LOOM_ADMIN_PASSWORD;
  if (Boolean(configuredEmail) !== Boolean(configuredPassword)) {
    throw new Error("LOOM_ADMIN_EMAIL and LOOM_ADMIN_PASSWORD must be set together");
  }

  if (configuredEmail && configuredPassword) {
    if (!emailSchema.safeParse(configuredEmail).success || !passwordPolicySchema.safeParse(configuredPassword).success) {
      throw new Error("LOOM_ADMIN_EMAIL or LOOM_ADMIN_PASSWORD does not satisfy the account policy");
    }
  }

  const legacy = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get("admin@loom.com") as
    | { id: string; password_hash: string }
    | undefined;
  if (legacy && verifyPassword("admin123", legacy.password_hash)) {
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(legacy.id);
    console.warn("[auth] Disabled the legacy default administrator account. Configure LOOM_ADMIN_EMAIL and LOOM_ADMIN_PASSWORD to bootstrap an administrator.");
  }

  if (configuredEmail && configuredPassword) {
    const existing = db.prepare("SELECT id, disabled FROM users WHERE email = ?").get(configuredEmail) as
      | { id: string; disabled: number }
      | undefined;
    if (existing) {
      if (existing.disabled) {
        db.prepare("UPDATE users SET password_hash = ?, role = 'admin', disabled = 0, updated_at = ? WHERE id = ?")
          .run(hashPassword(configuredPassword), new Date().toISOString(), existing.id);
      } else {
        db.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), existing.id);
      }
    } else {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO users (id, email, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, 'admin', 0, ?, ?)"
      ).run(generateId(), configuredEmail, hashPassword(configuredPassword), now, now);
    }
  }

  const activeAdmins = (db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get() as { count: number }).count;
  if (activeAdmins === 0) {
    throw new Error("An administrator must be initialized with LOOM_ADMIN_EMAIL and LOOM_ADMIN_PASSWORD before starting Loom");
  }
}

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // ---- 角色与停用 ----
  // role: 'admin'（超级管理员）/ 'user'（普通用户），默认 user。
  // disabled: 0=正常, 1=已停用（无法登录、会话失效）。
  try {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  } catch {/* column already exists */}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`);
  } catch {/* column already exists */}

  bootstrapAdmin();

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      device_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline',
      last_online_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      author TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      compatible_tools TEXT NOT NULL,
      visibility TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_files (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_asset_files_asset ON asset_files(asset_id)`);

  // 二进制文件支持：content 为 base64 时，encoding='base64'；文本文件该列为 NULL。
  try {
    db.exec(`ALTER TABLE asset_files ADD COLUMN encoding TEXT`);
  } catch {/* column already exists */}

  // Migrate existing content from assets table to asset_files
  try {
    db.exec(`
      INSERT INTO asset_files (id, asset_id, path, content, size, created_at, updated_at)
      SELECT
        lower(hex(randomblob(16))),
        a.id,
        COALESCE(a.source_path, 'README.md'),
        a.content,
        LENGTH(a.content),
        a.created_at,
        a.updated_at
      FROM assets a
      WHERE a.content IS NOT NULL AND a.content != ''
        AND a.id NOT IN (SELECT af.asset_id FROM asset_files af)
    `);
  } catch { /* content column might not exist or data already migrated */ }

  // Drop content column (SQLite 3.35+)
  try { db.exec(`ALTER TABLE assets DROP COLUMN content`); } catch { /* column may not exist */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      target_tools TEXT NOT NULL,
      visibility TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Migration: add user_id column if missing
  try {
    db.exec(`ALTER TABLE workspaces ADD COLUMN user_id TEXT REFERENCES users(id)`);
  } catch {/* column already exists */}

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_assets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      asset_id TEXT NOT NULL REFERENCES assets(id)
    )
  `);

  // 项目安装账本：服务端镜像每个项目 agent lock 里实际安装的 asset 集合。
  // 由 ws gateway 在收到 agent 推送的 LocalProjectState 时对账维护，作为 asset
  // 「留存 / GC」引用计数的权威来源（含通过「添加能力」单独安装、不入 workspace_assets 的能力）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_installed_assets (
      project_id   TEXT NOT NULL REFERENCES projects(id),
      asset_id     TEXT NOT NULL REFERENCES assets(id),
      installed_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_installed_assets_asset ON project_installed_assets(asset_id)`);

  // ---- project_disabled_assets：toggle 状态的服务端权威源（wire 协议 v2）----
  //
  // 旧路径下，每个 (asset, vendor) 的 enabled/disabled 由 CLI lock 单边持有，
  // server 端不可见、不可对账。v2 协议统一由 reconcileProject 在 server 端计算
  // plan，需要把 toggle 状态收口到 DB。
  //
  // 粒度：per (project, asset, tool) —— 同一 asset 在不同 vendor 下可独立 toggle。
  // 默认无行 = enabled；存在行 = disabled。
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_disabled_assets (
      project_id  TEXT NOT NULL REFERENCES projects(id),
      asset_id    TEXT NOT NULL REFERENCES assets(id),
      tool        TEXT NOT NULL,
      disabled_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id, tool)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_disabled_assets_asset ON project_disabled_assets(asset_id)`);

  // ---- project_capabilities：项目级直接成员（adopt 的本地外部能力）----
  //
  // 与 workspace_assets（共享、受 sync 扇出）并列，但归属单个项目、不扇出到其它项目。
  // 当用户在本地控制台 toggle/remove 一个「外部能力」时，先 adopt：把磁盘内容登记成
  // asset，再加入本表，使其进入 reconcile 受管集。单独安装（type 2）也走本表
  // （/capabilities/add 加入 project_capabilities，per-project 不扇出）。reconcile 受管集 =
  // workspace_assets(current_workspace) ∪ project_capabilities(project)。
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_capabilities (
      project_id TEXT NOT NULL REFERENCES projects(id),
      asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      added_at   TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_project_capabilities_asset ON project_capabilities(asset_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      project_name TEXT NOT NULL,
      normalized_path TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      detected_targets TEXT NOT NULL,
      default_targets TEXT NOT NULL,
      current_workspace_id TEXT,
      status TEXT NOT NULL DEFAULT 'registered'
    )
  `);
  // 安装时选择的同步策略（auto / locked），用于服务端在工作空间/能力被编辑时
  // 决定是否自动回推到该项目。安装成功时写入；默认 auto。
  // ADR-0006 起语义迁移到 project_subscriptions.sync_policy，本列仅为迁移来源保留。
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN sync_policy TEXT NOT NULL DEFAULT 'auto'`);
  } catch {/* column already exists */}

  // ---- project_subscriptions：项目 × 工作空间的订阅关系（ADR-0006）----
  //
  // 取代 projects.current_workspace_id / projects.sync_policy 的单值模型。一个项目
  // 可同时持有多条订阅，能力叠加生效；syncPolicy 与 targetTools 均挂在订阅上。
  // workspace_id = '' 为隐式订阅哨兵（「单独添加的能力」组，对应 project_capabilities；
  // SQLite PK 中 NULL 不判重，故用空串）。隐式订阅 target_tools = NULL（跟随项目有效工具）。
  // workspace_id 不设外键：留存空间被 workspace-gc 硬删后订阅行仍指向其 id。
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_subscriptions (
      project_id   TEXT NOT NULL REFERENCES projects(id),
      workspace_id TEXT NOT NULL,
      sync_policy  TEXT NOT NULL DEFAULT 'auto',
      target_tools TEXT,
      installed_at TEXT NOT NULL,
      PRIMARY KEY (project_id, workspace_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_subscriptions_workspace ON project_subscriptions(workspace_id)`);

  // 撞车裁决（ADR-0006）：同名不同 id 的能力在安装时被用户「跳过」的记录。
  // reconcile 计算受管集时从该订阅的 workspace_assets 中剔除这些 asset。
  // 跳过 = 仅本次不装；execute 携带新的 skipAssetIds 时整组替换，支持后续补齐。
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_subscription_excludes (
      project_id   TEXT NOT NULL REFERENCES projects(id),
      workspace_id TEXT NOT NULL,
      asset_id     TEXT NOT NULL,
      PRIMARY KEY (project_id, workspace_id, asset_id)
    )
  `);

  // 迁移：projects.current_workspace_id / sync_policy → 订阅行。
  // 显式订阅的 target_tools 取迁移时有效值（default_targets ∩ workspace.target_tools），
  // 与旧 reconcile 口径一致；隐式订阅为所有项目补一行（承载原项目级 sync_policy）。
  {
    const rows = db.prepare(`
      SELECT p.id AS project_id, p.current_workspace_id AS ws, p.sync_policy AS policy,
             p.default_targets AS defaults, w.target_tools AS ws_tools, p.registered_at AS at
      FROM projects p LEFT JOIN workspaces w ON w.id = p.current_workspace_id
    `).all() as {
      project_id: string; ws: string | null; policy: string;
      defaults: string; ws_tools: string | null; at: string;
    }[];
    const ins = db.prepare(
      "INSERT OR IGNORE INTO project_subscriptions (project_id, workspace_id, sync_policy, target_tools, installed_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      ins.run(r.project_id, "", r.policy === "locked" ? "locked" : "auto", null, r.at);
      if (r.ws) {
        const defaults = JSON.parse(r.defaults || "[]") as string[];
        const wsTools = r.ws_tools ? (JSON.parse(r.ws_tools) as string[]) : defaults;
        const eff = defaults.filter((t) => wsTools.includes(t));
        ins.run(r.project_id, r.ws, r.policy === "locked" ? "locked" : "auto",
          JSON.stringify(eff.length > 0 ? eff : defaults), r.at);
      }
    }
  }

  // Marketplace sources
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_sources (
      id                    TEXT PRIMARY KEY,
      kind                  TEXT NOT NULL,
      parent_id             TEXT REFERENCES marketplace_sources(id) ON DELETE CASCADE,
      repo_url              TEXT NOT NULL UNIQUE,
      display_name          TEXT NOT NULL,
      description           TEXT NOT NULL DEFAULT '',
      added_by              TEXT NOT NULL,
      origin_author         TEXT,
      ref                   TEXT,
      enabled               INTEGER NOT NULL DEFAULT 1,
      sync_interval_minutes INTEGER,
      last_sync_status      TEXT,
      last_sync_at          TEXT,
      last_error            TEXT,
      last_commit_sha       TEXT,
      local_path            TEXT NOT NULL,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_parent ON marketplace_sources(parent_id)`);

  // 能力类型过滤：NULL = 导入全部类型（默认）；非空 JSON 数组 = 仅导入列出的类型。
  try {
    db.exec(`ALTER TABLE marketplace_sources ADD COLUMN asset_types_filter TEXT`);
  } catch { /* column already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_sync_logs (
      id          TEXT PRIMARY KEY,
      source_id   TEXT NOT NULL REFERENCES marketplace_sources(id) ON DELETE CASCADE,
      trigger     TEXT NOT NULL,
      status      TEXT NOT NULL,
      added       INTEGER NOT NULL DEFAULT 0,
      updated     INTEGER NOT NULL DEFAULT 0,
      removed     INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL,
      error       TEXT,
      started_at  TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_source ON marketplace_sync_logs(source_id, started_at DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Seed default poll interval (only if missing)
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value, updated_at)
    VALUES ('marketplace.poll_interval_minutes', '360', ?)
  `).run(new Date().toISOString());

  // Extend assets table
  for (const stmt of [
    `ALTER TABLE assets ADD COLUMN source_id TEXT REFERENCES marketplace_sources(id) ON DELETE CASCADE`,
    `ALTER TABLE assets ADD COLUMN source_path TEXT`,
    `ALTER TABLE assets ADD COLUMN source_origin_author TEXT`,
    `ALTER TABLE assets ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE assets ADD COLUMN alias TEXT`,
    `ALTER TABLE assets ADD COLUMN source_url TEXT`,
    // skill 调用次数（市场展示）：由 Agent 通过 hook 旁路统计后增量上报、Server 累加。
    `ALTER TABLE assets ADD COLUMN invocation_count INTEGER NOT NULL DEFAULT 0`,
    // adopt 外部本地能力时标记：此类 asset 仅供本地控制台/reconcile 使用，
    // 不进入能力市场列表（/api/assets 过滤 adopted = 0）。
    `ALTER TABLE assets ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0`,
    // 能力鉴权声明（ADR-0003 已迁移到 asset_auth_bindings 子表，统一绑定列表模型）。
    // 旧三列保留供一次性数据迁移读取，新代码不再写入。
    `ALTER TABLE assets ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE assets ADD COLUMN auth_env_key TEXT`,
    `ALTER TABLE assets ADD COLUMN auth_page_url TEXT`,
  ]) {
    try { db.exec(stmt); } catch {/* column exists */}
  }
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_source ON assets(source_id, source_path) WHERE source_id IS NOT NULL`); } catch {/* exists */}

  // ---- asset_auth_bindings：资产侧鉴权声明（ADR-0003，统一绑定列表）----
  //
  // 取代 assets.auth_method/auth_env_key/auth_page_url 三列。每个绑定描述一条
  // 「凭据名 × kind(env|path) × 目标(envKey|path)」的声明；kind=path 仅对 mcp 有效。
  // asset_auth_bindings.ordinal 保持同资产内绑定顺序（UI 展示稳定）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_auth_bindings (
      id              TEXT PRIMARY KEY,
      asset_id        TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      ordinal         INTEGER NOT NULL DEFAULT 0,
      credential_name TEXT NOT NULL,
      kind            TEXT NOT NULL,
      env_key         TEXT,
      path            TEXT,
      auth_page_url   TEXT,
      created_at      TEXT NOT NULL,
      UNIQUE (asset_id, ordinal)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_bindings_asset ON asset_auth_bindings(asset_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_bindings_cred ON asset_auth_bindings(credential_name)`);
  // 一次性数据迁移：旧 auth_method=env 行 → 一条 env 绑定。仅当目标表为空时执行。
  try {
    const migrated = (db.prepare("SELECT COUNT(*) AS c FROM asset_auth_bindings").get() as { c: number }).c;
    if (migrated === 0) {
      const now = new Date().toISOString();
      const ins = db.prepare(
        "INSERT INTO asset_auth_bindings (id, asset_id, ordinal, credential_name, kind, env_key, path, auth_page_url, created_at) VALUES (?, ?, ?, ?, 'env', ?, NULL, ?, ?)",
      );
      const rows = db.prepare(
        "SELECT id, auth_env_key, auth_page_url FROM assets WHERE auth_method = 'env' AND auth_env_key IS NOT NULL AND auth_env_key != ''",
      ).all() as { id: string; auth_env_key: string; auth_page_url: string | null }[];
      for (const r of rows) {
        ins.run(
          generateId(), r.id, 0, r.auth_env_key, r.auth_env_key,
          r.auth_page_url ?? null, now,
        );
      }
    }
  } catch { /* 列不存在或已迁移——忽略 */ }

  // Extend workspaces table
  for (const stmt of [
    `ALTER TABLE workspaces ADD COLUMN source_id TEXT REFERENCES marketplace_sources(id) ON DELETE CASCADE`,
    `ALTER TABLE workspaces ADD COLUMN source_plugin TEXT`,
    // 隐式工作空间绑定：本地控制台对「未安装工作空间」项目「直接添加能力」时，
    // 自动创建并绑定到该项目的隐式工作空间。每项目至多一个（见下方部分唯一索引）。
    `ALTER TABLE workspaces ADD COLUMN implicit_project_id TEXT`,
  ]) {
    try { db.exec(stmt); } catch {/* column exists */}
  }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_source ON workspaces(source_id, source_plugin) WHERE source_id IS NOT NULL`);
  } catch {/* exists */}
  try {
    // 每项目至多一个「未软删」的隐式工作空间。软删行被排除，删除后可重新创建。
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_implicit_project ON workspaces(implicit_project_id) WHERE implicit_project_id IS NOT NULL AND deleted_at IS NULL`);
  } catch {/* exists */}
  try {
    // 同一用户不能创建相同名字的工作空间（软删的不参与约束，名字可复用）。
    // loom push 的覆盖语义依赖此约束：按 (user_id, name) 查找至多一条结果。
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_user_name ON workspaces(user_id, name) WHERE deleted_at IS NULL`);
  } catch {/* exists */}

  // ---- Performance indexes ----
  // projects: 项目列表主查询 WHERE user_id = ? AND status != 'unregistered'
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user_status ON projects(user_id, status)`);
  // projects: agent 连接/断开时按 device_id 批量更新
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_device ON projects(device_id)`);
  // projects: auto-sync 按 workspace 查项目
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(current_workspace_id)`);
  // workspace_assets: workspace 详情/列表必用
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_assets_ws ON workspace_assets(workspace_id)`);
  // workspace_assets: asset GC 引用计数
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_assets_asset ON workspace_assets(asset_id)`);
  // devices: 设备列表按用户查
  db.exec(`CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)`);

  // ---- sync_outbox：server→CLI 同步任务的持久化队列 ----
  //
  // 离线时编辑、重连时补偿、运行中失败重试，全部入这张表。worker（outbox-worker.ts）
  // 在 agent 上线时被唤醒，按 device_id 串行消费可执行（scheduled_at <= now）的行。
  //
  // 折叠：同 (project_id, asset_id) 未完成项至多一条。新一次 enqueue 会用最新 kind
  // 覆盖前一条（典型场景：短时间内 add 再 remove 同一 asset → 只发 remove）。靠 partial
  // unique index 在写入路径上保证唯一性，业务层在 enqueue 时 DELETE+INSERT。
  //
  // 取舍：payload 不存（只存 kind），worker 在 exec 时按当前 DB 状态重新构造请求体——
  // 避免存储 asset 文件 base64 膨胀、且保证发出去的内容总是最新版本。
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    TEXT NOT NULL,
      project_id   TEXT NOT NULL,
      asset_id     TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('add','remove')),
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      scheduled_at TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_device_pending
           ON sync_outbox(device_id, scheduled_at)
           WHERE completed_at IS NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_fold
           ON sync_outbox(project_id, asset_id)
           WHERE completed_at IS NULL`);

  // ---- sync_outbox_v2：wire 协议 v2 的 per-project 折叠队列 ----
  //
  // v2 协议下「让 CLI 落盘」统一为 reconcile op。行模型从 (project, asset, kind)
  // 退化为 project 单粒度——同一项目在窗口期内的多次变更折叠成一行；worker 执行
  // 时按当前 DB 状态调 reconcileProject 算最新 plan，无需保留中间步骤。
  //
  // 与 v1 共存：v1 worker 仍消费旧表（兼容老 CLI），v2 worker 仅消费此表。
  // CLI 在 auth 中自报 capabilities.reconcileV2 时，server 端入队走 v2；否则走 v1。
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_outbox_v2 (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    TEXT NOT NULL,
      project_id   TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      scheduled_at TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_v2_device_pending
           ON sync_outbox_v2(device_id, scheduled_at)
           WHERE completed_at IS NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_v2_fold
           ON sync_outbox_v2(project_id)
           WHERE completed_at IS NULL`);

  // force=1 标记「显式手动操作」(install / capabilities add·toggle·remove) 入队的行：
  // 即使项目 sync_policy=locked 也照常 reconcile。product-functional-doc §9.1 — locked
  // 只阻断自动同步，不阻断用户对本项目的显式操作。auto-sync 入队 force=0，仍由 worker
  // 兜底 skip（见 outbox-worker-v2 processRow）。
  try {
    db.exec(`ALTER TABLE sync_outbox_v2 ADD COLUMN force INTEGER NOT NULL DEFAULT 0`);
  } catch {/* column already exists */}

  // v1→v2 outbox 折叠迁移(每次启动 idempotent):把旧 sync_outbox 里所有未完成
  // 行按 project_id 折叠到 sync_outbox_v2,然后把旧表对应行标 completed,避免被
  // 任何残留的 v1 worker 再次拾起。docs/refactor/wire-protocol-unification.md §6.4。
  // 旧表 schema 本身保留 1 个版本周期,以便回滚检查。
  const hasOldOutbox = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_outbox'")
    .get();
  if (hasOldOutbox) {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO sync_outbox_v2 (device_id, project_id, attempts, scheduled_at, created_at)
        SELECT DISTINCT device_id, project_id, 0, ?, ?
          FROM sync_outbox
         WHERE completed_at IS NULL
      `).run(now, now);
      db.prepare(
        "UPDATE sync_outbox SET completed_at = ? WHERE completed_at IS NULL",
      ).run(now);
    });
    tx();
  }

  // Recover orphan running rows on restart
  db.prepare(`
    UPDATE marketplace_sources
    SET last_sync_status = 'failed', last_error = '服务重启中断'
    WHERE last_sync_status = 'running'
  `).run();

  // ---- env_vars：设置页用户密钥管理 ----
  //
  // value_cipher 为 AES-256-GCM 密文（自包含 iv:tag:cipher），明文永不落 DB。
  // 与创建页 AssetAuth「声明」解耦：这里只存用户维护的 key→value 对。
  // 同一用户下 key 唯一（删除后可重建）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS env_vars (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      key          TEXT NOT NULL,
      value_cipher TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_env_vars_user_key ON env_vars(user_id, key)`);
  // 描述字段（可选，用于在设置页说明该环境变量的用途）
  try {
    db.exec(`ALTER TABLE env_vars ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
  } catch {/* column already exists */}

  // ---- env_var_distributions：env var × 设备 的下发记录 ----
  //
  // 多对多：一个 env var 可下发到多台设备；一台设备可收多个 env var。
  // 下发 = upsert（重复下发即更新 pushed_at）；回收 = delete 行 + 给设备发 env:revoke。
  // 两端 FK 均 ON DELETE CASCADE：env var 删除或 device 删除时自动清理下发记录。
  db.exec(`
    CREATE TABLE IF NOT EXISTS env_var_distributions (
      env_var_id TEXT NOT NULL REFERENCES env_vars(id) ON DELETE CASCADE,
      device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      pushed_at  TEXT NOT NULL,
      PRIMARY KEY (env_var_id, device_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_env_distributions_device ON env_var_distributions(device_id)`);

  // ---- credentials / credential_distributions（ADR-0003：统一凭据值 + 显式分发）----
  //
  // credentials 取代 env_vars 作为凭据值存储（name = 旧 env_vars.key）；value_cipher
  // 复用同一 master.key 的 AES-256-GCM。credential_distributions 取代 env_var_distributions，
  // 新增 axis 维度：'env'=推设备系统环境变量（target_id=device_id）；'path'=写项目
  // .mcp.json（target_id=project_id，reconcile 时注入）。显式分发：配置值不自动下发。
  // 旧表保留供一次性迁移读取，新代码读写新表。
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      value_cipher TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_user_name ON credentials(user_id, name)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_distributions (
      credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      axis          TEXT NOT NULL,
      target_id     TEXT NOT NULL,
      pushed_at     TEXT NOT NULL,
      PRIMARY KEY (credential_id, axis, target_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_credential_dist_target ON credential_distributions(axis, target_id)`);

  // ---- tool_config_profiles：Codex / Claude Code 用户级配置档 + 设备下发状态 ----
  // secret_cipher 存 API Key / Auth Token；config_json 仅存非敏感配置。每台设备每个
  // 工具只记录最近一次成功下发的 profile，切换配置档时原子替换该指针。
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_config_profiles (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      tool          TEXT NOT NULL,
      config_json   TEXT NOT NULL,
      secret_cipher TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_profiles_user_tool_name ON tool_config_profiles(user_id, tool, name)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_config_distributions (
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      tool       TEXT NOT NULL,
      profile_id TEXT NOT NULL REFERENCES tool_config_profiles(id) ON DELETE CASCADE,
      pushed_at  TEXT NOT NULL,
      PRIMARY KEY (device_id, tool)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_config_dist_profile ON tool_config_distributions(profile_id)`);

  // 一次性迁移：env_vars → credentials；env_var_distributions → credential_distributions(axis='env')。
  try {
    const migrated = (db.prepare("SELECT COUNT(*) AS c FROM credentials").get() as { c: number }).c;
    if (migrated === 0) {
      const now = new Date().toISOString();
      const credIns = db.prepare(
        "INSERT INTO credentials (id, user_id, name, value_cipher, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const idMap = new Map<string, string>();
      for (const r of db.prepare("SELECT id, user_id, key, value_cipher, COALESCE(description,'') AS description, created_at, updated_at FROM env_vars").all() as any[]) {
        const nid = generateId();
        credIns.run(nid, r.user_id, r.key, r.value_cipher, r.description, r.created_at, r.updated_at);
        idMap.set(r.id, nid);
      }
      const distIns = db.prepare(
        "INSERT OR IGNORE INTO credential_distributions (credential_id, axis, target_id, pushed_at) VALUES (?, 'env', ?, ?)",
      );
      for (const d of db.prepare("SELECT env_var_id, device_id, pushed_at FROM env_var_distributions").all() as any[]) {
        const nid = idMap.get(d.env_var_id);
        if (nid) distIns.run(nid, d.device_id, d.pushed_at);
      }
    }
  } catch { /* 旧表不存在或已迁移——忽略 */ }

  // ---- credential_usages：凭据「被用到哪里」的使用记录（ADR-0003 决策 8）----
  //
  // reconcile-end 钩子维护：每次 reconcile 完成后对受影响资产 upsert 其当前 path
  // 绑定行（INSERT OR IGNORE，超集保证轮换不漏项目）；MCP 从项目移除时删其行。
  // 仅记录 path 绑定的使用（env 绑定通过 credential_distributions axis=env 体现设备维度）。
  // 读侧 LEFT JOIN project_installed_assets 过滤项目已不再装该资产的孤儿行。
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_usages (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_name TEXT NOT NULL,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      asset_id      TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      path          TEXT NOT NULL,
      recorded_at   TEXT NOT NULL,
      UNIQUE (project_id, asset_id, path)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_credential_usages_cred ON credential_usages(user_id, credential_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_credential_usages_project ON credential_usages(project_id)`);

  // ADR-0004：凭据创建时即定型 axis（env/path），禁止跨轴分发。新增 axis 列：
  //  - 老库回填：凭据若有 path 轴分发记录（credential_distributions axis='path'）
  //    或被 credential_usages（声明侧 path 使用）引用 → axis='path'；否则 'env'。
  //    （credential_usages 仅记录 path 绑定使用，故其存在即判 path。）
  //  - 仅对已有凭据补默认值；新建走路由层显式 axis。
  try {
    const cols = db.prepare("PRAGMA table_info(credentials)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "axis")) {
      db.exec(`ALTER TABLE credentials ADD COLUMN axis TEXT NOT NULL DEFAULT 'env'`);
      db.exec(`
        UPDATE credentials
           SET axis = 'path'
         WHERE EXISTS (
           SELECT 1 FROM credential_distributions d
            WHERE d.credential_id = credentials.id AND d.axis = 'path'
         )
         OR EXISTS (
           SELECT 1 FROM credential_usages u
            WHERE u.credential_name = credentials.name
         )
      `);
    }
  } catch { /* 列已存在或迁移已跑——忽略 */ }

  // ---- user_ai_settings：设置页 AI 生成配置（每用户一份）----
  //
  // 旧实现把 ai.base_url / ai.model / ai.api_key 存在全局 app_settings（所有人共用
  // 一份）。改为按用户隔离：每个用户配置自己的 AI Base URL / 模型 / API Key。
  // api_key_cipher 为 AES-256-GCM 密文（自包含 iv:tag:cipher，复用 env_vars 的
  // master.key），明文永不落 DB——相较旧的全局明文 ai.api_key 是严格升级。
  // 一行一用户，无行 = 未配置（GET 返回默认值）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_ai_settings (
      user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      base_url       TEXT NOT NULL DEFAULT '',
      model          TEXT NOT NULL DEFAULT '',
      api_key_cipher TEXT NOT NULL DEFAULT '',
      updated_at     TEXT NOT NULL
    )
  `);

  // ---- 语义搜索派生索引（docs/sqlite-vec-search-design.md §3）----
  // 三张表均为派生索引，权威源是 assets；可随时 DROP 重建。asset_vec/asset_fts/
  // asset_embeddings 的字段与向量化字段（name/tags/description）一致，正文不参与。
  // 软删/硬删 asset 时由写入钩子物理清理对应派生行（§5.4）。

  // 词法路：FTS5（ADR-0002，入队时同步写，解耦于 vec worker）。
  // trigram tokenizer 支持中文子串匹配，零外部依赖（决策 A）。
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(
      asset_id UNINDEXED,
      name, tags, description,
      tokenize = 'trigram'
    )
  `);

  // 队列 + 向量化元数据（决策 E）：asset_id 主键天然去重，status 驱动状态机
  // pending → processing → ready/failed。content_hash 用于判断是否需重算。
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_embeddings (
      asset_id        TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      status          TEXT NOT NULL,
      queued_at       TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error      TEXT,
      embed_model     TEXT,
      embed_dim       INTEGER NOT NULL,
      content_hash    TEXT NOT NULL,
      field_version   INTEGER NOT NULL,
      processed_at    TEXT,
      updated_at      TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_asset_emb_status_queue
           ON asset_embeddings(status, next_attempt_at, queued_at)
           WHERE status IN ('pending', 'processing')`);

  // 语义路：sqlite-vec 向量虚拟表（ADR-0001：metadata 列 + distance=cosine）。
  // 维度取自配置 search.embedding.dim（默认 4096）；model/dim 变更由重建模式
  // 处理（§5.6）—— IF NOT EXISTS 不会按新 dim 重建，需 DROP+CREATE。
  // 仅在 sqlite-vec 扩展加载成功时创建；失败则降级为纯词法（§3.3）。
  if (vecAvailable()) {
    const configuredDim = Number(appSettings.get("search.embedding.dim") ?? 4096);
    const dim = Number.isFinite(configuredDim) && configuredDim > 0 ? configuredDim : 4096;
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS asset_vec USING vec0(
      embedding float[${dim}] distance=cosine,
      asset_id  TEXT,
      field     TEXT
    )`);
  }

  // ---- 能力信息生成队列（ADR-0005，镜像 asset_embeddings，补缺口模型）----
  //
  // 后台为已落库能力自动补全空缺的 alias/tags/description/auth.bindings。
  // 派生索引：权威源是 assets/asset_auth_bindings，本表可 DROP 重建。
  // 镜像 asset_embeddings 的状态机与队列字段，但补缺口模型下「字段是否为空」即
  // 是否需调 AI 的信号，故无 content_hash/field_version/embed_dim。
  // 软删/硬删 asset 时由写入钩子物理清理本表行（与 removeSearchIndex 同模式）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_ai_info (
      asset_id        TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
      status          TEXT NOT NULL,
      queued_at       TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error      TEXT,
      gen_model       TEXT,
      processed_at    TEXT,
      updated_at      TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_asset_ai_info_status_queue
           ON asset_ai_info(status, next_attempt_at, queued_at)
           WHERE status IN ('pending', 'processing')`);
}
