import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation, Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { AuthProvider, useAuth } from "./hooks/useAuth.js";
import TopNav from "./components/TopNav.js";
import LoginPage from "./pages/LoginPage.js";
import HomePage from "./pages/HomePage.js";
import CapabilitySetListPage from "./pages/CapabilitySetListPage.js";
import KeepAlive from "./components/KeepAlive.js";
import Button from "./components/Button.js";

// 路由级代码分割：大页面按需加载，减小初始 bundle
const LocalConsolePage = lazy(() => import("./pages/LocalConsolePage.js"));
const AssetComposerPage = lazy(() => import("./pages/AssetComposerPage.js"));
const CapabilitySetComposerPage = lazy(() => import("./pages/CapabilitySetComposerPage.js"));
const DocsPage = lazy(() => import("./pages/DocsPage.js"));
const SettingsPage = lazy(() => import("./pages/SettingsPage.js"));

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3 text-text-muted">
        <div className="w-8 h-8 rounded-full border-2 border-brand/30 border-t-brand animate-spin" />
        <span className="text-sm">加载中…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-24">
      <div className="w-16 h-16 rounded-2xl bg-brand-soft grid place-items-center text-brand mb-5">
        <Compass className="w-8 h-8" />
      </div>
      <p className="text-2xl font-bold tracking-tight text-text-primary mb-1.5">页面走丢了</p>
      <p className="text-sm text-text-muted mb-6">你访问的地址不存在或已移动。</p>
      <Link to="/">
        <Button variant="primary">返回能力市场</Button>
      </Link>
    </div>
  );
}

function AppRoutes() {
  const { user } = useAuth();
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-surface-muted">
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="*" element={<AuthenticatedLayout />} />
      </Routes>
    </div>
  );
}

function AuthenticatedLayout() {
  const { user } = useAuth();
  const location = useLocation();

  // 主导航标签页：保持挂载、切换仅隐藏，避免重渲染 / 重新请求。
  const path = location.pathname;
  const isHome = path === "/";
  const isCapabilitySets = path === "/capability-sets";
  const isConsole = path === "/console";
  const isDocs = path === "/docs";
  const isSettings = path === "/settings";
  // 其余为瞬时页面（能力集编辑器、能力编辑器、404），走普通路由、用完即卸载。
  const isCachedTab = isHome || isCapabilitySets || isConsole || isDocs || isSettings;
  const isPublicTab = isHome || isCapabilitySets || isDocs;
  const isProtectedPath = !isPublicTab;
  const shouldRenderProtectedArea = !!user || isProtectedPath;

  const suspenseFallback = (
    <div className="flex items-center justify-center h-[40vh]">
      <div className="w-7 h-7 rounded-full border-2 border-brand/30 border-t-brand animate-spin" />
    </div>
  );

  return (
    <>
      <TopNav />
      <main className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <KeepAlive active={isHome}>
            <HomePage />
          </KeepAlive>
          <KeepAlive active={isCapabilitySets}>
            <CapabilitySetListPage />
          </KeepAlive>
          <KeepAlive active={isDocs}>
            <Suspense fallback={suspenseFallback}><DocsPage /></Suspense>
          </KeepAlive>

          {shouldRenderProtectedArea && (
            <ProtectedRoute>
              <KeepAlive active={isConsole}>
                <Suspense fallback={suspenseFallback}><LocalConsolePage /></Suspense>
              </KeepAlive>
              <KeepAlive active={isSettings}>
                <Suspense fallback={suspenseFallback}><SettingsPage /></Suspense>
              </KeepAlive>

              {!isCachedTab && (
                <Suspense fallback={suspenseFallback}>
                  <Routes>
                    <Route path="/capability-sets/new" element={<CapabilitySetComposerPage />} />
                    <Route path="/capability-sets/:id/edit" element={<CapabilitySetComposerPage />} />
                    <Route path="/assets/new" element={<AssetComposerPage />} />
                    <Route path="/assets/:id/edit" element={<AssetComposerPage />} />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </Suspense>
              )}
            </ProtectedRoute>
          )}
        </div>
      </main>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
