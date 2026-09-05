import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { generateId } from "../lib/crypto.js";
import { workspaceCreateSchema, workspaceUpdateSchema, workspaceSearchSchema } from "@maolinc/cc-loom-shared";
import { requireAuth } from "../lib/auth.js";
import { detectInstallKeyConflicts } from "../lib/asset-conflicts.js";
import { workspaceRefCount } from "../lib/workspace-gc.js";
import { maybeGcRetiredAsset } from "../lib/asset-gc.js";
import { syncWorkspaceMembersToProjects } from "../lib/auto-sync.js";
import type { Manifest } from "@maolinc/cc-loom-shared";
import { TARGET_TOOLS } from "@maolinc/cc-loom-shared";
import type { TargetTool } from "@maolinc/cc-loom-shared";
import { buildWorkspacePreviewEntries, buildWorkspaceVendorEntries, zipEntries, downloadFilename } from "../lib/download-archive.js";

/**
 * Light serializer used by workspace detail / update responses. Returns file
 * metadata only — `content` is intentionally omitted to keep the response
 * small. Clients fetch a single file's content on demand via
 * `GET /api/assets/:id/file?path=...`.
 *
 * Also normalises the source-* columns to camelCase and parses metadata so
 * the shape matches `/api/assets/:id` (consumed by `isAssetDirLayout`).
 */
function serializeAssetLight(row: any, prefetchedFiles?: any[]) {
  const files = prefetchedFiles ?? db.prepare(
    "SELECT id, asset_id, path, size, created_at, updated_at FROM asset_files WHERE asset_id = ? ORDER BY path"
  ).all(row.id) as any[];
  return {
    ...row,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags || "[]"),
    compatibleTools: JSON.parse(row.compatible_tools || "[]"),
    metadata: JSON.parse(row.metadata || "{}"),
    files: files.map((f) => ({
      id: f.id,
      assetId: f.asset_id,
      path: f.path,
      size: f.size,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    })),
    sourceId: row.source_id ?? null,
    sourcePath: row.source_path ?? null,
    sourceOriginAuthor: row.source_origin_author ?? null,
    sourceDisplayName: row.source_display_name ?? null,
    retained: !!row.deleted_at,
  };
}

/** 批量预取 asset_files (light: 无 content)，按 asset_id 分组 */
function batchLoadAssetFilesLight(assetIds: string[]): Map<string, any[]> {
  const map = new Map<string, any[]>();
  if (assetIds.length === 0) return map;
  const rows = db.prepare(
    `SELECT id, asset_id, path, size, created_at, updated_at FROM asset_files WHERE asset_id IN (${assetIds.map(() => "?").join(",")}) ORDER BY asset_id, path`
  ).all(...assetIds) as any[];
  for (const r of rows) {
    let arr = map.get(r.asset_id);
    if (!arr) { arr = []; map.set(r.asset_id, arr); }
    arr.push(r);
  }
  return map;
}

export function workspaceRoutes(app: FastifyInstance) {
  app.get("/api/workspaces", async (request, reply) => {
    const parsed = workspaceSearchSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: "查询参数不正确" });
    }

    const { query, visibility, page, pageSize } = parsed.data;
    const conditions: string[] = ["w.deleted_at IS NULL"];
    const params: any[] = [];

    if (!request.isAuthenticated) {
      conditions.push("w.visibility = 'public'");
    } else if (request.user!.role === "admin") {
      // admin 可见全部（含他人的 private）
      if (visibility === "private") {
        conditions.push("w.visibility = 'private'");
      } else if (visibility === "public") {
        conditions.push("w.visibility = 'public'");
      }
    } else {
      // Authenticated: show all public + own private workspaces
      if (visibility) {
        if (visibility === "private") {
          conditions.push("w.visibility = 'private' AND w.user_id = ?");
          params.push(request.user!.userId);
        } else {
          conditions.push("w.visibility = 'public'");
        }
      } else {
        conditions.push("(w.visibility = 'public' OR (w.visibility = 'private' AND w.user_id = ?))");
        params.push(request.user!.userId);
      }
    }

    if (query) {
      conditions.push("(w.name LIKE ? OR w.description LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }

    const where = conditions.join(" AND ");
    const total = (db.prepare(`SELECT COUNT(*) as count FROM workspaces w WHERE ${where}`).get(...params) as any).count;
    const rows = db
      .prepare(`
        SELECT w.*, s.display_name AS source_display_name, s.added_by AS source_added_by, s.repo_url AS source_repo_url, u.email AS author
        FROM workspaces w
        LEFT JOIN marketplace_sources s ON s.id = w.source_id
        LEFT JOIN users u ON u.id = w.user_id
        WHERE ${where}
        ORDER BY w.updated_at DESC LIMIT ? OFFSET ?
      `)
      .all(...params, pageSize, (page - 1) * pageSize) as any[];

    // 批量查询所有命中 workspace 的 asset 关联，避免 N+1
    const wsIds = rows.map((r) => r.id);
    const wsAssetRows = wsIds.length > 0
      ? db.prepare(
          `SELECT wa.workspace_id, wa.asset_id, a.type
           FROM workspace_assets wa
           LEFT JOIN assets a ON a.id = wa.asset_id
           WHERE wa.workspace_id IN (${wsIds.map(() => "?").join(",")})`
        ).all(...wsIds) as { workspace_id: string; asset_id: string; type: string | null }[]
      : [];
    // 按 workspace_id 分组
    const wsAssetMap = new Map<string, { assetIds: string[]; assetTypes: string[] }>();
    for (const r of wsAssetRows) {
      let entry = wsAssetMap.get(r.workspace_id);
      if (!entry) { entry = { assetIds: [], assetTypes: [] }; wsAssetMap.set(r.workspace_id, entry); }
      entry.assetIds.push(r.asset_id);
      if (r.type) entry.assetTypes.push(r.type);
    }

    const data = rows.map((row) => {
      const entry = wsAssetMap.get(row.id);
      return {
        ...row,
        targetTools: JSON.parse(row.target_tools || "[]"),
        author: row.author ?? null,
        sourceId: row.source_id ?? null,
        sourceDisplayName: row.source_display_name ?? null,
        sourceAddedBy: row.source_added_by ?? null,
        sourceUrl: row.source_repo_url ?? null,
        assetIds: entry?.assetIds ?? [],
        assetTypes: entry?.assetTypes ?? [],
      };
    });

    return { success: true, data, total, page, pageSize };
  });

  app.get("/api/workspaces/:id", async (request, reply) => {
    const row = db.prepare(`
      SELECT w.*, s.display_name AS source_display_name, s.added_by AS source_added_by, s.repo_url AS source_repo_url, u.email AS author
      FROM workspaces w
      LEFT JOIN marketplace_sources s ON s.id = w.source_id
      LEFT JOIN users u ON u.id = w.user_id
      WHERE w.id = ?
    `).get((request.params as any).id) as any;
    if (!row || row.deleted_at) {
      return reply.status(404).send({ success: false, error: "工作空间不存在" });
    }
    if (row.visibility === "private" && (!request.isAuthenticated || (row.user_id !== request.user!.userId && request.user!.role !== "admin"))) {
      return reply.status(404).send({ success: false, error: "工作空间不存在" });
    }

    const wa = db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?").all(row.id) as any[];
    const assetIds = wa.map((a) => a.asset_id);
    // 含留存（已软删但仍被本空间引用）成员：删除 asset 不应使其从空间里静默消失，
    // 仅从 asset 库浏览中隐藏；serializeAssetLight 会带上 retained 标识供 UI 标注。
    const assets = assetIds.length > 0
      ? db.prepare(`SELECT * FROM assets WHERE id IN (${assetIds.map(() => "?").join(",")})`).all(...assetIds) as any[]
      : [];
    const filesMap = batchLoadAssetFilesLight(assetIds);

    return {
      success: true,
      data: {
        ...row,
        targetTools: JSON.parse(row.target_tools || "[]"),
        author: row.author ?? null,
        sourceId: row.source_id ?? null,
        sourceDisplayName: row.source_display_name ?? null,
        sourceAddedBy: row.source_added_by ?? null,
        sourceUrl: row.source_repo_url ?? null,
        assets: assets.map((a) => serializeAssetLight(a, filesMap.get(a.id) ?? [])),
      },
    };
  });

  app.post("/api/workspaces", { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = workspaceCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const now = new Date().toISOString();
    const id = generateId();

    const assetIds = parsed.data.assetIds ?? [];
    // 加入工作空间即拦截落盘身份冲突：同一 (tool, 身份载体) 被多个 Asset 抢占
    // 时必然互相覆盖，必须二选一（hook 附属目录同名才算冲突）。
    const conflicts = detectInstallKeyConflicts(assetIds);
    if (conflicts.length > 0) {
      return reply.status(409).send({
        success: false,
        error: "存在落盘身份冲突，请在冲突的能力中二选一",
        conflicts,
      });
    }

    // 同名工作空间拦截：同一用户不能创建相同名字的工作空间。
    const nameConflict = db.prepare(
      "SELECT id FROM workspaces WHERE user_id = ? AND name = ? AND deleted_at IS NULL",
    ).get(request.user!.userId, parsed.data.name);
    if (nameConflict) {
      return reply.status(409).send({ success: false, error: "已存在同名工作空间，请更换名称" });
    }

    db.prepare(
      `INSERT INTO workspaces (id, user_id, name, description, target_tools, visibility, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, request.user!.userId, parsed.data.name, parsed.data.description, JSON.stringify(parsed.data.targetTools), parsed.data.visibility, "1.0.0", now, now);

    for (const assetId of assetIds) {
      db.prepare("INSERT INTO workspace_assets (id, workspace_id, asset_id) VALUES (?, ?, ?)").run(
        generateId(), id, assetId
      );
    }

    const created = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as any;
    const assets = assetIds.length > 0
      ? db.prepare(`SELECT * FROM assets WHERE id IN (${assetIds.map(() => "?").join(",")}) AND deleted_at IS NULL`).all(...assetIds) as any[]
      : [];
    const createFilesMap = batchLoadAssetFilesLight(assetIds);
    return {
      success: true,
      data: {
        ...created,
        targetTools: JSON.parse(created.target_tools || "[]"),
        assets: assets.map((a) => serializeAssetLight(a, createFilesMap.get(a.id) ?? [])),
      },
    };
  });

  app.put("/api/workspaces/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = db.prepare("SELECT * FROM workspaces WHERE id = ?").get((request.params as any).id) as any;
    if (!existing || existing.deleted_at) {
      return reply.status(404).send({ success: false, error: "工作空间不存在" });
    }
    if (existing.user_id !== request.user!.userId && request.user!.role !== "admin") {
      return reply.status(403).send({ success: false, error: "无权修改此工作空间" });
    }

    const parsed = workspaceUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const d = parsed.data;

    if (d.assetIds !== undefined) {
      const conflicts = detectInstallKeyConflicts(d.assetIds);
      if (conflicts.length > 0) {
        return reply.status(409).send({
          success: false,
          error: "存在落盘身份冲突，请在冲突的能力中二选一",
          conflicts,
        });
      }
    }

    // 改名时拦截同名冲突（排除自身）。
    if (d.name !== undefined && d.name !== existing.name) {
      const nameConflict = db.prepare(
        "SELECT id FROM workspaces WHERE user_id = ? AND name = ? AND deleted_at IS NULL AND id != ?",
      ).get(existing.user_id, d.name, existing.id);
      if (nameConflict) {
        return reply.status(409).send({ success: false, error: "已存在同名工作空间，请更换名称" });
      }
    }

    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [new Date().toISOString()];

    if (d.name !== undefined) { sets.push("name = ?"); params.push(d.name); }
    if (d.description !== undefined) { sets.push("description = ?"); params.push(d.description); }
    if (d.targetTools !== undefined) { sets.push("target_tools = ?"); params.push(JSON.stringify(d.targetTools)); }
    if (d.visibility !== undefined) { sets.push("visibility = ?"); params.push(d.visibility); }
    if (d.version !== undefined) { sets.push("version = ?"); params.push(d.version); }

    params.push(existing.id);
    db.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...params);

    if (d.assetIds !== undefined) {
      const beforeIds = (db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?")
        .all(existing.id) as { asset_id: string }[]).map((r) => r.asset_id);
      db.prepare("DELETE FROM workspace_assets WHERE workspace_id = ?").run(existing.id);
      for (const assetId of d.assetIds) {
        db.prepare("INSERT INTO workspace_assets (id, workspace_id, asset_id) VALUES (?, ?, ?)").run(
          generateId(), existing.id, assetId
        );
      }
      // 被移出本工作空间的 asset 失去一条引用，逐个尝试 GC（仅已软删且无其他引用者被删）。
      const after = new Set(d.assetIds);
      for (const id of beforeIds) if (!after.has(id)) maybeGcRetiredAsset(id);
      // 自动同步：把成员增删回推到安装了本空间（auto + 在线）的项目。fire-and-forget。
      syncWorkspaceMembersToProjects(existing.id, beforeIds, d.assetIds);
    }

    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(existing.id) as any;
    const wa2 = db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?").all(updated.id) as any[];
    const updatedAssetIds = wa2.map((a) => a.asset_id);
    const assets = updatedAssetIds.length > 0
      ? db.prepare(`SELECT * FROM assets WHERE id IN (${updatedAssetIds.map(() => "?").join(",")}) AND deleted_at IS NULL`).all(...updatedAssetIds) as any[]
      : [];
    const updateFilesMap = batchLoadAssetFilesLight(updatedAssetIds);

    return {
      success: true,
      data: {
        ...updated,
        targetTools: JSON.parse(updated.target_tools || "[]"),
        assets: assets.map((a) => serializeAssetLight(a, updateFilesMap.get(a.id) ?? [])),
      },
    };
  });

  app.delete("/api/workspaces/:id", { preHandler: [requireAuth] }, async (request, reply) => {
    const existing = db.prepare("SELECT * FROM workspaces WHERE id = ?").get((request.params as any).id) as any;
    if (!existing || existing.deleted_at) {
      return reply.status(404).send({ success: false, error: "工作空间不存在" });
    }
    if (existing.source_id) {
      return reply.status(403).send({ success: false, error: "来自数据来源的工作空间为只读" });
    }
    if (existing.user_id !== request.user!.userId && request.user!.role !== "admin") {
      return reply.status(403).send({ success: false, error: "无权删除此工作空间" });
    }

    // 引用计数决定删除方式：被活跃项目安装中 → 留存（软删，从库隐藏但仍服务已安装
    // 项目）；无引用 → 直接硬删除（连同 workspace_assets 关联，不动 assets 库）。
    if (workspaceRefCount(existing.id) > 0) {
      const now = new Date().toISOString();
      db.prepare("UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, existing.id);
    } else {
      const assetIds = (db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?")
        .all(existing.id) as { asset_id: string }[]).map((r) => r.asset_id);
      db.prepare("DELETE FROM workspace_assets WHERE workspace_id = ?").run(existing.id);
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(existing.id);
      // 这些 asset 刚失去本工作空间引用，逐个尝试 asset 级 GC（仅已软删且无其他引用者被删）。
      for (const id of assetIds) maybeGcRetiredAsset(id);
    }

    return { success: true };
  });

  app.get("/api/workspaces/:id/manifest", async (request, reply) => {
    const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get((request.params as any).id) as any;
    if (!row || row.deleted_at) {
      return reply.status(404).send({ success: false, error: "工作空间不存在" });
    }
    if (row.visibility === "private" && (!request.isAuthenticated || (row.user_id !== request.user!.userId && request.user!.role !== "admin"))) {
      return reply.status(404).send({ success: false, error: "工作空间不存在" });
    }

    return { success: true, data: buildWorkspaceManifest(row) };
  });

  /**
   * 工作空间下载：
   *  - 无 tool（默认）：预览结构铺放，所有成员资产完整包含。
   *  - 一个或多个 tool：走 adapter.generate，产出各厂商完整安装包；不兼容类型
   *    被跳过（决策点 A），返回的 X-Loom-Skipped 头供 UI 提示。
   * 不写任何描述文件，保证完整体不多不少。
   */
  app.get("/api/workspaces/:id/download", async (request, reply) => {
    const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get((request.params as any).id) as any;
    if (!row || row.deleted_at) {
      return reply.status(404).send({ success: false, error: "工作空间不存在" });
    }
    if (row.visibility === "private" && (!request.isAuthenticated || (row.user_id !== request.user!.userId && request.user!.role !== "admin"))) {
      return reply.status(404).send({ success: false, error: "工作空间不存在" });
    }

    const manifest = buildWorkspaceManifest(row);
    const rawTools = (request.query as any)?.tool;
    const tools: TargetTool[] = Array.isArray(rawTools)
      ? rawTools
      : typeof rawTools === "string" && rawTools.length > 0
        ? rawTools.split(",").map((t: string) => t.trim()).filter(Boolean)
        : [];
    // 仅接受已知厂商；未知值静默忽略，避免拼出无效路径。
    const validTools = tools.filter((t): t is TargetTool => (TARGET_TOOLS as readonly string[]).includes(t));

    let zip: Buffer;
    // 顶层目录为工作空间名，所有文件包在 <工作空间名>/ 下。
    const prefix = row.name;
    if (validTools.length === 0) {
      zip = zipEntries(buildWorkspacePreviewEntries(manifest.assets), prefix);
    } else {
      const { entries, skipped } = buildWorkspaceVendorEntries(manifest, validTools);
      zip = zipEntries(entries, prefix);
      if (skipped.length > 0) {
        reply.header("X-Loom-Skipped", encodeURIComponent(JSON.stringify(skipped)));
      }
    }
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${downloadFilename(row.name)}"`);
    return reply.send(zip);
  });
}

/** 从 workspace 行构建 Manifest（含留存成员），manifest 与 download 端点共用。 */
function buildWorkspaceManifest(row: any): Manifest {
  const wa = db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?").all(row.id) as any[];
  const assetIds = wa.map((a) => a.asset_id);
  // 含留存成员，保证已安装/重装工作空间时不会因某 asset 被从库删除而静默丢项。
  const assetRows = assetIds.length > 0
    ? db.prepare(`SELECT * FROM assets WHERE id IN (${assetIds.map(() => "?").join(",")})`).all(...assetIds) as any[]
    : [];

  return {
    workspaceId: row.id,
    workspaceName: row.name,
    version: row.version,
    targetTools: JSON.parse(row.target_tools || "[]"),
    assets: assetRows.map((a) => {
      const files = db.prepare(
        "SELECT path, content, encoding FROM asset_files WHERE asset_id = ? ORDER BY path"
      ).all(a.id) as any[];
      return {
        assetId: a.id,
        name: a.name,
        type: a.type,
        version: a.version,
        files: files.map((f: any) => ({ path: f.path, content: f.content, encoding: f.encoding ?? undefined })),
        compatibleTools: JSON.parse(a.compatible_tools || "[]"),
        metadata: JSON.parse(a.metadata || "{}"),
        sourcePath: a.source_path ?? null,
      };
    }),
  };
}
