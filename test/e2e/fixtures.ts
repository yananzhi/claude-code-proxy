// test/e2e/fixtures.js — standalone e2e 测试共享脚手架
//
// 每个 e2e 测试通过 `standalone` fixture 起一个独立 standalone 后端实例：
//   - 临时 CCP_HOME（mkdtemp，测后清理）
//   - 端口避开保留段 + 现有测试段（用 11700 段）
//   - 直接 import launchStandalone（ESM），拿 mgmt.port + stop()
//   - teardown 优雅关闭 + rm 临时目录
//
// 不 spawn 独立 node 子进程：launchStandalone 本身就是 in-proc 起 server.js 子进程，
// 再套一层 node 进程没必要，且拿端口更直接。
//
// 设计依据：docs/standalone管理界面重设计.md 第 8.1 节。
import { test as base } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = resolve(__dirname, '..', '..', 'standalone', 'main.js');

// e2e 专用端口段：11700+，避开：
//   - 11434（VS Code 插件默认代理）/ 11444（run-dev）/ 11544（run-dev mgmt）
//   - 11600-11620（test/standalone 套件占用）
//   - 8791-8796（mock 套件占用）
let portCounter = 11700;
function nextPort() {
    return portCounter++; // 每个 fixture 实例递增，防同测试内多实例撞端口
}

/** standalone 后端实例 + management URL。测后自动 teardown。 */
export const test = base.extend<{ standalone: { url: string; proxyPort: number; mgmtPort: number; home: string; stop: () => Promise<void> } }>({
    standalone: async ({}, use) => {
        // 运行时动态 import（避免顶层 await 触发 CJS require 的 TLA 限制）
        const mod = await import(pathToFileURL(MAIN_JS).href);
        const { launchStandalone, ensureConfig } = mod as { launchStandalone: Function; ensureConfig: Function };

        const home = mkdtempSync(join(tmpdir(), `e2e-standalone-`));
        // 先 ensureConfig 建默认 config，再改 listenPort 为唯一端口
        // （launchStandalone 内部 ensureConfig 已存在→不覆盖，复用改过的端口）
        const proxyPort = nextPort();
        const mgmtPort = proxyPort + 100;
        const ensured = await ensureConfig(home);
        const cfg = JSON.parse(readFileSync(ensured.configPath, 'utf8'));
        cfg.proxy.listenPort = proxyPort;
        writeFileSync(ensured.configPath, JSON.stringify(cfg), 'utf8');

        const { mgmt, stop } = await launchStandalone({
            homeDir: home,
            mgmtPort,
            log: () => {}, // 静默，不污染测试输出
        });

        if (!mgmt) {
            await stop();
            rmSync(home, { recursive: true, force: true });
            throw new Error(`management server 未启动（proxyPort=${proxyPort}）`);
        }

        const url = `http://127.0.0.1:${mgmt.port}`;
        await use({ url, proxyPort, mgmtPort: mgmt.port, home, stop });

        // teardown
        try { await stop(); } catch {}
        // 给子进程一点时间释放端口
        await new Promise(r => setTimeout(r, 200));
        rmSync(home, { recursive: true, force: true });
    },
});

export { expect } from '@playwright/test';
