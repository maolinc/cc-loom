# Loom Monorepo — 命令入口
# 用法: `just <命令>`，无参数列出所有命令

set shell := ["bash", "-cu"]
set dotenv-load := false

PNPM := "pnpm"
PACK_OUT := "dist-pack"
LOCAL_REG := "http://localhost:4873"
SERVER_PORT := "47474"
WEB_PORT := "47475"

# 默认: 列出所有命令
default:
    @just --list

# --- 依赖管理 ----------------------------------------------------------------

# 安装所有 workspace 依赖
install:
    {{PNPM}} install

# 重装依赖（清理后重新安装）
reinstall: clean-modules install

# --- 开发 --------------------------------------------------------------------

# 清理 server/web 端口占用（避免重复启动堆积）
kill-ports:
    -@lsof -t -i :{{SERVER_PORT}} -i :{{WEB_PORT}} 2>/dev/null | xargs -r kill -9 2>/dev/null
    @echo "✔ cleared ports {{SERVER_PORT}} (server) / {{WEB_PORT}} (web)"

# 设置管理员账号密码 (Windows 写用户级环境变量; macOS/Linux 写 shell rc; 新开终端生效; 首次 just dev 前跑一次)
# 密码策略 6-128 位; server 端语义: 已存在的启用账号不会被改密码, 仅首次创建/复启用生效
init-admin EMAIL PASSWORD:
    #!/usr/bin/env bash
    set -euo pipefail
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        setx LOOM_ADMIN_EMAIL "{{EMAIL}}" > /dev/null
        setx LOOM_ADMIN_PASSWORD "{{PASSWORD}}" > /dev/null
        echo "✔ 已写入 Windows 用户环境变量 LOOM_ADMIN_EMAIL / LOOM_ADMIN_PASSWORD — 新开终端后 just dev 自动携带"
        ;;
      *)
        rc="$HOME/.bashrc"
        shell_name="$(basename "${SHELL:-/bin/bash}")"
        if [[ "$shell_name" == "zsh" ]]; then
          rc="$HOME/.zshrc"
        elif [[ "$shell_name" == "bash" && "$(uname -s)" == "Darwin" ]]; then
          rc="$HOME/.bash_profile"
        fi
        touch "$rc"
        sed -i.bak '/^export LOOM_ADMIN_EMAIL=/d;/^export LOOM_ADMIN_PASSWORD=/d' "$rc" && rm -f "$rc.bak"
        echo "export LOOM_ADMIN_EMAIL='{{EMAIL}}'" >> "$rc"
        echo "export LOOM_ADMIN_PASSWORD='{{PASSWORD}}'" >> "$rc"
        echo "✔ 已写入 $rc — 新开终端或 source $rc 后 just dev 自动携带"
        ;;
    esac

# 启动全部 dev (shared/adapter watch + server + web 并行;cli 用 dev-cli <subcommand>)
# 首次启动(~/.loom 为空)需先跑一次: just init-admin <邮箱> <密码> (新开终端生效)
dev: kill-ports
    {{PNPM}} --parallel \
      --filter @maolinc/cc-loom-shared --filter @maolinc/cc-loom-adapter \
      --filter @maolinc/cc-loom-server --filter @maolinc/cc-loom-web \
      dev

# 单独启动 cli (tsx) — 透传额外参数: just dev-cli start
dev-cli *ARGS:
    {{PNPM}} --filter @maolinc/cc-loom dev {{ARGS}}

# --- 编译 --------------------------------------------------------------------

# 编译所有包 (按依赖顺序)
build: build-shared build-adapter build-web build-server build-cli

# 仅编译 shared
build-shared:
    {{PNPM}} --filter @maolinc/cc-loom-shared build

# 仅编译 adapter
build-adapter:
    {{PNPM}} --filter @maolinc/cc-loom-adapter build

# 仅编译 server
build-server:
    {{PNPM}} --filter @maolinc/cc-loom-server build

# 仅编译 web (产出 packages/web/dist)
build-web:
    {{PNPM}} --filter @maolinc/cc-loom-web build

# 仅编译 cli
build-cli:
    {{PNPM}} --filter @maolinc/cc-loom build

# --- 校验 --------------------------------------------------------------------

# 类型检查 (所有包)
typecheck:
    {{PNPM}} -r typecheck

# Lint (所有包,若已配置;否则跳过)
lint:
    {{PNPM}} -r --if-present lint

# --- 测试 --------------------------------------------------------------------

# 跑全部测试 (server 单元/集成 + cli scanner，含 install plan / 镜像 drift 等回归保护)
test:
    {{PNPM}} --filter @maolinc/cc-loom-server --filter @maolinc/cc-loom --if-present test

# Watch 模式 (改文件自动重跑)
test-watch:
    {{PNPM}} --filter @maolinc/cc-loom-server test:watch

# 跑指定测试文件,按路径或名称模糊匹配 — 用法: just test-file marketplaces
test-file PATTERN:
    {{PNPM}} --filter @maolinc/cc-loom-server test {{PATTERN}}

# 稳定性验证 (连跑 5 次,确认无 flake)
test-stable:
    @for i in 1 2 3 4 5; do \
      echo "=== Run $i ==="; \
      {{PNPM}} --filter @maolinc/cc-loom-server test 2>&1 | tail -4 | head -3; \
    done

# --- 运行 (生产) -------------------------------------------------------------

# 启动已编译的 server (需先 just build)
start: kill-ports
    {{PNPM}} --filter @maolinc/cc-loom-server start

# 运行已编译的 cli — 透传参数: just run-cli start
run-cli *ARGS:
    node packages/cli/dist/index.js {{ARGS}}

# Vite 预览已编译的 web
preview-web: kill-ports
    {{PNPM}} --filter @maolinc/cc-loom-web preview

# --- 打包 (产 tarball) -------------------------------------------------------

# 打包 server + cli 为 .tgz (输出到 ./{{PACK_OUT}}/)
pack: build pack-server pack-cli
    @echo "✔ tarballs in ./{{PACK_OUT}}/"

# 仅打包 server
pack-server: build-shared build-adapter build-server build-web
    @mkdir -p {{PACK_OUT}}
    {{PNPM}} --filter @maolinc/cc-loom-server pack --pack-destination "{{justfile_directory()}}/{{PACK_OUT}}"

# 仅打包 cli
pack-cli: build-shared build-adapter build-cli
    @mkdir -p {{PACK_OUT}}
    {{PNPM}} --filter @maolinc/cc-loom pack --pack-destination "{{justfile_directory()}}/{{PACK_OUT}}"

# --- 本地发布 (verdaccio) ----------------------------------------------------

# 启动本地 registry (后台运行;首次启动后跑 just bootstrap-local)
verdaccio:
    nohup npx --yes verdaccio --listen http://0.0.0.0:4873> /tmp/verdaccio.log 2>&1 &
    @echo "✔ verdaccio started in background (log: /tmp/verdaccio.log, port: 4873)"

# 首次配置: 注册账号 (交互式输入用户名/密码/邮箱) + 把 @maolinc scope 路由到本地 registry
bootstrap-local:
    npm adduser --registry {{LOCAL_REG}} --auth-type=legacy
    npm config set @maolinc:registry {{LOCAL_REG}}
    @echo "✔ bootstrap done — next: just publish-local"

# 撤回本地已发版本 (单条命令前缀 `-` 让首次运行时的 404 被忽略)
unpublish-local:
    -npm unpublish @maolinc/cc-loom-shared@0.1.0  --registry {{LOCAL_REG}} --force
    -npm unpublish @maolinc/cc-loom-adapter@0.1.0 --registry {{LOCAL_REG}} --force
    -npm unpublish @maolinc/cc-loom-server@0.1.2  --registry {{LOCAL_REG}} --force
    -npm unpublish @maolinc/cc-loom@0.1.0     --registry {{LOCAL_REG}} --force

uninstall-local:
    npm uninstall -g @maolinc/cc-loom --registry {{LOCAL_REG}}

# 一条龙: build → 撤回旧版 → 重发 4 个包 → 全局安装 CLI
# 注意: 必须在各包目录内 pnpm publish, `--filter publish` 可能跳过已发布版本
publish-local: build unpublish-local
    cd packages/shared  && {{PNPM}} publish --registry {{LOCAL_REG}} --no-git-checks
    cd packages/adapter && {{PNPM}} publish --registry {{LOCAL_REG}} --no-git-checks
    cd packages/server  && {{PNPM}} publish --registry {{LOCAL_REG}} --no-git-checks --tag dev
    cd packages/cli     && {{PNPM}} publish --registry {{LOCAL_REG}} --no-git-checks --tag dev
    # daemon 是 detached 长驻进程，会 mmap 住全局 node_modules/@maolinc/cc-loom，
    # install -g 的 uninstall 阶段会因文件被占而失败；先优雅停掉
    -loom stop 2>/dev/null
    npm install -g @maolinc/cc-loom@dev --registry {{LOCAL_REG}}
    @echo "✔ loom installed globally — try: loom --help"

# --- 公网发布 (npmjs.com) -----------------------------------------------------

NPM_REG := "https://registry.npmjs.org"

# 登录公网 npm (交互式，发布前需先执行一次)
npm-login:
    npm login --registry {{NPM_REG}}

# 查看当前登录账号
npm-whoami:
    npm whoami --registry {{NPM_REG}}

# 发布到公网 npm — 顺序: shared → adapter → server → cli (依赖顺序，web 为 private 不单独发布)
# 前提: 已 `just npm-login`；各包 version 已手动 bump（npmjs.com 不允许覆盖已发布版本号）
publish-public: build
    cd packages/shared  && {{PNPM}} publish --registry {{NPM_REG}} --no-git-checks
    cd packages/adapter && {{PNPM}} publish --registry {{NPM_REG}} --no-git-checks
    cd packages/server  && {{PNPM}} publish --registry {{NPM_REG}} --no-git-checks
    cd packages/cli     && {{PNPM}} publish --registry {{NPM_REG}} --no-git-checks
    @echo "✔ published — try: npx @maolinc/cc-loom-server / npx @maolinc/cc-loom"

# --- 清理 --------------------------------------------------------------------

# 清理所有 dist 和打包产物
clean:
    rm -rf packages/*/dist {{PACK_OUT}}

# 清理 node_modules (所有 workspace)
clean-modules:
    rm -rf node_modules packages/*/node_modules

# 清理本地 loom 数据 (~/.loom/)
clean-data:
    rm -rf ~/.loom

# 全清: dist + node_modules + 本地数据
clean-all: clean clean-modules clean-data

# --- Docker 测试 -------------------------------------------------------------

# 镜像 tag
TEST_IMG := "loom-test-runtime"
TEST_BASE := "loom-test-base"

# 构建测试基础镜像 (node:20-alpine + 编译工具链)
test-docker-base:
    docker build -f docker/Dockerfile.test-base -t {{TEST_BASE}}:latest docker/

# 构建测试 runtime 镜像 (含源码 + 编译产物 + fixture + testkit)
test-docker-build: test-docker-base
    docker build -f docker/Dockerfile.test-runtime -t {{TEST_IMG}}:latest .

# 进入测试容器交互 (调试)
test-docker-shell:
    docker run --rm -it --entrypoint /bin/sh {{TEST_IMG}}:latest

# --- L3 真实链路端到端 ---
# 运行模式 MODE: single(默认) | multi(compose 多容器)
# 跑全部 L3 用例
test-docker-e2e MODE="single":
    docker run --rm {{TEST_IMG}}:latest --layer l3 --mode {{MODE}}

# 跑指定 L3 用例 (按名模糊匹配): just test-docker-e2e-file happy
test-docker-e2e-file PATTERN MODE="single":
    docker run --rm {{TEST_IMG}}:latest --layer l3 --mode {{MODE}} --grep "{{PATTERN}}"

# --- L3 本地开发模式 (改用例即跑,无需重建镜像) ---
# 挂载宿主机 tests/ 覆盖容器内,改完用例直接跑
# 前提: 先 just test-docker-build 构建一次镜像
test-docker-e2e-dev MODE="single":
    docker run --rm -v {{justfile_directory()}}/tests:/opt/loom/tests {{TEST_IMG}}:latest --layer l3 --mode {{MODE}}

# 跑指定用例 (dev 模式): just test-docker-e2e-dev-file happy
test-docker-e2e-dev-file PATTERN MODE="single":
    docker run --rm -v {{justfile_directory()}}/tests:/opt/loom/tests {{TEST_IMG}}:latest --layer l3 --mode {{MODE}} --grep "{{PATTERN}}"

# --- L4 流程编排 ---
# 跑指定编排用例: just test-docker-scenario cross-user-sync
test-docker-scenario NAME MODE="single":
    docker run --rm {{TEST_IMG}}:latest --layer l4 --mode {{MODE}} --scenario "{{NAME}}"

# 跑全部编排用例
test-docker-scenarios MODE="single":
    docker run --rm {{TEST_IMG}}:latest --layer l4 --mode {{MODE}}

# --- L5 UI (Phase 4) ---
test-docker-ui:
    docker run --rm {{TEST_IMG}}:latest --layer l5

# --- 汇总 ---
# 跑全部 Docker 测试 (L3 + L4 + L5)
test-docker-all MODE="single": test-docker-build
    docker run --rm {{TEST_IMG}}:latest --all --mode {{MODE}}

# 稳定性验证 (连跑 5 次确认无 flake)
test-docker-stable MODE="single":
    @for i in 1 2 3 4 5; do \
      echo "=== Run $i ==="; \
      docker run --rm {{TEST_IMG}}:latest --all --mode {{MODE}} || exit 1; \
    done

# 清理测试镜像
test-docker-clean:
    -docker rmi {{TEST_IMG}}:latest {{TEST_BASE}}:latest 2>/dev/null

# --- Docker 生产镜像 ---------------------------------------------------------

# 生产镜像名/tag (覆盖: LOOM_TAG=v0.1.0 just docker-build)
LOOM_IMG := "loom-server"
LOOM_TAG := "latest"

# 构建生产 server 镜像 (多阶段: 全量编译 → 生产依赖裁剪; 产物自包含 web-dist)
docker-build:
    docker build -f docker/Dockerfile -t {{LOOM_IMG}}:{{LOOM_TAG}} .
    @echo "✔ image {{LOOM_IMG}}:{{LOOM_TAG}} ready — try: just docker-run"

# 运行生产 server 镜像 (数据持久化到宿主 ~/.loom; 端口 {{SERVER_PORT}})
# entrypoint 初始化卷属主后，服务进程以镜像内非 root 用户运行。
docker-run: kill-ports
    mkdir -p "$$HOME/.loom"
    docker run --rm -p {{SERVER_PORT}}:47474 -v "$$HOME/.loom":/data \
      -e LOOM_ADMIN_EMAIL="$${LOOM_ADMIN_EMAIL:?set LOOM_ADMIN_EMAIL}" \
      -e LOOM_ADMIN_PASSWORD="$${LOOM_ADMIN_PASSWORD:?set LOOM_ADMIN_PASSWORD}" \
      -e LOOM_COOKIE_SECURE=false \
      {{LOOM_IMG}}:{{LOOM_TAG}}

# 进入生产镜像调试
docker-shell:
    docker run --rm -it --entrypoint /bin/sh {{LOOM_IMG}}:{{LOOM_TAG}}

# 清理生产镜像
docker-clean:
    -docker rmi {{LOOM_IMG}}:{{LOOM_TAG}} 2>/dev/null
