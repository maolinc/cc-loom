/**
 * L5 UI: 登录页 → 输入邮箱密码 → 跳转首页。
 *
 * 不变量: 登录成功后 URL 变为 /（能力市场），页面显示「能力市场」标题。
 */
import { test, expect } from "@playwright/test";

test.describe("登录页", () => {
  test("输入邮箱密码 → 跳转能力市场", async ({ page }) => {
    await page.goto("/login");

    // 等待登录表单加载（input[type=email]，无 name 属性）
    await page.waitForSelector('input[type=email]', { timeout: 10000 });

    await page.fill('input[type=email]', 'ui-test@example.com');
    await page.fill('input[type=password]', 'test-user-password');
    await page.click('button[type=submit]');

    // 等待跳转到首页（能力市场）
    await page.waitForURL("/", { timeout: 10000 });
    await expect(page.locator("body")).toContainText("能力市场", { timeout: 5000 });
  });

  test("错误密码 → 显示错误提示", async ({ page }) => {
    // 先创建用户（首次登录自动创建）
    await page.goto("/login");
    await page.waitForSelector('input[type=email]', { timeout: 10000 });
    await page.fill('input[type=email]', 'ui-wrong@example.com');
    await page.fill('input[type=password]', 'test-user-password');
    await page.click('button[type=submit]');
    await page.waitForURL("/", { timeout: 10000 });

    // 退出登录（清除 session cookie 后访问 /login）
    await page.context().clearCookies();
    await page.goto("/login");
    await page.waitForSelector('input[type=email]', { timeout: 10000 });

    // 用错误密码登录
    await page.fill('input[type=email]', 'ui-wrong@example.com');
    await page.fill('input[type=password]', 'wrongpassword');
    await page.click('button[type=submit]');

    // 应该停在登录页，显示错误
    await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
    await expect(page.locator("body")).toContainText("密码", { timeout: 5000 });
  });
});
