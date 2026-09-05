import { useState, useRef, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Plus, ChevronDown, Boxes, Sparkles, LogIn } from "lucide-react";
import { useAuth } from "../hooks/useAuth.js";
import Logo from "./Logo.js";

export default function TopNav() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const isActive = (path: string) =>
    path === "/" ? location.pathname === "/" : location.pathname.startsWith(path);

  // 激活态用中性底而非品牌蓝：蓝色只留给主操作，导航保持安静。
  const linkClass = (path: string) =>
    `px-3.5 py-1.5 rounded-full text-sm transition-colors ${
      isActive(path)
        ? "bg-surface-sunken text-text-primary font-semibold"
        : "text-text-secondary font-medium hover:text-text-primary hover:bg-surface-sunken/70"
    }`;

  return (
    <nav className="z-50 bg-white/85 backdrop-blur-md border-b border-surface-sunken">
      <div className="max-w-7xl mx-auto px-6 h-[60px] flex items-center gap-1">
        <Link to="/" className="flex items-center gap-2.5 mr-6 group">
          <span className="w-8 h-8 rounded-[10px] bg-brand grid place-items-center shadow-brand transition-transform group-hover:scale-105">
            <Logo className="w-[18px] h-[18px]" />
          </span>
          <span className="text-[17px] font-semibold text-text-primary tracking-tight">Loom</span>
        </Link>

        <Link to="/" className={linkClass("/")}>能力市场</Link>
        <Link to="/workspaces" className={linkClass("/workspaces")}>工作空间</Link>
        <Link to="/console" className={linkClass("/console")}>本地控制台</Link>
        <Link to="/docs" className={linkClass("/docs")}>文档</Link>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          {/* New button with dropdown */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-1 pl-3.5 pr-3 h-9 bg-brand text-white rounded-lg text-sm font-medium shadow-brand hover:bg-brand-600 active:bg-brand-700 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <Plus size={15} /> 新建
              <ChevronDown size={14} className={`transition-transform ${menuOpen ? "rotate-180" : ""}`} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-2 w-52 bg-white rounded-xl shadow-lift border border-surface-sunken p-1.5 animate-scale-in origin-top-right">
                <button
                  onClick={() => { setMenuOpen(false); navigate(user ? "/assets/new" : "/login"); }}
                  className="w-full flex items-start gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-card text-left transition-colors"
                >
                  <Sparkles size={16} className="text-brand mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-text-primary">新建能力</span>
                    <span className="block text-[11px] text-text-muted">Skill / Rule / MCP / Hook…</span>
                  </span>
                </button>
                <button
                  onClick={() => { setMenuOpen(false); navigate(user ? "/workspaces/new" : "/login"); }}
                  className="w-full flex items-start gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-card text-left transition-colors"
                >
                  <Boxes size={16} className="text-brand mt-0.5 shrink-0" />
                  <span>
                    <span className="block text-sm font-medium text-text-primary">新建工作空间</span>
                    <span className="block text-[11px] text-text-muted">组合多个能力</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {user ? (
            <button
              onClick={() => navigate("/settings")}
              className="w-9 h-9 rounded-[10px] bg-brand-soft text-brand flex items-center justify-center text-sm font-semibold hover:bg-brand-100 hover:ring-2 hover:ring-brand/20 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              title={user.email}
            >
              {user.email.charAt(0).toUpperCase()}
            </button>
          ) : (
            <button
              onClick={() => navigate("/login")}
              className="inline-flex items-center gap-1.5 px-3.5 h-9 rounded-lg border border-gray-200 bg-white text-sm font-medium text-text-secondary hover:text-text-primary hover:border-gray-300 hover:bg-surface-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            >
              <LogIn size={15} /> 登录
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
