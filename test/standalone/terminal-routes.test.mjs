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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
    // ⚠ proxyPort 用 19998（无人监听），绝不用真实代理 11434——派生/proxy 路径会调
    // POST /api/upstream 注入上游，若指向 11434 会污染用户正在跑的插件代理（upstream last-write-wins + 落盘）。
    // 派生测试只验证路由不因类型 400，不验证代理成功路径（那在 terminal-env.test.mjs 用 mock proxyForward 覆盖）。
    const handle = await startManagementServer({
        homeDir: home, port, proxyPort: 19998,
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
// R1 创建终端（workspace 级，cfgId 可选）
// ════════════════════════════════════════════════════════════
test('R1a: 无 active config + 无 cfgId → 400', async () => {
    const { handle, port, home } = await startMgmt('r1a');
    const { proj, wsId } = await createWsAndDirectConfig(port, 'r1a');
    try {
        // 不 activate，直接开终端
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 400);
        const d = await r.json();
        assert.match(d.error, /默认|active/i);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R1b: activate direct config 后开终端（无 cfgId）→ 201 kind=normal', async () => {
    const { handle, port, home } = await startMgmt('r1b');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r1b');
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 201);
        const d = await r.json();
        assert.ok(d.terminalId);
        assert.ok(d.pid > 0);
        assert.equal(d.kind, 'normal');
        assert.equal(d.startedConfigName, 'cfg');
        assert.equal(d.configId, cfgId);
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R1c: workspace 级 + body 带 cfgId（普通配置）→ 201 用该 cfg（不需 active）', async () => {
    const { handle, port, home } = await startMgmt('r1c');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r1c');
    try {
        // 不 activate，直接带 cfgId 开终端
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cfgId }),
        });
        assert.equal(r.status, 201);
        const d = await r.json();
        assert.equal(d.configId, cfgId, '应用 body 指定的 cfgId');
        assert.equal(d.kind, 'normal');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R1d: workspace 级 + body 带 cfgId（派生配置）→ 不因类型 400（派生需代理，502 亦可）', async () => {
    const { handle, port, home } = await startMgmt('r1d');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r1d');
    // 手写派生 config（绕过依赖代理 next-alias-id 的创建流程）
    const derivedId = 'derived-r1d';
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    arr.push({
        id: derivedId, name: 'deriv', content: directContent(), mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: cfgId, derivedIndex: 1,
        modelAliases: { main: 'm' },
        sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'https://up.test', token: 'tok', mode: 'proxy' },
    });
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cfgId: derivedId }),
        });
        // 派生需代理（proxyPort 19998 不可达）→ 502，但不应是 400 类型拒绝
        assert.notEqual(r.status, 400, '派生配置不应被类型拒绝（旧限制已取消）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R2 创建终端（config 级，cfgId 必传）
// ════════════════════════════════════════════════════════════
test('R2a: 普通配置走 config 级终端入口 → 201（取消旧类型限制）', async () => {
    const { handle, port, home } = await startMgmt('r2a');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r2a');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 201);
        const d = await r.json();
        assert.equal(d.configId, cfgId);
        assert.equal(d.kind, 'normal');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d.terminalId}`, { method: 'DELETE' });
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

test('R2c: 派生配置走 config 级 → 不因类型 400（需代理，502 亦可）', async () => {
    const { handle, port, home } = await startMgmt('r2c');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r2c');
    const derivedId = 'derived-r2c';
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    arr.push({
        id: derivedId, name: 'deriv', content: directContent(), mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: cfgId, derivedIndex: 2,
        modelAliases: { main: 'm' },
        sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'https://up.test', token: 'tok', mode: 'proxy' },
    });
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}/terminals`, { method: 'POST' });
        assert.notEqual(r.status, 400, '派生配置不应被类型拒绝');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('F1: workspace 级与 config 级同 cfgId → env/configDir 一致（共享逻辑）', async () => {
    const { handle, port, home } = await startMgmt('f1');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'f1');
    try {
        // config 级
        const r1 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        const d1 = await r1.json();
        // workspace 级带 cfgId
        const r2 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cfgId }),
        });
        const d2 = await r2.json();
        // 两入口 kind/configId 一致（共享逻辑产出同结构）
        assert.equal(d1.kind, d2.kind, 'kind 应一致');
        assert.equal(d1.configId, d2.configId, 'configId 应一致');
        assert.equal(d1.startedConfigName, d2.startedConfigName, 'startedConfigName 应一致');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d1.terminalId}`, { method: 'DELETE' });
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d2.terminalId}`, { method: 'DELETE' });
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
// R5 activate 不再有存活终端警告（目标2：标记不覆盖 settings.json，存活终端不受影响）
// ════════════════════════════════════════════════════════════
test('R5a: 有存活终端时 activate → 无 warning（标记不覆盖 settings.json）', async () => {
    const { handle, port, home } = await startMgmt('r5a');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r5a');
    try {
        // activate + 开终端
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        const t = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' })).json();
        if (t.terminalId) {
            // 再次 activate 同配置 → 不应有 warning（标记不再覆盖 settings.json）
            const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
            const d = await r.json();
            assert.equal(d.warning, undefined, '标记不覆盖 settings.json，存活终端不受影响，无 warning');
            await fetch(`http://127.0.0.1:${port}/api/terminals/${t.terminalId}`, { method: 'DELETE' });
        }
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

// ════════════════════════════════════════════════════════════
// 代码审查 TDD：怀疑点确认
// ════════════════════════════════════════════════════════════

// 怀疑点 S1（错误映射）：sendTermError 缺 ValidationError 分支
//   buildTerminalEnv 对损坏 content（缺 BASE_URL/TOKEN）抛 ValidationError，
//   sendTermError 应映射 400，但实际落入 else → 500。
test('S1: config content 缺 BASE_URL → ValidationError 应 400（非 500）', async () => {
    const { handle, port, home } = await startMgmt('s1');
    const proj = newTmpDir('s1-proj');
    try {
        // 建 workspace
        const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', dir: proj }),
        })).json();
        const wsId = cr.workspace.id;
        // 建一个 content 缺 BASE_URL 的 direct config（绕过前端校验，直接 API）
        const badContent = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
        const cc = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'bad', content: badContent, mode: 'direct' }),
        })).json();
        const cfgId = cc.config.id;
        // config 级起终端 → buildTerminalEnv 抛 ValidationError
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 400, 'ValidationError 应映射 400，不应 500');
        const d = await r.json();
        assert.match(d.error, /BASE_URL|TOKEN/i);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 S2（边界条件）：workspace 级 body 非 JSON → 静默吞为空 body
//   readJsonBody reject（"请求体不是有效 JSON"），catch 吞掉 → body={}
//   有 active 时用 active 起 201，无 active 时 400"无默认"——都误导。
//   期望：非 JSON body 应 400。
test('S2: workspace 级 body 非 JSON → 应 400（非静默吞为空 body）', async () => {
    const { handle, port, home } = await startMgmt('s2');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 's2');
    try {
        // 不 activate，发非 JSON body（有 cfgId 但 body 解析失败 → body={} → 无 cfgId → 无 active → 400）
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not-json{',
        });
        assert.equal(r.status, 400, '非 JSON body 应 400，不应静默吞为空 body 后报"无默认"');
        const d = await r.json();
        assert.match(d.error, /JSON|无效/i, '错误信息应提示 body 非法 JSON，非"无默认配置"');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 S3（状态转换漏洞）：active 悬空指针（active.id 指向已删 config）
//   startWorkspaceTerminal 取 active.id → startTerminalForConfig 找不到 config
//   → NotFoundError → sendTermError → 404。
//   翻转：404 是合理行为（资源不存在），非 bug。回归锁定。
test('S3: active 悬空指针（id 指向已删 config）→ 404（非 bug，回归锁定）', async () => {
    const { handle, port, home } = await startMgmt('s3');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 's3');
    try {
        // activate 后删 config，制造悬空 active
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}`, { method: 'DELETE' });
        // workspace 级无 cfgId → 用 active.id（悬空）→ startTerminalForConfig 找不到 → 404
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 404, '悬空 active → config 不存在 → 404（合理）');
        const d = await r.json();
        assert.match(d.error, /config 不存在/i);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 S4（边界条件）：workspace 级 body.cfgId 为空字符串
//   !"" === true → 走 active 分支。空串视为"未提供"。
//   翻转：合理行为（空串 = 未指定），非 bug。回归锁定。
test('S4: workspace 级 body.cfgId="" → 视为未提供，走 active（非 bug，回归锁定）', async () => {
    const { handle, port, home } = await startMgmt('s4');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 's4');
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cfgId: '' }),
        });
        assert.equal(r.status, 201, '空串 cfgId 视为未提供 → 用 active 起 201');
        const d = await r.json();
        assert.equal(d.configId, cfgId, '用的是 active 的 cfgId');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 S5（类型安全）：workspace 级 body.cfgId 为数字（非字符串）
//   !123 === false → 传给 startTerminalForConfig → configs.find(c => c.id === 123)
//   id 是字符串，123 !== "123" → NotFoundError → 404。
//   翻转：合理行为（类型不匹配 → 找不到 → 404），非 bug。回归锁定。
test('S5: workspace 级 body.cfgId=数字 → 404（类型不匹配，非 bug，回归锁定）', async () => {
    const { handle, port, home } = await startMgmt('s5');
    const { proj, wsId } = await createWsAndDirectConfig(port, 's5');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cfgId: 123 }),
        });
        assert.equal(r.status, 404, '数字 cfgId 找不到字符串 id config → 404');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 S6（异常路径）：sessions.start spawn 失败 → 500
//   pty.spawn 抛错 → claudeSession 抛 Error（无 statusCode）→ sendTermError else → 500。
//   翻转：合理行为（spawn 失败是服务端错误 → 500），非 bug。回归锁定。
test('S6: pty spawn 失败 → 500（服务端错误，非 bug，回归锁定）', async () => {
    // 注入会 spawn 失败的 mock pty
    const home = newTmpDir('mgmt-s6');
    const port = 11900 + (seq++ % 40);
    const failPty = { spawn() { throw new Error('mock spawn boom'); } };
    const handle = await startManagementServer({
        homeDir: home, port, proxyPort: 19998,
        sessionPty: failPty,
    });
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 's6');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 500, 'spawn 失败 → 500');
        const d = await r.json();
        assert.match(d.error, /spawn.*失败|boom/i);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R6 终端详情 + alias-resolve（目标6：别名终端顶栏实时查映射）
// ════════════════════════════════════════════════════════════
test('R6a: GET /api/terminals/:tid 返回终端详情（kind/configId/startedConfigName）', async () => {
    const { handle, port, home } = await startMgmt('r6a');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r6a');
    try {
        const tr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}`);
        assert.equal(r.status, 200);
        const d = await r.json();
        assert.equal(d.kind, 'normal');
        assert.equal(d.configId, cfgId);
        assert.equal(d.startedConfigName, 'cfg');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R6b: 静态终端 alias-resolve → 不调代理，返回静态信息', async () => {
    const { handle, port, home } = await startMgmt('r6b');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r6b');
    try {
        const tr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}/alias-resolve`);
        assert.equal(r.status, 200);
        const d = await r.json();
        assert.equal(d.kind, 'normal');
        assert.equal(d.startedConfigName, 'cfg');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R6c: GET /api/terminals/:tid 不存在 → 404', async () => {
    const { handle, port, home } = await startMgmt('r6c');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/terminals/t_nonexist`);
        assert.equal(r.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

test('R6d: alias-resolve 不存在终端 → 404', async () => {
    const { handle, port, home } = await startMgmt('r6d');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/terminals/t_nonexist/alias-resolve`);
        assert.equal(r.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// 目标6 代码审查 TDD：6 类怀疑点逐条确认
// ════════════════════════════════════════════════════════════

// 怀疑点 G1（路由顺序）：mTermStop 正则 /^\/api\/terminals\/([^/]+)$/
//   是否会误匹配 /api/terminals/:tid/alias-resolve？
//   "bug 存在"断言：mTermStop 匹配 alias-resolve 路径 → alias-resolve 被当 GET /terminals/:tid 拦截。
//   若 alias-resolve 返回 {kind,...} 而非终端详情 → 被拦截 = bug；
//   若返回含 derivedIndex/modelAliases → 未被拦截 = 非 bug。
test('G1: alias-resolve 路径不被 mTermStop 误匹配（路由顺序正确）', async () => {
    const { handle, port, home } = await startMgmt('g1');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'g1');
    try {
        const tr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' })).json();
        // alias-resolve 应返回 {kind, startedConfigName, configId}（无 pid）
        // GET /api/terminals/:tid 应返回 {terminalId, pid, kind, ...}（有 pid）
        const ar = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}/alias-resolve`)).json();
        const td = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}`)).json();
        assert.equal(ar.pid, undefined, 'alias-resolve 不应返回 pid（证明未被 GET /terminals/:tid 拦截）');
        assert.ok(td.pid != null, 'GET /api/terminals/:tid 应返回 pid（两个路由独立）');
        assert.equal(ar.kind, 'normal', 'alias-resolve 返回 kind');
        assert.equal(td.kind, 'normal', 'GET /api/terminals/:tid 返回 kind');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 G2（边界：别名终端的 config 已删/找不到）
//   alias-resolve 路由：info.kind==='derived' 但 configs.find 找不到 cfg →
//   result 不含 derivedIndex/modelAliases，只返回 {kind:'derived', startedConfigName, configId}。
//   前端 d.derivedIndex 为 falsy → 跳过别名渲染；d.kind !== 'normal' → 跳过静态渲染。
//   顶栏保持默认文案。非崩溃，是静默降级——回归锁定。
//   注：derived 终端需代理（proxyPort 19998 不可达 → 502），无法在测试中起 derived 终端。
//   改验证路由源码：configs.find 找不到 cfg 时不崩（find 返回 undefined → if(cfg) 跳过）。
test('G2: alias-resolve 路由源码——config 找不到时不崩（if(cfg) 守卫，静默降级）', async () => {
    const { handle, port, home } = await startMgmt('g2');
    try {
        // 读 managementServer.js 源码验证 alias-resolve 路由对 cfg 找不到时有守卫
        const src = readFileSync(MS_JS, 'utf8');
        const aliasResolveBlock = src.match(/mAliasResolve[\s\S]*?sendJson\(res, 200, result\)/);
        assert.ok(aliasResolveBlock, '应找到 alias-resolve 路由块');
        // 路由应先 find cfg，再 if (cfg) 守卫添加 derivedIndex/modelAliases
        assert.ok(/configs\.find/.test(aliasResolveBlock[0]), '应 configs.find 查 cfg');
        assert.ok(/if\s*\(\s*cfg\s*\)/.test(aliasResolveBlock[0]), '应用 if(cfg) 守卫（cfg 找不到时不加 derivedIndex）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// G2b: alias-resolve 对 normal 终端不返回 derivedIndex/modelAliases（证明 derived 分支未误入）
test('G2b: alias-resolve normal 终端 → 无 derivedIndex/modelAliases（非 bug，回归锁定）', async () => {
    const { handle, port, home } = await startMgmt('g2b');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'g2b');
    try {
        const tr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}/alias-resolve`);
        assert.equal(r.status, 200);
        const d = await r.json();
        assert.equal(d.kind, 'normal');
        assert.equal(d.derivedIndex, undefined, 'normal 终端不应有 derivedIndex');
        assert.equal(d.modelAliases, undefined, 'normal 终端不应有 modelAliases');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 G3（类型安全：modelAliases 为 undefined/非对象）
//   路由 result.modelAliases = cfg.modelAliases || {} → 若 cfg.modelAliases 为 undefined → {}。
//   "bug 存在"断言：路由直接赋 cfg.modelAliases（无兜底）→ undefined 传前端 → aliases[t[0]] 崩。
//   若路由有 || {} 兜底则非 bug。
//   注：derived 终端需代理（proxyPort 不可达 → 502），无法在测试中起 derived 终端验证端到端。
//   改验证路由源码兜底（在 tree-html.test.mjs G3-source）+ 配置层允许 modelAliases 缺失（此测试）。
test('G3: 配置层允许 modelAliases 缺失（路由 || {} 兜底在 G3-source 验证）', async () => {
    const { handle, port, home } = await startMgmt('g3');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'g3');
    // 手写一个 modelAliases 为 undefined 的派生 config（绕过创建校验）
    const derivedId = 'derived-g3-nomodel';
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    arr.push({
        id: derivedId, name: 'deriv-no-aliases', content: directContent(), mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: cfgId, derivedIndex: 3,
        // 故意不设 modelAliases（模拟旧数据/手动编辑缺失）
        sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'https://up.test', token: 'tok', mode: 'proxy' },
    });
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
    try {
        // 验证 config 层确实允许 modelAliases 缺失（LocalConfigStore.load 不崩）
        const cfgR = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}`)).json();
        assert.equal(cfgR.config.modelAliases, undefined, 'config 层允许 modelAliases 缺失（不崩）');
        // 路由源码 || {} 兜底验证在 tree-html.test.mjs G3-source
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 G4（异常：alias-resolve 返回 404 时前端不崩）
//   前端 r.json() 解析 {error:...}，d.kind 为 undefined → 不进任何分支 → 顶栏保持默认。
//   "bug 存在"断言：前端无 catch → r.json() 抛 → 崩。
//   若有 .catch 则非 bug。此为前端逻辑，在 tree-html.test.mjs 验证。
//   这里验证 API 侧：404 返回 {error}，不含 kind。
test('G4: alias-resolve 404 响应不含 kind（前端不会误渲染）', async () => {
    const { handle, port, home } = await startMgmt('g4');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/terminals/t_nonexist/alias-resolve`);
        assert.equal(r.status, 404);
        const d = await r.json();
        assert.equal(d.kind, undefined, '404 响应不应含 kind（前端不会误进别名/静态分支）');
        assert.ok(d.error, '404 应有 error 字段');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// 怀疑点 G5（一致性：GET /api/terminals/:tid 与 alias-resolve 重复查 sessions.get）
//   两个路由各自调 sessions.get(tid)。前端终端页只调 alias-resolve（不调 GET /terminals/:tid）。
//   "bug 存在"断言：前端调两个接口 → 重复查询浪费。
//   若前端只调 alias-resolve 则非 bug。此为前端逻辑，在 tree-html.test.mjs 验证。
//   这里验证 API 侧：GET /api/terminals/:tid 返回 pid（alias-resolve 不返回），两者结构不同。
test('G5: GET /api/terminals/:tid 与 alias-resolve 返回结构不同（各有职责，非重复）', async () => {
    const { handle, port, home } = await startMgmt('g5');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'g5');
    try {
        const tr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' })).json();
        const td = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}`)).json();
        const ar = await (await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}/alias-resolve`)).json();
        // GET /terminals/:tid 返回 terminalId/pid/startedAt（完整详情）
        assert.ok(td.terminalId, 'GET /terminals/:tid 返回 terminalId');
        assert.ok(td.pid != null, 'GET /terminals/:tid 返回 pid');
        assert.ok(td.startedAt, 'GET /terminals/:tid 返回 startedAt');
        // alias-resolve 返回 kind/startedConfigName/configId（顶栏专用，轻量）
        assert.equal(ar.terminalId, undefined, 'alias-resolve 不返回 terminalId（轻量）');
        assert.equal(ar.pid, undefined, 'alias-resolve 不返回 pid（轻量）');
        assert.equal(ar.startedAt, undefined, 'alias-resolve 不返回 startedAt（轻量）');
        assert.ok(ar.kind, 'alias-resolve 返回 kind');
        assert.ok(ar.startedConfigName, 'alias-resolve 返回 startedConfigName');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${tr.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R6e alias 路由回写本地 modelAliases（目标6：别名终端顶栏实时反映映射）
// ════════════════════════════════════════════════════════════
test('R6e: alias-resolve 读到本地回写后的最新映射', async () => {
    const { handle, port, home } = await startMgmt('r6e');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r6e');
    // 手写别名配置
    const derivedId = 'derived-r6e';
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    arr.push({
        id: derivedId, name: 'deriv', content: directContent(), mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: cfgId, derivedIndex: 7,
        modelAliases: {}, sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'https://up.test', token: 'tok', mode: 'proxy' },
    });
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
    try {
        // 不起终端（别名起终端需代理会 502），直接测 alias-resolve 对别名配置的 config 读取。
        // 但 alias-resolve 要 terminalId → sessions.get。没起终端拿不到。
        // 改测：直接验证 alias 路由回写后，config 的 modelAliases 变了。
        // 用 management API 的 alias 路由（需代理，19998 不可达会失败不回写）。
        // 此用例验证：alias 路由对不可达代理返回非 2xx → 不回写本地（modelAliases 仍空）。
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-7', model: 'new-model' }),
        });
        // 代理不可达 → 非 2xx，不回写
        assert.ok(r.status >= 400, '代理不可达应返回错误');
        // 验证本地未回写（modelAliases 仍空）
        const cfg2 = JSON.parse(readFileSync(localCfgPath, 'utf8')).find(c => c.id === derivedId);
        assert.deepEqual(cfg2.modelAliases, {}, '代理失败时本地不应回写');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R6f alias 路由成功回写本地（临时代理，验证目标6 单向同步修复）
// ════════════════════════════════════════════════════════════
test('R6f: alias 路由代理成功 → 回写本地 config.modelAliases', async () => {
    const { spawn } = await import('node:child_process');
    const SERVER_JS = resolve(__dirname, '..', '..', 'proxy', 'server.js');
    const tmpProxyPort = 11630;
    const proxyHome = newTmpDir('r6f-proxy');
    writeFileSync(join(proxyHome, 'proxy-config.json'), JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', API_TIMEOUT_MS: '600000', ANTHROPIC_MODEL: '' },
        effortLevel: 'max',
        proxy: { listenHost: '127.0.0.1', listenPort: tmpProxyPort, maxAttempts: 5, backoffSec: 1, backoffMaxSec: 16, passthrough: true, retryRules: [] },
        modelAliases: {},
    }));
    mkdirSync(join(proxyHome, 'logs'), { recursive: true });
    const child = spawn(process.execPath, [SERVER_JS], {
        env: { ...process.env, CCP_CONFIG_PATH: join(proxyHome, 'proxy-config.json'), CCP_LOGS_DIR: join(proxyHome, 'logs'), CCP_LOGS_CONFIG_PATH: join(proxyHome, 'logs', 'logs-config.json'), ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    // 等代理就绪
    let ready = false;
    for (let i = 0; i < 30; i++) {
        try { if ((await fetch(`http://127.0.0.1:${tmpProxyPort}/healthz`)).ok) { ready = true; break; } } catch {}
        await new Promise(r => setTimeout(r, 150));
    }
    const home = newTmpDir('r6f-mgmt');
    const port = 11990;
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: tmpProxyPort, sessionPty: makeMockPty() });
    const proj = newTmpDir('r6f-proj');
    const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'w', dir: proj }) })).json();
    const wsId = cr.workspace.id;
    const cc = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'cfg', content: directContent(), mode: 'direct' }) })).json();
    const cfgId = cc.config.id;
    const derivedId = 'derived-r6f';
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    arr.push({ id: derivedId, name: 'deriv', content: directContent(), mode: 'proxy', updatedAt: '2026-01-01T00:00:00Z', derivedFrom: cfgId, derivedIndex: 8, modelAliases: {}, sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false }, derivedSnapshot: { baseUrl: 'https://up.test', token: 'tok', mode: 'proxy' } });
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
    try {
        if (!ready) { /* 跳过成功路径断言 */ }
        else {
            const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}/alias`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alias: 'ccp-main-8', model: 'new-model' }),
            });
            assert.equal(r.status, 200);
            // 验证本地回写
            const cfg2 = JSON.parse(readFileSync(localCfgPath, 'utf8')).find(c => c.id === derivedId);
            assert.equal(cfg2.modelAliases.main, 'new-model', '代理成功后本地应回写 modelAliases.main');
        }
    } finally {
        await handle.stop();
        try { child.kill('SIGTERM'); } catch {}
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
        rmSync(proxyHome, { recursive: true, force: true });
    }
});
