/**
 * `POST /api/push` — CLI `loom push` 的服务端入口。
 *
 * CLI 读取本地厂商目录、解析为 ImportedAsset[] 后发送。Server 负责：
 * 1. 逐个 asset 按 (author, type, name, source_id IS NULL) upsert。
 * 2. 按 (user_id, name) 查找工作空间——存在则覆盖成员，不存在则新建。
 * 3. 对失联 asset 调 maybeGcRetiredAsset。
 *
 * 认证：requireCliAuth（CLI Bearer token）。
 */
import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { generateId } from "../lib/crypto.js";
import { pushSchema } from "@maolinc/cc-loom-shared";
import type { ImportedAsset } from "@maolinc/cc-loom-shared";
import { requireCliAuth } from "../lib/auth.js";
import { maybeGcRetiredAsset } from "../lib/asset-gc.js";
import { enqueue } from "../lib/search-indexer.js";
import { enqueue as enqueueAiInfo } from "../lib/ai-info-indexer.js";

function byteLen(content: string, encoding?: string | null): number {
  return encoding === "base64"
    ? Buffer.from(content, "base64").length
    : Buffer.byteLength(content, "utf8");
}

export function pushRoutes(app: FastifyInstance) {
  app.post("/api/push", { preHandler: [requireCliAuth] }, async (request, reply) => {
    const parsed = pushSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message || "参数不正确" });
    }

    const { name, visibility, targetTool, assets } = parsed.data;
    const userId = request.user!.userId;
    const author = request.user!.email;
    const now = new Date().toISOString();

    // ---- 0. 批次内同名能力检测 ----
    // 能力的 (type, name) 是落盘身份：同一 targetTool 下两个同名能力会写入相同路径
    // （如两个 name="westock-data" 的 skill 都落到 skills/westock-data/），必然互相
    // 覆盖。这通常源于两个目录的 SKILL.md frontmatter 写了相同的 `name`。静默折叠会
    // 丢失能力且让用户困惑（数量对、内容没变），故此处显式拦截并指出冲突来源。
    const seenByKey = new Map<string, string>();
    const dups: string[] = [];
    for (const a of assets as ImportedAsset[]) {
      const key = `${a.type}::${a.name}`;
      const prev = seenByKey.get(key);
      if (prev) {
        dups.push(`${a.type} "${a.name}"：${prev} 与 ${a.sourcePath}`);
      } else {
        seenByKey.set(key, a.sourcePath);
      }
    }
    if (dups.length > 0) {
      return reply.status(409).send({
        success: false,
        error:
          "检测到同名能力（落盘会互相覆盖），请修改其中一个的名称后重试：\n  " +
          dups.join("\n  "),
      });
    }

    // ---- 1. Upsert assets (by author + type + name, source_id IS NULL) ----
    const assetIds: string[] = [];
    const toolsJson = JSON.stringify([targetTool]);

    for (const a of assets as ImportedAsset[]) {
      const existing = db.prepare(
        "SELECT id FROM assets WHERE author = ? AND type = ? AND name = ? AND source_id IS NULL AND deleted_at IS NULL",
      ).get(author, a.type, a.name) as { id: string } | undefined;

      const metadataJson = JSON.stringify(a.metadata);
      const tagsJson = JSON.stringify(a.tags);

      if (existing) {
        db.prepare(`
          UPDATE assets
          SET description = ?, compatible_tools = ?, version = ?, metadata = ?, updated_at = ?
          WHERE id = ?
        `).run(a.description, toolsJson, a.version, metadataJson, now, existing.id);

        db.prepare("DELETE FROM asset_files WHERE asset_id = ?").run(existing.id);
        for (const f of a.files) {
          db.prepare(`
            INSERT INTO asset_files (id, asset_id, path, content, encoding, size, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(generateId(), existing.id, f.path, f.content, f.encoding ?? null, byteLen(f.content, f.encoding), now, now);
        }
        enqueue(existing.id, "auto");
        enqueueAiInfo(existing.id, "auto");
        assetIds.push(existing.id);
      } else {
        const id = generateId();
        db.prepare(`
          INSERT INTO assets (id, name, type, description, author, tags, compatible_tools, visibility, version, metadata, source_path, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, a.name, a.type, a.description, author, tagsJson, toolsJson, visibility, a.version, metadataJson, a.sourcePath, now, now);

        for (const f of a.files) {
          db.prepare(`
            INSERT INTO asset_files (id, asset_id, path, content, encoding, size, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(generateId(), id, f.path, f.content, f.encoding ?? null, byteLen(f.content, f.encoding), now, now);
        }
        enqueue(id, "new");
        enqueueAiInfo(id, "new");
        assetIds.push(id);
      }
    }

    // ---- 2. Find or create workspace (by user_id + name) ----
    const existingWs = db.prepare(
      "SELECT id, source_id FROM workspaces WHERE user_id = ? AND name = ? AND deleted_at IS NULL",
    ).get(userId, name) as { id: string; source_id: string | null } | undefined;

    let workspaceId: string;
    let created: boolean;

    if (existingWs) {
      // 来自 marketplace 的 workspace 不允许 push 覆盖
      if (existingWs.source_id) {
        return reply.status(409).send({
          success: false,
          error: `工作空间「${name}」来自数据来源，不能被推送覆盖，请更换名称`,
        });
      }
      workspaceId = existingWs.id;
      created = false;

      db.prepare(`
        UPDATE workspaces
        SET description = ?, target_tools = ?, visibility = ?, version = ?, updated_at = ?
        WHERE id = ?
      `).run(`由 loom push 推送（${targetTool}）`, toolsJson, visibility, "1.0.0", now, workspaceId);

      // 记录旧成员用于 GC
      const oldAssetIds = (db.prepare("SELECT asset_id FROM workspace_assets WHERE workspace_id = ?")
        .all(workspaceId) as { asset_id: string }[]).map((r) => r.asset_id);

      // 全量替换成员
      db.prepare("DELETE FROM workspace_assets WHERE workspace_id = ?").run(workspaceId);
      for (const assetId of assetIds) {
        db.prepare("INSERT INTO workspace_assets (id, workspace_id, asset_id) VALUES (?, ?, ?)")
          .run(generateId(), workspaceId, assetId);
      }

      // 失联 asset 尝试 GC
      const afterSet = new Set(assetIds);
      for (const oldId of oldAssetIds) {
        if (!afterSet.has(oldId)) maybeGcRetiredAsset(oldId);
      }
    } else {
      workspaceId = generateId();
      created = true;

      db.prepare(`
        INSERT INTO workspaces (id, user_id, name, description, target_tools, visibility, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(workspaceId, userId, name, `由 loom push 推送（${targetTool}）`, toolsJson, visibility, "1.0.0", now, now);

      for (const assetId of assetIds) {
        db.prepare("INSERT INTO workspace_assets (id, workspace_id, asset_id) VALUES (?, ?, ?)")
          .run(generateId(), workspaceId, assetId);
      }
    }

    return {
      success: true,
      data: { workspaceId, workspaceName: name, created, assetCount: assetIds.length },
    };
  });
}
