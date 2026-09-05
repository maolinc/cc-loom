import { useState } from "react";
import { useAuth } from "../hooks/useAuth.js";
import PageHeader from "../components/PageHeader.js";
import AccountTab from "./settings/AccountTab.js";
import AiTab from "./settings/AiTab.js";
import AiInfoTab from "./settings/AiInfoTab.js";
import MarketplaceTab from "./settings/MarketplaceTab.js";
import AuthConfigTab from "./settings/AuthConfigTab.js";
import AdminTab from "./settings/AdminTab.js";
import SearchTab from "./settings/SearchTab.js";
import ToolConfigTab from "./settings/ToolConfigTab.js";

type TabId = "account" | "ai" | "ai-info" | "marketplace" | "auth-config" | "tool-config" | "search" | "admin";

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [tab, setTab] = useState<TabId>("account");

  const tabs: { id: TabId; label: string; adminOnly?: boolean }[] = [
    { id: "account", label: "账号" },
    { id: "ai", label: "AI 生成" },
    { id: "marketplace", label: "数据来源", adminOnly: true },
    { id: "auth-config", label: "能力鉴权配置" },
    { id: "tool-config", label: "AI 工具配置" },
    { id: "ai-info", label: "能力信息生成", adminOnly: true },
    { id: "search", label: "语义搜索", adminOnly: true },
    { id: "admin", label: "用户管理", adminOnly: true },
  ];

  const visibleTabs = tabs.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div>
      <PageHeader
        title="设置"
        description="管理账号安全、CLI Token、AI 生成、能力数据来源、鉴权凭据与设备工具配置。"
      />
      <div className="flex flex-wrap gap-1 border-b border-surface-sunken mb-7">
        {visibleTabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3.5 pb-3 text-sm border-b-2 -mb-px transition-colors ${
              tab === id
                ? "border-brand text-text-primary font-semibold"
                : "border-transparent text-text-muted font-medium hover:text-text-primary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "account" && <AccountTab />}
      {tab === "ai" && <AiTab />}
      {tab === "ai-info" && isAdmin && <AiInfoTab />}
      {tab === "marketplace" && isAdmin && <MarketplaceTab />}
      {tab === "auth-config" && <AuthConfigTab />}
      {tab === "tool-config" && <ToolConfigTab />}
      {tab === "search" && isAdmin && <SearchTab />}
      {tab === "admin" && isAdmin && <AdminTab />}
    </div>
  );
}
