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
test('S2: PUT derived 传 sessionContext1m → 应持久化（非丢弃）', async () => {
    const { handle, port, home } = await startMgmt('s2');
    const { wsId, proj } = await createWorkspace(port, 's2');
    try {
        const PARENT = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_MODEL: 'm' } });
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', content: PARENT }),
        })).json();
        const child = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', derivedFrom: parent.config.id, derivedIndex: 1 }),
        })).json();
        // 前端改 1m checkbox → PUT { name, sessionContext1m }
        const new1m = { main: true, haiku: false, sonnet: false, opus: false };
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${child.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', sessionContext1m: new1m }),
        });
        assert.equal(r.status, 200);
        // 重新 GET 确认 sessionContext1m 被持久化
        const got = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${child.config.id}`)).json();
        assert.deepEqual(got.config.sessionContext1m, new1m, 'sessionContext1m 应被 PUT 保存');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S3 getModelCatalog: workspace 不存在返回 [] vs createLocalConfig 抛 404 — 不一致
// ════════════════════════════════════════════════════════════
test('S3: model-catalog 对不存在的 workspace → 行为确认', async () => {
    const { handle, port, home } = await startMgmt('s3');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_nope/model-catalog`);
        // 当前实现返回 200 + { catalog: [] }（workspace 不存在不报错）
        // 这与 createLocalConfig 对不存在 workspace 抛 404 不一致，但 catalog 返空也是合理行为。
        // 此测试记录当前行为，确认是 200（非 404）。
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.deepEqual(data.catalog, []);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S4 别名转发: 非 derived config 也能调 alias 转发（语义漏洞）
// ════════════════════════════════════════════════════════════
test('S4: 普通 config 调 alias 转发 → 应拒绝（仅 derived 可设别名）', async () => {
    const { handle, port, home } = await startMgmt('s4', { proxyPort: 19999 });
    const { wsId, proj } = await createWorkspace(port, 's4');
    try {
        const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'plain', content: '{}' }),
        })).json();
        // 普通 config 调 alias 转发 → 当前实现不校验 derived，直接转发到 proxy。
        // proxy 不可达 → 502。但语义上普通 config 不该有别名，应返回 400。
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-1', model: 'x' }),
        });
        // 期望：400（普通 config 不支持别名），而非 502（盲目转发）
        assert.equal(r.status, 400, '普通 config 调 alias 应拒绝（400），不应盲目转发');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S5 derivedFrom = null → 进入 derived 分支但报"父配置不存在"
// ════════════════════════════════════════════════════════════
test('S5: derivedFrom=null → 应报错（null 不应被当 derived 创建）', async () => {
    const { handle, port, home } = await startMgmt('s5');
    const { wsId, proj } = await createWorkspace(port, 's5');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', derivedFrom: null, derivedIndex: 1 }),
        });
        // null !== undefined → 进入 derived 分支，但应被 derivedFrom 类型校验拦截。
        // 期望：400 + derivedFrom 格式错误消息。
        assert.equal(r.status, 400);
        const data = await r.json();
        assert.match(data.error, /derivedFrom/i, '错误消息应说明 derivedFrom 非法');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S6 别名 model 空字符串 → 前端应走 delete 路径
// ════════════════════════════════════════════════════════════
test('S6: 前端别名清空时 HTML 应含 delete 端点逻辑', async () => {
    // 前端 JS 无法在 node test 里跑，但可检查 HTML 是否包含 delete 路由逻辑。
    const html = buildConfigEditorHtml({
        workspaceId: 'ws1', workspaceName: 'test',
        config: { id: 'cfg1', name: 'd', content: '{}', mode: 'proxy', derivedFrom: 'p', derivedIndex: 1, modelAliases: {}, sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false } },
        catalog: [], apiBase: '',
    });
    // 修复后：前端空 model 时走 /alias/delete，非空走 /alias
    assert.ok(html.includes('/alias/delete'), '前端应含 delete 端点逻辑（空 model 时清别名）');
    assert.ok(html.includes("if (model)"), '前端应按 model 是否为空分流');
});

test('S6b: alias model 空字符串 → 后端转发到 proxy（当前行为记录）', async () => {
    // 后端 alias 转发收到 model:"" → 转发到 proxy → proxy 返回 400（需要非空字符串）。
    // 前端修复后清空走 /alias/delete，不再触发此路径。此测试记录后端不校验 model 非空。
    // 这个测试记录当前行为（502 proxy 不可达时不验证 body）。
    const { handle, port, home } = await startMgmt('s6', { proxyPort: 19999 });
    const { wsId, proj } = await createWorkspace(port, 's6');
    try {
        const PARENT = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_MODEL: 'm' } });
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', content: PARENT }),
        })).json();
        const child = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', derivedFrom: parent.config.id, derivedIndex: 1 }),
        })).json();
        // model 空字符串 → proxy 不可达 → 502
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${child.config.id}/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-1', model: '' }),
        });
        // 当前：502（proxy 不可达）。如果 proxy 可达会 400（model 非空校验）。
        // 期望改进：空 model 应转 delete 语义。此测试记录现状。
        assert.ok(r.status === 502 || r.status === 400, '空 model 当前被转发（502 或 400），无 delete 语义');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S7 derivedIndex 由客户端提供 → 不调 next-alias-id，可重号
// ════════════════════════════════════════════════════════════
test('S7: 两个 derived 用相同 derivedIndex → 都创建成功（可重号）', async () => {
    const { handle, port, home } = await startMgmt('s7');
    const { wsId, proj } = await createWorkspace(port, 's7');
    try {
        const PARENT = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_MODEL: 'm' } });
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', content: PARENT }),
        })).json();
        const r1 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c1', derivedFrom: parent.config.id, derivedIndex: 5 }),
        });
        const c1 = await r1.json();
        const r2 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c2', derivedFrom: parent.config.id, derivedIndex: 5 }),
        });
        const c2 = await r2.json();
        // 两个都用 derivedIndex=5 → 别名 ccp-main-5 冲突
        // 当前实现不校验重号，都创建成功。proxy 端别名表会被后者覆盖。
        assert.equal(r1.status, 201);
        assert.equal(r2.status, 201);
        assert.equal(c1.config.derivedIndex, 5);
        assert.equal(c2.config.derivedIndex, 5, '当前允许重号（无 next-alias-id 校验）');
        // 这是潜在 bug：应从 next-alias-id 取全局唯一编号，防别名冲突。
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S8 别名转发不校验 alias 格式 → 任意 alias 可写入 proxy
// ════════════════════════════════════════════════════════════
test('S8: alias 转发任意 alias 字符串 → 无格式校验', async () => {
    const { handle, port, home } = await startMgmt('s8', { proxyPort: 19999 });
    const { wsId, proj } = await createWorkspace(port, 's8');
    try {
        const PARENT = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_MODEL: 'm' } });
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', content: PARENT }),
        })).json();
        const child = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', derivedFrom: parent.config.id, derivedIndex: 1 }),
        })).json();
        // 传任意 alias（非 ccp-{tier}-N 格式）→ 当前实现直接转发，不校验。
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${child.config.id}/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'arbitrary-evil-alias', model: 'x' }),
        });
        // proxy 不可达 → 502。如果可达，任意 alias 会被写入 proxy 映射表。
        // 期望改进：后端应校验 alias 格式（ccp-{tier}-N）。
        assert.equal(r.status, 502, '当前不校验 alias 格式，直接转发');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S9 PUT derived 不传 name → 400（name 必填校验）
// ════════════════════════════════════════════════════════════
test('S9: PUT derived 不传 name → 400', async () => {
    const { handle, port, home } = await startMgmt('s9');
    const { wsId, proj } = await createWorkspace(port, 's9');
    try {
        const PARENT = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_MODEL: 'm' } });
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', content: PARENT }),
        })).json();
        const child = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', derivedFrom: parent.config.id, derivedIndex: 1 }),
        })).json();
        // 只传 sessionContext1m，不传 name
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${child.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionContext1m: { main: true, haiku: false, sonnet: false, opus: false } }),
        });
        // name 是必填 → 400。但前端 1m checkbox 总带 name:nameEl.value，所以实际不会触发。
        // 这记录了 name 必填约束。
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
// S11 sessionContext1m 畸形输入 → normalize 兜底（不崩溃）
// ════════════════════════════════════════════════════════════
test('S11: PUT derived sessionContext1m 畸形（字符串）→ normalize 兜底不崩', async () => {
    const { handle, port, home } = await startMgmt('s11');
    const { wsId, proj } = await createWorkspace(port, 's11');
    try {
        const PARENT = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_MODEL: 'm' } });
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', content: PARENT }),
        })).json();
        const child = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', derivedFrom: parent.config.id, derivedIndex: 1 }),
        })).json();
        // 传字符串而非对象 → normalizeSessionContext1m 应回退为全 false
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${child.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', sessionContext1m: 'garbage' }),
        });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.deepEqual(data.config.sessionContext1m, { main: false, haiku: false, sonnet: false, opus: false },
            '畸形 sessionContext1m 应被 normalize 兜底为全 false');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S12 alias 转发对不存在 config → 404（非 502）
// ════════════════════════════════════════════════════════════
test('S12: alias 转发 cfgId 不存在 → 404（非盲目转发 502）', async () => {
    const { handle, port, home } = await startMgmt('s12', { proxyPort: 19999 });
    const { wsId, proj } = await createWorkspace(port, 's12');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/cfg_nope/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-1', model: 'x' }),
        });
        assert.equal(r.status, 404, 'config 不存在应 404，不应盲目转发到 proxy');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S13 alias/delete 转发对普通 config → 400（仅 derived 可删别名）
// ════════════════════════════════════════════════════════════
test('S13: alias/delete 对普通 config → 400', async () => {
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
        assert.equal(r.status, 400, '普通 config 删别名应拒绝');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});
