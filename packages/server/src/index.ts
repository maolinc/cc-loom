#!/usr/bin/env node
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors, { type OriginFunction } from "@fastify/cors";
import compress from "@fastify/compress";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SERVER_PORT, DEFAULT_SERVER_HOST } from "@maolinc/cc-loom-shared";
import { migrate } from "./db/migrate.js";
import { db } from "./db/index.js";
import { sessionHook } from "./lib/auth.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { assetRoutes } from "./routes/assets.js";
import { capabilitySetRoutes } from "./routes/capability-sets.js";
import { projectRoutes } from "./routes/projects.js";
import { deviceRoutes } from "./routes/devices.js";
import { installRoutes } from "./routes/install.js";
import { websocketGateway, setAgentConnectHandler } from "./ws/gateway.js";
import { marketplaceRoutes } from "./routes/marketplaces.js";
import { settingsRoutes } from "./routes/settings.js";
import { aiRoutes } from "./routes/ai.js";
import { aiGenSettingsRoutes } from "./routes/ai-gen-settings.js";
import { configRoutes } from "./routes/config.js";
import { pushRoutes } from "./routes/push.js";
import { syncOutboxRoutes } from "./routes/sync-outbox.js";
import { credentialRoutes } from "./routes/credentials.js";
import { searchSettingsRoutes } from "./routes/search-settings.js";
import { toolConfigProfileRoutes } from "./routes/tool-config-profiles.js";
import { startScheduler } from "./marketplace/scheduler.js";
import { startSearchIndexer } from "./lib/search-indexer.js";
import { startAiInfoIndexer } from "./lib/ai-info-indexer.js";
import { compensateDeviceOnConnect } from "./lib/auto-sync.js";
import { isTrustedBrowserOrigin } from "./lib/runtime-security.js";
import { isMainModule } from "./lib/main-module.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export interface BuildAppOptions {
  /** Disable Fastify's logger (useful for tests). */
  silent?: boolean;
  /** Skip serving the SPA static files (useful for tests). */
  skipStatic?: boolean;
}

/**
 * Build the Fastify app. Migrations are run on every call so the same instance
 * works against fresh tmp DBs in tests.
 *
 * Note: this is the assembly function. It does NOT call .listen(); callers
 * decide whether to start the HTTP server (production) or use .inject() (tests).
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  migrate();

  // 服务器重启后，内存中的 agents Map 为空，但 DB 里设备/项目可能还残留
  // status='online'（上次 agent 连接时写入，close 事件未触发或服务器被 kill）。
  // 启动时统一标记为 offline，agent 重连后会重新设为 online。
  db.prepare("UPDATE devices SET status = 'offline' WHERE status = 'online'").run();
  db.prepare(
    "UPDATE projects SET status = 'offline' WHERE status = 'online'"
  ).run();

  // outbox 兜底:重启前在退避中的任务(scheduled_at 在未来)失去了 setTimeout,靠
  // 内存定时器永远不会再被唤醒。把它们 scheduled_at 拉回 now,让 agent 下次重连
  // 触发的 wakeDeviceV2 立即重试。语义上等同于"重启 = 退避表清零,激进重试一次",
  // 失败仍会重新进入退避,所以不会无限循环。
  db.prepare(
    "UPDATE sync_outbox_v2 SET scheduled_at = ? WHERE completed_at IS NULL AND scheduled_at > ?",
  ).run(new Date().toISOString(), new Date().toISOString());

  // outbox dead-letter 告警:8 次重试仍未成功的行通常是 server↔CLI 协议错配
  // 或 asset 长期不可见,需要人工介入。启动时数一下印日志,便于运维及时发现。
  const dead = (db.prepare(
    "SELECT COUNT(*) AS n FROM sync_outbox_v2 WHERE completed_at IS NULL AND attempts >= 8",
  ).get() as { n: number } | undefined)?.n ?? 0;
  if (dead > 0) {
    console.warn(`[outbox] ${dead} 条任务已耗尽重试次数(dead-letter)。本地控制台项目详情的「同步队列」查看详情。`);
  }

  // 能力上传支持二进制文件（base64 内联在 JSON body 里），单文件可达数 MB，
  // 多文件叠加远超 Fastify 默认 1MB body 上限。放宽到 64MB 以容纳整文件夹上传。
  const app = Fastify({
    logger: opts.silent ? false : true,
    bodyLimit: 64 * 1024 * 1024,
  });

  await app.register(helmet, {
    // The SPA is built separately and does not need cross-origin embedding.
    // Keep CSP opt-in until its asset and API policy is explicitly configured.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: 240,
    timeWindow: "1 minute",
    ban: 0,
  });
  await app.register(cors, {
    origin: ((origin, callback) =>
      callback(null, origin && isTrustedBrowserOrigin(origin) ? origin : false)) satisfies OriginFunction,
    credentials: true,
  });
  await app.register(cookie);
  // gzip JSON / text responses above ~1KB. Keeps Markdown/JSON capability set
  // payloads small over the wire without per-route configuration.
  await app.register(compress, { global: true, threshold: 1024 });
  await app.register(websocket);

  app.addHook("onRequest", sessionHook);

  authRoutes(app);
  adminRoutes(app);
  assetRoutes(app);
  capabilitySetRoutes(app);
  projectRoutes(app);
  deviceRoutes(app);
  installRoutes(app);
  marketplaceRoutes(app);
  settingsRoutes(app);
  aiRoutes(app);
  aiGenSettingsRoutes(app);
  configRoutes(app);
  pushRoutes(app);
  syncOutboxRoutes(app);
  credentialRoutes(app);
  searchSettingsRoutes(app);
  toolConfigProfileRoutes(app);

  websocketGateway(app);
  // agent 重连补偿：注入到 gateway 的连接钩子（回调注入避免循环依赖）。
  setAgentConnectHandler(compensateDeviceOnConnect);

  if (!opts.skipStatic) {
    // Published (npm): web dist embedded at dist/web-dist
    // Dev (monorepo): web dist at ../../web/dist relative to dist/
    let webDist = join(__dirname, "web-dist");
    if (!existsSync(webDist)) {
      webDist = join(__dirname, "../../web/dist");
    }
    if (existsSync(webDist)) {
      await app.register(fastifyStatic, {
        root: webDist,
        prefix: "/",
        // Vite 产物带 content hash，安全开启长期缓存（1 年 + immutable）。
        maxAge: "365d",
        immutable: true,
        // 入口 index.html 不能长期缓存——它引用的 chunk hash 会随 rebuild 变化，
        // 若被浏览器 immutable 缓存，rebuild 后用户一直加载旧 html 指向的旧 chunk。
        // 只对 .html 覆盖为 no-cache，hash assets 仍走 365d immutable。
        setHeaders: (reply, pathName) => {
          if (pathName.endsWith(".html")) {
            reply.header("Cache-Control", "public, max-age=0, must-revalidate");
          }
        },
      });

      // index.html 不能长期缓存（入口引用变化的 chunk hash）
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith("/api/") || request.url.startsWith("/ws")) {
          return reply.status(404).send({ success: false, error: "Not found" });
        }
        return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      });
    } else {
      app.log.warn("Web dist not found at " + webDist + ", SPA not served");
    }
  }

  return app;
}

async function start() {
  const app = await buildApp();

  const port = parseInt(process.env.PORT || String(DEFAULT_SERVER_PORT), 10);
  const host = process.env.HOST || DEFAULT_SERVER_HOST;

  try {
    await app.listen({ port, host });
    const externalUrl = process.env.LOOM_EXTERNAL_URL || `http://localhost:${port}`;
    console.log(`\n  Loom Server running at http://localhost:${port}`);
    console.log(`  External URL: ${externalUrl}\n`);
    startScheduler();
    startSearchIndexer();
    startAiInfoIndexer();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only auto-start when this file is the main entry. Tests import buildApp directly.
if (isMainModule(import.meta.url, process.argv[1])) {
  void start();
}
