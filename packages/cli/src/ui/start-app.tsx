/**
 * `loom start` 的 Ink 状态面板。
 *
 * 三块布局：
 *   1. 顶部：连接状态条（颜色编码 idle/connecting/authed/reconnecting）
 *   2. 中部：endpoint / deviceId / 在线时长 / 已注册项目数
 *   3. 底部：最近 5 条事件
 *
 * 命令层（commands/start.ts）创建好 `AgentClient` 后,把它作为 prop 传进来,
 * UI 只负责订阅 state/error 事件、渲染。落盘相关事件(reconcile)由命令层处理。
 * 退出由 `useApp().exit()` 触发,Ink 默认 `exitOnCtrlC: true`。
 */
import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import type { CliConfig } from "@maolinc/cc-loom-shared";
import type { AgentClient, AgentState } from "../ws/client.js";
import { listProjects } from "../lib/projects.js";

export interface StartAppProps {
  config: CliConfig;
  client: AgentClient;
}

interface EventLog {
  id: number;
  time: string;
  level: "info" | "warn" | "error" | "success";
  text: string;
}

const STATE_COLOR: Record<AgentState, string> = {
  idle: "gray",
  connecting: "yellow",
  authed: "green",
  reconnecting: "yellow",
  stopped: "red",
};

const STATE_LABEL: Record<AgentState, string> = {
  idle: "未启动",
  connecting: "连接中",
  authed: "已认证",
  reconnecting: "重连中",
  stopped: "已停止",
};

const MAX_LOGS = 5;

let logSeq = 0;

export const StartApp: React.FC<StartAppProps> = ({ config, client }) => {
  const { exit } = useApp();
  const [state, setState] = useState<AgentState>(client.getState());
  const [stateDetail, setStateDetail] = useState<string | undefined>();
  const [startedAt] = useState<number>(Date.now());
  const [logs, setLogs] = useState<EventLog[]>([]);
  const [projectCount] = useState<number>(() => listProjects().length);
  const [now, setNow] = useState<number>(Date.now());

  function pushLog(level: EventLog["level"], text: string) {
    setLogs((prev) => {
      const next = [
        ...prev,
        { id: ++logSeq, time: new Date().toLocaleTimeString(), level, text },
      ];
      return next.slice(-MAX_LOGS);
    });
  }

  useEffect(() => {
    const onState = (s: AgentState, detail?: string) => {
      setState(s);
      setStateDetail(detail);
      if (s === "authed") pushLog("success", "已认证，等待安装指令");
      if (s === "reconnecting" && detail) pushLog("warn", `重连：${detail}`);
      if (s === "stopped") pushLog("error", "Agent 已停止");
    };
    const onErr = (msg: string) => pushLog("error", msg);

    client.on("state", onState);
    client.on("error", onErr);

    const tick = setInterval(() => setNow(Date.now()), 1000);

    const sigterm = () => {
      client.stop();
      exit();
    };
    process.on("SIGTERM", sigterm);

    return () => {
      clearInterval(tick);
      client.off("state", onState);
      client.off("error", onErr);
      process.off("SIGTERM", sigterm);
    };
  }, [client, exit]);

  const uptime = formatUptime(now - startedAt);
  const masked = maskToken(config.token);

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      <Box>
        <Text bold color="cyan">Loom Agent </Text>
        <Text color={STATE_COLOR[state]}>● {STATE_LABEL[state]}</Text>
        {stateDetail ? <Text dimColor> ({stateDetail})</Text> : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text dimColor>Endpoint  </Text>
          <Text>{config.endpoint}</Text>
        </Text>
        <Text>
          <Text dimColor>Device    </Text>
          <Text>{config.deviceId || "—（首次连接后绑定）"}</Text>
        </Text>
        <Text>
          <Text dimColor>Token     </Text>
          <Text>{masked}</Text>
        </Text>
        <Text>
          <Text dimColor>Uptime    </Text>
          <Text>{uptime}</Text>
          <Text dimColor>   Projects </Text>
          <Text>{projectCount}</Text>
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>事件日志（最近 {MAX_LOGS} 条）</Text>
        {logs.length === 0 ? (
          <Text dimColor>  —</Text>
        ) : (
          logs.map((l) => (
            <Text key={l.id}>
              <Text dimColor>{l.time}  </Text>
              <Text color={LEVEL_COLOR[l.level]}>{LEVEL_TAG[l.level]}</Text>
              <Text> {l.text}</Text>
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>按 Ctrl+C 退出，或在另一个终端执行 `loom stop`</Text>
      </Box>
    </Box>
  );
};

const LEVEL_COLOR: Record<EventLog["level"], string> = {
  info: "cyan",
  warn: "yellow",
  error: "red",
  success: "green",
};

const LEVEL_TAG: Record<EventLog["level"], string> = {
  info: "[INFO]",
  warn: "[WARN]",
  error: "[ERR ]",
  success: "[ OK ]",
};

function maskToken(t: string): string {
  if (!t) return "—";
  if (t.length <= 12) return t.slice(0, 4) + "…";
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${m}m${sec}s`;
  if (m > 0) return `${m}m${sec}s`;
  return `${sec}s`;
}
