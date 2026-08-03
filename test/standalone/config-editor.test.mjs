// test/standalone/config-editor.test.mjs — 阶段4: 配置编辑 API 测试
//
// 运行：node --test test/standalone/config-editor.test.mjs
//
// 维度覆盖（见 plan/tmp/2026-08-03-stage4-config-editor.md）：
//   D1 local config CRUD
//   D2 derived 节点创建
//   D3 别名转发（mock proxy）
//   D4 模型清单
//   D5/D6 编辑页 + content（HTML 路由 + JSON 校验）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MS_JS = resolve(__dirname, '..', '..', 'standalone', 'managementServer.js');
const { startManagementServer } = await import(pathToFileURL(MS_JS).href);

let mgmtSeq = 0;
async function startMgmt(label, opts = {}) {
    const home = mkdtempSync(join(tmpdir(), `s4-${label}-`));
    const port = 11900 + (mgmtSeq++ % 40);
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: opts.proxyPort || 11434 });
    return { handle, home, port };
}

function newTmpProject(label) {
    return mkdtempSync(join(tmpdir(), `s4proj-${label}-`));
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
// D1 local config CRUD
// ════════════════════════════════════════════════════════════
test('D1a: 新建普通 config → 201 + 存入', async () => {
    const { handle, port, home } = await startMgmt('d1a');
    const { wsId, proj } = await createWorkspace(port, 'd1a');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'my-cfg', mode: 'direct', content: '{"env":{"ANTHROPIC_BASE_URL":"http://x"}}' }),
        });
        assert.equal(r.status, 201);
        const data = await r.json();
        assert.equal(data.config.name, 'my-cfg');
        assert.equal(data.config.mode, 'direct');
        assert.ok(data.config.id);
        // 确认存入 local-configs.json
        const list = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`)).json();
        assert.equal(list.configs.length, 1);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D1d: 新建 name 缺失 → 400', async () => {
    const { handle, port, home } = await startMgmt('d1d');
    const { wsId, proj } = await createWorkspace(port, 'd1d');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '', content: '{}' }),
        });
        assert.equal(r.status, 400);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D1e: 新建 content 非法 JSON → 400', async () => {
    const { handle, port, home } = await startMgmt('d1e');
    const { wsId, proj } = await createWorkspace(port, 'd1e');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x', content: '{ not json' }),
        });
        assert.equal(r.status, 400);
        assert.match((await r.json()).error, /JSON/);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D1f: workspace 不存在 → 404', async () => {
    const { handle, port, home } = await startMgmt('d1f');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_nope/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x', content: '{}' }),
        });
        assert.equal(r.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

test('D1b: PUT 更新 config → 200 + 字段更新', async () => {
    const { handle, port, home } = await startMgmt('d1b');
    const { wsId, proj } = await createWorkspace(port, 'd1b');
    try {
        const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'orig', mode: 'direct', content: '{}' }),
        })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cr.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'updated', mode: 'proxy', content: '{"env":{}}' }),
        });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.config.name, 'updated');
        assert.equal(data.config.mode, 'proxy');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D1c: DELETE config → 200', async () => {
    const { handle, port, home } = await startMgmt('d1c');
    const { wsId, proj } = await createWorkspace(port, 'd1c');
    try {
        const cr = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'del', content: '{}' }),
        })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cr.config.id}`, { method: 'DELETE' });
        assert.equal(r.status, 200);
        const list = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`)).json();
        assert.equal(list.configs.length, 0);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D1g: 更新/删除不存在的 config → 404', async () => {
    const { handle, port, home } = await startMgmt('d1g');
    const { wsId, proj } = await createWorkspace(port, 'd1g');
    try {
        const pu = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/cfg_nope`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
        });
        assert.equal(pu.status, 404);
        const de = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/cfg_nope`, { method: 'DELETE' });
        assert.equal(de.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D2 derived 节点创建
// ════════════════════════════════════════════════════════════
const PARENT_CONTENT = JSON.stringify({
    env: {
        ANTHROPIC_BASE_URL: 'http://upstream',
        ANTHROPIC_AUTH_TOKEN: 'tok',
        ANTHROPIC_MODEL: 'claude-x',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-x',
    },
});

test('D2a: 创建 derived → 201 + 含 derivedFrom/index/snapshot/aliases', async () => {
    const { handle, port, home } = await startMgmt('d2a');
    const { wsId, proj } = await createWorkspace(port, 'd2a');
    try {
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'parent', mode: 'proxy', content: PARENT_CONTENT }),
        })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'child', derivedFrom: parent.config.id, derivedIndex: 1 }),
        });
        assert.equal(r.status, 201);
        const data = await r.json();
        assert.equal(data.config.derivedFrom, parent.config.id);
        assert.equal(data.config.derivedIndex, 1);
        assert.equal(data.config.mode, 'proxy', 'derived 强制 proxy');
        assert.ok(data.config.derivedSnapshot, '应有快照');
        assert.equal(data.config.derivedSnapshot.baseUrl, 'http://upstream');
        assert.ok(data.config.modelAliases, '应继承父别名');
        assert.equal(data.config.modelAliases.haiku, 'haiku-x');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D2e: 父 content 无效 → snapshot=undefined（仍创建）', async () => {
    const { handle, port, home } = await startMgmt('d2e');
    const { wsId, proj } = await createWorkspace(port, 'd2e');
    try {
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'parent', mode: 'direct', content: '{"env":{}}' }),
        })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'child', derivedFrom: parent.config.id, derivedIndex: 1 }),
        });
        assert.equal(r.status, 201);
        assert.equal((await r.json()).config.derivedSnapshot, undefined);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D2: derived 父不存在 → 400', async () => {
    const { handle, port, home } = await startMgmt('d2parent');
    const { wsId, proj } = await createWorkspace(port, 'd2parent');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'child', derivedFrom: 'nope', derivedIndex: 1 }),
        });
        assert.equal(r.status, 400);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D2: derived derivedIndex 非法 → 400', async () => {
    const { handle, port, home } = await startMgmt('d2idx');
    const { wsId, proj } = await createWorkspace(port, 'd2idx');
    try {
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'p', content: PARENT_CONTENT }),
        })).json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', derivedFrom: parent.config.id, derivedIndex: 0 }),
        });
        assert.equal(r.status, 400);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D4 模型清单
// ════════════════════════════════════════════════════════════
test('D4a: model-catalog 聚合 config 的模型名', async () => {
    const { handle, port, home } = await startMgmt('d4a');
    const { wsId, proj } = await createWorkspace(port, 'd4a');
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c1', content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'model-a' } }) }),
        });
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/model-catalog`);
        const data = await r.json();
        assert.ok(data.catalog.includes('model-a'), `应含 model-a，got ${JSON.stringify(data.catalog)}`);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D4b: 无 config → 空清单', async () => {
    const { handle, port, home } = await startMgmt('d4b');
    const { wsId, proj } = await createWorkspace(port, 'd4b');
    try {
        const data = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/model-catalog`)).json();
        assert.deepEqual(data.catalog, []);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D3 别名转发（proxy 不真起，验证转发到不可达 proxy → 502）
// ════════════════════════════════════════════════════════════
test('D3c: alias 转发 proxy 不可达 → 502', async () => {
    // proxyPort 用一个没人监听的端口
    const { handle, port, home } = await startMgmt('d3c', { proxyPort: 19999 });
    const { wsId, proj } = await createWorkspace(port, 'd3c');
    const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'p', content: PARENT_CONTENT, derivedFrom: undefined, derivedIndex: undefined }),
    })).json();
    const child = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'c', derivedFrom: parent.config.id, derivedIndex: 1 }),
    })).json();
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${child.config.id}/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-1', model: 'real-model' }),
        });
        assert.equal(r.status, 502);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D5/D6 编辑页 + content
// ════════════════════════════════════════════════════════════
test('D5a: GET 编辑页（已有 config）→ HTML 含 name/content', async () => {
    const { handle, port, home } = await startMgmt('d5a');
    const { wsId, proj } = await createWorkspace(port, 'd5a');
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'edit-me', content: '{"env":{}}' }),
    })).json();
    try {
        const r = await fetch(`http://127.0.0.1:${port}/workspace/${wsId}/configs/${cfg.config.id}/edit`);
        assert.equal(r.status, 200);
        const html = await r.text();
        assert.ok(html.includes('edit-me'), '应含配置名');
        assert.ok(html.includes('textarea'), '应有 content textarea');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D5b: GET derived 编辑页 → HTML 含别名四档 + content 只读', async () => {
    const { handle, port, home } = await startMgmt('d5b');
    const { wsId, proj } = await createWorkspace(port, 'd5b');
    const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'p', content: PARENT_CONTENT }),
    })).json();
    const child = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'c', derivedFrom: parent.config.id, derivedIndex: 7 }),
    })).json();
    try {
        const r = await fetch(`http://127.0.0.1:${port}/workspace/${wsId}/configs/${child.config.id}/edit`);
        assert.equal(r.status, 200);
        const html = await r.text();
        // 别名是前端 JS 动态渲染（derivedBlock.innerHTML），静态 HTML 含 cfg 数据 + readonly
        assert.ok(html.includes('"derivedIndex":7'), '应含 derivedIndex 数据供前端渲染别名');
        assert.ok(html.includes('readonly'), 'content 应只读');
        assert.ok(html.includes('derivedBlock'), '应有 derived 渲染块');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D5: GET 新建配置编辑页 → HTML', async () => {
    const { handle, port, home } = await startMgmt('d5new');
    const { wsId, proj } = await createWorkspace(port, 'd5new');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/workspace/${wsId}/configs/new/edit`);
        assert.equal(r.status, 200);
        const html = await r.text();
        assert.ok(html.includes('textarea'));
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D6b: PUT derived 只更新 name（content 保留只读）', async () => {
    const { handle, port, home } = await startMgmt('d6b');
    const { wsId, proj } = await createWorkspace(port, 'd6b');
    const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'p', content: PARENT_CONTENT }),
    })).json();
    const child = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'c', derivedFrom: parent.config.id, derivedIndex: 1 }),
    })).json();
    try {
        // 前端 derived 更新只传 name（+ sessionContext1m）
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${child.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c-renamed', sessionContext1m: { main: true, haiku: false, sonnet: false, opus: false } }),
        });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.config.name, 'c-renamed');
        assert.equal(data.config.content, PARENT_CONTENT, 'derived content 应保留不变');
        assert.equal(data.config.derivedFrom, parent.config.id, 'derived 字段保留');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});
