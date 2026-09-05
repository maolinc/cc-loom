import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { generateId } from "../lib/crypto.js";
import { assetCreateSchema, assetUpdateSchema, assetSearchSchema, skillFilesHaveEntry } from "@maolinc/cc-loom-shared";
import type { AssetAuthBinding } from "@maolinc/cc-loom-shared";
import { requireAuth } from "../lib/auth.js";
import { deleteOrRetainAsset, assetRefs } from "../lib/asset-gc.js";
import { syncAssetContentToProjects } from "../lib/auto-sync.js";
import { enqueue } from "../lib/search-indexer.js";
import { enqueue as enqueueAiInfo } from "../lib/ai-info-indexer.js";
import { hybridSearch } from "../lib/search-query.js";
import { embeddingSettings } from "../lib/embedding-config.js";
import { buildAssetPreviewEntries, zipEntries, downloadFilename } from "../lib/download-archive.js";

/** lite 详情内联默认文件内容的上限：超过则不内联、仍由前端按需加载，避免大文件拖慢首屏。 */
const PRIMARY_FILE_INLINE_LIMIT = 256 * 1024;

/** 内容实际字节数：base64 解码后长度 / UTF-8 文本字节数。 */
function byteLen(content: string, encoding?: string | null): number {
  return encoding === "base64"
    ? Buffer.from(content, "base64").length
    : Buffer.byteLength(content, "utf8");
}

function serialize(row: any, prefetchedFiles?: any[], includeContent = true) {
  const files = prefetchedFiles ?? db.prepare(
    "SELECT * FROM asset_files WHERE asset_id = ? ORDER BY path"
  ).all(row.id) as any[];
  return {
    ...row,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags || "[]"),
    compatibleTools: JSON.parse(row.compatible_tools || "[]"),
    metadata: JSON.parse(row.metadata || "{}"),
    files: files.map((f) => {
      const base = {
        id: f.id,
        assetId: f.asset_id,
        path: f.path,
        encoding: f.encoding ?? undefined,
        size: f.size,
        createdAt: f.created_at,
        updatedAt: f.updated_at,
      };
      return includeContent ? { ...base, content: f.content } : base;
    }),
    sourceId: row.source_id ?? null,
    sourcePath: row.source_path ?? null,
    sourceOriginAuthor: row.source_origin_author ?? null,
    sourceDisplayName: row.source_display_name ?? null,
    sourceAddedBy: row.source_added_by ?? null,
    sourceUrl: row.source_url ?? row.source_repo_url ?? null,
    invocationCount: row.invocation_count ?? 0,
    auth: serializeAuth(row, row.id),
    retained: !!row.deleted_at,
  };
}

/** 加载一个 asset 的鉴权绑定列表（从 asset_auth_bindings 子表，按 ordinal 排序）。 */
function loadAssetAuthBindings(assetId: string): AssetAuthBinding[] {
  const rows = db.prepare(
    "SELECT credential_name, kind, env_key, path, auth_page_url FROM asset_auth_bindings WHERE asset_id = ? ORDER BY ordinal",
  ).all(assetId) as {
    credential_name: string; kind: string; env_key: string | null;
    path: string | null; auth_page_url: string | null;
  }[];
  return rows.map((r) => ({
    credentialName: r.credential_name,
    kind: r.kind as AssetAuthBinding["kind"],
    ...(r.env_key ? { envKey: r.env_key } : {}),
    ...(r.path ? { path: r.path } : {}),
    ...(r.auth_page_url ? { authPageUrl: r.auth_page_url } : {}),
  }));
}

/** 全量替换一个 asset 的鉴权绑定（delete + reinsert）。供 create/update 调用。 */
function saveAssetAuthBindings(assetId: string, bindings: AssetAuthBinding[], now: string): void {
  const del = db.prepare("DELETE FROM asset_auth_bindings WHERE asset_id = ?");
  const ins = db.prepare(
    "INSERT INTO asset_auth_bindings (id, asset_id, ordinal, credential_name, kind, env_key, path, auth_page_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const tx = db.transaction(() => {
    del.run(assetId);
    bindings.forEach((b, i) => {
      ins.run(
        generateId(), assetId, i, b.credentialName, b.kind,
        b.envKey ?? null, b.path ?? null, b.authPageUrl ?? null, now,
      );
    });
  });
  tx();
}

/**
 * 把 asset 行的鉴权声明映射成 AssetAuth 对象。无绑定 → undefined（免鉴权）。
 * 绑定来源是 asset_auth_bindings 子表（ADR-0003，旧 auth_* 列仅迁移用）。
 */
function serializeAuth(_row: any, assetId: string) {
  const bindings = loadAssetAuthBindings(assetId);
  if (bindings.length === 0) return undefined;
  return { bindings };
}

/** 批量预取 asset_files 的元信息（不含 content），用于列表接口避免读取大字段。 */
function batchLoadAssetFileMeta(assetIds: string[]): Map<string, any[]> {
  const map = new Map<string, any[]>();
  if (assetIds.length === 0) return map;
  const rows = db.prepare(
    `SELECT id, asset_id, path, encoding, size, created_at, updated_at FROM asset_files WHERE asset_id IN (${assetIds.map(() => "?").join(",")}) ORDER BY asset_id, path`
  ).all(...assetIds) as any[];
  for (const r of rows) {
    let arr = map.get(r.asset_id);
    if (!arr) { arr = []; map.set(r.asset_id, arr); }
    arr.push(r);
  }
  return map;
}

/** 按给定 id 列表拉取 asset 行（含 source 关联），返回 id→row 映射（不保证顺序）。 */
function fetchAssetsByIds(assetIds: string[]): Map<string, any> {
  const map = new Map<string, any>();
  if (assetIds.length === 0) return map;
  const rows = db.prepare(
    `SELECT a.*, s.display_name AS source_display_name, s.added_by AS source_added_by, s.repo_url AS source_repo_url
     FROM assets a
     LEFT JOIN marketplace_sources s ON s.id = a.source_id
     WHERE a.id IN (${assetIds.map(() => "?").join(",")})`
  ).all(...assetIds) as any[];
  for (const r of rows) map.set(r.id, r);
  return map;
}

export function assetRoutes(app: FastifyInstance) {
  app.get("/api/assets", async (request, reply) => {
    const parsed = assetSearchSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "查询参数不正确" });
    }

    const { query, type, tags, source, visibility, page, pageSize } = parsed.data;
    // adopted=1 的 asset 是本地控制台 adopt 外部能力的产物，仅供 reconcile 使用，不进能力市场。
    const visibilityConds: string[] = ["a.deleted_at IS NULL", "a.adopted = 0"];
    const visibilityParams: any[] = [];

    if (!request.isAuthenticated) {
      visibilityConds.push("a.visibility = 'public'");
    } else if (request.user!.role === "admin") {
      // admin 可见全部（含他人的 private）
      if (visibility === "private") {
        visibilityConds.push("a.visibility = 'private'");
      } else if (visibility === "public") {
        visibilityConds.push("a.visibility = 'public'");
      }
    } else if (visibility === "private") {
      visibilityConds.push("a.visibility = 'private' AND a.author = ?");
      visibilityParams.push(request.user!.email);
    } else if (visibility === "public") {
      visibilityConds.push("a.visibility = 'public'");
    } else {
      visibilityConds.push("(a.visibility = 'public' OR (a.visibility = 'private' AND a.author = ?))");
      visibilityParams.push(request.user!.email);
    }

    const visibleWhere = visibilityConds.join(" AND ");

    // 有查询词且至少启用一种搜索模式 → 混合检索（FTS5 + sqlite-vec 融合，由 useLexical/useSemantic 决定走哪条）。
    // 候选为空时回退 LIKE，保证不回归。详见 docs/sqlite-vec-search-design.md §2.4/§6。
    const searchCfg = embeddingSettings.get();
    if (query && (searchCfg.useLexical || searchCfg.useSemantic)) {
      const result = await hybridSearch({
        visibleWhere,
        visibleParams: visibilityParams,
        query,
        type,
        tags,
        source,
        page,
        pageSize,
      });
      if (result.total > 0) {
        reply.header("X-Loom-Search-Mode", result.mode);
        const rowsById = fetchAssetsByIds(result.assetIds);
        const filesMap = batchLoadAssetFileMeta(result.assetIds);
        return {
          success: true,
          data: result.assetIds.map((id) => serialize(rowsById.get(id), filesMap.get(id) ?? [], false)).filter(Boolean),
          total: result.total, page, pageSize,
        };
      }
      // 候选为空 → 回退 LIKE 词法
    }

    // 默认词法路径（LIKE）。embedding 未启用 / 混合检索无候选时走此路。
    if (query) reply.header("X-Loom-Search-Mode", "lexical");
    const conditions: string[] = [visibleWhere];
    const params: any[] = [...visibilityParams];

    if (query) {
      conditions.push("(a.name LIKE ? OR a.alias LIKE ? OR a.description LIKE ?)");
      params.push(`%${query}%`, `%${query}%`, `%${query}%`);
    }
    if (type) {
      conditions.push("a.type = ?");
      params.push(type);
    }
    // 按来源筛选："local" 表示本地创建（无来源），其余为具体来源 ID。
    if (source) {
      if (source === "local") {
        conditions.push("a.source_id IS NULL");
      } else {
        conditions.push("a.source_id = ?");
        params.push(source);
      }
    }
    if (tags && tags.length > 0) {
      const tagConds = tags.map(() => "a.tags LIKE ?");
      conditions.push(`(${tagConds.join(" OR ")})`);
      params.push(...tags.map((t) => `%"${t}"%`));
    }

    const where = conditions.join(" AND ");
    const total = (db.prepare(
      `SELECT COUNT(*) as count FROM assets a WHERE ${where}`
    ).get(...params) as any).count;
    const rows = db
      .prepare(`
        SELECT a.*, s.display_name AS source_display_name, s.added_by AS source_added_by, s.repo_url AS source_repo_url
        FROM assets a
        LEFT JOIN marketplace_sources s ON s.id = a.source_id
        WHERE ${where}
        ORDER BY a.updated_at DESC LIMIT ? OFFSET ?
      `)
      .all(...params, pageSize, (page - 1) * pageSize);

    const assetIds = (rows as any[]).map((r: any) => r.id);
    // 列表只返回文件元信息（path/size 等），不读取/传输 content，避免大字段拖慢列表。
    const filesMap = batchLoadAssetFileMeta(assetIds);
    return { success: true, data: (rows as any[]).map((r: any) => serialize(r, filesMap.get(r.id) ?? [], false)), total, page, pageSize };
  });

  /**
   * 能力市场「按来源筛选」用的来源清单：仅返回当前可见能力实际引用到的第三方来源，
   * 附带各来源下可见能力数量。遵循与 /api/assets 相同的可见性规则（匿名仅 public）。
   * 注册在 /api/assets/:id 之前——Fastify 静态路由优先，不会被参数路由吞掉。
   */
  app.get("/api/assets/sources", async (request) => {
    const conditions: string[] = ["a.deleted_at IS NULL", "a.source_id IS NOT NULL"];
    const params: any[] = [];
    if (!request.isAuthenticated) {
      conditions.push("a.visibility = 'public'");
    } else if (request.user!.role !== "admin") {
      conditions.push("(a.visibility = 'public' OR (a.visibility = 'private' AND a.author = ?))");
      params.push(request.user!.email);
    }
    const where = conditions.join(" AND ");
    const rows = db.prepare(`
      SELECT s.id AS id, s.display_name AS displayName, COUNT(*) AS count
      FROM assets a
      JOIN marketplace_sources s ON s.id = a.source_id
      WHERE ${where}
      GROUP BY s.id, s.display_name
      ORDER BY count DESC, s.display_name ASC
    `).all(...params);
    return { success: true, data: rows };
  });

  app.get("/api/assets/:id", async (request, reply) => {
    const row = db.prepare(`
      SELECT a.*, s.display_name AS source_display_name, s.added_by AS source_added_by, s.repo_url AS source_repo_url
      FROM assets a
      LEFT JOIN marketplace_sources s ON s.id = a.source_id
      WHERE a.id = ?
    `).get((request.params as any).id) as any;
    if (!row || row.deleted_at) {
      return reply.status(404).send({ success: false, error: "能力不存在" });
    }
    if (row.visibility === "private" && (!request.isAuthenticated || (row.author !== request.user!.email && request.user!.role !== "admin"))) {
      return reply.status(404).send({ success: false, error: "能力不存在" });
    }
    // ?lite=1：只返回文件元信息（不含 content），供详情预览按需加载文件内容，
    // 避免大文件随详情一次性返回导致卡顿。编辑器等需要完整内容的场景不传 lite。
    const lite = (request.query as any)?.lite === "1" || (request.query as any)?.lite === "true";
    const payload: any = { ...serialize(row, undefined, !lite), refs: assetRefs(row.id) };
    // lite 模式额外内联默认（按 path 排序首个）文件内容，让预览首屏一次请求即可
    // 渲染，避免「详情返回 → 再请求首个文件内容」的串行延迟。超过阈值的默认文件
    // 不内联，仍由前端按需加载。
    if (lite) {
      const primary = db.prepare(
        "SELECT path, content, encoding, size FROM asset_files WHERE asset_id = ? ORDER BY path LIMIT 1"
      ).get(row.id) as any;
      if (primary && (primary.size ?? 0) <= PRIMARY_FILE_INLINE_LIMIT) {
        payload.defaultFile = {
          path: primary.path,
          content: primary.content,
          encoding: primary.encoding ?? undefined,
          size: primary.size,
        };
      }
    }
    return { success: true, data: payload };
  });

  /**
   * On-demand single-file content lookup. Used by the capabilitySet detail panel,
   * which receives files (path + size only) up-front and fetches content for
   * the file the user is actually viewing.
   */
  app.get("/api/assets/:id/file", async (request, reply) => {
    const assetId = (request.params as any).id;
    const path = (request.query as any)?.path;
    if (typeof path !== "string" || path.length === 0) {
      return reply.status(400).send({ success: false, error: "缺少 path 参数" });
    }
    const asset = db.prepare("SELECT id, visibility, author, deleted_at FROM assets WHERE id = ?").get(assetId) as any;
    if (!asset || asset.deleted_at) {
      return reply.status(404).send({ success: false, error: "能力不存在" });
    }
    if (asset.visibility === "private") {
      if (!request.isAuthenticated || (asset.author !== request.user!.email && request.user!.role !== "admin")) {
        return reply.status(404).send({ success: false, error: "能力不存在" });
      }
    }
    const file = db.prepare(
      "SELECT path, content, encoding, size FROM asset_files WHERE asset_id = ? AND path = ?"
    ).get(assetId, path) as any;
    if (!file) {
      return reply.status(404).send({ success: false, error: "文件不存在" });
    }
    return {
      success: true,
      data: { path: file.path, content: file.content, encoding: file.encoding ?? undefined, size: file.size },
    };
  });

  /**
   * 单能力下载：zip 内为该能力所有 asset_files 的铺放——目录型 `<name>/<file.path>`，
   * 平铺型直接 `<file.path>`，不带顶层能力类型目录（zip 就是「能力本身」）。
   * 原样不聚合、不重组，完整体不多不少。可见性与详情接口一致。
   */
  app.get("/api/assets/:id/download", async (request, reply) => {
    const row = db.prepare("SELECT * FROM assets WHERE id = ?").get((request.params as any).id) as any;
    if (!row || row.deleted_at) {
      return reply.status(404).send({ success: false, error: "能力不存在" });
    }
    if (row.visibility === "private" && (!request.isAuthenticated || (row.author !== request.user!.email && request.user!.role !== "admin"))) {
      return reply.status(404).send({ success: false, error: "能力不存在" });
    }
    const files = db.prepare(
      "SELECT path, content, encoding FROM asset_files WHERE asset_id = ? ORDER BY path"
    ).all(row.id) as any[];
    const entries = buildAssetPreviewEntries(
      {
        type: row.type,
        name: row.name,
        sourcePath: row.source_path ?? null,
        files: files.map((f: any) => ({ path: f.path, content: f.content, encoding: f.encoding })),
      },
      { typeDir: false },
    );
    const zip = zipEntries(entries);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${downloadFilename(row.name)}"`);
    return reply.send(zip);
  });

  app.post("/api/assets", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = assetCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const now = new Date().toISOString();
    const id = generateId();
    db.prepare(
      `INSERT INTO assets (id, name, alias, source_url, type, description, author, tags, compatible_tools, visibility, version, metadata, auth_method, auth_env_key, auth_page_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', NULL, NULL, ?, ?)`
    ).run(
      id, parsed.data.name, parsed.data.alias || null, parsed.data.sourceUrl || null, parsed.data.type, parsed.data.description,
      request.user!.email, JSON.stringify(parsed.data.tags),
      JSON.stringify(parsed.data.compatibleTools), parsed.data.visibility, "1.0.0",
      JSON.stringify(parsed.data.metadata),
      now, now
    );

    saveAssetAuthBindings(id, parsed.data.auth?.bindings ?? [], now);

    for (const f of parsed.data.files) {
      db.prepare(
        "INSERT INTO asset_files (id, asset_id, path, content, encoding, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(generateId(), id, f.path, f.content, f.encoding ?? null, byteLen(f.content, f.encoding), now, now);
    }

    // 语义搜索：新建能力入队索引（FTS5 同步写，vec 异步）
    enqueue(id, "new");
    // 能力信息生成：新建能力入队（补缺口，worker 异步）
    enqueueAiInfo(id, "new");

    const created = db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
    return { success: true, data: serialize(created) };
  });

  app.put("/api/assets/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = db.prepare(`
      SELECT a.*, s.added_by AS source_added_by
      FROM assets a
      LEFT JOIN marketplace_sources s ON s.id = a.source_id
      WHERE a.id = ?
    `).get((request.params as any).id) as any;
    if (!existing || existing.deleted_at) {
      return reply.status(404).send({ success: false, error: "能力不存在" });
    }

    const canEdit = existing.author === request.user!.email || existing.source_added_by === request.user!.email || request.user!.role === "admin";
    if (!canEdit) {
      return reply.status(403).send({ success: false, error: "只能修改自己创建或导入的能力" });
    }

    const parsed = assetUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const d = parsed.data;

    if (d.name !== undefined && d.name !== existing.name) {
      const refs = assetRefs(existing.id);
      if (refs.total > 0) {
        return reply.status(409).send({
          success: false,
          error: "该能力已被能力集或本地项目引用，不能修改名称；如需调整展示文案，请修改别名",
        });
      }
    }

    // Skill 领域规则兜底：更新若改动 files，则现有 skill 必须仍包含 SKILL.md。
    // （schema 仅在 payload 带 type 时校验，update payload 通常不带 type。）
    if (existing.type === "skill" && d.files !== undefined && !skillFilesHaveEntry(d.files)) {
      return reply.status(400).send({ success: false, error: "Skill 必须包含一个 SKILL.md 文件（位于技能目录根）" });
    }

    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [new Date().toISOString()];

    if (d.name !== undefined) { sets.push("name = ?"); params.push(d.name); }
    if (d.alias !== undefined) { sets.push("alias = ?"); params.push(d.alias || null); }
    if (d.sourceUrl !== undefined) { sets.push("source_url = ?"); params.push(d.sourceUrl || null); }
    if (d.description !== undefined) { sets.push("description = ?"); params.push(d.description); }
    if (d.tags !== undefined) { sets.push("tags = ?"); params.push(JSON.stringify(d.tags)); }
    if (d.compatibleTools !== undefined) { sets.push("compatible_tools = ?"); params.push(JSON.stringify(d.compatibleTools)); }
    if (d.visibility !== undefined) { sets.push("visibility = ?"); params.push(d.visibility); }
    if (d.version !== undefined) { sets.push("version = ?"); params.push(d.version); }
    if (d.metadata !== undefined) { sets.push("metadata = ?"); params.push(JSON.stringify(d.metadata)); }
    // 鉴权声明落 asset_auth_bindings 子表（ADR-0003）；旧 auth_* 列不再写入。
    if (d.auth !== undefined) {
      saveAssetAuthBindings(existing.id, d.auth.bindings ?? [], new Date().toISOString());
    }

    params.push(existing.id);
    db.prepare(`UPDATE assets SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    if (d.files !== undefined) {
      const now = new Date().toISOString();
      db.prepare("DELETE FROM asset_files WHERE asset_id = ?").run(existing.id);
      for (const f of d.files) {
        db.prepare(
          "INSERT INTO asset_files (id, asset_id, path, content, encoding, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(generateId(), existing.id, f.path, f.content, f.encoding ?? null, byteLen(f.content, f.encoding), now, now);
      }
    }

    const updated = db.prepare("SELECT * FROM assets WHERE id = ?").get(existing.id);
    // 自动同步：内容相关字段（文件 / 元数据 / 兼容工具 / 名称 / 鉴权绑定）变化时，回推到
    // 安装了该 asset（auto + 在线）的项目，覆盖落盘。鉴权绑定变化会改变 .mcp.json 注入结果，
    // 故同样触发。fire-and-forget。
    if (d.files !== undefined || d.metadata !== undefined || d.compatibleTools !== undefined || d.name !== undefined || d.auth !== undefined) {
      syncAssetContentToProjects(existing.id);
    }
    // 语义搜索：编辑后按 content_hash 变化重排（FTS5 同步刷新）；正文变化不触发
    enqueue(existing.id, "auto");
    // 能力信息生成：编辑后重扫空缺（gap-fill，worker 异步）；仅在仍有空字段或首次时重算
    enqueueAiInfo(existing.id, "auto");
    return { success: true, data: serialize(updated) };
  });

  app.delete("/api/assets/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = db.prepare("SELECT * FROM assets WHERE id = ?").get((request.params as any).id) as any;
    if (!existing || existing.deleted_at) {
      return reply.status(404).send({ success: false, error: "能力不存在" });
    }

    if (existing.source_id) {
      return reply.status(403).send({ success: false, error: "来自数据来源的能力为只读" });
    }
    if (existing.author !== request.user!.email && request.user!.role !== "admin") {
      return reply.status(403).send({ success: false, error: "只能删除自己创建的能力" });
    }

    // 使用中（被能力集组合或某项目安装引用）→ 软删留存；未使用 → 直接硬删。
    deleteOrRetainAsset(existing.id);

    return { success: true };
  });
}
