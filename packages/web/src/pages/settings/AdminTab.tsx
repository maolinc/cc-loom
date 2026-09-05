import { useState, useEffect, useCallback } from "react";
import { Search, Shield, UserCog, Ban, CheckCircle2 } from "lucide-react";
import { api } from "../../api.js";
import { useToast } from "../../components/Toast.js";
import Button from "../../components/Button.js";
import ConfirmDialog from "../../components/ConfirmDialog.js";
import type { UserRole } from "@maolinc/cc-loom-shared";

// ============ Types ============

interface AdminUser {
  id: string;
  email: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
}

interface RegistrationData {
  maxUsers: number;
  currentCount: number;
}

interface WhitelistData {
  enabled: boolean;
  emails: string[];
}

// ============ Main Component ============

export default function AdminTab() {
  return (
    <div className="space-y-8 max-w-4xl">
      <RegistrationSection />
      <WhitelistSection />
      <UserListSection />
    </div>
  );
}

// ============ Registration Limit Section ============

function RegistrationSection() {
  const toast = useToast();
  const [data, setData] = useState<RegistrationData | null>(null);
  const [maxUsers, setMaxUsers] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<RegistrationData>("/admin/registration");
    if (res.success && res.data) {
      setData(res.data);
      setMaxUsers(String(res.data.maxUsers));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async () => {
    const n = parseInt(maxUsers, 10);
    if (isNaN(n) || n < 0) {
      toast.error("输入无效", "请输入 0 或正整数");
      return;
    }
    setSaving(true);
    const res = await api.put<RegistrationData>("/admin/registration", { maxUsers: n });
    setSaving(false);
    if (res.success && res.data) {
      setData(res.data);
      toast.success("已保存", n === 0 ? "不限制注册用户数" : `上限 ${n} 人`);
    } else {
      toast.error("保存失败", res.error || "请稍后重试");
    }
  };

  return (
    <div className="p-5 bg-white rounded-xl border border-surface-sunken">
      <div className="flex items-center gap-2 mb-4">
        <UserCog size={18} className="text-brand" />
        <h3 className="text-sm font-semibold text-text-primary">注册用户上限</h3>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        控制平台可注册的最大用户数。设为 <code className="px-1 py-0.5 bg-surface-card rounded text-xs">0</code> 表示不限制。
        管理员账户不受此限制。
      </p>
      {data && (
        <p className="text-xs text-text-muted mb-3">当前已注册 {data.currentCount} 人{data.maxUsers > 0 ? ` / 上限 ${data.maxUsers}` : "（不限制）"}</p>
      )}
      <div className="flex items-center gap-3">
        <input
          type="number"
          min={0}
          value={maxUsers}
          onChange={(e) => setMaxUsers(e.target.value)}
          className="w-40 px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
        <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>保存</Button>
      </div>
    </div>
  );
}

// ============ Whitelist Section ============

function WhitelistSection() {
  const toast = useToast();
  const [data, setData] = useState<WhitelistData | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [emailText, setEmailText] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<WhitelistData>("/admin/whitelist");
    if (res.success && res.data) {
      setData(res.data);
      setEnabled(res.data.enabled);
      setEmailText(res.data.emails.join("\n"));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async () => {
    const emails = emailText
      .split("\n")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);

    setSaving(true);
    const res = await api.put<WhitelistData>("/admin/whitelist", { enabled, emails });
    setSaving(false);
    if (res.success && res.data) {
      setData(res.data);
      toast.success("已保存", enabled ? "白名单已开启，非白名单邮箱无法登录" : "白名单已关闭");
    } else {
      toast.error("保存失败", res.error || "请检查邮箱格式是否正确");
    }
  };

  return (
    <div className="p-5 bg-white rounded-xl border border-surface-sunken">
      <div className="flex items-center gap-2 mb-4">
        <Shield size={18} className="text-brand" />
        <h3 className="text-sm font-semibold text-text-primary">登录白名单</h3>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        开启后，仅白名单内邮箱可登录平台；非白名单邮箱一律拒绝登录（即使之前已注册）。
        管理员账户始终豁免。
      </p>
      <label className="flex items-center gap-3 mb-4 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="w-4 h-4 rounded border-gray-300 text-brand focus:ring-brand/20"
        />
        <span className="text-sm text-text-primary">开启白名单登录限制</span>
      </label>
      <textarea
        value={emailText}
        onChange={(e) => setEmailText(e.target.value)}
        rows={8}
        placeholder={"每行一个邮箱，例如：\nuser1@example.com\nuser2@example.com"}
        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 font-mono"
      />
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>保存白名单</Button>
        {data && (
          <span className="text-xs text-text-muted">
            {data.emails.length} 个邮箱{data.enabled ? " · 已开启" : " · 已关闭"}
          </span>
        )}
      </div>
    </div>
  );
}

// ============ User List Section ============

function UserListSection() {
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirmAction, setConfirmAction] = useState<{ user: AdminUser; type: "disable" | "enable" } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const pageSize = 50;

  const load = useCallback(async (p: number, q: string) => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(p), pageSize: String(pageSize) });
    if (q) params.set("query", q);
    const res = await api.get<{ total: number }>(`/admin/users?${params}`);
    setLoading(false);
    if (res.success && res.data) {
      setUsers(res.data as any);
      setTotal((res as any).total);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => load(page, query), 300);
    return () => clearTimeout(timer);
  }, [page, query, load]);

  const handleToggleDisable = async () => {
    if (!confirmAction) return;
    setActionLoading(true);
    const res = await api.put<AdminUser>(`/admin/users/${confirmAction.user.id}/status`, {
      disabled: confirmAction.type === "disable",
    });
    setActionLoading(false);
    setConfirmAction(null);
    if (res.success && res.data) {
      setUsers((prev) => prev.map((u) => (u.id === res.data!.id ? res.data! : u)));
      toast.success(
        confirmAction.type === "disable" ? "已停用" : "已启用",
        confirmAction.type === "disable" ? "该用户会话已失效，无法再登录" : `${confirmAction.user.email} 可正常登录`
      );
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const handleRoleChange = async (user: AdminUser, role: UserRole) => {
    if (user.role === role) return;
    const res = await api.put<AdminUser>(`/admin/users/${user.id}/role`, { role });
    if (res.success && res.data) {
      setUsers((prev) => prev.map((u) => (u.id === res.data!.id ? res.data! : u)));
      toast.success("角色已更新", `${user.email} → ${role === "admin" ? "管理员" : "普通用户"}`);
    } else {
      toast.error("操作失败", res.error || "请稍后重试");
    }
  };

  const totalPages = Math.ceil(total / pageSize) || 1;

  return (
    <div className="p-5 bg-white rounded-xl border border-surface-sunken">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <UserCog size={18} className="text-brand" />
          <h3 className="text-sm font-semibold text-text-primary">用户列表</h3>
        </div>
        <div className="relative w-64">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="搜索邮箱..."
            className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
        </div>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-text-muted">加载中...</div>
      ) : users.length === 0 ? (
        <div className="py-12 text-center text-sm text-text-muted">暂无用户</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-sunken text-left text-text-muted">
                <th className="py-2 pr-4 font-medium">邮箱</th>
                <th className="py-2 pr-4 font-medium">角色</th>
                <th className="py-2 pr-4 font-medium">状态</th>
                <th className="py-2 pr-4 font-medium">注册时间</th>
                <th className="py-2 pr-4 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-gray-50">
                  <td className="py-2.5 pr-4 text-text-primary">{u.email}</td>
                  <td className="py-2.5 pr-4">
                    <select
                      value={u.role}
                      onChange={(e) => handleRoleChange(u, e.target.value as UserRole)}
                      className="text-xs px-2 py-1 rounded border border-gray-200 bg-white focus:outline-none focus:border-brand"
                    >
                      <option value="user">普通用户</option>
                      <option value="admin">管理员</option>
                    </select>
                  </td>
                  <td className="py-2.5 pr-4">
                    {u.disabled ? (
                      <span className="inline-flex items-center gap-1 text-xs text-red-500">
                        <Ban size={12} /> 已停用
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-green-600">
                        <CheckCircle2 size={12} /> 正常
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-text-muted">
                    {new Date(u.createdAt).toLocaleDateString("zh-CN")}
                  </td>
                  <td className="py-2.5 pr-4 text-right">
                    {u.role === "admin" ? (
                      <span className="text-xs text-text-muted">管理员不可停用</span>
                    ) : (
                      <button
                        onClick={() => setConfirmAction({ user: u, type: u.disabled ? "enable" : "disable" })}
                        className={`text-xs px-2 py-1 rounded ${u.disabled ? "text-green-600 hover:bg-green-50" : "text-red-500 hover:bg-red-50"}`}
                      >
                        {u.disabled ? "启用" : "停用"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-xs text-text-muted">共 {total} 人</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
            <span className="text-xs text-text-muted py-1">{page} / {totalPages}</span>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmAction}
        kind={confirmAction?.type === "disable" ? "danger" : "default"}
        title={confirmAction?.type === "disable" ? "停用用户" : "启用用户"}
        description={
          confirmAction?.type === "disable"
            ? `停用 ${confirmAction.user.email}？该用户所有会话将立即失效，无法再登录。`
            : `启用 ${confirmAction?.user.email}？该用户可恢复正常登录。`
        }
        confirmLabel={confirmAction?.type === "disable" ? "停用" : "启用"}
        confirmingLabel="处理中…"
        busy={actionLoading}
        onConfirm={handleToggleDisable}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
