// playwright.config.ts — standalone 管理界面 e2e 测试配置
//
// 范围：只测 standalone 管理界面（http://127.0.0.1:<mgmtPort>/）的用户可见行为。
// 不进现有 node --test 全量命令，单独 `npm run test:e2e`。
//
// 设计依据：docs/standalone管理界面重设计.md 第 8 节。
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './test/e2e',
    fullyParallel: false,
    // 串行：每个测试自己起 standalone 子进程占用端口，并发会端口抢占
    // （与现有 node --test --test-concurrency=1 约定一致）
    workers: 1,
    retries: 0,
    reporter: 'list',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    use: {
        baseURL: 'http://127.0.0.1', // 实际端口由 fixture 注入；测试里用 page.goto(fixture.url)
        trace: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
