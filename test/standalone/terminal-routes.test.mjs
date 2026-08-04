// test/standalone/terminal-routes.test.mjs — 终端路由集成测试
//
// 运行：node --test test/standalone/terminal-routes.test.mjs
//
// 覆盖：
//   R1 POST /api/workspaces/:id/terminals 创建 normal 终端（基于 active config）
//   R2 POST /api/workspaces/:id/configs/:cfgId/terminals 创建 derived 终端
//   R3 DELETE /api/terminals/:tid
//   R4 GET /api/workspaces/:id/terminals + /api/workspaces/:id/configs/:cfgId/terminals 列表
//   R5 activate 时存活终端警告
//
// 用 mock pty（注入 sessionPty），不真 spawn。代理用 mock（proxyPort 指向不可达端口，derived/proxy 路径会 502，
// 故 derived 测试用 direct-derived 或 mock proxy——这里 derived 用 buildTerminalEnv 的真实代理转发，
// 测试只验证路由逻辑 + 非 proxy 路径；derived proxy 路径在 terminal-env.test.mjs 已覆盖 env 构建）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MS_JS = resolve(__dirname, '..', '..', 'standalone', 'managementServer.js');
const { startManagementServer } = await import(pathToFileURL(MS_JS).href);

function newTmpDir(label) {
    return mkdtempSync(join(tmpdir(), `tr-${label}-`));
}

function makeMockPty() {
    const handles = [];
    return {
        spawn(binaryPath, args, opts) {
            const handle = {
                pid: Math.floor(Math.random() * 100000) + 1000,
                _dataCbs: [], _exitCbs: [], _written: [],
                onData(cb) { this._dataCbs.push(cb); },
                onExit(cb) { this._exitCbs.push(cb); },
                write(data) { this._written.push(data); },
                kill() { this._killed = true; },
                _emitData(d) { for (const cb of this._dataCbs) cb(d); },
                _emitExit(c) { for (const cb of this._exitCbs) cb({ exitCode: c, signal: undefined }); },
            };
            handles.push(handle);
            return handle;
        },
        _handles: handles,
    };
}

let seq = 0;
async function startMgmt(label) {
    const home = newTmpDir(`mgmt-${label}`);
    const port = 11900 + (seq++ % 40);
    const handle = await startManagementServer({
        homeDir: home, port, proxyPort: 11434,
        sessionPty: makeMockPty(),
    });
    return { handle, home, port };
}

function directContent() {
    return JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://up.test', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'm' },
    });
}

async function createWsAndDirectConfig(port, label) {
    const proj = newTmpDir(`${label}-proj`);
    const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'p', dir: proj }),
    })).json();
    const cc = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${cr.workspace.id}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'cfg', content: directContent(), mode: 'direct' }),
    })).json();
    return { proj, wsId: cr.workspace.id, cfgId: cc.config.id };
}

// ════════════════════════════════════════════════════════════
// R1 创建 normal 终端
// ════════════════════════════════════════════════════════════
test('R1a: 无 active config → 400', async () => {
    const { handle, port, home } = await startMgmt('r1a');
    const { proj, wsId } = await createWsAndDirectConfig(port, 'r1a');
    try {
        // 不 activate，直接开终端
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 400);
        const d = await r.json();
        assert.match(d.error, /active/i);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R1b: activate direct config 后开终端 → 201', async () => {
    const { handle, port, home } = await startMgmt('r1b');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r1b');
    try {
        // activate
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        // 开终端
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 201);
        const d = await r.json();
        assert.ok(d.terminalId);
        assert.ok(d.pid > 0);
        assert.equal(d.kind, 'normal');
        assert.equal(d.startedConfigName, 'cfg');
        assert.equal(d.configId, cfgId);
        // 清理
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R2 创建 derived 终端（需代理，proxyPort 11434 不可达 → 502）
// ════════════════════════════════════════════════════════════
test('R2a: 普通配置走 config 级终端入口 → 400（引导用 workspace 级）', async () => {
    const { handle, port, home } = await startMgmt('r2a');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r2a');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 400);
        const d = await r.json();
        assert.match(d.error, /普通配置|workspace/i);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R2b: config 不存在 → 404', async () => {
    const { handle, port, home } = await startMgmt('r2b');
    const { proj, wsId } = await createWsAndDirectConfig(port, 'r2b');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/cfg_nonexist/terminals`, { method: 'POST' });
        assert.equal(r.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R3 DELETE 终端
// ════════════════════════════════════════════════════════════
test('R3a: DELETE 不存在的终端 → 200 stopped=false', async () => {
    const { handle, port, home } = await startMgmt('r3a');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/terminals/t_nonexist`, { method: 'DELETE' });
        assert.equal(r.status, 200);
        const d = await r.json();
        assert.equal(d.stopped, false);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R4 列表
// ════════════════════════════════════════════════════════════
test('R4a: 开两个 normal 终端 → listByWorkspace 返回 2', async () => {
    const { handle, port, home } = await startMgmt('r4a');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r4a');
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        const t1 = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' })).json();
        const t2 = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`);
        const d = await r.json();
        assert.equal(d.terminals.length, 2);
        assert.ok(d.terminals.every(t => t.workspaceId === wsId));
        // 清理
        await fetch(`http://127.0.0.1:${port}/api/terminals/${t1.terminalId}`, { method: 'DELETE' });
        await fetch(`http://127.0.0.1:${port}/api/terminals/${t2.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R5 activate 存活终端警告
// ════════════════════════════════════════════════════════════
test('R5a: 有存活终端时 activate → 返回 warning', async () => {
    const { handle, port, home } = await startMgmt('r5a');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r5a');
    try {
        // activate + 开终端
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        const t = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' })).json();
        // 再次 activate 同配置 → 应有 warning
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        const d = await r.json();
        assert.ok(d.warning, '有存活终端时 activate 应返回 warning');
        assert.match(d.warning, /存活终端|受影响|resume/i);
        await fetch(`http://127.0.0.1:${port}/api/terminals/${t.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R5b: 无存活终端时 activate → 无 warning', async () => {
    const { handle, port, home } = await startMgmt('r5b');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r5b');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        const d = await r.json();
        assert.equal(d.warning, undefined);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});
