# Loom 生产镜像 (@maolinc/cc-loom-server)
# 多阶段构建: builder 全量依赖编译 → runtime 仅生产依赖 + 产物
#
# 用法:
#   just docker-build                 # 构建为 loom-server:latest
#   just docker-run                   # 本地运行,数据持久化到宿主 ~/.loom
#   docker run -p 47474:47474 -v loom-data:/data \
#     -e LOOM_ADMIN_EMAIL=admin@example.com \
#     -e LOOM_ADMIN_PASSWORD='a-long-unique-password' loom-server:latest

# ---- Builder: 全量依赖 + 编译 ----
FROM node:22-slim AS builder

# better-sqlite3 等原生模块需要编译工具链
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git bash ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/loom

# 1. 依赖层 (仅 manifest 变化时重装)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY packages/shared/package.json  packages/shared/
COPY packages/adapter/package.json packages/adapter/
COPY packages/server/package.json  packages/server/
COPY packages/cli/package.json     packages/cli/
COPY packages/web/package.json     packages/web/
COPY packages/testkit/package.json packages/testkit/
RUN corepack enable && pnpm install --frozen-lockfile

# 2. 源码 + 编译 (shared → adapter → web → server，pnpm -r 按依赖序)
COPY packages/ ./packages/
RUN pnpm -r build

# 3. 把 @maolinc/cc-loom-server 及其生产依赖 (含 workspace: @maolinc/cc-loom-shared / @maolinc/cc-loom-adapter 的 dist)
#    部署到独立目录,形成自包含的可运行产物。
#    --legacy: pnpm v10+ 默认要求 inject-workspace-packages,这里用经典 deploy 把
#    workspace 依赖实际文件拷进 target (而非软链 store),产物自包含、可跨镜像层移动。
RUN pnpm --filter @maolinc/cc-loom-server deploy --legacy --prod /opt/loom-server

# ---- Runtime: 仅生产依赖 + 产物 ----
FROM node:22-slim AS runtime

# tini 做 PID 1,确保 SIGTERM 优雅退出; ca-certificates 供 marketplace git https clone
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/loom-server /opt/loom-server

# 数据目录: SQLite + master.key + locks。
# 默认 /data,运行时用 -v <host>:/data 挂载持久化。
# 不声明 VOLUME 指令——它会注入属主为 root 的匿名卷,与运行时降权用户冲突。
# entrypoint 仅在挂载目录需要初始化时以 root 调整属主，实际服务进程始终降权为 loom。
RUN groupadd --system --gid 10001 loom \
    && useradd --system --uid 10001 --gid loom --home-dir /data --shell /usr/sbin/nologin loom \
    && mkdir -p /data \
    && chown loom:loom /data

COPY docker/entrypoint.sh /usr/local/bin/loom-entrypoint
RUN chmod 755 /usr/local/bin/loom-entrypoint

ENV LOOM_DATA_DIR=/data
ENV NODE_ENV=production
ENV PORT=47474
ENV HOST=0.0.0.0

WORKDIR /data
EXPOSE 47474

ENTRYPOINT ["tini", "--", "/usr/local/bin/loom-entrypoint"]
CMD ["node", "/opt/loom-server/dist/index.js"]
