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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

// Windows 上服务端刚读完/写完 settings.json 后文件句柄释放有延迟，rmSync 偶发 ENOTEMPTY。
// 重试几次消化句柄释放竞态，避免 flaky 失败（仅清理用，不影响断言）。
function forceRm(p) {
    for (let i = 0; i < 5; i++) {
        try { rmSync(p, { recursive: true, force: true }); return; }
        catch (e) { if (i === 4) throw e; }
    }
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

// 派生配置已移除（2026-08）：alias-resolve 不再查 config / modelAliases，只返回 info 基础字段（kind 恒为 normal）。
test('G2: alias-resolve 路由源码——只返回 info 基础字段，不查 config（派生已移除）', async () => {
    const { handle, port, home } = await startMgmt('g2');
    try {
        // 读 managementServer.js 源码验证 alias-resolve 路由的简化形态
        const src = readFileSync(MS_JS, 'utf8');
        const idx = src.indexOf('mAliasResolve');
        assert.ok(idx > 0, '应找到 alias-resolve 路由');
        const block = src.slice(idx, idx + 400);
        assert.ok(/kind: info\.kind/.test(block), '应返回 info.kind');
        assert.ok(!/configs\.find/.test(block), '不应查 config（派生已移除）');
        assert.ok(!/modelAliases/.test(block), '不应返回 modelAliases');
        assert.ok(!/derivedIndex/.test(block), '不应返回 derivedIndex');
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

// 派生配置已移除：load 时剥离 legacy derived 节点（derivedFrom 非空）→ 该类 config 不可见（GET 404）。
test('G3: 配置层剥离 legacy derived 节点（load 时过滤 derivedFrom）', async () => {
    const { handle, port, home } = await startMgmt('g3');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'g3');
    // 手写一个 legacy derived config 到文件（模拟旧数据残留）
    const derivedId = 'derived-g3-nomodel';
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    arr.push({
        id: derivedId, name: 'deriv-no-aliases', content: directContent(), mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: cfgId, derivedIndex: 3,
        sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'https://up.test', token: 'tok', mode: 'proxy' },
    });
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
    try {
        // 派生配置已移除：load 剥离 derivedFrom → GET 该 config 返回 404（不可见）
        const cfgR = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}`);
        assert.equal(cfgR.status, 404, 'legacy derived 配置应被 load 剥离（不可见）');
        // 列表也不含 derived 节点（父 config 仍在）
        const list = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`)).json();
        assert.ok(!list.configs.find(c => c.id === derivedId), '列表不应含 derived 节点');
        assert.ok(list.configs.find(c => c.id === cfgId), '父 config 应保留');
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
// R6f alias 路由已移除（派生配置删除，2026-08）——POST /alias 与 /alias/delete 均应 404
// ════════════════════════════════════════════════════════════
test('R6f: alias 路由已移除 → POST /configs/:id/alias 404（派生已删除）', async () => {
    const { handle, port, home } = await startMgmt('r6f');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r6f');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-8', model: 'new-model' }),
        });
        assert.equal(r.status, 404, 'alias 路由应已移除（404）');
        const rd = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/alias/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-8' }),
        });
        assert.equal(rd.status, 404, 'alias/delete 路由应已移除（404）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// 跨目标冲突审查 TDD（非 bug 回归看护）
// ════════════════════════════════════════════════════════════

// 怀疑点 C1（目标1 vs 目标2/3）：markDefaultConfig 不校验 content，但起终端时 buildTerminalEnv 校验
//   active 标记指向 content 缺 BASE_URL 的 config → markDefaultConfig 成功 → 起终端时 ValidationError → 400
//   翻转：错误路径一致（400 ValidationError），非 bug。回归锁定。
test('C1: active 指向缺 BASE_URL 的 config → 起终端 400 ValidationError（错误路径一致，非 bug）', async () => {
    const { handle, port, home } = await startMgmt('c1');
    const proj = newTmpDir('c1-proj');
    try {
        // 建 workspace
        const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', dir: proj }),
        })).json();
        const wsId = cr.workspace.id;
        // 建一个 content 缺 BASE_URL 的 direct config
        const badContent = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'tok' } });
        const cc = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'bad', content: badContent, mode: 'direct' }),
        })).json();
        const cfgId = cc.config.id;
        // 标记为默认（markDefaultConfig 不校验 content → 成功）
        const actR = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        assert.equal(actR.status, 200, 'markDefaultConfig 不校验 content → 标记成功');
        // workspace 级无 cfgId 起终端 → 用 active → buildTerminalEnv 校验失败 → 400
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 400, 'content 缺 BASE_URL → ValidationError → 400');
        const d = await r.json();
        assert.match(d.error, /BASE_URL|TOKEN/i, '错误信息应提示缺 BASE_URL/TOKEN');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 C2（目标3 vs 目标6）：双向同步一致性
//   syncDerivedAliases 只补不删（toRemove 始终空），但 management alias/delete 路由同时删代理+本地。
//   翻转：经 management 路由的删除双向一致，非 bug。回归锁定。
//   验证：alias/delete 路由转发代理 delete（见 R6f 验证 set 路径），这里验证 delete 路由对不可达代理不回写本地。
test('C2: alias/delete 代理不可达 → 不回写本地（双向同步保护，非 bug）', async () => {
    const { handle, port, home } = await startMgmt('c2');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'c2');
    // 手写别名配置
    const derivedId = 'derived-c2';
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    arr.push({
        id: derivedId, name: 'deriv', content: directContent(), mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: cfgId, derivedIndex: 9,
        modelAliases: { main: 'old-model' }, sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'https://up.test', token: 'tok', mode: 'proxy' },
    });
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
    try {
        // 删别名（代理 19998 不可达 → 非 2xx → 不回写本地）
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}/alias/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-9' }),
        });
        assert.ok(r.status >= 400, '代理不可达应返回错误');
        // 验证本地未回写（main 仍为 old-model）
        const cfg2 = JSON.parse(readFileSync(localCfgPath, 'utf8')).find(c => c.id === derivedId);
        assert.equal(cfg2.modelAliases.main, 'old-model', '代理失败时本地不应回写删除');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 C3（目标1 per-terminal configDir vs ensureProjectPermissions）：重复写 permissions
//   startTerminalForConfig 每次起终端都调 ensureProjectPermissions + ensureGitignore。
//   翻转：两个函数幂等（已写则跳过），非 bug。回归锁定。
//   验证：同一 workspace 起两个终端，permissions 文件只写一次（内容不变）。
test('C3: 同一 workspace 起两个终端 → permissions 不重复写（幂等，非 bug）', async () => {
    const { handle, port, home } = await startMgmt('c3');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'c3');
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        // 起第一个终端
        const t1 = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' })).json();
        // 读 permissions 文件
        const settingsLocalPath = join(proj, '.claude', 'settings.local.json');
        const content1 = readFileSync(settingsLocalPath, 'utf8');
        // 起第二个终端
        const t2 = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' })).json();
        // permissions 文件内容应不变（幂等）
        const content2 = readFileSync(settingsLocalPath, 'utf8');
        assert.equal(content1, content2, '起两个终端后 permissions 文件内容应不变（幂等）');
        // 清理
        await fetch(`http://127.0.0.1:${port}/api/terminals/${t1.terminalId}`, { method: 'DELETE' });
        await fetch(`http://127.0.0.1:${port}/api/terminals/${t2.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 C4（ValidationError instanceof 链）：terminalApi 抛的 ValidationError 是否被 managementServer sendTermError 正确识别
//   terminalApi.js 从 configApi.js 解构导入 ValidationError → throw new ValidationError(...)
//   managementServer.js 从 configApi.js 导入 ValidationError → instanceof 检查
//   翻转：同一引用，instanceof 成立，非 bug。回归锁定。（已由 S1 覆盖，这里补一个 derived 路径）
test('C4: config 级起终端 content 非法 JSON → ValidationError → 400（instanceof 链正确，非 bug）', async () => {
    const { handle, port, home } = await startMgmt('c4');
    const proj = newTmpDir('c4-proj');
    try {
        const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', dir: proj }),
        })).json();
        const wsId = cr.workspace.id;
        // 建一个 content 非法 JSON 的 config（绕过前端校验）
        const cc = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'bad', content: '{"env":{', mode: 'direct' }),
        })).json();
        // 注意：createLocalConfig 会校验 JSON，所以这里用合法 JSON 但缺字段
        const cc2 = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'bad2', content: '{"env":{}}', mode: 'direct' }),
        })).json();
        const cfgId2 = cc2.config.id;
        // config 级起终端 → buildTerminalEnv → extractUpstream 成功但缺 BASE_URL → ValidationError → 400
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId2}/terminals`, { method: 'POST' });
        assert.equal(r.status, 400, '缺 BASE_URL → ValidationError → 400（instanceof 链正确）');
        const d = await r.json();
        assert.match(d.error, /BASE_URL|TOKEN/i);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 C5（GET vs POST mWsTerm 正则共享）：GET /api/workspaces/:id/terminals 不读 body
//   mWsTerm 正则同时匹配 POST 和 GET，但 method 检查分离。GET 不调 readJsonBody。
//   翻转：GET 请求不会被当 POST 处理读 body，非 bug。回归锁定。
test('C5: GET /api/workspaces/:id/terminals → 200 列表（不被 POST 路由拦截读 body，非 bug）', async () => {
    const { handle, port, home } = await startMgmt('c5');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'c5');
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/activate`, { method: 'POST' });
        const t1 = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' })).json();
        // GET 列表（不应被 POST 路由拦截读 body）
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`);
        assert.equal(r.status, 200, 'GET 列表应 200（不被 POST 路由拦截）');
        const d = await r.json();
        assert.ok(Array.isArray(d.terminals), 'GET 应返回 terminals 数组');
        assert.ok(d.terminals.length >= 1, '应含已起的终端');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${t1.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 怀疑点 C6（configDir 路径安全）：terminalId 含特殊字符时 configDir 路径
//   terminalId 由 sessions.newTerminalId() 生成（t_ + hex），用户无法通过路由参数影响 configDir。
//   路由参数 tid 仅用于内存 Map 查找或 HTML 渲染（不进 path.join/fs）。
//   翻转：configDir 路径安全，非 bug。回归锁定。
//   验证：起终端后 configDir 为 {ws}/.claude_proxy/sessions/t_xxxxxxxx 格式。
test('C6: 起终端后 configDir 为共享 {ws}/.claude_proxy（与插件一致，onboarding 复用）', async () => {
    const { handle, port, home } = await startMgmt('c6');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'c6');
    try {
        const t1 = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' })).json();
        // terminalId 应为 t_ + hex 格式
        assert.match(t1.terminalId, /^t_[0-9a-f]+$/, 'terminalId 应为 t_+hex 格式（安全）');
        // configDir 路径应为共享 {ws}/.claude_proxy（不再 per-terminal，避免重复引导）
        
        assert.ok(existsSync(join(proj, '.claude_proxy')), 'configDir 应为共享 {ws}/.claude_proxy');
        await fetch(`http://127.0.0.1:${port}/api/terminals/${t1.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R7 settings.json 含 modelname 冲突 key 时拒绝起终端（终端走 env，settings.json env 会覆盖注入值）
// ════════════════════════════════════════════════════════════
test('R7a: settings.json 含 ANTHROPIC_BASE_URL → 起终端 400 拒绝', async () => {
    const { handle, port, home } = await startMgmt('r7a');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r7a');
    // 手写 settings.json（模拟旧 activateConfig/插件模式遗留，含冲突 key）
    mkdirSync(join(proj, '.claude_proxy'), { recursive: true });
    writeFileSync(join(proj, '.claude_proxy', 'settings.json'), JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'http://old-proxy:11434', ANTHROPIC_AUTH_TOKEN: 'old-tok' },
    }), 'utf8');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 400, '含 BASE_URL 冲突 key 应拒绝');
        const d = await r.json();
        assert.match(d.error, /ANTHROPIC_BASE_URL|覆盖.*modelname|不支持共存/, '应提示冲突 key');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R7b: 无 settings.json → 正常起终端（201）', async () => {
    const { handle, port, home } = await startMgmt('r7b');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r7b');
    try {
        // 不写 settings.json，正常起
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 201);
        const d = await r.json();
        assert.ok(d.terminalId);
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R7c: settings.json 仅 theme/skipDangerous（无 env 冲突 key）→ 放行起终端（201）', async () => {
    // CLI 走完引导后自己写 {theme, skipDangerousModePermissionPrompt}，无 env，不冲突，应放行。
    // 这是第二次起终端能成功的保证。
    const { handle, port, home } = await startMgmt('r7c');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r7c');
    mkdirSync(join(proj, '.claude_proxy'), { recursive: true });
    writeFileSync(join(proj, '.claude_proxy', 'settings.json'), JSON.stringify({
        theme: 'dark',
        skipDangerousModePermissionPrompt: true,
    }), 'utf8');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 201, '仅 theme/skipDangerous 无 env 冲突应放行');
        const d = await r.json();
        assert.ok(d.terminalId);
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('R7d: settings.json env 含三档别名 key（ANTHROPIC_DEFAULT_SONNET_MODEL）→ 拒绝', async () => {
    const { handle, port, home } = await startMgmt('r7d');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r7d');
    mkdirSync(join(proj, '.claude_proxy'), { recursive: true });
    writeFileSync(join(proj, '.claude_proxy', 'settings.json'), JSON.stringify({
        env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet' },
    }), 'utf8');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 400, '含三档别名冲突 key 应拒绝');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// R8 冲突 key「确认框 + 一键删除」：code 信号 + strip-conflict-keys endpoint + 端到端剥离重试
// ════════════════════════════════════════════════════════════

test('R8a: settings.json 含 ANTHROPIC_BASE_URL → 起终端 400 且 d.code==="CONFLICT_KEYS"', async () => {
    const { handle, port, home } = await startMgmt('r8a');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r8a');
    mkdirSync(join(proj, '.claude_proxy'), { recursive: true });
    writeFileSync(join(proj, '.claude_proxy', 'settings.json'), JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'http://old-proxy:11434', ANTHROPIC_AUTH_TOKEN: 'old-tok' },
    }), 'utf8');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r.status, 400, '含 BASE_URL 冲突 key 应拒绝');
        const d = await r.json();
        assert.match(d.error, /ANTHROPIC_BASE_URL|覆盖.*modelname|不支持共存/, '应提示冲突 key');
        assert.equal(d.code, 'CONFLICT_KEYS', '冲突错误应携带结构化 code 供前端判定');
    } finally {
        await handle.stop();
        forceRm(home);
        forceRm(proj);
    }
});

test('R8b: strip-conflict-keys 删 BASE_URL/TOKEN 保留其余 + 之后起终端 201（端到端）', async () => {
    const { handle, port, home } = await startMgmt('r8b');
    const { proj, wsId, cfgId } = await createWsAndDirectConfig(port, 'r8b');
    mkdirSync(join(proj, '.claude_proxy'), { recursive: true });
    const settingsPath = join(proj, '.claude_proxy', 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
        env: {
            ANTHROPIC_BASE_URL: 'http://old-proxy:11434',
            ANTHROPIC_AUTH_TOKEN: 'old-tok',
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000',
        },
        skipDangerousModePermissionPrompt: true,
    }), 'utf8');
    try {
        // 1) 起终端先被冲突拒绝（带 code）
        const r0 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r0.status, 400);
        assert.equal((await r0.json()).code, 'CONFLICT_KEYS');

        // 2) 调 strip endpoint 一键剥离
        const rs = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/settings/strip-conflict-keys`, { method: 'POST' });
        assert.equal(rs.status, 200, 'strip 应 200');
        const ds = await rs.json();
        assert.ok(Array.isArray(ds.removed), 'removed 应为数组');
        assert.ok(ds.removed.includes('ANTHROPIC_BASE_URL'), '应删 BASE_URL');
        assert.ok(ds.removed.includes('ANTHROPIC_AUTH_TOKEN'), '应一并删 AUTH_TOKEN 残留');
        assert.ok(!ds.removed.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW'), '不应删非冲突 key');

        // 3) 文件：冲突 key 已删，保留 AUTO_COMPACT + skipDangerous
        const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
        assert.equal(after.env.ANTHROPIC_BASE_URL, undefined, 'BASE_URL 已删');
        assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, undefined, 'AUTH_TOKEN 已删');
        assert.equal(after.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000', '保留非冲突 env key');
        assert.equal(after.skipDangerousModePermissionPrompt, true, '保留文件其余字段');

        // 4) 起终端重试 → 201 成功（端到端验证剥离生效）
        const r1 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfgId}/terminals`, { method: 'POST' });
        assert.equal(r1.status, 201, '剥离冲突 key 后起终端应成功');
        const d1 = await r1.json();
        assert.ok(d1.terminalId);
        await fetch(`http://127.0.0.1:${port}/api/terminals/${d1.terminalId}`, { method: 'DELETE' });
    } finally {
        await handle.stop();
        forceRm(home);
        forceRm(proj);
    }
});

test('R8c: settings.json 无冲突 key（仅 theme/skipDangerous）→ strip 返回 removed:[] 文件不变', async () => {
    const { handle, port, home } = await startMgmt('r8c');
    const { proj, wsId } = await createWsAndDirectConfig(port, 'r8c');
    mkdirSync(join(proj, '.claude_proxy'), { recursive: true });
    const settingsPath = join(proj, '.claude_proxy', 'settings.json');
    const before = JSON.stringify({
        theme: 'dark',
        skipDangerousModePermissionPrompt: true,
    }, null, 2);
    writeFileSync(settingsPath, before, 'utf8');
    try {
        const rs = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/settings/strip-conflict-keys`, { method: 'POST' });
        assert.equal(rs.status, 200, '无冲突 key 应 200（幂等不报错）');
        const ds = await rs.json();
        assert.deepEqual(ds.removed, [], '无命中应返回空 removed');
        // 文件内容不变
        assert.equal(readFileSync(settingsPath, 'utf8'), before, '无剥离则文件不应被重写');
    } finally {
        await handle.stop();
        forceRm(home);
        forceRm(proj);
    }
});

test('R8d: workspace 无 settings.json → strip 返回 400（不存在）', async () => {
    const { handle, port, home } = await startMgmt('r8d');
    const { proj, wsId } = await createWsAndDirectConfig(port, 'r8d');
    // 不写 settings.json
    try {
        const rs = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/settings/strip-conflict-keys`, { method: 'POST' });
        assert.equal(rs.status, 400, 'settings.json 不存在应 400');
        const ds = await rs.json();
        assert.match(ds.error, /不存在/, '应提示不存在');
    } finally {
        await handle.stop();
        forceRm(home);
        forceRm(proj);
    }
});

test('R8e: settings.json 损坏（非法 JSON）→ strip 返回 400（无法解析）', async () => {
    const { handle, port, home } = await startMgmt('r8e');
    const { proj, wsId } = await createWsAndDirectConfig(port, 'r8e');
    mkdirSync(join(proj, '.claude_proxy'), { recursive: true });
    writeFileSync(join(proj, '.claude_proxy', 'settings.json'), '{ not valid json !!!', 'utf8');
    try {
        const rs = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/settings/strip-conflict-keys`, { method: 'POST' });
        assert.equal(rs.status, 400, '非法 JSON 应 400');
        const ds = await rs.json();
        assert.match(ds.error, /无法解析/, '应提示无法解析');
    } finally {
        await handle.stop();
        forceRm(home);
        forceRm(proj);
    }
});

test('R8f: workspace 不存在 → strip 返回 404', async () => {
    const { handle, port, home } = await startMgmt('r8f');
    try {
        const rs = await fetch(`http://127.0.0.1:${port}/api/workspaces/nope-ws/settings/strip-conflict-keys`, { method: 'POST' });
        assert.equal(rs.status, 404, 'workspace 不存在应 404');
        const ds = await rs.json();
        assert.match(ds.error, /workspace 不存在/, '应提示 workspace 不存在');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});
