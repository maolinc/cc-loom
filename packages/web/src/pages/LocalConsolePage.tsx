/**
 * 本地控制台 — 多能力集订阅版（ADR-0006）。
 *
 * 信息架构：
 *  - 顶部：driftCleared banner（若触发）
 *  - 左：项目列表（5s 轮询）
 *  - 右上：项目 header（名称 + 状态 + 路径复制 + 添加能力 + 重新扫描 + ⋯）
 *  - 右中：订阅条（每个能力集一卡 + 隐式订阅简卡 + 添加能力集）
 *  - 右下：本地镜像 — 视图切换（按厂商横 tab / 按能力矩阵）
 *
 * 反馈：toast 队列；卸载与移除能力均走 ConfirmDialog（替换原生 confirm）。
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Download,
  GripVertical,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { TARGET_TOOLS, TARGET_DIRS } from "@maolinc/cc-loom-shared";
import type {
  AssetCapability,
  AssetType,
  LocalFileNode,
  LocalProjectState,
  Project,
  TargetTool,
} from "@maolinc/cc-loom-shared";
import { api } from "../api.js";
import { useToast } from "../components/Toast.js";
import Button from "../components/Button.js";
import ConfirmDialog from "../components/ConfirmDialog.js";
import DetailPanel from "../components/DetailPanel.js";
import VendorTabStrip from "./local-console/VendorTabStrip.js";
import MirrorTreeView, { type MirrorTreeViewHandle } from "./local-console/MirrorTreeView.js";
import CapabilityMatrix from "./local-console/CapabilityMatrix.js";
import PreviewPanel, { type PreviewTarget } from "./local-console/PreviewPanel.js";
import ProjectSyncCard from "./local-console/ProjectSyncCard.js";
import AddCapabilityDialog from "./local-console/AddCapabilityDialog.js";
import SubscriptionStrip, { type SubscriptionCapabilitySetMeta } from "./local-console/SubscriptionStrip.js";
import { ActiveContext } from "../components/KeepAlive.js";

const PROJECT_POLL_MS = 30_000;

/** 记住上次选中的项目，避免切换导航再切回来时丢失选择。 */
const SELECTED_PROJECT_KEY = "loom:console:selectedProjectId";

/**
 * 项目列表的自定义排序（前端持久化，纯 localStorage）。
 * Project 模型无服务端排序字段，故拖拽顺序只存本地浏览器；新项目追加到末尾。
 */
const PROJECT_ORDER_KEY = "loom:console:projectOrder";

function loadProjectOrder(): string[] {
  try {
    const raw = localStorage.getItem(PROJECT_ORDER_KEY);
    if (!raw) return [];
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveProjectOrder(ids: string[]) {
  try {
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(ids));
  } catch {
    /* 忽略隐私模式 / 配额 */
  }
}

interface ProjectWithDevice extends Project {
  device?: { id: string; deviceName: string; status: string };
}

type ViewMode = "vendor" | "capability";

export default function LocalConsolePage() {
  const toast = useToast();
  const treeRef = useRef<MirrorTreeViewHandle>(null);
  const isActive = useContext(ActiveContext);

  const [projects, setProjects] = useState<ProjectWithDevice[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => localStorage.getItem(SELECTED_PROJECT_KEY),
  );
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [state, setState] = useState<LocalProjectState | null>(null);
  const [stateWarning, setStateWarning] = useState<string | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // 预览面板 target（同一面板支持文件 / 目录两种形态）
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);

  // 视图模式 + 当前选中厂商 tab
  const [viewMode, setViewMode] = useState<ViewMode>("vendor");
  const [activeTab, setActiveTab] = useState<TargetTool | null>(null);

  // 能力集相关
  const [openAssetId, setOpenAssetId] = useState<string | null>(null);
  const [openCapabilitySetId, setOpenCapabilitySetId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [capabilityBusy, setCapabilityBusy] = useState(false);

  // 用户最近的 toggle 意图：key=`${assetId}:${tool}` → 目标 enabled。
  // 用于在 WS 推送的滞后 scan 覆盖 state 时，重新投影用户最新意图，
  // 避免「连续 toggle 时开关被旧真值刷回、来回跳」。scan 真值与意图一致后清除。
  const pendingTogglesRef = useRef<Map<string, boolean>>(new Map());

  // 卸载能力集 dialog
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  // 移除单个能力 dialog
  const [removeAssetId, setRemoveAssetId] = useState<string | null>(null);
  const [removeTool, setRemoveTool] = useState<TargetTool | null>(null);

  // 删除项目（purge）dialog
  const [purgeProjectId, setPurgeProjectId] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);

  // 各订阅能力集的 asset 列表（id + name + type，跨能力集合并），用于：
  //  - PreviewPanel "查看 Asset" 链接匹配
  //  - MirrorTreeView assetTypes 映射（渲染 chip）
  //  - 能力矩阵的别名 / 描述映射
  const [capabilitySetAssets, setCapabilitySetAssets] = useState<
    { id: string; name: string; type: AssetType; alias?: string | null; description?: string }[] | undefined
  >(undefined);
  // capabilitySetId → 订阅卡补充信息（描述 / 声明厂商）；retained 能力集拉不到详情时缺省。
  const [capabilitySetMeta, setCapabilitySetMeta] = useState<Map<string, SubscriptionCapabilitySetMeta>>(new Map());

  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedProjectId;

  // ---- 项目拖拽排序（前端持久化）-------------------------------------------
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadProjectOrder());
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // 按 localStorage 顺序排列；未登记的新项目追加在末尾（保持服务端相对顺序）。
  const orderedProjects = useMemo(() => {
    if (projects.length <= 1) return projects;
    const idx = new Map(projectOrder.map((id, i) => [id, i]));
    return [...projects].sort((a, b) => {
      const ia = idx.get(a.id);
      const ib = idx.get(b.id);
      if (ia === undefined && ib === undefined) return 0;
      if (ia === undefined) return 1;
      if (ib === undefined) return -1;
      return ia - ib;
    });
  }, [projects, projectOrder]);

  const handleProjectDrop = () => {
    if (!dragId || !overId || dragId === overId) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const ids = orderedProjects.map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(overId);
    if (from === -1 || to === -1) {
      setDragId(null);
      setOverId(null);
      return;
    }
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setProjectOrder(next);
    saveProjectOrder(next);
    setDragId(null);
    setOverId(null);
  };

  // ---- 项目列表 + 轮询（非活跃时暂停）---------------------------------------
  const fetchProjectsRef = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    const fetchProjects = async () => {
      const res = await api.get<ProjectWithDevice[]>("/projects", controller.signal);
      if (controller.signal.aborted) return;
      if (res.success && res.data) {
        const list = res.data;
        setProjects(list);
        // 优先沿用上次选中的项目；若已不存在则回退到第一个。
        const cur = selectedRef.current;
        if ((!cur || !list.some((p) => p.id === cur)) && list.length > 0) {
          setSelectedProjectId(list[0]!.id);
        }
      }
      setProjectsLoading(false);
    };
    fetchProjectsRef.current = fetchProjects;
    fetchProjects();
    // KeepAlive 非活跃时不轮询，节省网络和服务端 QPS
    if (!isActive) return () => { controller.abort(); };
    const t = setInterval(fetchProjects, PROJECT_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(t);
    };
  }, [isActive]);

  // ---- 持久化选中项目 ------------------------------------------------------
  useEffect(() => {
    if (selectedProjectId) localStorage.setItem(SELECTED_PROJECT_KEY, selectedProjectId);
  }, [selectedProjectId]);

  // ---- 选中项目的镜像 ------------------------------------------------------
  // 把用户未对齐的 toggle 意图重新投影到 server 返回的 state 上：
  //  - 若 server 真值已等于意图 → 意图达成，清除该 pending；
  //  - 否则（scan 滞后，真值仍是旧值）→ 维持乐观意图，防止开关被刷回。
  const reconcilePending = (s: LocalProjectState): LocalProjectState => {
    if (pendingTogglesRef.current.size === 0) return s;
    let next = s;
    for (const [key, enabled] of [...pendingTogglesRef.current.entries()]) {
      const sep = key.lastIndexOf(":");
      const reqAssetId = key.slice(0, sep);
      const tool = key.slice(sep + 1) as TargetTool;
      const cap = resolveCapability(next.capabilities, reqAssetId);
      const serverEnabled = cap?.vendors[tool]?.enabled;
      if (!cap || serverEnabled === enabled) {
        pendingTogglesRef.current.delete(key); // 已对齐或该能力已不在
      } else {
        next = applyOptimisticToggle(next, cap.type, cap.name, tool, enabled); // 维持意图
      }
    }
    return next;
  };

  const fetchState = async (projectId: string, opts: { force?: boolean; signal?: AbortSignal } = {}) => {
    setStateLoading(true);
    setStateWarning(null);
    const path = opts.force
      ? `/projects/${projectId}/scan`
      : `/projects/${projectId}/state`;
    const res = opts.force
      ? await api.post<LocalProjectState>(path, undefined, opts.signal)
      : await api.get<LocalProjectState>(path, opts.signal);
    if (opts.signal?.aborted) return;
    if (res.success && res.data) {
      setState(reconcilePending(res.data));
      const w = (res as { warning?: string }).warning;
      if (w) setStateWarning(w);
    } else {
      setState(null);
      setStateWarning(res.error || null);
    }
    setStateLoading(false);
  };

  useEffect(() => {
    if (!selectedProjectId) {
      setState(null);
      return;
    }
    setPreviewTarget(null);
    setHeaderMenuOpen(false);
    setBannerDismissed(false);
    const controller = new AbortController();
    fetchState(selectedProjectId, { signal: controller.signal });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  // ---- 自动选定 active tab：优先选 managedCount 最大的已创建厂商 ----
  useEffect(() => {
    if (!state) return;
    const exists = TARGET_TOOLS.filter((t) => state.vendors[t]?.exists);
    if (exists.length === 0) {
      setActiveTab(null);
      return;
    }
    if (activeTab && exists.includes(activeTab)) return;
    // 选 managedCount 最大的，若全为 0 则取第一个
    const ranked = exists.sort(
      (a, b) => (state.vendors[b]!.managedCount - state.vendors[a]!.managedCount),
    );
    setActiveTab(ranked[0]!);
  }, [state, activeTab]);

  // ---- WS：监听 web:project:state_changed（指数退避 + 非活跃暂停）-----------
  useEffect(() => {
    // 非活跃时不保持 WS 连接
    if (!isActive) return;
    const url = new URL("/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket | null = null;
    let stopped = false;
    let reconnectTimer: number | null = null;
    let backoff = 3_000; // 起始 3s，翻倍到最大 30s
    const MAX_BACKOFF = 30_000;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(url.toString());
      ws.onopen = () => { backoff = 3_000; }; // 连接成功重置退避
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "web:project:state_changed") {
            const pid = msg.payload?.projectId;
            // 刷新选中项目 state + 刷新项目列表（可能状态/capabilitySet变化）
            if (pid && pid === selectedRef.current) fetchState(pid);
            fetchProjectsRef.current();
          } else if (msg.type === "project:registered") {
            // 新项目注册
            fetchProjectsRef.current();
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        reconnectTimer = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [isActive]);

  // ---- 拉各订阅 capabilitySet 的 asset 列表 + 订阅卡补充信息 --------------------
  const project = projects.find((p) => p.id === selectedProjectId);
  const explicitCapabilitySetIds = useMemo(
    () =>
      (project?.subscriptions ?? [])
        .map((s) => s.capabilitySetId)
        .filter((capabilitySetId): capabilitySetId is string => capabilitySetId !== null)
        .sort(),
    [project?.subscriptions],
  );
  const explicitCapabilitySetKey = explicitCapabilitySetIds.join(",");
  useEffect(() => {
    const capabilitySetIds = explicitCapabilitySetKey ? explicitCapabilitySetKey.split(",") : [];
    if (capabilitySetIds.length === 0) {
      setCapabilitySetAssets(undefined);
      setCapabilitySetMeta(new Map());
      return;
    }
    let alive = true;
    Promise.all(
      capabilitySetIds.map((capabilitySetId) =>
        api.get<{ assets?: Array<any>; description?: string; targetTools?: TargetTool[] }>(
          `/capability-sets/${capabilitySetId}`,
        ),
      ),
    ).then((results) => {
      if (!alive) return;
      const list: { id: string; name: string; type: AssetType; alias?: string | null; description?: string }[] = [];
      const seen = new Set<string>();
      const meta = new Map<string, SubscriptionCapabilitySetMeta>();
      for (let i = 0; i < capabilitySetIds.length; i++) {
        const res = results[i]!;
        if (!res.success || !res.data) continue; // retained 能力集详情拉不到，跳过
        meta.set(capabilitySetIds[i]!, {
          description: res.data.description ?? "",
          targetTools: res.data.targetTools ?? [],
        });
        for (const entry of res.data.assets ?? []) {
          const a = (entry as { asset?: any }).asset ?? entry;
          if (a?.id && a?.name && a?.type && !seen.has(a.id)) {
            seen.add(a.id);
            list.push({ id: a.id, name: a.name, type: a.type, alias: a.alias ?? null, description: a.description ?? "" });
          }
        }
      }
      setCapabilitySetAssets(list);
      setCapabilitySetMeta(meta);
    });
    return () => {
      alive = false;
    };
  }, [explicitCapabilitySetKey]);

  // assetId → AssetType 映射
  const assetTypes = useMemo(() => {
    const m = new Map<string, AssetType>();
    for (const a of capabilitySetAssets ?? []) m.set(a.id, a.type);
    return m;
  }, [capabilitySetAssets]);

  // assetId → 别名 / 描述 映射：用于在本地控制台各视图以「名称为主、别名灰色」展示，
  // 描述用于 hover 提示（均取自创建能力时的 Asset 记录）。
  const assetAliases = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of capabilitySetAssets ?? []) {
      const alias = a.alias?.trim();
      if (alias) m.set(a.id, alias);
    }
    return m;
  }, [capabilitySetAssets]);
  const assetDescriptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of capabilitySetAssets ?? []) {
      if (a.description) m.set(a.id, a.description);
    }
    return m;
  }, [capabilitySetAssets]);

  // 能力矩阵「来源能力集」过滤器选项：项目的订阅集合（显式能力集 + 「单独添加」）。
  const capabilitySourceOptions = useMemo(
    () =>
      (project?.subscriptions ?? []).map((s) => ({
        capabilitySetId: s.capabilitySetId,
        name: s.capabilitySetId === null ? "单独添加" : (s.capabilitySetName ?? s.capabilitySetId!),
      })),
    [project?.subscriptions],
  );

  // ---- 操作：刷新 / 卸载 / 能力开关 -------------------------------
  const handleRefresh = async () => {
    if (!selectedProjectId) return;
    setRefreshing(true);
    try {
      await fetchState(selectedProjectId, { force: true });
      toast.success("已重新扫描", "agent 已完成本地目录刷新");
    } finally {
      setRefreshing(false);
    }
  };

  // 订阅变更（增删订阅、sync-policy、targets）后统一刷新：项目列表 + 本地镜像。
  const refreshAfterSubscriptionChange = async () => {
    const list = await api.get<ProjectWithDevice[]>("/projects");
    if (list.success && list.data) setProjects(list.data);
    if (selectedRef.current) await fetchState(selectedRef.current);
  };

  const handleUninstallConfirm = async () => {
    if (!selectedProjectId || !project) return;
    setUninstalling(true);
    const res = await api.post<{ success: boolean; filesWritten: string[]; errors: string[] }>(
      `/projects/${selectedProjectId}/uninstall`,
    );
    setUninstalling(false);
    setUninstallOpen(false);
    if (!res.success || !res.data) {
      toast.error("卸载失败", res.error || "未知错误");
      return;
    }
    if (res.data.success) {
      toast.success(
        "已卸载全部能力集",
        `共清理 ${res.data.filesWritten.length} 个文件`,
      );
      const list = await api.get<ProjectWithDevice[]>("/projects");
      if (list.success && list.data) setProjects(list.data);
      await fetchState(selectedProjectId);
    } else {
      toast.error("卸载部分失败", res.data.errors.join("; "));
    }
  };

  const handleToggleCapability = async (assetId: string, tool: TargetTool, enabled: boolean) => {
    if (!selectedProjectId || capabilityBusy) return;
    setCapabilityBusy(true);
    // 解析能力行：矩阵传代表 id；树视图可能传某厂商受管 id 或 external:<type>:<name>。
    const cap = resolveCapability(state?.capabilities, assetId);
    const vendor = cap?.vendors[tool];
    // 该厂商这份是否为磁盘副本（未纳管）→ 需先 adopt（内部处理，用户无感知）；
    // 否则用该厂商自己的受管 assetId（同名能力在不同厂商可能是不同 asset 行）。
    const isExternalVendor = !!vendor?.external;
    const reqAssetId = isExternalVendor
      ? `external:${cap!.type}:${cap!.name}`
      : (vendor?.assetId ?? cap?.assetId ?? assetId);
    const externalAsset = isExternalVendor
      ? { name: cap!.name, type: cap!.type, files: vendor!.files }
      : undefined;
    // 记录用户意图（key 用最终请求 id）：WS 滞后 scan 回来时由 reconcilePending 维持。
    const key = `${reqAssetId}:${tool}`;
    pendingTogglesRef.current.set(key, enabled);
    // 乐观更新：按 (type,name) 翻转矩阵格 + 树节点，UI 立刻响应；失败回滚 + toast。
    const prev = state;
    setState((s) => (s && cap ? applyOptimisticToggle(s, cap.type, cap.name, tool, enabled) : s));
    const res = await api.post<{ filesWritten: string[]; filesRemoved: string[]; adoptedAssetId?: string }>(
      `/projects/${selectedProjectId}/capabilities/toggle`,
      { assetId: reqAssetId, tool, enabled, ...(externalAsset ? { externalAsset } : {}) },
    );
    setCapabilityBusy(false);
    if (!res.success || !res.data) {
      pendingTogglesRef.current.delete(key);
      setState(prev);
      toast.error("操作失败", res.error || "未知错误");
      return;
    }
    // 共享能力轻提示：该能力被多个订阅引用，开关对所有来源同时生效（ADR-0006 决策 3）。
    if (cap?.sources && cap.sources.length > 1) {
      const names = cap.sources.map((s) => (s.capabilitySetId === null ? "单独添加" : s.name)).join("、");
      toast.info("共享能力已更新", `该能力同时被 ${names} 引用，本次${enabled ? "开启" : "关闭"}对所有来源生效`);
    }
    // adopt 后 assetId 变真实 id / 行 id 变化 → WS 推回镜像旧 key 无法对齐，直接 refetch。
    if (isExternalVendor || res.data.adoptedAssetId) {
      pendingTogglesRef.current.delete(key);
      await fetchState(selectedProjectId, { force: true });
    }
  };

  const handleRemoveCapabilityConfirm = async () => {
    if (!selectedProjectId || !removeAssetId || capabilityBusy) return;
    setCapabilityBusy(true);
    const aid = removeAssetId;
    const tool = removeTool;
    setRemoveAssetId(null);
    setRemoveTool(null);
    // 解析能力行 + 目标厂商格：磁盘副本需带 adopt 信息，受管则用该厂商受管 assetId。
    const cap = resolveCapability(state?.capabilities, aid);
    const vendor = tool ? cap?.vendors[tool] : undefined;
    const isExternalVendor = !!vendor?.external;
    const reqAssetId = isExternalVendor
      ? `external:${cap!.type}:${cap!.name}`
      : (vendor?.assetId ?? cap?.assetId ?? aid);
    const externalAsset =
      isExternalVendor && vendor
        ? { name: cap!.name, type: cap!.type, files: vendor.files }
        : undefined;
    const res = await api.post<{ filesWritten: string[]; filesRemoved: string[] }>(
      `/projects/${selectedProjectId}/capabilities/remove`,
      { assetId: reqAssetId, ...(tool ? { tool } : {}), ...(externalAsset ? { externalAsset } : {}) },
    );
    setCapabilityBusy(false);
    const asset = capabilitySetAssets?.find((a) => a.id === reqAssetId);
    const name = asset?.name ?? cap?.name ?? aid;
    if (!res.success || !res.data) {
      toast.error("移除失败", res.error || "未知错误");
      return;
    }
    toast.success(`已移除 ${name}`, "已从所有厂商目录与隔离区清理");
    await fetchState(selectedProjectId, { force: true });
  };

  const handlePurgeConfirm = async () => {
    if (!purgeProjectId || purging) return;
    setPurging(true);
    const targetId = purgeProjectId;
    const res = await api.post<{ depth: "deep" | "shallow"; warning?: string }>(
      `/projects/${targetId}/purge`,
    );
    setPurging(false);
    setPurgeProjectId(null);
    if (!res.success || !res.data) {
      toast.error("删除失败", res.error || "未知错误");
      return;
    }
    // 若删除的是当前选中项目，切到第一个可用项目
    if (selectedProjectId === targetId) {
      const list = await api.get<ProjectWithDevice[]>("/projects");
      if (list.success && list.data) {
        setProjects(list.data);
        const next = list.data.find((p) => p.id !== targetId);
        setSelectedProjectId(next ? next.id : null);
      }
    } else {
      const list = await api.get<ProjectWithDevice[]>("/projects");
      if (list.success && list.data) setProjects(list.data);
    }
    if (res.data.depth === "deep") {
      toast.success("项目已删除", "服务端记录与本地痕迹均已清理");
    } else {
      toast.success("项目已删除（浅度清理）", res.data.warning || "本地痕迹将在 Agent 上线后自动清理");
    }
  };

  const copyText = async (text: string, label = "内容") => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label}已复制`, text);
    } catch {
      toast.error("复制失败", "浏览器拒绝访问剪贴板");
    }
  };

  // 导出当前本地镜像快照为 JSON 文件（真实可下载结果，替换原占位 toast）。
  const handleExportSnapshot = () => {
    if (!project || !state) {
      toast.error("无法导出", "本地镜像尚未就绪");
      return;
    }
    const snapshot = {
      project: { id: project.id, name: project.projectName, path: project.normalizedPath },
      subscriptions: project.subscriptions.map((s) => ({
        capabilitySetId: s.capabilitySetId,
        capabilitySetName: s.capabilitySetName ?? (s.capabilitySetId === null ? "单独添加" : null),
        syncPolicy: s.syncPolicy,
        targetTools: s.targetTools,
        installedAt: s.installedAt,
        retained: s.retained ?? false,
      })),
      scannedAt: state.scannedAt,
      capabilities: state.capabilities ?? [],
      vendors: state.vendors,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `loom-${project.projectName}-mirror.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("已导出镜像清单", `${a.download}`);
  };

  // ---- 当前 tab 的镜像（按厂商视图） -------------------------------------
  const activeMirror = activeTab && state ? state.vendors[activeTab] : null;
  const showBanner = state?.driftCleared && !bannerDismissed;

  // 给当前 tab 的 tree 挂上 MCP 虚拟子节点的 UI 兜底：
  // scanner 只在 lock.aggregates 有登记时才生成 mcp-server 子节点；早期/部分 lock
  // 没填 aggregates 的项目，mcp.json 看上去就是个普通文件，看不到内含的 server。
  // 这里在 web 端做兜底：从 capabilities 里挑出 type='mcp' 且映射到本 tool 的能力，
  // 当成虚拟子节点挂给本 vendor 的 mcp.json 节点（仅当 scanner 没挂时）。
  const augmentedTree = useMemo<LocalFileNode[] | null>(() => {
    if (!activeMirror || !state) return null;
    if (!state.capabilities || state.capabilities.length === 0) return activeMirror.tree;
    const tool = activeMirror.tool;
    const mcpCaps = state.capabilities.filter((c) => c.type === "mcp" && c.vendors[tool]);
    if (mcpCaps.length === 0) return activeMirror.tree;
    return cloneTreeWithMcpFallback(activeMirror.tree, mcpCaps, tool);
  }, [activeMirror, state]);

  // 预览面板用的 tree：跟主区视图共用 augmented 版本，保证 mcp.json 在两处行为一致
  const previewVendorTree = augmentedTree ?? activeMirror?.tree ?? undefined;

  return (
    <div className="flex flex-col gap-0">
      {/* ======================== 顶部 Banner ======================== */}
      {showBanner && (
        <div className="bg-amber-50/80 border border-amber-200/60 rounded-xl mb-5 px-4 py-3 flex items-start gap-3">
          <span className="w-2 h-2 mt-1.5 rounded-full bg-amber-500 shrink-0 animate-pulse" />
          <div className="flex-1 text-xs text-amber-900 leading-relaxed">
            <span className="font-semibold">{project?.projectName}</span> 的 lock 文件中所有
            Loom 文件均不存在于磁盘，已自动清除失效记录。
          </div>
          <button
            type="button"
            onClick={() => setBannerDismissed(true)}
            aria-label="关闭通知"
            className="text-amber-700 hover:text-amber-900 p-1 -mr-1 -mt-1"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      <div className="flex gap-6">
        {/* ======================== 左侧：项目列表 ======================== */}
        {projectsLoading || projects.length > 0 ? (
        <div className="w-72 shrink-0">
          <div className="flex items-center justify-between mb-3 px-1">
            <h2 className="text-sm font-semibold tracking-tight text-text-primary">
              项目
            </h2>
            <span className="text-[11px] text-text-muted bg-surface-sunken rounded-full px-2 py-0.5 tabular-nums">
              {projectsLoading && projects.length === 0 ? "…" : projects.length}
            </span>
          </div>
          {projectsLoading && projects.length === 0 ? (
            <div className="space-y-1.5" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[60px] rounded-xl bg-surface-sunken animate-pulse" />
              ))}
            </div>
          ) : projects.length === 0 ? null : (
            <ul className="space-y-1.5" role="listbox">
              {orderedProjects.map((p) => {
                const selected = selectedProjectId === p.id;
                const subs = p.subscriptions.filter((s) => s.capabilitySetId !== null);
                const subSummary =
                  subs.length > 0
                    ? `${subs.length} 个能力集：${subs.map((s) => s.capabilitySetName ?? s.capabilitySetId).join("、")}`
                    : "未订阅能力集";
                const isDragging = dragId === p.id;
                const isOver = !!dragId && dragId !== p.id && overId === p.id;
                return (
                  <li
                    key={p.id}
                    draggable
                    onDragStart={(e) => {
                      setDragId(p.id);
                      setOverId(null);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", p.id);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragId && dragId !== p.id) setOverId(p.id);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleProjectDrop();
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverId(null);
                    }}
                    className={`group relative cursor-grab active:cursor-grabbing ${isDragging ? "opacity-50" : ""}`}
                  >
                    <button
                      role="option"
                      aria-selected={selected}
                      onClick={() => setSelectedProjectId(p.id)}
                      className={`relative w-full text-left p-3 pl-8 rounded-xl border transition-all ${
                        selected
                          ? "border-brand/20 bg-brand-50 shadow-[inset_3px_0_0_#4B5AD3]"
                          : isOver
                          ? "border-brand/40 bg-brand-50/60"
                          : "border-surface-sunken bg-white hover:border-gray-200 hover:bg-surface-card"
                      }`}
                    >
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted/60 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                        <GripVertical size={12} />
                      </span>
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm font-medium truncate ${selected ? "text-text-primary" : "text-text-primary"}`}>
                          {p.projectName}
                        </span>
                        <span className="flex items-center gap-1 shrink-0 transition-opacity group-hover:opacity-0">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              p.status === "online"
                                ? "bg-emerald-500"
                                : p.status === "syncing"
                                ? "bg-amber-500"
                                : "bg-gray-300"
                            }`}
                          />
                          <span className="text-[10px] font-medium text-text-muted">
                            {p.status === "online" ? "在线" : p.status === "syncing" ? "同步" : "离线"}
                          </span>
                        </span>
                      </div>
                      <div className="text-xs text-text-muted mt-1 truncate" title={subSummary}>
                        {subSummary}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPurgeProjectId(p.id);
                      }}
                      aria-label={`删除项目 ${p.projectName}`}
                      title="删除项目（抹掉全部痕迹）"
                      className="absolute top-2.5 right-2.5 w-6 h-6 grid place-items-center rounded-md text-text-muted opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 transition"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        ) : null}

        {/* ======================== 右侧：项目详情 ======================== */}
        {project ? (
          <div className="flex-1 min-w-0">
            {/* ─── Header ─── */}
            <header className="flex items-start justify-between gap-6 mb-6">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5 mb-1 flex-wrap">
                  <h1 className="text-2xl font-semibold tracking-tight text-text-primary truncate">
                    {project.projectName}
                  </h1>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                      project.status === "online"
                        ? "bg-emerald-50 border border-emerald-100 text-emerald-700"
                        : "bg-surface-card border border-surface-sunken text-text-muted"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        project.status === "online" ? "bg-emerald-500" : "bg-gray-400"
                      }`}
                    />
                    {project.status === "online" ? "在线" : project.status}
                    {project.device?.deviceName && (
                      <span className="text-text-secondary"> · {project.device.deviceName}</span>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => copyText(project.normalizedPath, "路径")}
                  aria-label="复制项目路径"
                  className="group inline-flex items-center gap-1.5 max-w-full"
                >
                  <code className="text-[11px] font-mono text-text-muted truncate group-hover:text-text-secondary">
                    {project.normalizedPath}
                  </code>
                  <Copy size={12} className="text-text-muted shrink-0 opacity-0 group-hover:opacity-100 transition" />
                </button>
              </div>
              <div className="shrink-0 flex items-center gap-2">
                {!state?.legacyLock && (
                  <button
                    type="button"
                    onClick={() => setAddDialogOpen(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-brand bg-brand-50 border border-brand/20 rounded-lg hover:bg-brand-soft transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                  >
                    <Plus size={13} />
                    添加能力
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title="重新扫描（强制 agent 刷新缓存）"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-text-secondary border border-gray-200 rounded-lg bg-white hover:bg-surface-card hover:border-gray-300 hover:text-text-primary disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                >
                  <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
                  重新扫描
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setHeaderMenuOpen((v) => !v)}
                    aria-label="更多操作"
                    aria-haspopup="menu"
                    className="w-8 h-8 grid place-items-center text-text-muted border border-gray-200 rounded-lg bg-white hover:bg-surface-card hover:text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                  >
                    <MoreHorizontal size={15} />
                  </button>
                  {headerMenuOpen && (
                    <div
                      className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-lift border border-surface-sunken overflow-hidden z-20 animate-scale-in origin-top-right"
                      onMouseLeave={() => setHeaderMenuOpen(false)}
                    >
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-surface-card inline-flex items-center gap-2"
                        onClick={() => {
                          setHeaderMenuOpen(false);
                          handleExportSnapshot();
                        }}
                      >
                        <Download size={14} />
                        导出镜像清单 (JSON)
                      </button>
                      {project.subscriptions.length > 0 && (
                        <>
                          <div className="h-px bg-surface-sunken" />
                          <button
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 inline-flex items-center gap-2"
                            onClick={() => {
                              setHeaderMenuOpen(false);
                              setUninstallOpen(true);
                            }}
                          >
                            <Trash2 size={14} />
                            卸载全部能力集…
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </header>

            {stateWarning && (
              <div className="mb-5 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-100 text-xs text-amber-800">
                {stateWarning}
              </div>
            )}

            {/* ─── 订阅条（每个能力集一卡 + 隐式订阅简卡 + 添加能力集） ─── */}
            <SubscriptionStrip
              project={project}
              capabilitySetMeta={capabilitySetMeta}
              hasStandaloneCapabilities={
                !!state?.capabilities?.some((c) => (c.sources ?? []).some((src) => src.capabilitySetId === null))
              }
              legacyLock={!!state?.legacyLock}
              onChanged={refreshAfterSubscriptionChange}
              onExport={handleExportSnapshot}
              onOpenCapabilitySet={(capabilitySetId) => setOpenCapabilitySetId(capabilitySetId)}
            />

            {/* ─── 同步队列（项目维度） ─── */}
            <ProjectSyncCard projectId={project.id} isActive={isActive} />

            {/* ─── 本地镜像 ─── */}
            <section>
              <div className="flex items-end justify-between mb-4 gap-4 flex-wrap">
                <div>
                  <h2 className="text-base font-semibold text-text-primary">本地镜像</h2>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    {state?.scannedAt && (
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1 h-1 rounded-full bg-emerald-500" />
                        {new Date(state.scannedAt).toLocaleTimeString()} 同步
                      </span>
                    )}
                    {state && (
                      <>
                        <span className="mx-1.5 text-text-muted/60">·</span>
                        {TARGET_TOOLS.filter((t) => state.vendors[t]?.exists).length} 个厂商目录
                        {state.capabilities && state.capabilities.length > 0 && (
                          <>
                            <span className="mx-1.5 text-text-muted/60">·</span>
                            {state.capabilities.length} 项能力
                          </>
                        )}
                      </>
                    )}
                  </p>
                </div>
                {/* 视图切换 */}
                <div role="tablist" aria-label="视图切换" className="flex bg-surface-sunken rounded-full p-0.5 text-xs font-medium">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "vendor"}
                    onClick={() => setViewMode("vendor")}
                    className={`px-3.5 py-1.5 rounded-full inline-flex items-center gap-1.5 transition ${
                      viewMode === "vendor"
                        ? "bg-white shadow-sm text-text-primary"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    <LayoutGrid size={13} />
                    按厂商
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "capability"}
                    onClick={() => setViewMode("capability")}
                    className={`px-3.5 py-1.5 rounded-full inline-flex items-center gap-1.5 transition ${
                      viewMode === "capability"
                        ? "bg-white shadow-sm text-text-primary"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    <ListIcon size={13} />
                    按能力
                  </button>
                </div>
              </div>

              {state?.legacyLock && (
                <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 text-amber-700 text-xs">
                  该项目当前为旧版安装格式（基于整体 plan 的 lock）。重新安装该能力集即可启用「单项能力管理」（开关 / 添加 / 移除）。
                </div>
              )}

              {/* 按厂商 */}
              {viewMode === "vendor" && state && (
                <>
                  <VendorTabStrip
                    vendors={state.vendors}
                    active={activeTab}
                    onSelect={setActiveTab}
                    refreshing={refreshing || stateLoading}
                    onRefresh={handleRefresh}
                  />
                  {activeMirror && augmentedTree ? (
                    <div className="rounded-2xl border border-surface-sunken bg-white shadow-sm overflow-hidden">
                      <div className="px-3 py-1.5 border-b border-surface-sunken bg-surface-card/50 flex items-center justify-between">
                        <code className="text-[10.5px] text-text-muted font-mono">
                          {activeMirror.dir}/
                        </code>
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => treeRef.current?.expandAll()}
                            title="全部展开"
                            aria-label="全部展开"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-white"
                          >
                            <ChevronsUpDown size={11} />
                            展开
                          </button>
                          <button
                            type="button"
                            onClick={() => treeRef.current?.collapseAll()}
                            title="全部折叠"
                            aria-label="全部折叠"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-white"
                          >
                            <ChevronsDownUp size={11} />
                            折叠
                          </button>
                        </div>
                      </div>
                      <div className="bg-surface-card/30 max-h-[28rem] overflow-y-auto">
                        <MirrorTreeView
                          ref={treeRef}
                          nodes={augmentedTree}
                          activePath={previewTarget?.kind === "file" ? previewTarget.path : ""}
                          assetAliases={assetAliases}
                          onSelect={(path, managed) =>
                            setPreviewTarget({ kind: "file", path, managed })
                          }
                          onDirSelect={(path) => {
                            const node = findNodeByPath(augmentedTree, path);
                            if (node) setPreviewTarget({ kind: "dir", path, node });
                          }}
                          tool={activeMirror.tool}
                          assetTypes={assetTypes}
                          onToggleCapability={handleToggleCapability}
                          onRemoveCapability={(aid, t) => { setRemoveAssetId(aid); setRemoveTool(t); }}
                          disabled={!!state?.legacyLock}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="px-4 py-12 text-xs text-text-muted text-center bg-surface-card/50 rounded-2xl">
                      本地未发现任何已创建的厂商目录。
                      {!project.subscriptions.some((s) => s.capabilitySetId !== null) &&
                        " 添加一个能力集即可创建对应目录。"}
                    </div>
                  )}
                </>
              )}

              {/* 按能力 */}
              {viewMode === "capability" && state && (
                state.capabilities && state.capabilities.length > 0 ? (
                  <CapabilityMatrix
                    capabilities={state.capabilities}
                    vendors={state.vendors}
                    assetAliases={assetAliases}
                    assetDescriptions={assetDescriptions}
                    sourceOptions={capabilitySourceOptions}
                    onToggle={handleToggleCapability}
                    onRemove={(aid) => setRemoveAssetId(aid)}
                    onPreview={(aid) => {
                      setPreviewTarget(null);
                      setOpenAssetId(aid);
                    }}
                    disabled={!!state?.legacyLock || capabilityBusy}
                  />
                ) : (
                  <div className="px-4 py-12 text-xs text-text-muted text-center bg-surface-card/50 rounded-2xl">
                    {state?.legacyLock
                      ? "该项目使用 legacy lock，请重新安装能力集以启用矩阵视图"
                      : "尚未安装任何能力"}
                  </div>
                )
              )}
            </section>
          </div>
        ) : projectsLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2.5 py-24 text-text-muted">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-xs">加载项目中…</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-20 px-6">
            <div className="w-full max-w-lg">
              <div className="text-center mb-7">
                <div className="w-16 h-16 rounded-2xl bg-brand-soft grid place-items-center mx-auto mb-5 text-brand">
                  <Terminal className="w-8 h-8" />
                </div>
                <p className="text-lg font-semibold text-text-primary mb-1.5">还没有已注册项目</p>
                <p className="text-sm text-text-muted">
                  在本地终端依次执行以下命令，将项目接入 Loom。
                </p>
              </div>
              <ol className="space-y-2.5">
              {[
                {
                  cmd: `loom login --endpoint ${window.location.origin} --token <token>`,
                  desc: "在「设置」页生成 CLI Token 后填入",
                },
                { cmd: "loom start", desc: "启动 Agent 并绑定当前设备" },
                { cmd: "cd <项目目录> && loom register", desc: "注册当前目录为 Loom 项目" },
              ].map((step, i) => (
                <li
                  key={i}
                  className="group flex items-start gap-3 rounded-xl border border-surface-sunken bg-white p-3.5 shadow-card hover:border-gray-200 transition-colors"
                >
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand-soft text-brand grid place-items-center text-xs font-semibold">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <code className="block text-[13px] font-mono text-text-primary break-all">
                      {step.cmd}
                    </code>
                    <p className="text-xs text-text-muted mt-1">{step.desc}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyText(step.cmd, "命令")}
                    aria-label="复制命令"
                    className="flex-shrink-0 p-1.5 rounded-lg text-text-muted hover:bg-surface-card hover:text-text-secondary opacity-0 group-hover:opacity-100 transition"
                  >
                    <Copy size={14} />
                  </button>
                </li>
              ))}
            </ol>
            </div>
          </div>
        ) : (
          <div className="flex-1 text-text-muted text-center py-12">
            请选择左侧项目查看本地镜像
          </div>
        )}
      </div>

      {/* ======================== 预览面板 ======================== */}
      {previewTarget && project && (
        <PreviewPanel
          projectId={project.id}
          target={previewTarget}
          vendorTree={previewVendorTree}
          vendorTool={activeTab ?? undefined}
          assetTypes={assetTypes}
          assetAliases={assetAliases}
          capabilitySetAssets={capabilitySetAssets}
          onNavigate={setPreviewTarget}
          onToggleCapability={handleToggleCapability}
          onRemoveCapability={(aid, t) => { setRemoveAssetId(aid); setRemoveTool(t); }}
          capabilityDisabled={!!state?.legacyLock}
          onOpenAsset={(id) => {
            setPreviewTarget(null);
            setOpenAssetId(id);
          }}
          onClose={() => setPreviewTarget(null)}
        />
      )}

      {/* DetailPanel: Asset 详情浮层 */}
      {openAssetId && (
        <DetailPanel type="asset" id={openAssetId} onClose={() => setOpenAssetId(null)} />
      )}

      {/* DetailPanel: 能力集详情浮层（复用市场/列表的同款面板） */}
      {openCapabilitySetId && (
        <DetailPanel type="capabilitySet" id={openCapabilitySetId} onClose={() => setOpenCapabilitySetId(null)} />
      )}

      {/* 添加能力 */}
      {addDialogOpen && project && (
        <AddCapabilityDialog
          projectId={project.id}
          alreadyInstalledIds={(capabilitySetAssets ?? []).map((a) => a.id)}
          title="为项目添加能力"
          subtitle="从 Asset 库挑选若干能力，作为「单独添加」的能力直接安装（不属于任何能力集）。"
          onClose={() => setAddDialogOpen(false)}
          onAdded={() => toast.success("已添加能力", "本地镜像将随 agent 推送实时更新")}
        />
      )}

      {/* 卸载全部能力集确认 */}
      {project && (
        <ConfirmDialog
          open={uninstallOpen}
          kind="danger"
          title={`卸载「${project.projectName}」的全部能力集？`}
          description={
            <>
              将移除该项目的全部能力集订阅与单独添加的能力，从本地{" "}
              <span className="font-medium text-text-primary">
                {state ? TARGET_TOOLS.filter((t) => state.vendors[t]?.exists).length : 0}
              </span>{" "}
              个厂商目录中清除 Loom 文件，并删除 lock 记录。此操作
              <span className="font-medium text-red-600">不可撤销</span>。
            </>
          }
          confirmText={project.projectName}
          confirmLabel="确认卸载"
          confirmingLabel="卸载中…"
          busy={uninstalling}
          onConfirm={handleUninstallConfirm}
          onCancel={() => setUninstallOpen(false)}
        />
      )}

      {/* 移除能力确认 */}
      <ConfirmDialog
        open={!!removeAssetId}
        kind="danger"
        title="移除该能力？"
        description={
          <>
            将从所有厂商目录与隔离区清理对应文件，并从 lock 中删除记录。
            该能力之后将不再随项目同步。
            {(() => {
              const cap = removeAssetId ? resolveCapability(state?.capabilities, removeAssetId) : undefined;
              if (!cap?.sources || cap.sources.length < 2) return null;
              const names = cap.sources.map((s) => (s.capabilitySetId === null ? "单独添加" : s.name)).join("、");
              return (
                <span className="block mt-1.5 text-amber-700">
                  注意：该能力同时被 {names} 引用，移除后这些来源都将不再包含它。
                </span>
              );
            })()}
          </>
        }
        confirmLabel="确认移除"
        confirmingLabel="移除中…"
        busy={capabilityBusy}
        onConfirm={handleRemoveCapabilityConfirm}
        onCancel={() => { setRemoveAssetId(null); setRemoveTool(null); }}
      />

      {/* 删除项目确认 */}
      <ConfirmDialog
        open={!!purgeProjectId}
        kind="danger"
        title={`删除项目「${projects.find((p) => p.id === purgeProjectId)?.projectName ?? ""}」？`}
        description={
          <>
            将抹掉该项目的全部痕迹：服务端记录、本地 lock、隔离区、skill 统计，以及
            <code className="mx-1 px-1 py-0.5 rounded bg-surface-sunken text-[11px]">~/.loom</code>
            下该项目相关文件。此操作
            <span className="font-medium text-red-600">不可撤销</span>。
          </>
        }
        extra={
          <div className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-100 text-[11px] text-amber-800 leading-relaxed">
            {projects.find((p) => p.id === purgeProjectId)?.status === "online"
              ? "Agent 在线：将执行深度清理，本地痕迹一并清除。"
              : "Agent 未在线：仅清理服务端记录（浅度清理），本地 ~/.loom 痕迹将在 Agent 上线后自动清理。"}
          </div>
        }
        confirmLabel="确认删除"
        confirmingLabel="删除中…"
        busy={purging}
        onConfirm={handlePurgeConfirm}
        onCancel={() => setPurgeProjectId(null)}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// 工具：从 nodes 树中按 path 找节点（目录预览要用）
// ────────────────────────────────────────────────────────────────────────
function findNodeByPath(nodes: LocalFileNode[], path: string): LocalFileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.type === "dir" && n.children) {
      const hit = findNodeByPath(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// 能力行解析：矩阵传代表 id；树视图可能传某厂商受管 id 或 external:<type>:<name>。
// 统一按「直接 id → external:type:name 的 type+name → 任一厂商受管 id」解析到同一行。
// ────────────────────────────────────────────────────────────────────────
function resolveCapability(
  caps: AssetCapability[] | undefined,
  assetId: string,
): AssetCapability | undefined {
  if (!caps) return undefined;
  const direct = caps.find((c) => c.assetId === assetId);
  if (direct) return direct;
  if (assetId.startsWith("external:")) {
    const segs = assetId.split(":");
    const type = segs[1];
    const name = segs.slice(2).join(":");
    const byName = caps.find((c) => c.type === type && c.name === name);
    if (byName) return byName;
  }
  return caps.find((c) => Object.values(c.vendors).some((v) => v?.assetId === assetId));
}

// ────────────────────────────────────────────────────────────────────────
// 乐观更新：toggle 一刀切到本地 state，等 WS 推送来对齐
// ────────────────────────────────────────────────────────────────────────
//
// 按 (type, name) 定位能力行（跨厂商合并后行 id 可能是任一受管 id），把 tool 格的
// enabled 翻在两个地方：
//  1) state.capabilities[*].vendors[tool].enabled —— 矩阵视图依据
//  2) state.vendors[tool].tree 内对应文件 node.enabled —— 树视图与 toggle 显示依据
// 树节点 assetId 可能是该厂商受管 id 或 external:<type>:<name>，故按「该行涉及的所有
// assetId 集合」匹配翻转。
function applyOptimisticToggle(
  s: LocalProjectState,
  type: AssetType,
  name: string,
  tool: TargetTool,
  enabled: boolean,
): LocalProjectState {
  const cap = s.capabilities?.find((c) => c.type === type && c.name === name);
  const nodeIds = new Set<string>();
  if (cap) {
    nodeIds.add(`external:${type}:${name}`);
    for (const v of Object.values(cap.vendors)) if (v?.assetId) nodeIds.add(v.assetId);
  }
  const newCapabilities = s.capabilities?.map((c) => {
    if (c.type !== type || c.name !== name) return c;
    const v = c.vendors[tool];
    if (!v) return c;
    return { ...c, vendors: { ...c.vendors, [tool]: { ...v, enabled } } };
  });
  const oldMirror = s.vendors[tool];
  const newVendors: Record<TargetTool, typeof oldMirror> = { ...s.vendors };
  if (oldMirror) {
    newVendors[tool] = {
      ...oldMirror,
      tree: walkAndFlipNode(oldMirror.tree, nodeIds, enabled),
    };
  }
  return { ...s, capabilities: newCapabilities, vendors: newVendors };
}

function walkAndFlipNode(
  nodes: LocalFileNode[],
  assetIds: Set<string>,
  enabled: boolean,
): LocalFileNode[] {
  return nodes.map((n) => {
    const next = n.assetId && assetIds.has(n.assetId) ? { ...n, enabled } : n;
    if (next.children && next.children.length > 0) {
      return { ...next, children: walkAndFlipNode(next.children, assetIds, enabled) };
    }
    return next;
  });
}

// ────────────────────────────────────────────────────────────────────────
// MCP 虚拟子节点兜底
// ────────────────────────────────────────────────────────────────────────
//
// 业务背景：scanner 只在 lock.aggregates[tool] 登记了某个 mcp.json 时才会读它的
// JSON 内容、并把每个 server 名 当成 LocalFileNode 的 virtual="mcp-server" 子节点
// 挂回来。早期/legacy 安装可能没填 aggregates，mcp.json 表现为一个无 children 的
// 普通文件，UI 上完全看不到内含的 server，开关也无从下手。
//
// 这里在 web 侧做"展示层兜底"：从 LocalProjectState.capabilities 里挑 type='mcp'
// 且 vendors[tool] 有记录的能力，按 (tool 推断出的 mcp.json 路径) 把它们当成虚拟
// 子节点挂回。tool=cursor → ".cursor/mcp.json"；其它 vendor 同理。
//
// 该函数纯函数 + 浅拷贝，不会污染原 tree。仅当 scanner 没挂 children 时介入。
function cloneTreeWithMcpFallback(
  nodes: LocalFileNode[],
  mcpCaps: AssetCapability[],
  tool: TargetTool,
): LocalFileNode[] {
  const mcpJsonPath = `${TARGET_DIRS[tool]}/mcp.json`;
  return nodes.map((n) => walk(n));

  function walk(n: LocalFileNode): LocalFileNode {
    if (n.path === mcpJsonPath && (!n.children || n.children.length === 0)) {
      // 合成虚拟子节点：每个 MCP capability 一个
      const synth: LocalFileNode[] = mcpCaps.map((cap) => ({
        name: cap.name,
        // 与 scanner 用的伪路径保持一致：父文件路径 + #mcp:<name>
        path: `${n.path}#mcp:${cap.name}`,
        type: "file" as const,
        managed: true,
        virtual: "mcp-server" as const,
        assetId: cap.assetId,
        enabled: cap.vendors[tool]?.enabled ?? true,
      }));
      return { ...n, children: synth };
    }
    if (n.children && n.children.length > 0) {
      return { ...n, children: n.children.map(walk) };
    }
    return n;
  }
}
