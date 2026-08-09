// test/e2e/xterm-shift-enter.spec.ts — xterm Shift+Enter 换行回归测试
//
// 锁定 2026-08-09 修复的 bug：attachCustomKeyEventHandler 对 Shift+Enter 仅 return false
// 时，xterm 5.3.0 不调 preventDefault，浏览器后续 keypress/input 会让 '\r' 经 onData
// 泄漏（=提交）。修复=显式 preventDefault+stopPropagation。
//
// 此测试不起 standalone 后端、不起 PTY——只用真实 xterm 5.3.0 vendor + 复刻 workspaces-html.js
// 里的 handler，用 Playwright 真实键盘事件驱动，断言 onData 的输出契约：
//   - plain Enter     → onData 收到 '\r'（提交，不变）
//   - Shift+Enter     → ws.send 路径发 '\n'，且 onData 不泄漏 '\r'
//   - Ctrl+J          → onData 收到 '\n'（换行，不变）
//
// 这样既不依赖 PTY（CI 稳定），又覆盖了真实浏览器+xterm 的事件链（单测覆盖不到的部分）。
import { test, expect } from './fixtures.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(__dirname, '..', '..', 'standalone', 'web', 'vendor');
const XTERM_JS = readFileSync(resolve(VENDOR, 'xterm.min.js'), 'utf8');
const XTERM_CSS = readFileSync(resolve(VENDOR, 'xterm.css'), 'utf8');

// 复刻 workspaces-html.js 里 buildTerminalHtml 的 handler（修复后版本）。
const HANDLER_SRC = `
window.__CCP_NEWLINE_SEQ = '\\n';
var onDataChunks = [];
var wsSent = [];
var term = new Terminal({ cursorBlink: true });
term.open(document.getElementById('terminal'));
term.attachCustomKeyEventHandler(function (e) {
  if (e.type !== 'keydown') return true;
  if (e.keyCode === 13 && e.shiftKey) {
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    // 模拟 ws.send（真实前端发到 PTY；这里记录到 wsSent）
    wsSent.push(window.__CCP_NEWLINE_SEQ);
    return false;
  }
  if (e.keyCode === 86 && (e.ctrlKey || e.metaKey)) {
    return false;
  }
  return true;
});
term.onData(function (data) { onDataChunks.push(data); });
window.__getOnData = function () { return onDataChunks.slice(); };
window.__getWsSent = function () { return wsSent.slice(); };
window.__clear = function () { onDataChunks.length = 0; wsSent.length = 0; };
term.focus();
`;

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>${XTERM_CSS}</style>
<script>${XTERM_JS}</script>
</head>
<body>
<div id="terminal"></div>
<script>${HANDLER_SRC}</script>
</body></html>`;

test.describe('xterm Shift+Enter 换行（回归 2026-08-09）', () => {
    let server: any;
    let url: string;

    test.beforeAll(async () => {
        server = createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(HTML);
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;
        url = `http://127.0.0.1:${port}/`;
    });

    test.afterAll(async () => {
        if (server) await new Promise<void>((r) => server.close(() => r()));
    });

    async function press(page: import('@playwright/test').Page, key: string) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => typeof window.__getOnData === 'function');
        await page.focus('#terminal textarea');
        await page.keyboard.press(key);
        await page.waitForTimeout(120);
        const onData = await page.evaluate(() => (window as any).__getOnData());
        const wsSent = await page.evaluate(() => (window as any).__getWsSent());
        return { onData, wsSent };
    }

    test('plain Enter → onData 收到 \\r（提交，不变）', async ({ page }) => {
        const { onData, wsSent } = await press(page, 'Enter');
        expect(onData).toEqual(['\r']);
        expect(wsSent).toEqual([]);
    });

    test('Shift+Enter → ws.send 发 \\n，onData 不泄漏 \\r（修复核心断言）', async ({ page }) => {
        const { onData, wsSent } = await press(page, 'Shift+Enter');
        // ws.send 路径发了换行序列
        expect(wsSent).toEqual(['\n']);
        // onData 绝不能含 '\r'（旧 bug：'\r' 泄漏=提交）
        expect(onData).not.toContain('\r');
        // onData 应为空（换行完全由 ws.send 承担，不经 xterm onData）
        expect(onData).toEqual([]);
    });

    test('Ctrl+J → onData 收到 \\n（换行，不经 handler）', async ({ page }) => {
        const { onData, wsSent } = await press(page, 'Control+j');
        expect(onData).toEqual(['\n']);
        expect(wsSent).toEqual([]);
    });
});
