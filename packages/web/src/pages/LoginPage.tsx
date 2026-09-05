import { useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Boxes, TerminalSquare, ArrowLeft, ArrowRight } from "lucide-react";
import { useAuth } from "../hooks/useAuth.js";
import Button from "../components/Button.js";
import Logo from "../components/Logo.js";

const HIGHLIGHTS = [
  { icon: Sparkles, title: "统一能力注册", desc: "Skill、Rule、MCP、Hook、Command、Agent 一处发现与管理。" },
  { icon: Boxes, title: "工作空间组合", desc: "把常用能力打包复用，一次安装到多个 AI 工具目录。" },
  { icon: TerminalSquare, title: "本地落地闭环", desc: "通过本地 Agent 安全写入 .cursor / .codebuddy / .claude 等目录。" },
];

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes("@")) {
      setError("请输入有效的邮箱地址");
      return;
    }
    setError("");
    setLoading(true);
    const err = await login(email, password);
    if (err) setError(err);
    setLoading(false);
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Left: brand / value */}
      <div className="relative hidden lg:flex flex-col justify-between p-12 overflow-hidden bg-brand text-white">
        <div className="absolute inset-0 opacity-[0.16]" style={{ backgroundImage: "radial-gradient(circle at 20% 20%, white 0, transparent 40%), radial-gradient(circle at 80% 70%, white 0, transparent 35%)" }} />
        <div className="absolute inset-0" style={{ backgroundImage: "linear-gradient(160deg, rgba(255,255,255,0.06) 0%, transparent 45%, rgba(0,0,0,0.12) 100%)" }} />
        <div className="relative">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-[10px] bg-white/15 backdrop-blur grid place-items-center">
              <Logo className="w-5 h-5" />
            </span>
            <span className="text-2xl font-bold tracking-tight">Loom</span>
          </div>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-[34px] font-bold leading-[1.2] tracking-tight mb-3">面向 AI 开发工具的能力平台</h2>
          <p className="text-white/80 text-sm mb-9 leading-relaxed">
            在 Web 上组合可复用的 AI 工程能力，并通过本地 Agent 安全落地到你的项目目录。
          </p>
          <div className="space-y-5">
            {HIGHLIGHTS.map(({ icon: Icon, title, desc }) => (
              <div key={title} className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-[10px] bg-white/15 grid place-items-center shrink-0">
                  <Icon size={17} />
                </span>
                <div>
                  <div className="font-semibold text-sm">{title}</div>
                  <div className="text-white/70 text-xs mt-0.5 leading-relaxed">{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative text-white/60 text-xs">服务端 / CLI 独立分发 · 数据本地优先</div>
      </div>

      {/* Right: login card */}
      <div className="flex items-center justify-center p-6 bg-surface-muted">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-2 mb-8 justify-center">
            <span className="w-8 h-8 rounded-lg bg-brand grid place-items-center">
              <Logo className="w-4 h-4" />
            </span>
            <span className="text-xl font-bold text-text-primary">Loom</span>
          </div>

          <div className="bg-white rounded-2xl shadow-lift border border-surface-sunken p-8">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-text-muted hover:text-text-primary transition-colors mb-5"
            >
              <ArrowLeft size={15} /> 返回首页
            </Link>
            <h1 className="text-xl font-bold tracking-tight text-text-primary mb-1">登录到 Loom</h1>
            <p className="text-sm text-text-muted mb-6">输入邮箱和密码即可登录，新邮箱将自动注册。</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">邮箱</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  autoFocus
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1.5">密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 6 位"
                  minLength={6}
                  className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
              </div>

              {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

              <Button type="submit" variant="primary" size="lg" fullWidth loading={loading}>
                登录 <ArrowRight size={16} />
              </Button>
            </form>

            <p className="text-xs text-text-muted text-center mt-6">
              没有账号？输入邮箱和至少 6 位密码即可自动注册。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
