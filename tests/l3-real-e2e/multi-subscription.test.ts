/**
 * L3 多能力集订阅（ADR-0006）— 真实 server + agent + WS + 磁盘。
 *
 * 不变量：
 *  1. 一个项目可同时安装多个 CapabilitySet，能力叠加落盘。
 *  2. 同一 asset id 跨订阅共享单例：卸载某订阅时，仅当它是最后一个引用者才删文件
 *     （能力级 + (能力 × 厂商) 级引用计数）。
 *  3. 同名不同 id 撞车：plan 报 conflictingAssets，execute 未裁决 → 409；
 *     带 skipAssetIds 裁决后安装成功且不动已有文件；冲突方卸载后重装可补齐。
 *  4. syncPolicy 挂在订阅上：auto 订阅的能力集变更自动回推，locked 订阅不回推。
 *  5. 隐式订阅（单独添加的能力）与显式订阅共存。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  startServer,
  stopServer,
  type ServerHandle,
  startAgent,
  stopAgent,
  type AgentHandle,
  makeProject,
  cleanupProject,
  ApiClient,
  assetBuilders,
  expectFileExists,
  expectFileNotExists,
} from "@maolinc/cc-loom-testkit";

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

describe("L3 multi-subscription: 多能力集订阅", () => {
  let server: ServerHandle;
  let api: ApiClient;
  let agent: AgentHandle | null;
  let projectRoot: string | null;

  beforeEach(() => {
    agent = null;
    projectRoot = null;
  });

  afterEach(async () => {
    if (agent) await stopAgent(agent);
    if (server) await stopServer(server);
    if (projectRoot) cleanupProject(projectRoot);
  });

  async function boot(email: string): Promise<string> {
    server = await startServer();
    api = new ApiClient(server.baseUrl);
    await api.login(email);
    const token = await api.getCliToken();
    projectRoot = makeProject("empty");
    agent = await startAgent({
      endpoint: server.baseUrl,
      token,
      projectRoot,
      isOnline: async () => {
        const devices = await api.listDevices();
        return devices.some((d) => d.status === "online");
      },
    });
    return token;
  }

  const skillFile = (name: string, tool: "cursor" | "claudecode" = "cursor") =>
    join(projectRoot!, tool === "cursor" ? `.cursor/skills/${name}/SKILL.md` : `.claude/skills/${name}/SKILL.md`);

  it("两个能力集叠加安装；共享能力单例；卸载按引用计数保留", async () => {
    await boot("multi-basic@example.com");
    const shared = await api.createAsset(assetBuilders.skill("shared-skill", ["cursor"]));
    const onlyA = await api.createAsset(assetBuilders.skill("only-a", ["cursor"]));
    const onlyB = await api.createAsset(assetBuilders.skill("only-b", ["cursor"]));
    const wsA = await api.createCapabilitySet(
      { name: "ws-a", description: "a", targetTools: ["cursor"], visibility: "public" },
      [shared.id, onlyA.id],
    );
    const wsB = await api.createCapabilitySet(
      { name: "ws-b", description: "b", targetTools: ["cursor"], visibility: "public" },
      [shared.id, onlyB.id],
    );

    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsA.id, targetTools: ["cursor"], policy: "auto" });
    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsB.id, targetTools: ["cursor"], policy: "auto" });

    // 叠加生效：三份能力都在；共享能力只落一份
    expectFileExists(projectRoot!, ".cursor/skills/shared-skill/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/only-a/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/only-b/SKILL.md");

    // 两条显式订阅
    const proj = await api.getProject(agent!.projectId);
    const explicit = proj.subscriptions.filter((s) => s.capabilitySetId !== null);
    expect(explicit.map((s) => s.capabilitySetId).sort()).toEqual([wsA.id, wsB.id].sort());

    // 卸载 A：only-a 删除；shared 因 B 仍引用而保留；only-b 不动
    await api.unsubscribeCapabilitySet(agent!.projectId, wsA.id);
    expectFileNotExists(projectRoot!, ".cursor/skills/only-a/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/shared-skill/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/only-b/SKILL.md");

    // 卸载 B（最后引用者）：shared 与 only-b 都删除
    await api.unsubscribeCapabilitySet(agent!.projectId, wsB.id);
    expectFileNotExists(projectRoot!, ".cursor/skills/shared-skill/SKILL.md");
    expectFileNotExists(projectRoot!, ".cursor/skills/only-b/SKILL.md");
  });

  it("(能力 × 厂商) 引用计数：不同厂商的订阅卸载只撤自己厂商的文件", async () => {
    await boot("multi-axis@example.com");
    const shared = await api.createAsset(assetBuilders.skill("axis-shared", ["cursor", "claudecode"]));
    const wsCursor = await api.createCapabilitySet(
      { name: "ws-cur", description: "c", targetTools: ["cursor", "claudecode"], visibility: "public" },
      [shared.id],
    );
    const wsClaude = await api.createCapabilitySet(
      { name: "ws-cc", description: "c", targetTools: ["cursor", "claudecode"], visibility: "public" },
      [shared.id],
    );

    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsCursor.id, targetTools: ["cursor"], policy: "auto" });
    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsClaude.id, targetTools: ["claudecode"], policy: "auto" });

    expectFileExists(projectRoot!, ".cursor/skills/axis-shared/SKILL.md");
    expectFileExists(projectRoot!, ".claude/skills/axis-shared/SKILL.md");

    // 卸载 cursor 订阅：.cursor 撤下，.claude 保留（仍被 wsClaude 引用）
    await api.unsubscribeCapabilitySet(agent!.projectId, wsCursor.id);
    expectFileNotExists(projectRoot!, ".cursor/skills/axis-shared/SKILL.md");
    expectFileExists(projectRoot!, ".claude/skills/axis-shared/SKILL.md");
  });

  it("同名不同 id 撞车：plan 报冲突 → 未裁决 409 → 跳过裁决安装 → 冲突方卸载后重装补齐", async () => {
    await boot("multi-conflict@example.com");
    const dupA = await api.createAsset(assetBuilders.skill("dup-skill", ["cursor"]));
    const dupB = await api.createAsset(assetBuilders.skill("dup-skill", ["cursor"]));
    const other = await api.createAsset(assetBuilders.skill("other-skill", ["cursor"]));
    expect(dupA.id).not.toBe(dupB.id);
    const wsA = await api.createCapabilitySet(
      { name: "ws-dup-a", description: "a", targetTools: ["cursor"], visibility: "public" },
      [dupA.id],
    );
    const wsB = await api.createCapabilitySet(
      { name: "ws-dup-b", description: "b", targetTools: ["cursor"], visibility: "public" },
      [dupB.id, other.id],
    );

    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsA.id, targetTools: ["cursor"], policy: "auto" });

    // plan：结构化撞车清单
    const plan = await api.installPlan({ projectId: agent!.projectId, capabilitySetId: wsB.id, targetTools: ["cursor"], policy: "auto" });
    expect(plan.conflictingAssets?.length).toBe(1);
    expect(plan.conflictingAssets![0]!.incomingAssetId).toBe(dupB.id);
    expect(plan.conflictingAssets![0]!.existingAssetId).toBe(dupA.id);

    // 未裁决 → 409
    await expect(
      api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsB.id, targetTools: ["cursor"], policy: "auto" }),
    ).rejects.toThrow();

    // 裁决：跳过 dupB → B 的 other 照装，磁盘 dup-skill 仍是 A 的内容
    await api.installExecute({
      projectId: agent!.projectId, capabilitySetId: wsB.id, targetTools: ["cursor"], policy: "auto",
      skipAssetIds: [dupB.id],
    });
    expectFileExists(projectRoot!, ".cursor/skills/other-skill/SKILL.md");
    expect(existsSync(skillFile("dup-skill"))).toBe(true);

    // 冲突方卸载后重装 B（不带 skip）→ 补齐：dup-skill 仍在（现在是 B 的 dupB 渲染）
    await api.unsubscribeCapabilitySet(agent!.projectId, wsA.id);
    expectFileNotExists(projectRoot!, ".cursor/skills/dup-skill/SKILL.md");
    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsB.id, targetTools: ["cursor"], policy: "auto" });
    expectFileExists(projectRoot!, ".cursor/skills/dup-skill/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/other-skill/SKILL.md");
  });

  it("订阅级同步策略：auto 订阅的能力集变更回推，locked 订阅不回推", async () => {
    await boot("multi-policy@example.com");
    const a1 = await api.createAsset(assetBuilders.skill("pol-a1", ["cursor"]));
    const b1 = await api.createAsset(assetBuilders.skill("pol-b1", ["cursor"]));
    const wsA = await api.createCapabilitySet(
      { name: "ws-auto", description: "a", targetTools: ["cursor"], visibility: "public" },
      [a1.id],
    );
    const wsB = await api.createCapabilitySet(
      { name: "ws-locked", description: "b", targetTools: ["cursor"], visibility: "public" },
      [b1.id],
    );
    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsA.id, targetTools: ["cursor"], policy: "auto" });
    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsB.id, targetTools: ["cursor"], policy: "locked" });

    // 两个能力集各加一个能力：只有 auto 的 A 回推
    const a2 = await api.createAsset(assetBuilders.skill("pol-a2", ["cursor"]));
    await api.updateCapabilitySet(wsA.id, { assetIds: [a1.id, a2.id] });
    const b2 = await api.createAsset(assetBuilders.skill("pol-b2", ["cursor"]));
    await api.updateCapabilitySet(wsB.id, { assetIds: [b1.id, b2.id] });

    expect(await waitUntil(() => existsSync(skillFile("pol-a2")))).toBe(true);
    // locked 的 B：等一小段时间确认没有回推
    await new Promise((r) => setTimeout(r, 2000));
    expect(existsSync(skillFile("pol-b2"))).toBe(false);

    // B 切回 auto → 立即追平
    await api.setSubscriptionPolicy(agent!.projectId, wsB.id, "auto");
    expect(await waitUntil(() => existsSync(skillFile("pol-b2")))).toBe(true);
  });

  it("隐式订阅：单独添加的能力与能力集能力共存，各自独立移除", async () => {
    await boot("multi-implicit@example.com");
    const wsSkill = await api.createAsset(assetBuilders.skill("imp-ws", ["cursor"]));
    const solo = await api.createAsset(assetBuilders.skill("imp-solo", ["cursor"]));
    const ws = await api.createCapabilitySet(
      { name: "ws-imp", description: "a", targetTools: ["cursor"], visibility: "public" },
      [wsSkill.id],
    );
    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: ws.id, targetTools: ["cursor"], policy: "auto" });
    await api.addCapability(agent!.projectId, [solo.id]);

    expectFileExists(projectRoot!, ".cursor/skills/imp-ws/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/imp-solo/SKILL.md");

    // 隐式订阅存在（capabilitySetId = null）
    const proj = await api.getProject(agent!.projectId);
    expect(proj.subscriptions.some((s) => s.capabilitySetId === null)).toBe(true);
    expect(proj.subscriptions.some((s) => s.capabilitySetId === ws.id)).toBe(true);

    // 移除单独能力不影响能力集能力
    await api.removeCapability(agent!.projectId, { assetId: solo.id });
    expectFileNotExists(projectRoot!, ".cursor/skills/imp-solo/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/imp-ws/SKILL.md");

    // 卸载能力集订阅不影响其它单独能力（再加一个验证）
    await api.addCapability(agent!.projectId, [solo.id]);
    await api.unsubscribeCapabilitySet(agent!.projectId, ws.id);
    expectFileNotExists(projectRoot!, ".cursor/skills/imp-ws/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/imp-solo/SKILL.md");
  });

  it("订阅级厂商调整：收窄 targetTools 只撤该订阅独占的厂商文件", async () => {
    await boot("multi-targets@example.com");
    const shared = await api.createAsset(assetBuilders.skill("tgt-shared", ["cursor", "claudecode"]));
    const wsA = await api.createCapabilitySet(
      { name: "ws-tgt-a", description: "a", targetTools: ["cursor", "claudecode"], visibility: "public" },
      [shared.id],
    );
    const wsB = await api.createCapabilitySet(
      { name: "ws-tgt-b", description: "b", targetTools: ["cursor", "claudecode"], visibility: "public" },
      [shared.id],
    );
    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsA.id, targetTools: ["cursor", "claudecode"], policy: "auto" });
    await api.installExecute({ projectId: agent!.projectId, capabilitySetId: wsB.id, targetTools: ["cursor"], policy: "auto" });

    expectFileExists(projectRoot!, ".claude/skills/tgt-shared/SKILL.md");

    // A 收窄到 cursor：claude 目录的文件撤下（只有 A 覆盖 claudecode）
    await api.setSubscriptionTargets(agent!.projectId, wsA.id, ["cursor"]);
    expectFileNotExists(projectRoot!, ".claude/skills/tgt-shared/SKILL.md");
    expectFileExists(projectRoot!, ".cursor/skills/tgt-shared/SKILL.md");
  });
});
