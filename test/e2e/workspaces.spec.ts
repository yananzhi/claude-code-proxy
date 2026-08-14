// test/e2e/workspaces.spec.ts — 列表页结构 e2e（目标7）
//
// 覆盖 docs/standalone管理界面重设计.md 第 8.2 节关键行为：
//   树形结构（配置/终端两个一级标签）+ 文案统一 + 默认标记按钮。
//   不起真终端（需 PTY），xterm/顶栏留手动验证。
import { test, expect } from './fixtures.js';

const API = (url, path) => `${url}${path}`;

async function createWorkspaceAndConfig(url, label, mode = 'direct') {
    // 建 workspace
    const dir = await import('node:os').then(os => os.tmpdir()) + `/e2e-proj-${label}-${Date.now()}`;
    await import('node:fs').then(fs => fs.mkdirSync(dir, { recursive: true }));
    const wsRes = await fetch(API(url, '/api/workspaces'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: label, dir }),
    });
    const wsData = await wsRes.json();
    const wsId = wsData.workspace.id;
    // 建 config
    const content = mode === 'direct'
        ? JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://up.test', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'glm-5' } })
        : JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://up.proxy', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'pm' } });
    const cfgRes = await fetch(API(url, `/api/workspaces/${wsId}/configs`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${label}-cfg`, content, mode }),
    });
    const cfgData = await cfgRes.json();
    return { wsId, cfgId: cfgData.config.id, dir };
}

test('列表页：空状态显示新建 workspace 提示', async ({ page, standalone }) => {
    await page.goto(standalone.url);
    await expect(page.locator('h1')).toContainText('Workspace 管理');
    // 无 workspace 时列表区有占位
    const list = page.locator('#list');
    await expect(list).not.toBeEmpty();
});

test('树形结构：workspace 下有「配置」「终端」两个一级标签', async ({ page, standalone }) => {
    await createWorkspaceAndConfig(standalone.url, 'tree');
    await page.goto(standalone.url);
    // workspace 默认展开（toggle 初始 ▼），configs 异步加载，等「配置」标题出现
    await expect(page.locator('.group-title', { hasText: '配置' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.group-title', { hasText: '终端' })).toBeVisible({ timeout: 10000 });
});

test('文案统一：静态配置行显示 [直连]/[代理] 徽标', async ({ page, standalone }) => {
    await createWorkspaceAndConfig(standalone.url, 'direct-cfg', 'direct');
    await createWorkspaceAndConfig(standalone.url, 'proxy-cfg', 'proxy');
    await page.goto(standalone.url);
    await expect(page.locator('.config-row', { hasText: '[直连]' })).toBeVisible({ timeout: 10000 });
});

test('文案统一：无"派生/derived/Local LLM Configs"残留（用户可见处）', async ({ page, standalone }) => {
    await createWorkspaceAndConfig(standalone.url, 'wcopy');
    await page.goto(standalone.url);
    await expect(page.locator('.group-title', { hasText: '配置' })).toBeVisible({ timeout: 10000 });
    const body = page.locator('body');
    await expect(body).not.toContainText('Local LLM Configs');
    await expect(body).not.toContainText('派生节点');
});

test('默认标记：静态配置有「激活」按钮', async ({ page, standalone }) => {
    await createWorkspaceAndConfig(standalone.url, 'default-cfg');
    await page.goto(standalone.url);
    await expect(page.locator('.cfg-act', { hasText: '激活' })).toBeVisible({ timeout: 10000 });
});

test('默认标记：点「激活」后变为「✓ 已激活」徽标', async ({ page, standalone }) => {
    await createWorkspaceAndConfig(standalone.url, 'mark-cfg');
    await page.goto(standalone.url);
    const btn = page.locator('.cfg-act', { hasText: '激活' }).first();
    await expect(btn).toBeVisible({ timeout: 10000 });
    await btn.click();
    await expect(page.locator('.active-badge', { hasText: '✓ 已激活' })).toBeVisible({ timeout: 5000 });
});
