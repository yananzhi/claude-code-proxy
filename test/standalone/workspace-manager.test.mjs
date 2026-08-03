// test/standalone/workspace-manager.test.mjs — 阶段2: WorkspaceManager + management API 测试
//
// 运行：node --test test/standalone/workspace-manager.test.mjs
//
// 维度覆盖（见 plan/tmp/2026-08-03-stage2-workspace-manager.md）：
//   D1 索引读写（不存在/已存在/损坏不崩）
//   D2 创建（dir 存在/不存在/已注册/name 缺失/.claude_proxy 已存在复用）
//   D3 删除（id 存在/不存在/磁盘保留）
//   D4 路径归一化（尾斜杠/分隔符/相对/大小写）
//   D5 management API（GET/POST/DELETE 各路由 + 错误路径）
//   D6 id 生成（格式/唯一）
//   D7 索引并发写（原子写不丢记录）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WM_JS = resolve(__dirname, '..', '..', 'standalone', 'workspaceManager.js');
const MS_JS = resolve(__dirname, '..', '..', 'standalone', 'managementServer.js');
const PORTS_JS = resolve(__dirname, '..', '..', 'standalone', 'ports.js');

const {
    WorkspaceManager,
    normalizeDir,
    generateWorkspaceId,
    resolveHome,
} = await import(pathToFileURL(WM_JS).href);
const { startManagementServer } = await import(pathToFileURL(MS_JS).href);
const { managementPort } = await import(pathToFileURL(PORTS_JS).href);

/** 造临时 home + 可选预建项目目录。 */
function newTmpHome(label) {
    return mkdtempSync(join(tmpdir(), `wm-${label}-`));
}
function newTmpProjectDir(label) {
    const d = mkdtempSync(join(tmpdir(), `proj-${label}-`));
    return d;
}
import { join } from 'node:path';

/** 在临时 home 里建 WorkspaceManager。 */
function newManager(label) {
    const home = newTmpHome(label);
    return { home, mgr: new WorkspaceManager({ homeDir: home }) };
}

// ════════════════════════════════════════════════════════════
// D6 id 生成
// ════════════════════════════════════════════════════════════
test('D6: generateWorkspaceId 格式 ws_ + 8 位 hex', () => {
    const id = generateWorkspaceId();
    assert.match(id, /^ws_[0-9a-f]{8}$/, '应匹配 ws_ + 8 hex');
});
test('D6: generateWorkspaceId 多次不撞（查重兜底在 create 里）', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(generateWorkspaceId());
    assert.equal(ids.size, 100, '100 次应全唯一（概率上）');
});

// ════════════════════════════════════════════════════════════
// D4 路径归一化
// ════════════════════════════════════════════════════════════
test('D4a: 尾斜杠归一（D:/a/b 与 D:/a/b/ 视为同）', () => {
    assert.equal(normalizeDir('D:/a/b'), normalizeDir('D:/a/b/'));
});
test('D4b: 分隔符归一（D:/a/b 与 D:\\\\a\\\\b 视为同）', () => {
    assert.equal(normalizeDir('D:/a/b'), normalizeDir('D:\\\\a\\\\b'));
});
test('D4c: 相对路径 resolve 成绝对', () => {
    const rel = normalizeDir('./a');
    const abs = normalizeDir(join(process.cwd(), 'a'));
    assert.equal(rel, abs);
});

// ════════════════════════════════════════════════════════════
// D1 索引读写
// ════════════════════════════════════════════════════════════
test('D1a: 索引不存在 → list 返回 []', async () => {
    const { mgr } = newManager('d1a');
    const list = await mgr.list();
    assert.deepEqual(list, []);
});
test('D1c: 索引损坏 JSON → list 不崩返回 []', async () => {
    const { home, mgr } = newManager('d1c');
    writeFileSync(join(home, 'workspaces.json'), '{ not valid json', 'utf8');
    const list = await mgr.list();
    assert.deepEqual(list, []);
});

// ════════════════════════════════════════════════════════════
// D2 创建
// ════════════════════════════════════════════════════════════
test('D2a: dir 存在 + 未注册 → 创建成功 + .claude_proxy 生成 + 索引含记录', async () => {
    const { mgr } = newManager('d2a');
    const proj = newTmpProjectDir('d2a');
    const { workspace, created } = await mgr.create('my-project', proj);
    assert.equal(created, true, '应新建 .claude_proxy');
    assert.ok(existsSync(join(proj, '.claude_proxy')), '.claude_proxy 应生成');
    assert.match(workspace.id, /^ws_[0-9a-f]{8}$/);
    assert.equal(workspace.name, 'my-project');
    assert.equal(workspace.dir, resolve(proj));
    const list = await mgr.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, workspace.id);
});

test('D2b: dir 不存在 → 拒绝', async () => {
    const { mgr } = newManager('d2b');
    await assert.rejects(
        () => mgr.create('x', join(tmpdir(), 'nonexistent-' + Date.now())),
        /目录不存在/,
    );
});

test('D2c: dir 已注册 → 拒绝（一对一）', async () => {
    const { mgr } = newManager('d2c');
    const proj = newTmpProjectDir('d2c');
    await mgr.create('first', proj);
    await assert.rejects(
        () => mgr.create('second', proj),
        /已注册/,
    );
    const list = await mgr.list();
    assert.equal(list.length, 1, '第二次应未创建');
});

test('D2d: name 缺失 → 拒绝', async () => {
    const { mgr } = newManager('d2d');
    const proj = newTmpProjectDir('d2d');
    await assert.rejects(() => mgr.create('', proj), /name 不能为空/);
    await assert.rejects(() => mgr.create('   ', proj), /name 不能为空/);
});

test('D2e: .claude_proxy 已存在 → 复用不报错（created=false）', async () => {
    const { mgr } = newManager('d2e');
    const proj = newTmpProjectDir('d2e');
    mkdirSync(join(proj, '.claude_proxy'), { recursive: true }); // 预先存在
    const { created } = await mgr.create('reuse', proj);
    assert.equal(created, false, '复用已有 .claude_proxy');
});

// ════════════════════════════════════════════════════════════
// D3 删除
// ════════════════════════════════════════════════════════════
test('D3a: 删除 id 存在 → 索引移除 + 磁盘保留', async () => {
    const { mgr } = newManager('d3a');
    const proj = newTmpProjectDir('d3a');
    const { workspace } = await mgr.create('del', proj);
    await mgr.remove(workspace.id);
    const list = await mgr.list();
    assert.equal(list.length, 0);
    assert.ok(existsSync(join(proj, '.claude_proxy')), '磁盘 .claude_proxy 应保留');
});

test('D3b: 删除 id 不存在 → 拒绝', async () => {
    const { mgr } = newManager('d3b');
    await assert.rejects(() => mgr.remove('ws_nonexist'), /workspace 不存在/);
});

// ════════════════════════════════════════════════════════════
// D7 索引并发写（原子写不丢记录）
// ════════════════════════════════════════════════════════════
test('D7: 并发创建多个 workspace → 索引不丢记录', async () => {
    const { mgr } = newManager('d7');
    const projs = Array.from({ length: 5 }, (_, i) => newTmpProjectDir(`d7-${i}`));
    // 并发 create（每个不同 dir，不触发一对一冲突）
    await Promise.all(projs.map((p, i) => mgr.create(`p${i}`, p)));
    const list = await mgr.list();
    assert.equal(list.length, 5, '5 个并发创建都应保留');
});

// ════════════════════════════════════════════════════════════
// getLocalConfigs（复用 LocalConfigStore）
// ════════════════════════════════════════════════════════════
test('getLocalConfigs: 无 local 配置 → 空数组', async () => {
    const { mgr } = newManager('cfgs');
    const proj = newTmpProjectDir('cfgs');
    const { workspace } = await mgr.create('c', proj);
    const cfgs = await mgr.getLocalConfigs(workspace.id);
    assert.deepEqual(cfgs, []);
});

// ════════════════════════════════════════════════════════════
// D5 management API（用真实 HTTP server）
// ════════════════════════════════════════════════════════════
let mgmtHandle = null;
async function startMgmt(label) {
    const home = newTmpHome(label);
    const port = 11700 + (Math.floor(Math.random() * 50)); // 11700-11749 避开保留段
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: 11434 });
    mgmtHandle = { handle, home, port };
    return mgmtHandle;
}

test('D5a: GET /api/workspaces → 200 + 列表', async () => {
    const { handle, port } = await startMgmt('d5a');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`);
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.deepEqual(data.workspaces, []);
    } finally {
        await handle.stop();
        rmSync(mgmtHandle.home, { recursive: true, force: true });
    }
});

test('D5b: POST /api/workspaces 合法 → 201', async () => {
    const { handle, port, home } = await startMgmt('d5b');
    const proj = newTmpProjectDir('d5b');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'api-proj', dir: proj }),
        });
        assert.equal(r.status, 201);
        const data = await r.json();
        assert.equal(data.workspace.name, 'api-proj');
        assert.ok(data.created);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D5c: POST /api/workspaces 非法（dir 不存在）→ 400', async () => {
    const { handle, port, home } = await startMgmt('d5c');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x', dir: join(tmpdir(), 'no-such-' + Date.now()) }),
        });
        assert.equal(r.status, 400);
        const data = await r.json();
        assert.match(data.error, /目录不存在/);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

test('D5c2: POST body 非 JSON → 400', async () => {
    const { handle, port, home } = await startMgmt('d5c2');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{ not json',
        });
        assert.equal(r.status, 400);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

test('D5d+e: DELETE 存在 → 200；不存在 → 404', async () => {
    const { handle, port, home } = await startMgmt('d5de');
    const proj = newTmpProjectDir('d5de');
    try {
        const cr = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'del', dir: proj }),
        });
        const { workspace } = await cr.json();
        const dr = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}`, { method: 'DELETE' });
        assert.equal(dr.status, 200);
        const dr2 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}`, { method: 'DELETE' });
        assert.equal(dr2.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D5f: GET /api/workspaces/:id → 200 + configs', async () => {
    const { handle, port, home } = await startMgmt('d5f');
    const proj = newTmpProjectDir('d5f');
    try {
        const cr = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'get', dir: proj }),
        });
        const { workspace } = await cr.json();
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}`);
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.workspace.id, workspace.id);
        assert.deepEqual(data.configs, []);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('D5g: 未知路由 → 404', async () => {
    const { handle, port, home } = await startMgmt('d5g');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/nonexistent`);
        assert.equal(r.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

test('D5h: GET / → 管理网页 HTML', async () => {
    const { handle, port, home } = await startMgmt('d5h');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(r.status, 200);
        const html = await r.text();
        assert.ok(html.includes('Workspace 管理'), '应含标题');
        assert.ok(html.includes('新建 Workspace'), '应含创建表单');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// managementPort 端口策略
// ════════════════════════════════════════════════════════════
test('managementPort: win32 → 11534（proxy 11434 + 100）', () => {
    assert.equal(managementPort('win32'), 11534);
});
test('managementPort: linux → 11535', () => {
    assert.equal(managementPort('linux'), 11535);
});
test('managementPort: darwin → 11536', () => {
    assert.equal(managementPort('darwin'), 11536);
});
