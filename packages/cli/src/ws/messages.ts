/**
 * WS 协议常量。两端共用消息名应放 @maolinc/cc-loom-shared，但 shared 当前未导出常量；
 * gateway.ts 与 ws/client.ts 各持一份字符串字面量也行，但抽到这里至少让 CLI 内
 * 不会拼错。
 */
export const MSG_AUTH = "auth";
export const MSG_AUTH_OK = "auth_ok";
export const MSG_HEARTBEAT = "heartbeat";
export const MSG_PONG = "pong";
export const MSG_ERROR = "error";
export const MSG_ACK = "ack";

// ---- 通用 request/response（双向）：用于 server↔agent 之间按 requestId 关联的同步问答。
// payload 结构：
//   req:  { requestId: string; op: string; ...opPayload }
//   res:  { requestId: string; success: boolean; data?: unknown; error?: string }
export const MSG_REQ = "req";
export const MSG_RES = "res";

// ---- agent → server 主动推送，无 requestId：
//   payload: LocalProjectState
export const MSG_PROJECT_STATE = "project:state";

// ---- agent → server 主动推送 skill 调用次数增量，无 requestId：
//   payload: SkillUsageReport { projectId, items: { assetId, delta }[] }
//   Server 累加到 assets.invocation_count（只增不减）。
export const MSG_SKILL_USAGE = "skill:usage";

// ---- server → web 客户端推送，无 requestId：
//   payload: { projectId: string }
//   表示该项目本地状态有变化，web 可重拉 GET /api/projects/:id/state。
export const MSG_WEB_STATE_CHANGED = "web:project:state_changed";

// ---- request op 字符串（payload 字段约定见各处理器） ----
export const OP_PROJECT_SCAN = "project:scan";              // server→agent
export const OP_PROJECT_READ_FILE = "project:read_file";    // server→agent
export const OP_INSTALL_UNINSTALL = "install:uninstall";    // server→agent

// ---- wire 协议 v2：统一落盘 op ----
// 取代 v1 时代的 install / capability:add / capability:remove / capability:toggle 四个 op。
// payload: WsReconcileRequest（含完整 ReconcilePlan，文件级 diff 已由 server 渲染）。
// 响应 data: WsReconcileResponseData。
export const OP_RECONCILE = "reconcile";                    // server→agent

// ---- 项目彻底清理：server→agent
// 让 agent 抹掉该项目的全部本地 `~/.loom` 痕迹（projects/<id>.json、locks/<id>.json、
// disabled/<id>/、stats/<id>.*），并停止 watcher。用于 Web 端「删除项目」：在线时走
// 深度清理，离线时仅服务端浅度清理，agent 重连后由 server 补发本 op 自愈。
// payload: { projectId: string }，响应 data: { projectId: string }。
export const OP_PROJECT_PURGE = "project:purge";            // server→agent

// ---- 环境变量下发/回收：server→agent ----
// 把设置页维护的环境变量写入/移除设备系统环境变量文件。仅在线 agent 处理（不走 outbox）。
//   env:push  payload: { key, value } → 写入系统 env + agent 自身 process.env
//   env:revoke payload: { key }       → 从系统 env 文件移除该 key
// 响应 data: { key }。落盘细节见 lib/system-env.ts。
export const OP_ENV_PUSH = "env:push";                      // server→agent
export const OP_ENV_REVOKE = "env:revoke";                  // server→agent

// ---- Codex / Claude Code 用户级配置档下发：server→agent ----
// payload: WsToolConfigApplyPayload。路径固定为当前用户 ~/.codex / ~/.claude，
// Agent 只合并本功能负责的字段，不覆盖其它配置。
export const OP_TOOL_CONFIG_APPLY = "tool-config:apply";     // server→agent
