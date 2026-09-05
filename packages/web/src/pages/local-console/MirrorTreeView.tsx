/**
 * 镜像树视图：直接渲染 scanner 产出的 `LocalFileNode[]`。
 *
 * v3 视觉原则（修订）：
 *  - **类型只在 chip 上展示**，文件名一律用中性色（managed 用 text-primary 字重 medium，
 *    external 用 text-secondary，disabled 用 text-muted）；之前给文件名按类型上色 +
 *    chip 双重表达，被用户反馈为"UI 污染"——同一信息说两遍。
 *  - 关闭态用 bg-surface-card + (已关闭) chip 替代 line-through
 *  - Toggle 36×20，关闭态 bg-gray-200（不是 300，弱化"开关墙"压迫感）
 *  - 更多操作按钮 opacity-60 常驻，hover 加深
 *  - 目录头按钮：点击触发 onDirSelect（父组件打开预览面板）
 *  - 移除菜单：assetId 抛给父组件由 ConfirmDialog 处理
 *
 * 命令式 API：通过 `forwardRef` 暴露 `expandAll()` / `collapseAll()`，让
 * 父组件在工具栏上挂"全部展开 / 全部折叠"按钮。
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, MoreHorizontal } from "lucide-react";
import type { AssetType, LocalFileNode, TargetTool } from "@maolinc/cc-loom-shared";

export interface MirrorTreeViewHandle {
  expandAll: () => void;
  collapseAll: () => void;
}

interface Props {
  /** scanner 输出的子节点列表（每个 vendor 的 mirror.tree） */
  nodes: LocalFileNode[];
  activePath: string;
  /** 选中文件 → 打开文件预览 */
  onSelect: (path: string, managed: boolean) => void;
  /** 选中目录 → 打开目录预览 */
  onDirSelect?: (path: string) => void;
  /** 默认全部折叠 */
  defaultCollapsed?: boolean;
  /** 该树所属厂商；toggle / 移除时一并下发给 server */
  tool?: TargetTool;
  /** assetId → type 映射；当前组件不再用（chip 已撤），保留 prop 以兼容父级传参 */
  assetTypes?: Map<string, AssetType>;
  /** assetId → 别名：文件节点名后以灰色辅助展示（名称为主、别名为辅）。 */
  assetAliases?: Map<string, string>;
  /** toggle 单 (asset, tool)。enabled 为目标状态 */
  onToggleCapability?: (assetId: string, tool: TargetTool, enabled: boolean) => void;
  /** 移除某能力（带 tool：外部能力 adopt 需指定厂商）。父组件应弹 ConfirmDialog 二次确认 */
  onRemoveCapability?: (assetId: string, tool: TargetTool) => void;
  /** legacy lock 时禁用 toggle/移除 */
  disabled?: boolean;
}

/** 收集所有可展开节点的 path：包含 type:"dir" 与 type:"file" 但带 children 的（mcp.json）。 */
function collectExpandablePaths(nodes: LocalFileNode[], out: Set<string>): Set<string> {
  for (const n of nodes) {
    const expandable = n.type === "dir" || (n.children && n.children.length > 0);
    if (expandable) {
      out.add(n.path);
      if (n.children) collectExpandablePaths(n.children, out);
    }
  }
  return out;
}

/** 能力类型目录：其直接子目录即一个「目录形态能力单元」（skill/hook 等）。 */
const CAPABILITY_TYPE_DIRS = new Set(["skills", "rules", "commands", "agents", "hooks"]);

/** 收集子树内真实能力文件的 assetId → enabled（排除 mcp-server 虚拟节点）。 */
function collectCapabilityInfo(node: LocalFileNode): Map<string, boolean> {
  const m = new Map<string, boolean>();
  const walk = (n: LocalFileNode) => {
    if (n.type === "file" && n.assetId && n.virtual !== "mcp-server") {
      m.set(n.assetId, n.enabled !== false);
    }
    n.children?.forEach(walk);
  };
  walk(node);
  return m;
}

/** 清除子树上的能力标记（提升到目录后，内部文件回归为普通文件，不再单独出现开关/别名）。 */
function clearCapabilityIds(node: LocalFileNode): LocalFileNode {
  const next: LocalFileNode = { ...node };
  if (next.assetId && next.virtual !== "mcp-server") {
    delete next.assetId;
    delete next.enabled;
  }
  if (next.children) next.children = next.children.map(clearCapabilityIds);
  return next;
}

/**
 * 把「目录形态能力单元」的 assetId/enabled 从内部文件提升到能力根目录，
 * 使开关、别名、移除等控件展示在目录行上而非内部 SKILL.md 等文件上。
 * 判定：位于能力类型目录（skills/…）之下、且整棵子树只含单一 assetId 的目录。
 */
function hoistDirCapabilities(nodes: LocalFileNode[], parentIsTypeDir = false): LocalFileNode[] {
  return nodes.map((node) => {
    if (node.type !== "dir") return node;
    if (parentIsTypeDir && !node.assetId) {
      const info = collectCapabilityInfo(node);
      if (info.size === 1) {
        const [aid, enabled] = [...info.entries()][0]!;
        return {
          ...node,
          assetId: aid,
          enabled,
          children: node.children?.map(clearCapabilityIds),
        };
      }
    }
    const isTypeDir = CAPABILITY_TYPE_DIRS.has(node.name);
    return {
      ...node,
      children: node.children ? hoistDirCapabilities(node.children, isTypeDir) : node.children,
    };
  });
}

const MirrorTreeView = forwardRef<MirrorTreeViewHandle, Props>(function MirrorTreeView(
  {
    nodes,
    activePath,
    onSelect,
    onDirSelect,
    defaultCollapsed = true,
    tool,
    assetTypes,
    assetAliases,
    onToggleCapability,
    onRemoveCapability,
    disabled,
  },
  ref,
) {
  // —— 折叠状态稳定性 —————————————————————————————————————
  //
  // 之前 [nodes, defaultCollapsed] 作为依赖，乐观更新时 enabled 翻转会让父级重建
  // 整棵 tree（新数组引用），useEffect 把 collapsed 重置回初始值，表现为
  // **点一下 toggle 整棵树突然展开**。
  //
  // 改成基于"路径集合"的指纹：只在 path 集合（结构）真变了时才重置。enabled
  // 翻转不影响 path → fingerprint 同 → 折叠状态保留。
  //
  // 关键：指纹只收集「可展开节点」（目录 + 含子节点的 mcp.json），不含叶子文件。
  // toggle 开关会增删叶子文件（写入/删除或占位切换），若指纹含叶子 path，会因
  // path 集合变化触发折叠重置，表现为「点开关后目录突然折叠」。只看目录结构后，
  // 叶子文件增删不再影响折叠状态。
  const treeShape = useMemo(() => {
    return [...collectExpandablePaths(nodes, new Set<string>())].sort().join("\n");
  }, [nodes]);

  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    defaultCollapsed ? collectExpandablePaths(nodes, new Set<string>()) : new Set<string>(),
  );
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // 仅在树结构（path 集合）变化时重置折叠 —— 切厂商 / 新一次 scan 等是真结构变化；
  // 单纯的 enabled 翻转 → fingerprint 同 → 这里不会跑。
  useEffect(() => {
    setCollapsed(
      defaultCollapsed ? collectExpandablePaths(nodes, new Set<string>()) : new Set<string>(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意省略 nodes：结构变化由 treeShape 反映
  }, [treeShape, defaultCollapsed]);

  // 暴露给父组件用：让外部工具栏的"全部展开/折叠"按钮命令式调用
  useImperativeHandle(
    ref,
    () => ({
      expandAll: () => setCollapsed(new Set()),
      collapseAll: () => setCollapsed(collectExpandablePaths(nodes, new Set<string>())),
    }),
    [nodes],
  );

  const toggle = (p: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  // 渲染前把目录形态能力的 assetId 提升到能力根目录（开关/别名/移除展示在目录行）。
  const displayNodes = useMemo(() => hoistDirCapabilities(nodes), [nodes]);

  if (nodes.length === 0) {
    return <div className="px-4 py-3 text-xs text-text-muted">该目录为空</div>;
  }

  return (
    <div className="py-1">
      {displayNodes.map((n) => (
        <Node
          key={n.path}
          node={n}
          depth={0}
          collapsed={collapsed}
          onToggle={toggle}
          activePath={activePath}
          onSelect={onSelect}
          onDirSelect={onDirSelect}
          tool={tool}
          assetTypes={assetTypes}
          assetAliases={assetAliases}
          onToggleCapability={onToggleCapability}
          onRemoveCapability={onRemoveCapability}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          disabled={disabled}
        />
      ))}
    </div>
  );
});

export default MirrorTreeView;

interface NodeProps {
  node: LocalFileNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (p: string) => void;
  activePath: string;
  onSelect: (path: string, managed: boolean) => void;
  onDirSelect?: (path: string) => void;
  tool?: TargetTool;
  assetTypes?: Map<string, AssetType>;
  assetAliases?: Map<string, string>;
  onToggleCapability?: (assetId: string, tool: TargetTool, enabled: boolean) => void;
  onRemoveCapability?: (assetId: string, tool: TargetTool) => void;
  openMenu: string | null;
  setOpenMenu: (k: string | null) => void;
  disabled?: boolean;
}

function Node(props: NodeProps) {
  const {
    node, depth, collapsed, onToggle, activePath, onSelect, onDirSelect,
    tool, onToggleCapability, onRemoveCapability,
    openMenu, setOpenMenu, disabled,
  } = props;
  const padding = 12 + depth * 16;

  // ──── 目录节点 ────
  if (node.type === "dir") {
    const isCollapsed = collapsed.has(node.path);
    const children = node.children ?? [];
    // 目录形态能力单元：经 hoistDirCapabilities 提升后，目录本身带 assetId/enabled。
    const hasCapability = !!node.assetId && node.enabled !== undefined && !!tool;
    const enabled = node.enabled !== false;
    const alias = node.assetId ? props.assetAliases?.get(node.assetId) : undefined;
    const menuKey = `menu:${node.path}`;
    const menuOpen = openMenu === menuKey;
    const rowBg = hasCapability && !enabled ? "bg-surface-card" : "hover:bg-white";
    return (
      <div>
        <div
          className={`group flex items-center gap-1 ${rowBg} transition-colors`}
          style={{ paddingLeft: padding }}
        >
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            aria-label={isCollapsed ? `展开 ${node.name}` : `折叠 ${node.name}`}
            className="p-1 -ml-1 rounded text-text-muted hover:text-text-secondary"
          >
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <button
            type="button"
            onClick={() => (onDirSelect ? onDirSelect(node.path) : onToggle(node.path))}
            className="flex items-center gap-1.5 flex-1 min-w-0 px-1 py-1 text-[11px] font-medium text-text-secondary text-left rounded hover:text-text-primary"
            title={onDirSelect ? `预览 ${node.name}` : ""}
          >
            <Folder size={13} className="text-text-muted shrink-0" />
            <span className="truncate">{node.name}</span>
            {alias && (
              <span className="text-[11px] text-text-muted font-normal truncate shrink-0 max-w-[45%]">{alias}</span>
            )}
            <span className="text-[10px] text-text-muted font-normal ml-0.5 shrink-0">
              {children.length === 0 ? "(空)" : children.length}
            </span>
          </button>

          {hasCapability && !enabled && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-sunken text-text-muted shrink-0">
              已关闭
            </span>
          )}

          {hasCapability && !disabled && (
            <ToggleSwitch
              enabled={enabled}
              onClick={() => onToggleCapability?.(node.assetId!, tool!, !enabled)}
              label={`${enabled ? "关闭" : "开启"} ${node.name}`}
            />
          )}

          {hasCapability && !disabled && (
            <div className="relative shrink-0 mr-2">
              <button
                type="button"
                aria-label="更多操作"
                className="p-1 rounded text-text-muted/70 hover:text-text-secondary hover:bg-gray-200 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu(menuOpen ? null : menuKey);
                }}
              >
                <MoreHorizontal size={14} />
              </button>
              {menuOpen && (
                <div
                  className="absolute right-0 top-7 z-20 bg-white border border-surface-sunken rounded-lg shadow-lg text-xs py-1 min-w-36"
                  onMouseLeave={() => setOpenMenu(null)}
                >
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600"
                    onClick={() => {
                      setOpenMenu(null);
                      onRemoveCapability?.(node.assetId!, tool!);
                    }}
                  >
                    移除该能力…
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {!isCollapsed && children.length > 0 && children.map((c) => (
          <Node {...props} key={c.path} node={c} depth={depth + 1} />
        ))}
      </div>
    );
  }

  // ──── 文件节点 ────
  // 注意：mcp.json 是 type:"file" 但 scanner 给它挂了 virtual="mcp-server" 子节点
  //（每个对应 mcp.json 内的一个 server 条目，独立 assetId/enabled）。
  // 所以"文件 + 含 children"也要按可展开渲染：上方一行是 mcp.json 本身（点击进
  // 预览面板），下方缩进列出每个 server，每个 server 自带 toggle / 移除菜单。
  const fileChildren = node.children ?? [];
  const fileExpandable = fileChildren.length > 0;
  const fileCollapsed = collapsed.has(node.path);

  const isActive = activePath === node.path;
  const hasCapability = !!node.assetId && node.enabled !== undefined && !!tool;
  const enabled = node.enabled !== false;
  // 外部能力（assetId 形如 external:<type>:<name>）：全部类型可 adopt 本地管理。
  const isExternal = node.assetId?.startsWith("external:") ?? false;
  const menuKey = `menu:${node.path}`;
  const menuOpen = openMenu === menuKey;
  const isVirtualMcp = node.virtual === "mcp-server";
  const isDisabledPlaceholder = node.virtual === "disabled-asset";
  const managed = node.managed;

  // 文件名色：active > managed-enabled (text-primary medium) > disabled (muted) > external (secondary)
  // 注：刻意不再按类型给文件名上色 —— 类型信息由右侧 chip 单独承担，
  //     避免"chip + 名字色"两路重复表达造成的视觉污染。
  let nameColor = "text-text-secondary";
  if (isActive) nameColor = "text-brand font-medium";
  else if (managed && enabled) nameColor = "text-text-primary font-medium";
  else if (!enabled) nameColor = "text-text-muted";

  // 行底色：active > disabled > 默认
  const rowBg = isActive
    ? "bg-brand-soft/60"
    : !enabled
    ? "bg-surface-card"
    : "hover:bg-surface-card/70";

  return (
    <div>
      <div className={`group flex items-center gap-2 ${rowBg} transition-colors`} style={{ paddingLeft: padding + (fileExpandable ? 0 : 18) }}>
        {fileExpandable && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
            aria-label={fileCollapsed ? `展开 ${node.name}` : `折叠 ${node.name}`}
            className="p-1 -ml-0.5 rounded text-text-muted hover:text-text-secondary"
          >
            {fileCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (isVirtualMcp || isDisabledPlaceholder) return;
            onSelect(node.path, managed);
          }}
          className="flex items-center gap-1.5 flex-1 min-w-0 py-1.5 text-left"
        >
          <FileText size={12} className={nameColor.includes("text-text-muted") ? "text-text-muted" : "text-current"} />
          <span className={`text-[12.5px] truncate ${nameColor}`}>{node.name}</span>
          {node.assetId && props.assetAliases?.get(node.assetId) && (
            <span className="text-[11px] text-text-muted truncate shrink-0 max-w-[45%]">
              {props.assetAliases.get(node.assetId)}
            </span>
          )}
          {fileExpandable && (
            <span className="text-[10px] text-text-muted ml-0.5">
              {fileChildren.length}
            </span>
          )}
        </button>

        {/* 状态/类型 chips */}
        {!enabled && hasCapability && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-sunken text-text-muted shrink-0">
            已关闭
          </span>
        )}
        {/* mcp.json 这种聚合载体：标识共享配置，不带 toggle */}
        {fileExpandable && !node.assetId && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-mcp-green-bg text-mcp-green-text shrink-0">
            MCP × {fileChildren.length}
          </span>
        )}
        {/*
         * 单文件类型 chip 已撤除：父级目录已经按类型分（agents/、commands/、
         * hooks/、rules/、skills/），再给文件加 [AGENT]/[COMMAND] 等于把同一
         * 信息说两遍，构成视觉污染。类型信息留在矩阵视图与预览面板 header。
         */}

        {/* Toggle */}
        {hasCapability && !disabled && (
          <ToggleSwitch
            enabled={enabled}
            onClick={() => onToggleCapability?.(node.assetId!, tool!, !enabled)}
            label={`${enabled ? "关闭" : "开启"} ${node.name}`}
          />
        )}

        {/* 更多操作（常驻显示）— managed 与外部能力均可移除（外部能力移除会 adopt 后删磁盘文件） */}
        {hasCapability && !disabled && (managed || isExternal) && (
          <div className="relative shrink-0 mr-2">
            <button
              type="button"
              aria-label="更多操作"
              className="p-1 rounded text-text-muted/70 hover:text-text-secondary hover:bg-gray-200 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenu(menuOpen ? null : menuKey);
              }}
            >
              <MoreHorizontal size={14} />
            </button>
            {menuOpen && (
              <div
                className="absolute right-0 top-7 z-20 bg-white border border-surface-sunken rounded-lg shadow-lg text-xs py-1 min-w-36"
                onMouseLeave={() => setOpenMenu(null)}
              >
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600"
                  onClick={() => {
                    setOpenMenu(null);
                    onRemoveCapability?.(node.assetId!, tool!);
                  }}
                >
                  移除该能力…
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {/* 文件展开后的子节点（mcp.json 内的 server 条目）—— 复用同一 Node 组件 */}
      {fileExpandable && !fileCollapsed && fileChildren.map((c) => (
        <Node {...props} key={c.path} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

/** 加大版 toggle：36×20，圆点 16×16；关闭态用 gray-200（弱化整列开关墙的压迫感）。 */
function ToggleSwitch({
  enabled,
  onClick,
  label,
}: {
  enabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        enabled ? "bg-brand" : "bg-gray-200"
      } hover:shadow-[0_0_0_4px_rgba(75,90,211,0.08)]`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          enabled ? "translate-x-[18px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
