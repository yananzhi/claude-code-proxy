// test/standalone/tree-html.test.mjs — 树状管理页 HTML 结构测试
//
// 运行：node --test test/standalone/tree-html.test.mjs
//
// 覆盖：
//   T1 buildWorkspacesHtml 含树结构 + 终端 fetch 序列 + 新建终端入口
//   T2 XSS：用户数据不进 innerHTML
//   T3 buildTerminalHtml 用 terminalId + 无 POST-start

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_JS = resolve(__dirname, '..', '..', 'standalone', 'web', 'workspaces-html.js');
const { buildWorkspacesHtml, buildTerminalHtml } = await import(pathToFileURL(HTML_JS).href);

// ════════════════════════════════════════════════════════════
// T1 树状结构 + 终端路由
// ════════════════════════════════════════════════════════════
test('T1a: HTML 含树容器结构', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('class="tree"') || html.includes('id="list"'), '应有树/list 容器');
});

test('T1b: fetch normal 终端列表（/api/workspaces/:id/terminals）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('/terminals'), '应 fetch 终端列表');
    assert.ok(html.match(/\/api\/workspaces\/.*\/terminals/), '应有 /api/workspaces/:id/terminals fetch');
});

test('T1c: 新建终端 POST /api/workspaces/:id/terminals', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.match(/\/api\/workspaces\/.*\/terminals.*method.*POST/s) || html.includes("method: 'POST'"),
        '应有 POST 新建终端');
});

test('T1d: 派生配置终端入口（POST /api/workspaces/:id/configs/:cfgId/terminals）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.match(/\/configs\/.*\/terminals/), '应有 /configs/:cfgId/terminals 入口');
});

test('T1g: normal 配置有「+ 派生」入口（newDerivedConfig + next-alias-id）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('newDerivedConfig'), '应有 newDerivedConfig 函数');
    assert.ok(html.includes('+ 派生'), 'normal 配置行应有「+ 派生」按钮');
    assert.ok(html.includes('/next-alias-id'), '建派生应取 next-alias-id');
});

test('T1e: 不含旧 /workspace/:id/terminal 链接', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(!html.match(/\/workspace\/.*\/terminal/), '不应残留旧 /workspace/:id/terminal 链接');
});

test('T1f: 终端节点打开走 /terminal/:tid', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('/terminal/'), '终端节点应链接到 /terminal/:tid');
});

// ════════════════════════════════════════════════════════════
// T2 XSS：用户数据不进 innerHTML
// ════════════════════════════════════════════════════════════
test('T2a: buildWorkspacesHtml 用户数据不直接进 innerHTML（用 textContent）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // 检查 JS 源：不应有 innerHTML = 拼接用户数据的模式（如 ws.name 直接拼）
    // 允许 innerHTML 设静态模板字符串（无用户数据），但不允许 innerHTML 拼接变量
    const lines = html.split('\n');
    const bad = lines.find(l => /innerHTML\s*=\s*[^'"`]/.test(l) && /innerHTML\s*=\s*[a-zA-Z_]/.test(l)
        && !/innerHTML\s*=\s*['"`]/.test(l));
    assert.ok(!bad, `不应有 innerHTML = 变量（应 textContent）: ${bad}`);
});

// ════════════════════════════════════════════════════════════
// T3 buildTerminalHtml 用 terminalId + 无 POST-start
// ════════════════════════════════════════════════════════════
test('T3a: buildTerminalHtml WS URL 指向 /api/terminals/:tid/ws', () => {
    const html = buildTerminalHtml({ terminalId: 't_abc', apiBase: '' });
    assert.ok(html.includes('/api/terminals/'), 'WS URL 应含 /api/terminals/');
    assert.ok(html.includes('/ws'), 'WS URL 应含 /ws');
});

test('T3b: buildTerminalHtml 无 POST-start（终端已存在，直接连 WS）', () => {
    const html = buildTerminalHtml({ terminalId: 't_abc', apiBase: '' });
    assert.ok(!html.includes("method: 'POST'") && !html.includes('method: "POST"'),
        '不应有 POST-start（终端已存在）');
    assert.ok(html.includes('WebSocket'), '应直接 new WebSocket 连接');
});

test('T3c: buildTerminalHtml terminalId 通过 encodeURIComponent 入 URL', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    const wsUrlLine = html.split('\n').find(l => l.includes('wsUrl') || (l.includes('/api/terminals/') && l.includes('ws')));
    assert.ok(wsUrlLine, '应有 wsUrl 构造');
    assert.ok(wsUrlLine.includes('encodeURIComponent'), 'wsUrl 应通过 encodeURIComponent(tid) 构造');
});
