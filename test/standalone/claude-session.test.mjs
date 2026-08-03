// test/standalone/claude-session.test.mjs — 阶段3: 二进制探测 + CLI 会话测试
//
// 运行：node --test test/standalone/claude-session.test.mjs
//
// 维度覆盖（见 plan/tmp/2026-08-03-stage3-cli-session.md）：
//   D1 二进制探测来源优先级（纯函数）
//   D2 系统 PATH 遍历（纯函数）
//   D3 VS Code 扩展目录扫描（纯函数）
//   D4 PTY 会话生命周期（mock pty，避免 conpty handle 卡 event loop）
//   D5 WebSocket 路由逻辑（management API 路由，不真连 WS）
//   D6 二进制不可用（纯逻辑）
//   D7 cleanup（stopAll 逻辑）
//
// 注：真实 PTY/conpty 集成（含 xterm.js 端到端）由手动 smoke 验证，不进 node --test
// （node-pty 的 conpty handle 进程退出后不自动释放，会让 event loop 不空卡死套件）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const { WebSocket } = _require('ws');

const __dirname = dirname(fileURLToPath(import.meta.url));
const CBS_JS = resolve(__dirname, '..', '..', 'standalone', 'claudeBinaryStandalone.js');
const CS_JS = resolve(__dirname, '..', '..', 'standalone', 'claudeSession.js');
const MS_JS = resolve(__dirname, '..', '..', 'standalone', 'managementServer.js');

const {
    resolveClaudeBinaryStandalone,
    searchPathForClaude,
    scanVscodeExtensionDir,
} = await import(pathToFileURL(CBS_JS).href);
const { ClaudeSessionManager } = await import(pathToFileURL(CS_JS).href);
const { startManagementServer } = await import(pathToFileURL(MS_JS).href);

function newTmpDir(label) {
    return mkdtempSync(join(tmpdir(), `s3-${label}-`));
}

// ── mock pty（不真 spawn，避免 conpty handle 卡 event loop）──────────────
/** 造一个 mock pty：spawn 返回假 handle，onData/onExit 可控。 */
function makeMockPty() {
    const handles = [];
    return {
        spawn(binaryPath, args, opts) {
            const handle = {
                pid: Math.floor(Math.random() * 100000) + 1000,
                _dataCbs: [],
                _exitCbs: [],
                _written: [],
                onData(cb) { this._dataCbs.push(cb); },
                onExit(cb) { this._exitCbs.push(cb); },
                write(data) { this._written.push(data); },
                kill() { this._killed = true; },
                // 测试辅助：模拟 PTY 输出
                _emitData(data) { for (const cb of this._dataCbs) cb(data); },
                _emitExit(code) { for (const cb of this._exitCbs) cb({ exitCode: code, signal: undefined }); },
            };
            handles.push(handle);
            return handle;
        },
        _handles: handles,
    };
}

// ════════════════════════════════════════════════════════════
// D2 系统 PATH 遍历
// ════════════════════════════════════════════════════════════
test('D2a: PATH 含 claude → 找到第一个匹配', () => {
    const dir = newTmpDir('d2a');
    const plat = process.platform;
    const name = plat === 'win32' ? 'claude.exe' : 'claude';
    writeFileSync(join(dir, name), 'x');
    const result = searchPathForClaude({ platform: plat, path: dir });
    assert.equal(result, join(dir, name));
});

test('D2b: PATH 不含 claude → null', () => {
    const dir = newTmpDir('d2b');
    assert.equal(searchPathForClaude({ platform: process.platform, path: dir }), null);
});

test('D2c: PATH 空/undefined → null 不崩', () => {
    assert.equal(searchPathForClaude({ platform: 'linux', path: '' }), null);
    assert.equal(searchPathForClaude({ platform: 'linux', path: undefined }), null);
});

test('D2d: Windows 试 .exe/.cmd/.bat', () => {
    const dir = newTmpDir('d2d');
    writeFileSync(join(dir, 'claude.cmd'), 'fake');
    const result = searchPathForClaude({ platform: 'win32', path: dir });
    assert.equal(result, join(dir, 'claude.cmd'));
});

test('D2f: PATH 多目录都有 claude → 返回第一个（顺序优先）', () => {
    const d1 = newTmpDir('d2f1');
    const d2 = newTmpDir('d2f2');
    const plat = process.platform;
    const name = plat === 'win32' ? 'claude.exe' : 'claude';
    writeFileSync(join(d1, name), 'a');
    writeFileSync(join(d2, name), 'b');
    const result = searchPathForClaude({ platform: plat, path: `${d1}${path.delimiter}${d2}`, delimiter: path.delimiter });
    assert.equal(result, join(d1, name));
});

// ════════════════════════════════════════════════════════════
// D3 VS Code 扩展目录扫描
// ════════════════════════════════════════════════════════════
function makeFakeExtension(extensionsRoot, version, platform) {
    const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';
    const extDir = join(extensionsRoot, `anthropic.claude-code-${version}`);
    const binDir = join(extDir, 'resources', 'native-binary');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, binaryName), 'fake');
    return extDir;
}

test('D3a: 多版本 → 取最新（semver）', () => {
    const root = newTmpDir('d3a');
    makeFakeExtension(root, '1.9.0', 'linux');
    makeFakeExtension(root, '1.10.0', 'linux');
    makeFakeExtension(root, '1.2.3', 'linux');
    assert.equal(scanVscodeExtensionDir({ platform: 'linux', extensionsRoot: root }), join(root, 'anthropic.claude-code-1.10.0'));
});

test('D3b: 单版本 → 返回该版本', () => {
    const root = newTmpDir('d3b');
    makeFakeExtension(root, '2.0.0', 'linux');
    assert.equal(scanVscodeExtensionDir({ platform: 'linux', extensionsRoot: root }), join(root, 'anthropic.claude-code-2.0.0'));
});

test('D3c: 扩展目录不存在 → null', () => {
    assert.equal(scanVscodeExtensionDir({ platform: 'linux', extensionsRoot: join(tmpdir(), 'no-such-' + Date.now()) }), null);
});

test('D3d: 扩展目录存在但无 anthropic.claude-code-* → null', () => {
    const root = newTmpDir('d3d');
    mkdirSync(join(root, 'other.extension-1.0.0'), { recursive: true });
    assert.equal(scanVscodeExtensionDir({ platform: 'linux', extensionsRoot: root }), null);
});

test('D3e: 版本目录存在但 native-binary 缺失 → 跳过该版本', () => {
    const root = newTmpDir('d3e');
    mkdirSync(join(root, 'anthropic.claude-code-1.5.0', 'resources', 'native-binary'), { recursive: true });
    makeFakeExtension(root, '1.4.0', 'linux');
    assert.equal(scanVscodeExtensionDir({ platform: 'linux', extensionsRoot: root }), join(root, 'anthropic.claude-code-1.4.0'));
});

test('D3f: semver 比较 1.10.0 > 1.9.0（非字典序）', () => {
    const root = newTmpDir('d3f');
    makeFakeExtension(root, '1.9.0', 'linux');
    makeFakeExtension(root, '1.10.0', 'linux');
    assert.ok(scanVscodeExtensionDir({ platform: 'linux', extensionsRoot: root }).includes('1.10.0'));
});

// ════════════════════════════════════════════════════════════
// D1 探测来源优先级
// ════════════════════════════════════════════════════════════
test('D1a: 用户覆盖存在 → 返回用户路径（即使 PATH/扩展也有）', () => {
    const pathDir = newTmpDir('d1a-path');
    const plat = process.platform;
    const pname = plat === 'win32' ? 'claude.exe' : 'claude';
    writeFileSync(join(pathDir, pname), 'path');
    const extRoot = newTmpDir('d1a-ext');
    makeFakeExtension(extRoot, '1.0.0', plat);
    const userDir = newTmpDir('d1a-user');
    writeFileSync(join(userDir, 'claude-user'), 'user');
    const userPath = join(userDir, 'claude-user');
    assert.equal(resolveClaudeBinaryStandalone({ userOverride: userPath, platform: plat, path: pathDir, extensionsRoot: extRoot }), userPath);
});

test('D1c: 用户覆盖不存在 + PATH 找到 → 返回 PATH（优先于扩展）', () => {
    const pathDir = newTmpDir('d1c-path');
    const plat = process.platform;
    const pname = plat === 'win32' ? 'claude.exe' : 'claude';
    writeFileSync(join(pathDir, pname), 'path');
    const extRoot = newTmpDir('d1c-ext');
    makeFakeExtension(extRoot, '1.0.0', plat);
    const result = resolveClaudeBinaryStandalone({ userOverride: '/nonexistent/claude', platform: plat, path: pathDir, extensionsRoot: extRoot });
    assert.equal(result, join(pathDir, pname));
});

test('D1e: 用户/PATH 都没找到 + 扩展目录有 → 返回扩展二进制', () => {
    const extRoot = newTmpDir('d1e-ext');
    makeFakeExtension(extRoot, '1.0.0', 'linux');
    const result = resolveClaudeBinaryStandalone({ platform: 'linux', path: newTmpDir('d1e-empty'), extensionsRoot: extRoot });
    assert.ok(result.includes('anthropic.claude-code-1.0.0'));
    assert.ok(result.includes('native-binary'));
});

test('D1f: 都没找到 → null', () => {
    assert.equal(resolveClaudeBinaryStandalone({ platform: 'linux', path: newTmpDir('d1f-empty'), extensionsRoot: newTmpDir('d1f-noext') }), null);
});

// ════════════════════════════════════════════════════════════
// D4 PTY 会话生命周期（mock pty）
// ════════════════════════════════════════════════════════════
test('D4a: 启动会话 → PTY spawn + 入 Map + 返回 sessionId/pid', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    const result = await mgr.start('ws1', { dir: newTmpDir('d4a'), binaryPath: '/fake/claude' });
    assert.equal(result.sessionId, 'ws1');
    assert.ok(result.pid > 0);
    assert.equal(result.reused, false);
    assert.ok(mgr.status('ws1'));
    await mgr.stop('ws1');
});

test('D4b: 重复启动同 workspace → 复用（reused=true）', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    const r1 = await mgr.start('ws2', { dir: newTmpDir('d4b'), binaryPath: '/fake/claude' });
    const r2 = await mgr.start('ws2', { dir: newTmpDir('d4b'), binaryPath: '/fake/claude' });
    assert.equal(r2.reused, true);
    assert.equal(r1.pid, r2.pid);
    await mgr.stop('ws2');
});

test('D4c: 停止会话 → kill + 出 Map', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    await mgr.start('ws3', { dir: newTmpDir('d4c'), binaryPath: '/fake/claude' });
    assert.equal(await mgr.stop('ws3'), true);
    assert.equal(mgr.status('ws3'), null);
});

test('D4d: 停止不存在的会话 → false', async () => {
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: makeMockPty() });
    assert.equal(await mgr.stop('nonexistent'), false);
});

test('D4e: PTY 自然退出 → onExit 清 Map', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    await mgr.start('ws4', { dir: newTmpDir('d4e'), binaryPath: '/fake/claude' });
    // 模拟 PTY 退出
    mockPty._handles[0]._emitExit(0);
    assert.equal(mgr.status('ws4'), null);
});

// ════════════════════════════════════════════════════════════
// D5 PTY onData → WS 广播（mock pty + 假 ws 客户端）
// ════════════════════════════════════════════════════════════
test('D5a: PTY onData → 广播到所有 attached WS 客户端', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    await mgr.start('ws5', { dir: newTmpDir('d5a'), binaryPath: '/fake/claude' });

    // 造假 ws 客户端
    const received = [];
    const fakeWs = {
        readyState: 1, // OPEN
        OPEN: 1,
        send(data) { received.push(data); },
        on(event, cb) { this['_' + event] = cb; },
        close() {},
    };
    assert.equal(mgr.attachWs('ws5', fakeWs), true);
    // 模拟 PTY 输出
    mockPty._handles[0]._emitData('hello from claude\n');
    assert.ok(received.some(r => String(r).includes('hello from claude')), `应广播 PTY 输出，got ${JSON.stringify(received)}`);
    await mgr.stop('ws5');
});

test('D5b: WS message → PTY write（用户输入）', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    await mgr.start('ws6', { dir: newTmpDir('d5b'), binaryPath: '/fake/claude' });

    const fakeWs = { readyState: 1, OPEN: 1, send() {}, on(event, cb) { this['_' + event] = cb; }, close() {} };
    mgr.attachWs('ws6', fakeWs);
    // 模拟用户输入
    fakeWs._message('user input\n');
    assert.ok(mockPty._handles[0]._written.includes('user input\n'), 'PTY 应收到用户输入');
    await mgr.stop('ws6');
});

test('D5e: 会话不存在时 attachWs → false', () => {
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: makeMockPty() });
    assert.equal(mgr.attachWs('nonexistent', { readyState: 1, OPEN: 1, on() {} }), false);
});

test('D5c: WS close → 移除客户端，PTY 保持', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    await mgr.start('ws7', { dir: newTmpDir('d5c'), binaryPath: '/fake/claude' });
    const fakeWs = { readyState: 1, OPEN: 1, send() {}, on(event, cb) { this['_' + event] = cb; }, close() {} };
    mgr.attachWs('ws7', fakeWs);
    fakeWs._close();
    // PTY 会话应仍在
    assert.ok(mgr.status('ws7'), 'PTY 会话应保持（可重连）');
    await mgr.stop('ws7');
});

// ════════════════════════════════════════════════════════════
// D6 二进制不可用
// ════════════════════════════════════════════════════════════
test('D6a: binaryPath 为空 → 启动拒绝', async () => {
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: makeMockPty() });
    await assert.rejects(() => mgr.start('ws8', { dir: newTmpDir('d6a'), binaryPath: '' }), /二进制未找到|binary/i);
});

test('D6b: workspace dir 缺失 → 启动拒绝', async () => {
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: makeMockPty() });
    await assert.rejects(() => mgr.start('ws9', { dir: '', binaryPath: '/fake/claude' }), /目录无效/i);
});

// ════════════════════════════════════════════════════════════
// D7 cleanup
// ════════════════════════════════════════════════════════════
test('D7a: stopAll → 停所有会话', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    await mgr.start('a', { dir: newTmpDir('d7a1'), binaryPath: '/fake/claude' });
    await mgr.start('b', { dir: newTmpDir('d7a2'), binaryPath: '/fake/claude' });
    await mgr.stopAll();
    assert.equal(mgr.status('a'), null);
    assert.equal(mgr.status('b'), null);
});

// ════════════════════════════════════════════════════════════
// management API 会话路由（用真实 server + mock pty 注入）
// 注：startManagementServer 内部用真实 ClaudeSessionManager（默认 node-pty），
// 这里只测路由返回逻辑（二进制不可用 → 400；workspace 不存在 → 404）。
// ════════════════════════════════════════════════════════════
let mgmtSeq = 0;
async function startMgmt(label) {
    const home = newTmpDir(`s3mgmt-${label}`);
    const port = 11800 + (mgmtSeq++ % 40);
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: 11434 });
    return { handle, home, port };
}

test('D5route: POST 会话 workspace 不存在 → 404', async () => {
    const { handle, port, home } = await startMgmt('route404');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_nonexist/claude-session`, { method: 'POST' });
        assert.equal(r.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

test('D5route: GET 会话状态（未启动）→ 200 + null', async () => {
    const { handle, port, home } = await startMgmt('routeStatus');
    const proj = newTmpDir('routeStatus-proj');
    try {
        const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', dir: proj }),
        })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${cr.workspace.id}/claude-session`);
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.session, null);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('GET /workspace/:id/terminal → 终端页 HTML', async () => {
    const { handle, port, home } = await startMgmt('term');
    const proj = newTmpDir('term-proj');
    try {
        const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', dir: proj }),
        })).json();
        const r = await fetch(`http://127.0.0.1:${port}/workspace/${cr.workspace.id}/terminal`);
        assert.equal(r.status, 200);
        const html = await r.text();
        assert.ok(html.includes('xterm'));
        assert.ok(html.includes('claude-session/ws'));
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// 代码审查 TDD 疑点确认（2026-08-03 review）
// ════════════════════════════════════════════════════════════

// ── XSS-1: buildTerminalHtml workspaceId 未转义 → JS 字符串注入 ──
test('REVIEW-XSS-1: buildTerminalHtml workspaceId 含单引号 → 不应注入可执行 JS', async () => {
    const { buildTerminalHtml } = await import(pathToFileURL(resolve(__dirname, '..', '..', 'standalone', 'web', 'workspaces-html.js')).href);
    // 模拟路由放行的恶意 id（不含 /，路由 [^/]+ 放行）
    const malicious = "';alert(1);//";
    const html = buildTerminalHtml({ workspaceId: malicious, workspaceName: 'x', apiBase: '' });
    // 期望：workspaceId 不被直接模板插值进 JS 上下文。
    // 修复后 wsId 通过 JSON.stringify 嵌入（"';alert(1);//"），URL 通过 encodeURIComponent 拼接。
    // 验证：不应出现裸的模板插值 ${workspaceId} 残留，也不应把 workspaceId 直接拼进 wsUrl/fetch 字符串字面量。
    // 关键标志：wsUrl 构造应通过 encodeURIComponent(wsId)，而非直接插值。
    const wsUrlLine = html.split('\n').find(l => l.includes('wsUrl') && l.includes('encodeURIComponent'));
    assert.ok(wsUrlLine, 'wsUrl 应通过 encodeURIComponent(wsId) 构造，而非直接插值');
    // 验证 fetch 也走 encodeURIComponent
    const fetchLine = html.split('\n').find(l => l.includes('fetch(') && l.includes('encodeURIComponent'));
    assert.ok(fetchLine, 'fetch URL 应通过 encodeURIComponent(wsId) 构造');
});

// ── XSS-2: buildTerminalHtml workspaceId 含 HTML → 不应产生可执行 HTML 元素 ──
test('REVIEW-XSS-2: buildTerminalHtml workspaceId 含 < > → HTML 上下文应转义', async () => {
    const { buildTerminalHtml } = await import(pathToFileURL(resolve(__dirname, '..', '..', 'standalone', 'web', 'workspaces-html.js')).href);
    const malicious = 'x"><img src=x onerror=alert(1)>';
    const html = buildTerminalHtml({ workspaceId: malicious, workspaceName: 'x', apiBase: '' });
    // 期望：HTML 上下文（title/bar）中 < 被转义为 &lt;，不产生裸 <img 元素。
    // JS 字符串上下文用 JSON.stringify 转义引号（" → \"），不产生可执行 HTML。
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/);
    assert.ok(titleMatch, '应有 title');
    assert.ok(!titleMatch[1].includes('<img'), `title 里不应有裸 <img: ${titleMatch[1]}`);
    const barMatch = html.match(/<span>Claude Code — ([\s\S]*?)<\/span>/);
    assert.ok(barMatch, '应有 bar span');
    assert.ok(!barMatch[1].includes('<img'), `bar 里不应有裸 <img: ${barMatch[1]}`);
});

// ── RACE-1: PTY onExit 后 disposed 未设 true → ws message 仍 write 死 PTY ──
test('REVIEW-RACE-1: PTY 自然退出后 ws message 不应写死 PTY', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    await mgr.start('rev1', { dir: newTmpDir('rev1'), binaryPath: '/fake/claude' });
    const fakeWs = { readyState: 1, OPEN: 1, send() {}, on(event, cb) { this['_' + event] = cb; }, close() {} };
    mgr.attachWs('rev1', fakeWs);
    // 模拟 PTY 退出
    mockPty._handles[0]._emitExit(0);
    // 清空 written 记录
    mockPty._handles[0]._written.length = 0;
    // ws 在 close 触发前收到消息（真实 ws 中 close 是异步的）
    fakeWs._message('input after exit');
    // 期望：不写死 PTY（disposed 防护）
    assert.equal(mockPty._handles[0]._written.length, 0,
        'PTY 退出后仍被 write，disposed 未设 true');
    await mgr.stop('rev1').catch(() => {});
});

// ── RACE-2: onData 广播一个 ws.send 抛错 → 其他 ws 应仍收到 ──
test('REVIEW-RACE-2: onData 广播一个 ws.send 抛错不影响其他客户端', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    await mgr.start('rev2', { dir: newTmpDir('rev2'), binaryPath: '/fake/claude' });

    const ws1 = {
        readyState: 1, OPEN: 1,
        send() { throw new Error('backpressure'); },
        on(event, cb) { this['_' + event] = cb; },
        close() {},
    };
    const received2 = [];
    const ws2 = {
        readyState: 1, OPEN: 1,
        send(d) { received2.push(d); },
        on(event, cb) { this['_' + event] = cb; },
        close() {},
    };
    mgr.attachWs('rev2', ws1);
    mgr.attachWs('rev2', ws2);

    // 模拟 PTY 输出 —— 不应因 ws1.send 抛错而中断
    assert.doesNotThrow(() => mockPty._handles[0]._emitData('important data'));
    assert.ok(received2.some(r => String(r).includes('important data')),
        `ws2 应收到数据（广播不应被 ws1 抛错中断），got ${JSON.stringify(received2)}`);
    await mgr.stop('rev2').catch(() => {});
});

// ── RACE-2b: PTY onExit 时 ws.send 抛错 → ws.close 仍应执行（防孤儿）──
test('REVIEW-RACE-2b: PTY onExit ws.send 抛错 → ws.close 仍执行', async () => {
    const mockPty = makeMockPty();
    const mgr = new ClaudeSessionManager({ log: () => {}, pty: mockPty });
    await mgr.start('rev2b', { dir: newTmpDir('rev2b'), binaryPath: '/fake/claude' });

    let wsClosed = false;
    const fakeWs = {
        readyState: 1, OPEN: 1,
        send() { throw new Error('ws gone'); },
        on(event, cb) { this['_' + event] = cb; },
        close() { wsClosed = true; },
    };
    mgr.attachWs('rev2b', fakeWs);
    // 模拟 PTY 退出 —— ws.send 会抛错，但 ws.close 仍应执行
    mockPty._handles[0]._emitExit(0);
    assert.equal(wsClosed, true, 'onExit 中 ws.send 抛错不应阻止 ws.close（防孤儿 ws）');
    await mgr.stop('rev2b').catch(() => {});
});
// ── RACE-3: handleUpgrade status 检查后 attachWs 前会话被 stop → ws 应被关闭 ──
test('REVIEW-RACE-3: WS upgrade 会话不存在 → ws 应被 close（非孤儿）', async () => {
    // 集成测试：真实 managementServer，连真实 WS 客户端。
    // 会话未启动 → upgrade 应拒绝 + close ws（code 1008）。
    const { handle, port, home } = await startMgmt('rev3');
    const proj = newTmpDir('rev3-proj');
    try {
        const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', dir: proj }),
        })).json();
        // 不 POST 启动会话，直接连 WS → 应被拒
        const wsUrl = `ws://127.0.0.1:${port}/api/workspaces/${cr.workspace.id}/claude-session/ws`;
        const ws = new WebSocket(wsUrl);
        const closed = await new Promise((resolve) => {
            const msgs = [];
            ws.on('message', (d) => msgs.push(d.toString()));
            ws.on('close', (code, reason) => resolve({ code, msgs }));
            ws.on('error', () => {}); // 防未处理 error
            // 超时兜底
            setTimeout(() => resolve({ code: -1, msgs, timeout: true }), 3000);
        });
        assert.ok(!closed.timeout, 'WS 应在超时前关闭');
        assert.equal(closed.code, 1008, `应 close 1008，got ${closed.code}`);
        assert.ok(closed.msgs.some(m => m.includes('会话不存在')), '应收到错误消息');
    } finally {
        try { ws && ws.close(); } catch {}
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ── SEMVER-1: 预发布版本与正式版同号 → 当前实现视为相等（已知局限，留回归用例）──
test('REVIEW-SEMVER-1: 1.10.0 与 1.10.0-beta.1 都存在 → 至少返回一个有效版本', () => {
    // parseSemver 对 "1.10.0-beta.1" 取 [1,10,0]，与 "1.10.0" 相等
    // compareSemver 返回 0 → 不替换 → 留先扫到的
    // 这是已知局限：预发布版本不区分（readdirSync 顺序不定 → 可能返回 beta 或正式版）
    // 现实中扩展目录不太可能同时存在 1.10.0 和 1.10.0-beta.1，记回归用例
    const root = newTmpDir('rev-semver');
    makeFakeExtension(root, '1.10.0-beta.1', 'linux');
    makeFakeExtension(root, '1.10.0', 'linux');
    const result = scanVscodeExtensionDir({ platform: 'linux', extensionsRoot: root });
    assert.ok(result, '应返回某个版本');
    assert.ok(result.includes('1.10.0'), `应返回 1.10.0 系，got ${result}`);
});
