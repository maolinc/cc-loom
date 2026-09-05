import { useState, useEffect } from "react";
import { Copy, Check, KeyRound } from "lucide-react";
import { useAuth } from "../../hooks/useAuth.js";
import { api } from "../../api.js";
import { useToast } from "../../components/Toast.js";
import Button from "../../components/Button.js";
import ConfirmDialog from "../../components/ConfirmDialog.js";

export default function AccountTab() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  const [token, setToken] = useState<string | null>(null);
  const [tokenCreatedAt, setTokenCreatedAt] = useState("");
  const [tokenCopied, setTokenCopied] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    api.get<any>("/auth/cli-token").then((res) => {
      if (res.success && res.data) {
        setToken(res.data.token);
        setTokenCreatedAt(res.data.createdAt);
      }
    });
  }, []);

  const handleChangePassword = async () => {
    setPwError("");
    if (!currentPassword || !newPassword) {
      setPwError("请填写所有字段");
      return;
    }
    setPwSaving(true);
    const res = await api.post("/auth/change-password", { currentPassword, newPassword });
    setPwSaving(false);
    if (res.success) {
      toast.success("密码已更新", "下次登录请使用新密码");
      setCurrentPassword("");
      setNewPassword("");
    } else {
      setPwError(res.error || "修改失败");
    }
  };

  const handleRegenerateToken = async () => {
    setRegenerating(true);
    const res = await api.post<{ token: string }>("/auth/cli-token/regenerate");
    setRegenerating(false);
    setConfirmRegen(false);
    if (res.success && res.data) {
      setToken(res.data.token);
      setTokenCreatedAt(new Date().toISOString());
      toast.success("Token 已重新生成", "旧 Token 已失效，请更新本地 CLI");
    } else {
      toast.error("生成失败", res.error || "请稍后重试");
    }
  };

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      toast.error("复制失败", "浏览器拒绝访问剪贴板");
    }
  };

  const inputCls =
    "w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

  return (
    <div className="max-w-xl">
      <div className="mb-8 p-4 bg-white rounded-xl border border-surface-sunken">
        <p className="text-sm text-text-muted">当前账号</p>
        <p className="text-text-primary font-medium">{user?.email}</p>
      </div>

      <div className="mb-8">
        <h3 className="text-sm font-semibold text-text-primary mb-3">修改密码</h3>
        <div className="space-y-3">
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="当前密码" className={inputCls} />
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="新密码（至少 6 位）" minLength={6} className={inputCls} />
          <div className="flex items-center gap-3">
            <Button variant="primary" loading={pwSaving} onClick={handleChangePassword}>更新密码</Button>
            {pwError && <span className="text-sm text-red-500">{pwError}</span>}
          </div>
        </div>
      </div>

      <div className="mb-8">
        <h3 className="text-sm font-semibold text-text-primary mb-3">CLI Token</h3>
        <div className="p-4 bg-white rounded-xl border border-surface-sunken">
          {token ? (
            <>
              <div className="flex items-center gap-2 mb-2">
                <code className="flex-1 text-sm bg-surface-card px-3 py-2 rounded-lg border border-surface-sunken select-all font-mono truncate">{token}</code>
                <Button variant="primary" size="sm" leftIcon={tokenCopied ? <Check size={13} /> : <Copy size={13} />} onClick={copyToken}>
                  {tokenCopied ? "已复制" : "复制"}
                </Button>
              </div>
              <p className="text-xs text-text-muted mb-3">
                创建于 {tokenCreatedAt ? new Date(tokenCreatedAt).toLocaleString("zh-CN") : "-"}
              </p>
              <button onClick={() => setConfirmRegen(true)} className="inline-flex items-center gap-1.5 text-sm text-red-500 hover:text-red-600">
                <KeyRound size={14} /> 重新生成（旧 Token 立即失效）
              </button>
              <div className="mt-4 p-3 bg-surface-card rounded-lg border border-surface-sunken">
                <p className="text-xs text-text-secondary mb-2">CLI 登录完整命令：</p>
                <code className="text-xs bg-white border border-surface-sunken px-2 py-1 rounded select-all font-mono break-all">
                  loom login --token {token} --endpoint {window.location.origin}
                </code>
              </div>
            </>
          ) : (
            <p className="text-sm text-text-muted">加载中...</p>
          )}
        </div>
      </div>

      <Button variant="ghost" size="sm" className="!text-red-500 hover:!bg-red-50" onClick={logout}>退出登录</Button>

      <ConfirmDialog
        open={confirmRegen}
        kind="danger"
        title="重新生成 CLI Token"
        description="当前 Token 会立即失效，所有使用旧 Token 的设备需要重新登录。"
        confirmLabel="重新生成"
        confirmingLabel="生成中…"
        busy={regenerating}
        onConfirm={handleRegenerateToken}
        onCancel={() => setConfirmRegen(false)}
      />
    </div>
  );
}
