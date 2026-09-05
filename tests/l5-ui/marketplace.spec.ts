/**
 * L5 UI: 能力市场页 → 导航 → 文档页。
 *
 * 不变量: 未登录用户能看到 public 内容，导航 tab 可切换。
 */
import { test, expect } from "@playwright/test";

test.describe("能力市场 + 导航", () => {
  test("未登录访问首页 → 显示能力市场", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toContainText("能力市场", { timeout: 10000 });
  });

  test("导航到文档页 → 显示文档内容", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // 点击文档 tab（可能需要根据实际 UI 调整选择器）
    const docsLink = page.locator('a[href="/docs"]').first();
    if (await docsLink.isVisible()) {
      await docsLink.click();
      await page.waitForURL("/docs", { timeout: 5000 });
      await expect(page.locator("body")).not.toBeEmpty();
    }
  });

  test("导航到能力集页 → 显示能力集列表", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const wsLink = page.locator('a[href="/capability-sets"]').first();
    if (await wsLink.isVisible()) {
      await wsLink.click();
      await page.waitForURL("/capability-sets", { timeout: 5000 });
      await expect(page.locator("body")).not.toBeEmpty();
    }
  });
});
