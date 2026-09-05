/**
 * HTTP API 客户端 — 复用 @maolinc/cc-loom-shared 类型，封装 session cookie / Bearer token。
 *
 * 两类认证:
 * - Web session: login 后自动管理 cookie
 * - CLI Bearer: setToken 后所有请求带 Authorization header
 */
import type {
  Asset,
  AssetCreateInput,
  AssetUpdateInput,
  ApiResponse,
  Credential,
  CredentialDistribution,
  InstallPlan,
  InstallResult,
  LocalProjectState,
  Project,
  SessionUser,
  TargetTool,
  Visibility,
  CapabilitySet,
  CapabilitySetCreateInput,
  CapabilitySetUpdateInput,
  SyncPolicy,
  Device,
  ToolConfigDistribution,
  ToolConfigProfile,
} from "@maolinc/cc-loom-shared";

export class ApiClient {
  private cookie: string | null = null;
  private bearerToken: string | null = null;

  constructor(private baseUrl: string) {}

  /** Web 登录（首次使用提交的密码自动注册）。 */
  async login(email: string, password = "test-user-password"): Promise<SessionUser> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json()) as ApiResponse<SessionUser>;
    if (!res.ok || !body.success) {
      throw new Error(`login 失败: ${body.error ?? res.statusText}`);
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const match = /loom_session=([^;]+)/.exec(setCookie);
      if (match) this.cookie = `loom_session=${match[1]}`;
    }
    return body.data!;
  }

  /** 设置 CLI Bearer token（替代 session cookie）。 */
  setToken(token: string): void {
    this.bearerToken = token;
    this.cookie = null;
  }

  /** 当前 session cookie（供需要原始 fetch 断言状态码的用例复用鉴权态）。 */
  getCookie(): string | null {
    return this.cookie;
  }

  /** 当前 Bearer token（同上）。 */
  getBearer(): string | null {
    return this.bearerToken;
  }

  /** 获取当前用户的 CLI token。 */
  async getCliToken(): Promise<string> {
    const body = await this.get<{ token: string }>("/api/auth/cli-token");
    return body.token;
  }

  // ---- Assets ----

  async createAsset(input: AssetCreateInput): Promise<Asset> {
    return this.post<Asset>("/api/assets", input);
  }

  async getAsset(id: string): Promise<Asset> {
    return this.get<Asset>(`/api/assets/${id}`);
  }

  async listAssets(params?: { type?: string; query?: string }): Promise<Asset[]> {
    const qs = new URLSearchParams();
    if (params?.type) qs.set("type", params.type);
    if (params?.query) qs.set("query", params.query);
    return this.get<Asset[]>(`/api/assets?${qs}`);
  }

  async updateAsset(id: string, input: AssetUpdateInput): Promise<Asset> {
    return this.put<Asset>(`/api/assets/${id}`, input);
  }

  async deleteAsset(id: string): Promise<void> {
    await this.del(`/api/assets/${id}`);
  }

  // ---- CapabilitySets ----

  async createCapabilitySet(
    input: CapabilitySetCreateInput,
    assetIds?: string[],
  ): Promise<CapabilitySet> {
    const body = assetIds ? { ...input, assetIds } : input;
    return this.post<CapabilitySet>("/api/capability-sets", body);
  }

  async getCapabilitySet(id: string): Promise<CapabilitySet> {
    return this.get<CapabilitySet>(`/api/capability-sets/${id}`);
  }

  async updateCapabilitySet(id: string, input: CapabilitySetUpdateInput): Promise<CapabilitySet> {
    return this.put<CapabilitySet>(`/api/capability-sets/${id}`, input);
  }

  async listCapabilitySets(): Promise<CapabilitySet[]> {
    return this.get<CapabilitySet[]>("/api/capability-sets");
  }

  async deleteCapabilitySet(id: string): Promise<void> {
    await this.del(`/api/capability-sets/${id}`);
  }

  // ---- Projects ----

  async listProjects(): Promise<Project[]> {
    return this.get<Project[]>("/api/projects");
  }

  async getProject(id: string): Promise<Project> {
    return this.get<Project>(`/api/projects/${id}`);
  }

  // ---- Install ----

  async installPlan(input: {
    projectId: string;
    capabilitySetId: string;
    targetTools: TargetTool[];
    policy: SyncPolicy;
  }): Promise<InstallPlan> {
    return this.post<InstallPlan>("/api/install/plan", input);
  }

  async installExecute(input: {
    projectId: string;
    capabilitySetId: string;
    targetTools: TargetTool[];
    policy: SyncPolicy;
    skipAssetIds?: string[];
  }): Promise<{ plan: InstallPlan; result: InstallResult }> {
    return this.post<{ plan: InstallPlan; result: InstallResult }>("/api/install/execute", input);
  }

  // ---- Subscriptions（ADR-0006 多能力集订阅）----

  /** 卸载一条显式订阅。 */
  async unsubscribeCapabilitySet(projectId: string, capabilitySetId: string): Promise<void> {
    await this.del(`/api/projects/${projectId}/subscriptions/${capabilitySetId}`);
  }

  /** 修改订阅同步策略；capabilitySetId 传 "implicit" 表示隐式订阅（单独添加的能力组）。 */
  async setSubscriptionPolicy(
    projectId: string,
    capabilitySetId: string,
    policy: SyncPolicy,
  ): Promise<void> {
    await this.post(`/api/projects/${projectId}/subscriptions/${capabilitySetId}/sync-policy`, { policy });
  }

  /** 修改显式订阅的落盘厂商集合。 */
  async setSubscriptionTargets(
    projectId: string,
    capabilitySetId: string,
    targets: TargetTool[],
  ): Promise<{ filesWritten: string[]; filesRemoved: string[] }> {
    return this.post(`/api/projects/${projectId}/subscriptions/${capabilitySetId}/targets`, { targets });
  }

  // ---- Devices ----

  async listDevices(): Promise<Device[]> {
    return this.get<Device[]>("/api/devices");
  }

  // ---- Codex / Claude Code 工具配置档 ----

  async createToolConfigProfile(input: Record<string, unknown>): Promise<ToolConfigProfile> {
    return this.post<ToolConfigProfile>("/api/tool-config-profiles", input);
  }

  async listToolConfigProfiles(): Promise<ToolConfigProfile[]> {
    return this.get<ToolConfigProfile[]>("/api/tool-config-profiles");
  }

  async listToolConfigDistributions(): Promise<ToolConfigDistribution[]> {
    return this.get<ToolConfigDistribution[]>("/api/tool-config-profiles/distributions");
  }

  async distributeToolConfigProfile(profileId: string, deviceIds: string[]): Promise<{ pushed: string[]; skipped: { deviceId: string; reason: string }[] }> {
    return this.post(`/api/tool-config-profiles/${profileId}/distribute`, { deviceIds });
  }

  // ---- Marketplaces ----

  async listMarketplaces(): Promise<any[]> {
    return this.get<any[]>("/api/marketplaces");
  }

  async addMarketplace(repoUrl: string, ref?: string): Promise<any>;
  async addMarketplace(repoUrl: string, opts: { ref?: string; assetTypes?: string[] }): Promise<any>;
  async addMarketplace(repoUrl: string, refOrOpts?: string | { ref?: string; assetTypes?: string[] }): Promise<any> {
    const body =
      typeof refOrOpts === "object" && refOrOpts !== null
        ? { repoUrl, ...(refOrOpts.ref ? { ref: refOrOpts.ref } : {}), ...(refOrOpts.assetTypes ? { assetTypes: refOrOpts.assetTypes } : {}) }
        : { repoUrl, ...(typeof refOrOpts === "string" ? { ref: refOrOpts } : {}) };
    return this.post<any>("/api/marketplaces", body);
  }

  async refreshMarketplace(id: string): Promise<any> {
    return this.post<any>(`/api/marketplaces/${id}/refresh`, undefined);
  }

  async deleteMarketplace(id: string, keepAssets = false): Promise<void> {
    await this.del(`/api/marketplaces/${id}?keepAssets=${keepAssets}`);
  }

  async getMarketplaceLogs(id: string): Promise<any[]> {
    return this.get<any[]>(`/api/marketplaces/${id}/logs`);
  }

  /** 暂停/启用一个数据源（PATCH /api/marketplaces/:id）。 */
  async setMarketplaceEnabled(id: string, enabled: boolean): Promise<any> {
    return this.patch<any>(`/api/marketplaces/${id}`, { enabled });
  }

  /** 管理员立即同步全部数据源（POST /api/admin/marketplaces/sync → tick）。需 admin 登录。 */
  async syncAllMarketplaces(): Promise<void> {
    await this.post<void>("/api/admin/marketplaces/sync", undefined);
  }

  // ---- Credentials（ADR-0003：统一凭据值 + 显式分发）----

  async createCredential(
    name: string,
    value: string,
    axis: "env" | "path" = "env",
    description?: string,
  ): Promise<Credential> {
    return this.post<Credential>("/api/credentials", { name, value, axis, description });
  }

  async listCredentials(): Promise<Credential[]> {
    return this.get<Credential[]>("/api/credentials");
  }

  async listCredentialDistributions(): Promise<CredentialDistribution[]> {
    return this.get<CredentialDistribution[]>("/api/credentials/distributions");
  }

  async listCredentialUsages(): Promise<Array<{ credentialName: string; projectId: string; projectName: string; assetId: string; assetName: string; assetType: string; path: string }>> {
    return this.get("/api/credentials/usages");
  }

  async distributeCredential(
    credentialId: string,
    axis: "env" | "path",
    targetIds: string[],
  ): Promise<{ pushed: string[]; skipped: { targetId: string; reason: string }[] }> {
    return this.post(`/api/credentials/${credentialId}/distribute`, { axis, targetIds });
  }

  async revokeCredential(credentialId: string, axis: "env" | "path", targetId: string): Promise<void> {
    await this.post(`/api/credentials/${credentialId}/revoke`, { axis, targetId });
  }

  async deleteCredential(id: string): Promise<void> {
    await this.del(`/api/credentials/${id}`);
  }

  /** 更新凭据（value 留空 = 保持原值；值变化触发 path 分发项目轮换）。 */
  async updateCredential(id: string, body: { name?: string; value?: string; description?: string }): Promise<Credential> {
    return this.put<Credential>(`/api/credentials/${id}`, body);
  }

  /** 读取项目本地镜像状态（server 缓存的 agent 上报快照）。 */
  async getState(projectId: string): Promise<LocalProjectState> {
    return this.get<LocalProjectState>(`/api/projects/${projectId}/state`);
  }

  /** 强制重扫并返回最新本地镜像状态。 */
  async scanState(projectId: string): Promise<LocalProjectState> {
    return this.post<LocalProjectState>(`/api/projects/${projectId}/scan`, undefined);
  }

  async toggleCapability(
    projectId: string,
    body: { assetId: string; tool: string; enabled: boolean; externalAsset?: { name: string; type: string; files: string[] } },
  ): Promise<{ filesWritten: string[]; filesRemoved: string[]; adoptedAssetId?: string }> {
    return this.post(`/api/projects/${projectId}/capabilities/toggle`, body);
  }

  async addCapability(
    projectId: string,
    assetIds: string[],
  ): Promise<{ filesWritten: string[]; filesRemoved: string[] }> {
    return this.post(`/api/projects/${projectId}/capabilities/add`, { assetIds });
  }

  async removeCapability(
    projectId: string,
    body: { assetId: string; tool?: string; externalAsset?: { name: string; type: string; files: string[] } },
  ): Promise<{ filesWritten: string[]; filesRemoved: string[] }> {
    return this.post(`/api/projects/${projectId}/capabilities/remove`, body);
  }

  /** Web 端删除项目（purge）：返回深度/浅度清理结果。 */
  async purgeProject(projectId: string): Promise<{ depth: "deep" | "shallow"; warning?: string }> {
    return this.post(`/api/projects/${projectId}/purge`, undefined);
  }

  // ---- 内部 HTTP 原语 ----

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.bearerToken) {
      headers["authorization"] = `Bearer ${this.bearerToken}`;
    } else if (this.cookie) {
      headers["cookie"] = this.cookie;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: ApiResponse<T> | null = null;
    try {
      parsed = JSON.parse(text) as ApiResponse<T>;
    } catch {
      throw new Error(`${method} ${path} 返回非 JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok || parsed.success === false) {
      throw new ApiRequestError(res.status, parsed.error ?? res.statusText);
    }
    return parsed.data as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
  private put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
  private async del(path: string): Promise<void> {
    await this.request<void>("DELETE", path);
  }
}

/** API 请求错误，带 HTTP 状态码。测试用例可断言具体码。 */
export class ApiRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}
