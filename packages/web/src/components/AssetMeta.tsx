import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Pencil, Trash2, KeyRound, ExternalLink, Download } from "lucide-react";
import { api } from "../api.js";
import type { Asset } from "@maolinc/cc-loom-shared";
import { ASSET_TYPE_LABELS, ASSET_TYPE_COLORS, sortTargetTools } from "@maolinc/cc-loom-shared";
import { useAuth } from "../hooks/useAuth.js";
import { useToast } from "./Toast.js";
import ConfirmDialog from "./ConfirmDialog.js";
import Button from "./Button.js";
import ToolIcon from "./ToolIcon.js";
import { assetDisplayName, assetAliasName, formatAuthorName } from "../lib/assetDisplay.js";
import { formatRelativeTime } from "../lib/time.js";

interface AssetMetaProps {
  asset: Asset;
  onClose: () => void;
  onChanged: () => void;
  /**
   * limited：数据来自工作空间 payload 子集（完整详情不可得：已下架留存 / 私有无权）。
   * 隐藏鉴权行（子集无 auth 字段，渲染会误显「免鉴权」）与全部操作按钮
   * （下载/编辑/删除/安装对这类能力必然失败）。
   */
  mode?: "full" | "limited";
  /** 类型徽章旁的提示徽章（如「已下架（留存）」「私有能力…」），配合 limited 使用。 */
  notice?: string;
}

export default function AssetMeta({ asset, onClose, onChanged, mode = "full", notice }: AssetMetaProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const limited = mode === "limited";
  const fromSource = !!asset.sourceId;
  const displayAuthor = fromSource ? (asset.sourceAddedBy ?? asset.author) : asset.author;
  const isAdmin = !!user && user.role === "admin";
  const canEdit = !!user && (isAdmin || user.email === asset.author || user.email === asset.sourceAddedBy);
  const canDelete = !!user && (isAdmin || user.email === asset.author) && (!fromSource || isAdmin);
  const colors = ASSET_TYPE_COLORS[asset.type] || ASSET_TYPE_COLORS.skill;
  const displayName = assetDisplayName(asset);
  const aliasName = assetAliasName(asset);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const onDelete = async () => {
    setDeleting(true);
    const res = await api.delete<unknown>(`/assets/${asset.id}`);
    setDeleting(false);
    setConfirmDelete(false);
    if (res.success) {
      toast.success("能力已删除", displayName);
      onClose();
    } else {
      toast.error("删除失败", res.error ?? "请稍后重试");
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        <span
          className="px-2.5 py-0.5 rounded-full text-xs font-semibold"
          style={{ backgroundColor: colors.bg, color: colors.text }}
        >
          {ASSET_TYPE_LABELS[asset.type]}
        </span>
        {notice && (
          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-surface-sunken text-text-muted">
            {notice}
          </span>
        )}
      </div>
      <h2 className="text-lg font-bold text-text-primary mb-1">{asset.name}</h2>
      {aliasName && <p className="text-xs text-text-muted -mt-0.5 mb-1.5">别名 {aliasName}</p>}
      <p className="text-sm text-text-secondary mb-3">{asset.description}</p>

      {asset.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {asset.tags.map((tag) => (
            <span key={tag} className="px-2 py-0.5 rounded-full text-[10px] bg-surface-sunken text-text-secondary">
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="space-y-2 text-sm">
        <div className="flex justify-between items-center">
          <span className="text-text-muted">兼容工具</span>
          <span className="flex gap-1">
            {sortTargetTools(asset.compatibleTools).map((t) => <ToolIcon key={t} tool={t} size={16} />)}
          </span>
        </div>
        <MetaRow label={fromSource ? "导入人" : "作者"} value={formatAuthorName(displayAuthor)} />
        <MetaRow label="更新时间" value={formatRelativeTime(asset.updatedAt || asset.createdAt)} />
        <MetaRow label="可见性" value={asset.visibility === "public" ? "公开" : "个人"} />
        {!limited && (
          <div className="flex justify-between items-center">
            <span className="text-text-muted flex items-center gap-1"><KeyRound size={11} /> 鉴权</span>
            <span className="text-right max-w-[220px]">
              {asset.auth?.bindings?.length ? (
                <span className="inline-flex flex-col items-end gap-1">
                  {asset.auth.bindings.map((b, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 flex-wrap justify-end">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${b.kind === "env" ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                        {b.kind === "env" ? "环境变量" : "注入路径"}
                      </span>
                      <code className="font-mono text-text-primary text-xs">{b.kind === "env" ? b.envKey : b.path}</code>
                      {b.authPageUrl && (
                        <a href={b.authPageUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline text-[11px]" onClick={(e) => e.stopPropagation()}>
                          获取 <ExternalLink size={10} />
                        </a>
                      )}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-text-muted">免鉴权</span>
              )}
            </span>
          </div>
        )}
        <MetaRow label="文件数" value={`${asset.files?.length || 0} 个文件`} />
        {fromSource && <MetaRow label="来源类型" value="第三方" />}
        {asset.sourceDisplayName && (
          <MetaRow label="来源" value={<SourceLink name={asset.sourceDisplayName} url={asset.sourceUrl} />} />
        )}
      </div>

      {!limited && (
        <div className="mt-4">
          <DownloadAssetButton assetId={asset.id} />
        </div>
      )}

      {!limited && (canEdit || canDelete) && (
        <div className="grid grid-cols-2 gap-2 mt-4">
          {canEdit && (
            <Button variant="secondary" size="sm" leftIcon={<Pencil size={12} />} onClick={() => { onClose(); navigate(`/assets/${asset.id}/edit`); }}>
              编辑
            </Button>
          )}
          {canDelete && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Trash2 size={12} />}
              className="!text-red-600 !border-red-100 hover:!bg-red-50 hover:!border-red-200"
              onClick={() => setConfirmDelete(true)}
            >
              删除
            </Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        kind="danger"
        title={`删除能力「${displayName}」`}
        description="此操作不可撤销。已安装到本地项目的文件不会自动移除。"
        confirmLabel="删除"
        confirmingLabel="删除中…"
        busy={deleting}
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/** AssetMeta 加载骨架：完整详情按需拉取期间的占位，形状对齐 AssetMeta。 */
export function AssetMetaSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-5 w-16 rounded-full bg-surface-sunken mb-3" />
      <div className="h-6 w-3/4 rounded bg-surface-sunken mb-2" />
      <div className="h-4 w-full rounded bg-surface-sunken mb-1.5" />
      <div className="h-4 w-5/6 rounded bg-surface-sunken mb-4" />
      <div className="space-y-2.5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex justify-between">
            <div className="h-3.5 w-14 rounded bg-surface-sunken" />
            <div className="h-3.5 w-20 rounded bg-surface-sunken" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary text-right max-w-[160px] truncate">{value}</span>
    </div>
  );
}

/** 来源名称：可点击在新标签打开来源仓库地址；无地址时退化为纯文本。 */
export function SourceLink({ name, url }: { name: string; url?: string | null }) {
  if (!url) return <>{name}</>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
      className="text-brand hover:underline inline-flex items-center gap-0.5 max-w-full"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="truncate">{name}</span>
      <ExternalLink size={10} className="shrink-0" />
    </a>
  );
}

/** 触发浏览器下载：把响应 blob 以 Content-Disposition 中的文件名落盘。 */
function triggerBlobDownload(url: string, fallbackName: string) {
  fetch(url, { credentials: "include" })
    .then(async (res) => {
      if (!res.ok) throw new Error(`status ${res.status}`);
      const blob = await res.blob();
      const disp = res.headers.get("Content-Disposition") || "";
      const filename = /filename="([^"]+)"/.exec(disp)?.[1] || fallbackName;
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    })
    .catch(() => {
      // 网络错误或 404：fetch 不抛但 res.ok=false 走这里
    });
}

/** 单能力下载按钮：zip 内为该能力完整内容（预览结构铺放）。任何能查看该能力的用户都可下载。 */
function DownloadAssetButton({ assetId }: { assetId: string }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      fullWidth
      leftIcon={<Download size={12} />}
      onClick={() => triggerBlobDownload(`/api/assets/${assetId}/download`, "asset.zip")}
    >
      下载 zip
    </Button>
  );
}
