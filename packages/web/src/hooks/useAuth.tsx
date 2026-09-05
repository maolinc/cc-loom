import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { api, setUnauthorizedHandler } from "../api.js";
import type { UserRole } from "@maolinc/cc-loom-shared";

interface AuthState {
  userId: string;
  email: string;
  role: UserRole;
}

interface AuthContextValue {
  user: AuthState | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<AuthState>("/auth/me").then((res) => {
      if (res.success && res.data) setUser(res.data);
      setLoading(false);
    });
  }, []);

  // 任意请求收到 401 时清空登录态，ProtectedRoute 会据此跳转登录页。
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = async (email: string, password: string): Promise<string | null> => {
    const res = await api.post<AuthState>("/auth/login", { email, password });
    if (res.success && res.data) {
      setUser(res.data);
      return null;
    }
    return res.error || "登录失败";
  };

  const logout = async () => {
    await api.post("/auth/logout");
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
