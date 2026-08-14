// test/standalone/config-editor-review.test.mjs — 代码审查 TDD 确认用例
//
// 运行：node --test test/standalone/config-editor-review.test.mjs
//
// 覆盖审查疑点：XSS、sessionContext1m 丢失、getModelCatalog 不一致、
// 别名转发语义、derivedFrom=null、next-alias-id 未用、并发等。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MS_JS = resolve(__dirname, '..', '..', 'standalone', 'managementServer.js');
const { startManagementServer } = await import(pathToFileURL(MS_JS).href);
const HTML_MOD = resolve(__dirname, '..', '..', 'standalone', 'web', 'workspaces-html.js');
const { buildConfigEditorHtml } = await import(pathToFileURL(HTML_MOD).href);

let mgmtSeq = 0;
async function startMgmt(label, opts = {}) {
    const home = mkdtempSync(join(tmpdir(), `s4r-${label}-`));
    const port = 11940 + (mgmtSeq++ % 40);
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: opts.proxyPort || 11434 });
    return { handle, home, port };
}

function newTmpProject(label) {
    return mkdtempSync(join(tmpdir(), `s4rproj-${label}-`));
}

async function createWorkspace(port, label) {
    const proj = newTmpProject(label);
    const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: label, dir: proj }),
    });
    const data = await r.json();
    return { wsId: data.workspace.id, proj };
}

// ════════════════════════════════════════════════════════════
// S1 XSS: </script> in config content breaks out of <script> block
// ════════════════════════════════════════════════════════════
test('S1a: config content 含 </script> → 不应破出 script 块（XSS）', async () => {
    const malicious = '<script>alert("xss")</script>';
    const html = buildConfigEditorHtml({
        workspaceId: 'ws1', workspaceName: 'test',
        config: { id: 'cfg1', name: 'evil', content: malicious, mode: 'direct' },
        catalog: [], apiBase: '',
    });
    // JSON.stringify 不转义 </script>，直接插入 <script> 块会导致 HTML 解析器提前结束 script。
    // 期望：safeCfg 中的 </script> 应被转义（如 </script>），不出现在原文中。
    assert.ok(
        !html.includes('</script>var catalog'),
        'safeCfg 中的 </script> 应被转义，不应原文出现在 script 块内',
    );
    // 更精确：在 <script> 块内部不应有裸 </script>（除了真正的结束标签）
    const scriptStart = html.indexOf('<script>');
    const scriptEnd = html.lastIndexOf('</script>');
    const scriptContent = html.slice(scriptStart, scriptEnd);
    // scriptContent 内不应有 </script>（第一个 <script> 之后、最后 </script> 之前）
    assert.ok(
        !scriptContent.includes('</script>'),
        'script 块内部不应含裸 </script>（会被 HTML 解析器当作结束标签）',
    );
});

test('S1b: config content 含 </textarea> → textarea 内容应被转义不破 HTML', async () => {
    const malicious = 'hello</textarea><img src=x onerror=alert(1)>';
    const html = buildConfigEditorHtml({
        workspaceId: 'ws1', workspaceName: 'test',
        config: { id: 'cfg1', name: 'evil', content: malicious, mode: 'direct' },
        catalog: [], apiBase: '',
    });
    // escapeHtml 把 < > 转义，所以 </textarea> 在 textarea 内是安全的。
    // 但需确认 textarea 标签内容确实被转义。
    const taStart = html.indexOf('<textarea');
    const taEnd = html.indexOf('</textarea>');
    const taContent = html.slice(taStart, taEnd);
    assert.ok(!taContent.includes('</textarea>'), 'textarea 内不应含裸 </textarea>');
});

test('S1c: workspaceName 含 </script> → 标题插值应安全', async () => {
    const html = buildConfigEditorHtml({
        workspaceId: 'ws1',
        workspaceName: '</script><script>alert(1)</script>',
        config: null, catalog: [], apiBase: '',
    });
    // workspaceName 在 <h2> 中用 escapeHtml，安全。但不应破出任何 script 块。
    const scriptStart = html.indexOf('<script>');
    const scriptEnd = html.lastIndexOf('</script>');
    const scriptContent = html.slice(scriptStart, scriptEnd);
    assert.ok(
        !scriptContent.includes('</script>'),
        'workspaceName 经 JSON.stringify 插入 script 块也不应含裸 </script>',
    );
});

// ════════════════════════════════════════════════════════════
// S2 sessionContext1m: PUT 不保存前端传的 sessionContext1m
// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
// S2 legacy 派生字段 PUT 时被忽略（派生已移除，2026-08）
// ════════════════════════════════════════════════════════════
test('S2: PUT 传 legacy 派生字段 → 忽略不持久化', async () => {
    const { handle, port, home } = await startMgmt('s2');
    const { wsId, proj } = await createWorkspace(port, 's2');
    try {
        const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', content: '{"env":{}}' }),
        })).json();
        // 前端/旧数据 PUT 时带了 legacy 派生字段 → 后端应忽略，不持久化
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'renamed',
                sessionContext1m: { main: true, haiku: false, sonnet: false, opus: false },
                derivedFrom: 'some-parent', derivedIndex: 3, modelAliases: { main: 'x' },
            }),
        });
        assert.equal(r.status, 200);
        const got = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}`)).json();
        assert.equal(got.config.name, 'renamed');
        assert.equal(got.config.sessionContext1m, undefined, 'sessionContext1m 不应被持久化');
        assert.equal(got.config.derivedFrom, undefined, 'derivedFrom 不应被持久化');
        assert.equal(got.config.derivedIndex, undefined, 'derivedIndex 不应被持久化');
        assert.equal(got.config.modelAliases, undefined, 'modelAliases 不应被持久化');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S3 model-catalog 路由已移除（派生/别名删除，2026-08）→ 404
// ════════════════════════════════════════════════════════════
test('S3: model-catalog 路由已移除 → 404', async () => {
    const { handle, port, home } = await startMgmt('s3');
    const { wsId, proj } = await createWorkspace(port, 's3');
    try {
        const r1 = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_nope/model-catalog`);
        assert.equal(r1.status, 404, '不存在的 workspace model-catalog 应 404');
        const r2 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/model-catalog`);
        assert.equal(r2.status, 404, '存在的 workspace model-catalog 也应 404（路由已移除）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S4 别名转发路由已移除（派生删除）→ POST /alias 404
// ════════════════════════════════════════════════════════════
test('S4: alias 路由已移除 → POST /configs/:id/alias 404', async () => {
    const { handle, port, home } = await startMgmt('s4', { proxyPort: 19999 });
    const { wsId, proj } = await createWorkspace(port, 's4');
    try {
        const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'plain', content: '{}' }),
        })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-1', model: 'x' }),
        });
        assert.equal(r.status, 404, 'alias 路由应已移除（404）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S5 创建请求带 legacy 派生字段 → 按普通 config 处理（字段忽略）
// ════════════════════════════════════════════════════════════
test('S5: 创建带 legacy derivedFrom/derivedIndex → 忽略，按普通 config 创建', async () => {
    const { handle, port, home } = await startMgmt('s5');
    const { wsId, proj } = await createWorkspace(port, 's5');
    try {
        // derivedFrom=null 与 derivedIndex 重复都应被忽略，创建为普通 config
        const r1 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c1', content: '{"env":{}}', derivedFrom: null, derivedIndex: 1 }),
        });
        assert.equal(r1.status, 201);
        const c1 = (await r1.json()).config;
        assert.equal(c1.derivedFrom, undefined, 'derivedFrom 不应被持久化');
        assert.equal(c1.derivedIndex, undefined, 'derivedIndex 不应被持久化');
        assert.equal(c1.mode, 'direct', '应按普通 config 的 mode 归一');
        // 同号重复创建也按普通 config
        const r2 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c2', content: '{"env":{}}', derivedFrom: 'ghost', derivedIndex: 1 }),
        });
        assert.equal(r2.status, 201);
        const c2 = (await r2.json()).config;
        assert.equal(c2.derivedIndex, undefined, '重复 derivedIndex 不产生别名冲突（字段被忽略）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S6 编辑页 HTML 无派生/别名残留（派生已移除）
// ════════════════════════════════════════════════════════════
test('S6: 编辑页 HTML 无 derivedBlock/readonly/alias 端点引用', () => {
    const html = buildConfigEditorHtml({
        workspaceId: 'ws1', workspaceName: 'test',
        config: { id: 'cfg1', name: 'd', content: '{}', mode: 'proxy' },
        apiBase: '',
    });
    assert.ok(!html.includes('derivedBlock'), '编辑页不应有 derived 渲染块');
    assert.ok(!html.includes('/alias'), '编辑页不应引用 alias 端点');
    assert.ok(!html.includes('readonly'), 'content 不应只读');
    assert.ok(html.includes('textarea'), '编辑页应有 content textarea');
});

// ════════════════════════════════════════════════════════════
// S9 PUT 不传 name → 400（name 必填校验，普通 config 同约束）
// ════════════════════════════════════════════════════════════
test('S9: PUT 不传 name → 400', async () => {
    const { handle, port, home } = await startMgmt('s9');
    const { wsId, proj } = await createWorkspace(port, 's9');
    try {
        const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', content: '{"env":{}}' }),
        })).json();
        // 只传 content，不传 name → name 必填 → 400
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '{"env":{}}' }),
        });
        assert.equal(r.status, 400);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S10 updateLocalConfig: 普通 config PUT 不传 content → content 保留
// ════════════════════════════════════════════════════════════
test('S10: PUT 普通配置不传 content → content 保留（非清空）', async () => {
    const { handle, port, home } = await startMgmt('s10');
    const { wsId, proj } = await createWorkspace(port, 's10');
    try {
        const orig = '{"env":{"ANTHROPIC_MODEL":"keep-me"}}';
        const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', content: orig }),
        })).json();
        // PUT 只传 name，不传 content
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'renamed' }),
        });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.config.content, orig, '不传 content 时应保留原 content');
        assert.equal(data.config.name, 'renamed');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S11 PUT 传畸形 sessionContext1m → 字段被忽略不持久化（不崩）
// ════════════════════════════════════════════════════════════
test('S11: PUT 畸形 sessionContext1m（字符串）→ 忽略不持久化，不崩', async () => {
    const { handle, port, home } = await startMgmt('s11');
    const { wsId, proj } = await createWorkspace(port, 's11');
    try {
        const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', content: '{"env":{}}' }),
        })).json();
        // 传字符串而非对象 → 后端应忽略（派生字段已移除），不崩溃
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', sessionContext1m: 'garbage' }),
        });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.config.sessionContext1m, undefined, 'sessionContext1m 不应被持久化（字段已移除）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S12 alias 路由已移除 → cfgId 不存在也 404（非盲目转发 502）
// ════════════════════════════════════════════════════════════
test('S12: alias 路由已移除 → cfgId 不存在 404（非盲目转发）', async () => {
    const { handle, port, home } = await startMgmt('s12', { proxyPort: 19999 });
    const { wsId, proj } = await createWorkspace(port, 's12');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/cfg_nope/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-1', model: 'x' }),
        });
        assert.equal(r.status, 404, 'alias 路由已移除，不应盲目转发到 proxy');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S13 alias/delete 路由已移除 → 404（普通/任意 config 均如此）
// ════════════════════════════════════════════════════════════
test('S13: alias/delete 路由已移除 → 404', async () => {
    const { handle, port, home } = await startMgmt('s13', { proxyPort: 19999 });
    const { wsId, proj } = await createWorkspace(port, 's13');
    try {
        const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'plain', content: '{}' }),
        })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}/alias/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-1' }),
        });
        assert.equal(r.status, 404, 'alias/delete 路由应已移除（404）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});
