/**
 * L5 UI: 工作空间预览面板 → 点击能力单元 → 右栏切换为该能力的基本信息 → 返回链接恢复。
 *
 * 不变量:
 * 1. 打开工作空间预览时，右栏默认显示工作空间信息（「目标工具」）。
 * 2. 点击左侧能力树中的能力后，右栏切换为该能力的信息视图：返回链接、
 *    类型徽章、名称标题、元信息行（「文件数」）出现，工作空间信息消失。
 * 3. 点击「返回工作空间信息」后，右栏恢复工作空间信息，返回链接消失。
 *
 * 数据准备走真实 HTTP API（登录态 cookie 由浏览器上下文共享给 page.request）。
 * 名称带随机后缀，同一数据目录下重复跑不因同名工作空间 409。
 */
import { test, expect } from "@playwright/test";

test.describe("工作空间预览 - 能力信息", () => {
  test("点击能力单元 → 右栏显示能力基本信息 → 返回工作空间信息", async ({ page }) => {
    const suffix = Date.now().toString(36);
    const assetName = `l5-preview-rule-${suffix}`;
    const workspaceName = `L5预览空间-${suffix}`;

    // 登录（首次自动创建用户）
    await page.goto("/login");
    await page.waitForSelector('input[type=email]', { timeout: 10000 });
    await page.fill('input[type=email]', 'ui-ws-preview@example.com');
    await page.fill('input[type=password]', 'test-user-password');
    await page.click('button[type=submit]');
    await page.waitForURL("/", { timeout: 10000 });

    // 真实 API 准备数据：一个 rule 能力 + 一个包含它的工作空间
    const assetRes = await page.request.post("/api/assets", {
      data: {
        name: assetName,
        type: "rule",
        description: "L5 预览测试用规则",
        files: [{ path: "l5-preview.md", content: "# L5 预览测试\n\n这是规则内容。\n" }],
        compatibleTools: ["cursor"],
        visibility: "private",
        metadata: { globs: [] },
      },
    });
    expect(assetRes.ok(), `创建能力失败: ${await assetRes.text()}`).toBeTruthy();
    const assetId = (await assetRes.json()).data.id as string;

    const wsRes = await page.request.post("/api/workspaces", {
      data: {
        name: workspaceName,
        description: "L5 预览测试用空间",
        targetTools: ["cursor"],
        visibility: "private",
        assetIds: [assetId],
      },
    });
    expect(wsRes.ok(), `创建工作空间失败: ${await wsRes.text()}`).toBeTruthy();

    // 打开工作空间列表 → 点击卡片 → 预览面板默认显示工作空间信息
    await page.goto("/workspaces");
    await page.getByText(workspaceName).click();
    await expect(page.getByText("能力 (1)")).toBeVisible();
    await expect(page.getByText("目标工具")).toBeVisible();

    // 展开 rules 分组 → 点击能力行 → 右栏切换为该能力的基本信息
    await page.getByRole("button", { name: /rules/ }).click();
    await page.getByRole("button", { name: assetName }).click();
    await expect(page.getByRole("button", { name: "返回工作空间信息" })).toBeVisible();
    await expect(page.getByRole("heading", { name: assetName, exact: true })).toBeVisible();
    await expect(page.getByText("Rule", { exact: true })).toBeVisible();
    await expect(page.getByText("文件数")).toBeVisible();
    await expect(page.getByText("目标工具")).toBeHidden();

    // 返回链接 → 右栏恢复工作空间信息
    await page.getByRole("button", { name: "返回工作空间信息" }).click();
    await expect(page.getByText("目标工具")).toBeVisible();
    await expect(page.getByRole("button", { name: "返回工作空间信息" })).toBeHidden();
  });
});
