import { File, Folder, ChevronRight, ChevronDown } from "lucide-react";
import { useState, useMemo, useRef } from "react";

interface FileNode {
  path: string;
  name: string;
  isFolder: boolean;
  children: FileNode[];
}

interface Props {
  files: { id: string; path: string; content?: string }[];
  activePath: string;
  onSelect: (path: string) => void;
  /** When true, all folders start collapsed; the user opens them on demand. */
  defaultCollapsed?: boolean;
}

export default function FileTree({ files, activePath, onSelect, defaultCollapsed = false }: Props) {
  const tree = useMemo(() => {
    const root: FileNode = { path: "", name: "", isFolder: true, children: [] };

    for (const f of files) {
      const parts = f.path.split("/");
      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const isLast = i === parts.length - 1;
        let child = current.children.find((c) => c.name === part);
        if (!child) {
          child = {
            path: parts.slice(0, i + 1).join("/"),
            name: part,
            isFolder: !isLast,
            children: [],
          };
          current.children.push(child);
        }
        current = child;
      }
    }

    // Sort: folders first, then by name (dictionary order, locale-aware)
    const sort = (nodes: FileNode[]) => {
      nodes.sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const n of nodes) sort(n.children);
    };
    sort(root.children);
    return root.children;
  }, [files]);

  // When defaultCollapsed is on, seed `collapsed` with every folder path so the
  // user sees only the top-level entries until they explicitly drill in.
  const initialCollapsed = useMemo(() => {
    if (!defaultCollapsed) return new Set<string>();
    const out = new Set<string>();
    const visit = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.isFolder) {
          out.add(n.path);
          visit(n.children);
        }
      }
    };
    visit(tree);
    return out;
  }, [tree, defaultCollapsed]);

  const [collapsed, setCollapsed] = useState<Set<string>>(initialCollapsed);

  // Re-seed collapse state when the input file list changes (e.g. user adds an
  // asset to a workspace) so newly-introduced folders honor defaultCollapsed.
  const lastSeed = useRef(initialCollapsed);
  if (lastSeed.current !== initialCollapsed) {
    lastSeed.current = initialCollapsed;
    setCollapsed(initialCollapsed);
  }

  const toggleCollapse = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (files.length === 0) return null;

  return (
    <div className="py-1">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          collapsed={collapsed}
          onToggle={toggleCollapse}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  activePath,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  activePath: string;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isCollapsed = collapsed.has(node.path);

  if (node.isFolder) {
    const allCollapsed = node.children.every(
      (c) => !c.isFolder && collapsed.size > 0
    );
    return (
      <div>
        <button
          onClick={() => onToggle(node.path)}
          className="w-full flex items-center gap-1 px-3 py-1 text-xs text-text-secondary hover:bg-surface-card transition-colors"
          style={{ paddingLeft: 12 + depth * 16 }}
        >
          {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <Folder size={12} className="text-text-muted" />
          <span className="truncate">{node.name}</span>
        </button>
        {!isCollapsed &&
          node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
      </div>
    );
  }

  const isActive = activePath === node.path;
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`w-full flex items-center gap-1 px-3 py-1 text-xs text-left hover:bg-surface-card transition-colors ${
        isActive ? "bg-brand-soft/50 text-brand font-medium" : "text-text-secondary"
      }`}
      style={{ paddingLeft: 12 + depth * 16 }}
    >
      {/* spacer matching the chevron width so files align with folder icons at same depth */}
      <span className="w-3 shrink-0" />
      <File size={12} className={isActive ? "text-brand" : "text-text-muted"} />
      <span className="truncate">{node.name}</span>
    </button>
  );
}
