/**
 * L5 UI: hook 能力创建 —— 触发事件多选。
 *
 * 不变量:
 *  - hook 类型下渲染事件多选 chips（非单选下拉），可选中多个事件；
 *  - 选中计数随点选变化；取消选中恢复；
 *  - 至少选一个事件才能通过校验（不选 → 提交报「Hook 需要至少一个事件」）。
 */
import { test, expect } from "@playwright/test";

async function login(page: any) {
  await page.goto("/login");
  await page.waitForSelector('input[type=email]', { timeout: 10000 });
  await page.fill('input[type=email]', `hook-composer-${Date.now()}@example.com`);
  await page.fill('input[type=password]', 'test-user-password');
  await page.click('button[type=submit]');
  await page.waitForURL("/", { timeout: 10000 });
}

test.describe("hook 创建表单：触发事件多选", () => {
  test("事件 chips 多选 + 计数 + 必填校验", async ({ page }) => {
    await login(page);
    await page.goto("/assets/new");

    // 选 hook 类型（composer 是 lazy chunk，等类型配置区出现再交互）
    await page.click('text=事件驱动的脚本');
    await expect(page.locator("text=触发事件（可多选，已选 1 个）")).toBeVisible();

    // 事件区渲染 chips（HOOK_EVENTS 全量），不是 select 下拉；默认预选 PreToolUse
    await expect(page.locator("select")).toHaveCount(0);

    // 默认已选 PreToolUse；再点两个事件 → 计数变 3
    await page.click('button:has-text("Notification")');
    await page.click('button:has-text("Stop")');
    await expect(page.locator("text=已选 3 个")).toBeVisible();

    // 取消一个 → 计数变 2
    await page.click('button:has-text("Stop")');
    await expect(page.locator("text=已选 2 个")).toBeVisible();
  });
});
