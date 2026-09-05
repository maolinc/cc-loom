import type { FastifyInstance } from "fastify";

/**
 * 公开（无需登录）配置端点。
 *
 * 当前只暴露 `externalUrl` —— server 的对外可访问地址，由启动时的环境变量
 * `LOOM_EXTERNAL_URL` 注入。Web 文档页"快速开始"用它构造 `loom login
 * --endpoint <url>` 命令，确保用户在远端机器跑 CLI 时复制出来的命令可直接用。
 *
 * 未设置环境变量时返回 null，调用方应回落到 `window.location.origin`。
 */
export function configRoutes(app: FastifyInstance) {
  app.get("/api/config", async () => {
    return {
      success: true,
      data: {
        externalUrl: process.env.LOOM_EXTERNAL_URL || null,
      },
    };
  });
}
