// test/standalone/config-editor.test.mjs — 阶段4: 配置编辑 API 测试
//
// 运行：node --test test/standalone/config-editor.test.mjs
//
// 维度覆盖（派生/别名已移除，2026-08——见 docs/plan/tmp/2026-08-03-stage4-config-editor.md 旧版）：
//   D1 local config CRUD（普通配置；legacy derived 字段被忽略/剥离）
//   D2 legacy 派生字段创建时忽略
//   D3 alias 路由已移除 → 404
//   D4 model-catalog 路由已移除 → 404
//   D5/D6 编辑页 + content（HTML 路由 + JSON 校验；无派生 UI）

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

// 重命名 config：只改 name，content 保留（updateLocalConfig 用 ...existing 保留）；
// 且 legacy 派生字段（derivedFrom/derivedIndex）不会被 PUT 新增持久化。
test('D1h: 重命名 config → name 变，content 保留，legacy 派生字段不入库', async () => {
    const { handle, port, home } = await startMgmt('d1h');
    const { wsId, proj } = await createWorkspace(port, 'd1h');
    try {
        const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'orig', mode: 'proxy', content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'm' } }) }),
        })).json();
        // 重命名（同时传 legacy 派生字段 → 应被忽略）
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'new-name', derivedFrom: 'p', derivedIndex: 5 }),
        });
        assert.equal(r.status, 200);
        const updated = (await r.json()).config;
        assert.equal(updated.name, 'new-name', 'name 应更新');
        assert.equal(updated.derivedIndex, undefined, 'legacy derivedIndex 不应被持久化');
        assert.equal(updated.derivedFrom, undefined, 'legacy derivedFrom 不应被持久化');
        assert.ok(updated.content.includes('ANTHROPIC_MODEL'), 'content 应保留');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// 删除 config：普通 config 删除正常；legacy derived 节点（文件里残留）不可见 → DELETE 404
test('D1i: DELETE 普通 config → 200；legacy derived 残留 → 404（剥离不可见）', async () => {
    const { handle, port, home } = await startMgmt('d1i');
    const { wsId, proj } = await createWorkspace(port, 'd1i');
    try {
        const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c', content: '{}' }),
        })).json();
        // 手写 legacy derived 节点到文件（派生已移除：load 剥离）
        const derivedId = 'derived-test-d1i';
        const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
        const arr = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'));
        arr.push({
            id: derivedId, name: 'deriv', content: '{}', mode: 'proxy',
            updatedAt: '2026-01-01T00:00:00Z', derivedFrom: cfg.config.id, derivedIndex: 1,
            modelAliases: { main: 'x' },
        });
        fs.writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
        // legacy derived 不可见 → DELETE 404
        const rd = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}`, { method: 'DELETE' });
        assert.equal(rd.status, 404, 'legacy derived 节点应被剥离，DELETE 404');
        // 普通 config 删除正常 + 列表减少
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}`, { method: 'DELETE' });
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
// D2 legacy 派生字段创建时忽略（派生配置已移除，2026-08）
// ════════════════════════════════════════════════════════════
const PARENT_CONTENT = JSON.stringify({
    env: {
        ANTHROPIC_BASE_URL: 'http://upstream',
        ANTHROPIC_AUTH_TOKEN: 'tok',
        ANTHROPIC_MODEL: 'claude-x',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-x',
    },
});

test('D2a: 创建带 legacy derived 字段 → 按普通 config 处理（忽略字段）', async () => {
    const { handle, port, home } = await startMgmt('d2a');
    const { wsId, proj } = await createWorkspace(port, 'd2a');
    try {
        const parent = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'parent', mode: 'proxy', content: PARENT_CONTENT }),
        })).json();
        // 旧客户端/残留数据带 derivedFrom/derivedIndex → 忽略，创建为普通 config
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'child', mode: 'proxy', content: PARENT_CONTENT, derivedFrom: parent.config.id, derivedIndex: 1 }),
        });
        assert.equal(r.status, 201);
        const data = await r.json();
        assert.equal(data.config.derivedFrom, undefined, 'derivedFrom 不应被持久化');
        assert.equal(data.config.derivedIndex, undefined, 'derivedIndex 不应被持久化');
        assert.equal(data.config.modelAliases, undefined, 'modelAliases 不应存在');
        assert.equal(data.config.mode, 'proxy', 'mode 按 body 归一');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D2e: 创建只需 name + content（无派生逻辑，无快照/别名）', async () => {
    const { handle, port, home } = await startMgmt('d2e');
    const { wsId, proj } = await createWorkspace(port, 'd2e');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'plain', mode: 'direct', content: '{"env":{}}' }),
        });
        assert.equal(r.status, 201);
        const c = (await r.json()).config;
        assert.equal(c.derivedSnapshot, undefined, '无快照字段');
        assert.equal(c.derivedFrom, undefined, '无 derivedFrom');
        assert.equal(c.mode, 'direct');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D2f: 创建缺 content → 400（content 必填，无 derived 分支）', async () => {
    const { handle, port, home } = await startMgmt('d2f');
    const { wsId, proj } = await createWorkspace(port, 'd2f');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'child', derivedFrom: 'nope', derivedIndex: 1 }),
        });
        assert.equal(r.status, 400, '缺 content 应 400（不再有"父不存在"派生校验，纯普通创建）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D4 model-catalog 路由已移除（派生/别名删除，2026-08）→ 404
// ════════════════════════════════════════════════════════════
test('D4a: model-catalog 路由已移除 → 404', async () => {
    const { handle, port, home } = await startMgmt('d4a');
    const { wsId, proj } = await createWorkspace(port, 'd4a');
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c1', content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'model-a' } }) }),
        });
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/model-catalog`);
        assert.equal(r.status, 404, 'model-catalog 路由应已移除（404）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D4b: 无 config 的 workspace model-catalog 也 404', async () => {
    const { handle, port, home } = await startMgmt('d4b');
    const { wsId, proj } = await createWorkspace(port, 'd4b');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/model-catalog`);
        assert.equal(r.status, 404, '即使无 config，路由已移除也应 404');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D3 alias 转发路由已移除 → 404
// ════════════════════════════════════════════════════════════
test('D3c: alias 路由已移除 → POST /configs/:id/alias 404', async () => {
    const { handle, port, home } = await startMgmt('d3c', { proxyPort: 19999 });
    const { wsId, proj } = await createWorkspace(port, 'd3c');
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'c', content: PARENT_CONTENT }),
    })).json();
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}/alias`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alias: 'ccp-main-1', model: 'real-model' }),
        });
        assert.equal(r.status, 404, 'alias 路由应已移除（404），不再转发代理');
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

test('D5b: GET 编辑页（普通 config）→ HTML 含 name/content，无派生渲染块', async () => {
    const { handle, port, home } = await startMgmt('d5b');
    const { wsId, proj } = await createWorkspace(port, 'd5b');
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'c', content: PARENT_CONTENT }),
    })).json();
    try {
        const r = await fetch(`http://127.0.0.1:${port}/workspace/${wsId}/configs/${cfg.config.id}/edit`);
        assert.equal(r.status, 200);
        const html = await r.text();
        assert.ok(html.includes('c'), '应含配置名');
        assert.ok(!html.includes('derivedBlock'), '派生已移除：不应有 derived 渲染块');
        assert.ok(!html.includes('readonly'), '派生已移除：content 不应只读');
        assert.ok(!html.includes('/alias'), '派生已移除：不应有 alias 端点引用');
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

test('D6b: PUT 只更新 name（content 保留），legacy 派生字段不入库', async () => {
    const { handle, port, home } = await startMgmt('d6b');
    const { wsId, proj } = await createWorkspace(port, 'd6b');
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'c', content: PARENT_CONTENT }),
    })).json();
    try {
        // 更新只传 name（+ legacy 派生字段 → 应忽略）
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.config.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'c-renamed', sessionContext1m: { main: true, haiku: false, sonnet: false, opus: false } }),
        });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.config.name, 'c-renamed');
        assert.equal(data.config.content, PARENT_CONTENT, 'content 应保留不变');
        assert.equal(data.config.sessionContext1m, undefined, 'legacy sessionContext1m 不应被持久化');
        assert.equal(data.config.derivedFrom, undefined, 'legacy derivedFrom 不应被持久化');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});
