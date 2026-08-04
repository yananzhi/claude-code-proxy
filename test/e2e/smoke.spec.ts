// test/e2e/smoke.spec.mjs — e2e 冒烟测试（目标 0：基建验证）
//
// 只验证 Playwright 基建可用：起 standalone → 打开列表页 → 断言标题渲染。
// 不验证重设计行为（那些在目标 7 补全）。
//
// 运行：npx playwright test --config=playwright.config.ts
import { test, expect } from './fixtures';

test('冒烟：起 standalone 后端 → 打开列表页 → 标题渲染', async ({ page, standalone }) => {
    await page.goto(standalone.url);

    // 标题（h1）渲染——证明 management server 起来了、HTML 返回了、浏览器加载了
    await expect(page.locator('h1')).toContainText('Workspace 管理');

    // 空状态提示渲染（无 workspace 时列表区的占位文案）
    await expect(page.locator('#list')).not.toBeEmpty();
});

test('冒烟：代理控制台链接指向 proxyPort', async ({ page, standalone }) => {
    await page.goto(standalone.url);
    const proxyLink = page.locator('a', { hasText: '127.0.0.1' }).first();
    await expect(proxyLink).toBeVisible();
    // 链接 href 含真实 proxyPort（fixture 改过 listenPort）
    const href = await proxyLink.getAttribute('href');
    expect(href).toContain(`127.0.0.1:${standalone.proxyPort}`);
});
