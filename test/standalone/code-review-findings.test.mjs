// test/standalone/code-review-findings.test.mjs — 代码审查 TDD 确认（独立文件，不污染原测试）
//
// 运行：node --test test/standalone/code-review-findings.test.mjs
//
// 每个测试断言"bug 存在"或"期望正确行为"，FAILS=bug 真，PASSES=非 bug。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WM_JS = resolve(__dirname, '..', '..', 'standalone', 'workspaceManager.js');
const MS_JS = resolve(__dirname, '..', '..', 'standalone', 'managementServer.js');

const {
    WorkspaceManager,
    normalizeDir,
    generateWorkspaceId,
} = await import(pathToFileURL(WM_JS).href);
const { startManagementServer } = await import(pathToFileURL(MS_JS).href);

function newTmpHome(label) {
    return mkdtempSync(join(tmpdir(), `wm-review-${label}-`));
}
function newTmpProjectDir(label) {
    return mkdtempSync(join(tmpdir(), `proj-review-${label}-`));
}
function newManager(label) {
    const home = newTmpHome(label);
    return { home, mgr: new WorkspaceManager({ homeDir: home }) };
}

// ════════════════════════════════════════════════════════════
// S5/S6/S14: _transaction 链断裂 — fn 抛错后后续事务被静默跳过
// ════════════════════════════════════════════════════════════
test('S5: _transaction fn 抛错后，后续 create 仍能成功（链不应断裂）', async () => {
    const { mgr } = newManager('s5');
    const proj1 = newTmpProjectDir('s5-1');
    const proj2 = newTmpProjectDir('s5-2');

    // 第一次 create 成功
    await mgr.create('first', proj1);

    // 第二次 create 同一 dir → 抛错（"已注册"），fn 在 _transaction 内抛
    await assert.rejects(() => mgr.create('dup', proj1), /已注册/);

    // 第三次 create 用不同 dir —— 链断裂的话这个会被静默跳过，workspace=null，不写索引
    const result = await mgr.create('third', proj2);
    assert.ok(result.workspace, '第三次 create 应返回 workspace（链未断裂）');
    assert.equal(result.workspace.name, 'third');

    const list = await mgr.list();
    assert.equal(list.length, 2, '索引应含 2 条记录（first + third）');
});

test('S5b: _transaction fn 抛错后，后续 remove 仍能成功（链不应断裂）', async () => {
    const { mgr } = newManager('s5b');
    const proj1 = newTmpProjectDir('s5b-1');
    const proj2 = newTmpProjectDir('s5b-2');

    const { workspace: w1 } = await mgr.create('first', proj1);
    await mgr.create('second', proj2);

    // remove 不存在的 id → 抛错
    await assert.rejects(() => mgr.remove('ws_nonexist'), /workspace 不存在/);

    // remove 真实 id —— 链断裂的话会被跳过，返回 found=false
    const found = await mgr.remove(w1.id);
    assert.equal(found, true, 'remove 应成功（链未断裂）');
    const list = await mgr.list();
    assert.equal(list.length, 1, '应剩 1 条');
});

test('S5c: 连续多次事务失败后，链仍不断裂（压力验证）', async () => {
    const { mgr } = newManager('s5c');
    const proj1 = newTmpProjectDir('s5c-1');
    const proj2 = newTmpProjectDir('s5c-2');
    const proj3 = newTmpProjectDir('s5c-3');

    // 第一次 create 成功
    await mgr.create('first', proj1);

    // 连续 3 次失败：dup dir、remove nonexist、dup dir
    await assert.rejects(() => mgr.create('dup', proj1), /已注册/);
    await assert.rejects(() => mgr.remove('ws_nonexist1'), /workspace 不存在/);
    await assert.rejects(() => mgr.create('dup2', proj1), /已注册/);
    await assert.rejects(() => mgr.remove('ws_nonexist2'), /workspace 不存在/);

    // 链应仍能工作：create 新 dir + remove 真实 id
    const { workspace: w2 } = await mgr.create('second', proj2);
    assert.ok(w2, '连续失败后 create 仍应成功');
    const { workspace: w3 } = await mgr.create('third', proj3);
    assert.ok(w3, '第三次 create 也应成功');
    await mgr.remove(w2.id);
    const list = await mgr.list();
    assert.equal(list.length, 2, '应剩 first + third');
    assert.equal(list.find(w => w.id === w2.id), undefined, 'w2 应被删');
});

// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
test('S12: create 事务失败（dir 已注册）后 .claude_proxy 不应残留（或应可重试）', async () => {
    const { mgr } = newManager('s12');
    const proj = newTmpProjectDir('s12');

    // 第一次 create 成功
    const { created: created1 } = await mgr.create('first', proj);
    assert.equal(created1, true, '第一次应新建 .claude_proxy');

    // 第二次 create 同 dir → 事务内抛"已注册"，但 .claude_proxy 已在事务外建好
    // 问题是：如果第一次 create 的事务**失败**（非"已注册"，而是别的原因），
    // .claude_proxy 已建但索引没写 → 重试时 created=false（误报"复用"）
    // 这里模拟：手动删索引记录，再 create 同 dir
    const idx = await mgr.loadIndex();
    idx.workspaces = []; // 清空索引（模拟事务失败后索引无记录）
    await mgr.saveIndex(idx);

    // 此时 .claude_proxy 已存在（第一次建的），但索引无记录
    const { created: created2, workspace } = await mgr.create('retry', proj);
    // created2 会是 false（因为 .claude_proxy 已存在），但实际是"恢复"
    // 这不是数据损坏，但 created 标志语义不准
    assert.ok(workspace, '重试应能创建索引记录');
    // 期望：created 语义应反映"本次是否新建了 .claude_proxy"
    // 当前行为：created=false（因为 dir 存在），这是正确的（本次没新建）
    // 结论：非 bug，created 语义正确
    assert.equal(created2, false, '本次未新建 .claude_proxy（已存在）');
});

// ════════════════════════════════════════════════════════════
// S9: loadIndex 不校验 workspaces 元素结构 → null/非对象元素致 NPE
// ════════════════════════════════════════════════════════════
test('S9: 索引含 null 元素 → list 不应崩（应过滤或容错）', async () => {
    const { home, mgr } = newManager('s9');
    // 手写含 null 元素的索引
    writeFileSync(join(home, 'workspaces.json'), JSON.stringify({
        workspaces: [null, { id: 'ws_ok', name: 'ok', dir: '/tmp', createdAt: '2026-01-01' }],
    }), 'utf8');

    // list 会 sort → null.createdAt → (null.createdAt || '') → TypeError: Cannot read properties of null
    // 期望：应容错（过滤 null 或 try/catch）
    let list;
    try {
        list = await mgr.list();
    } catch (e) {
        // 如果崩了，说明 bug 真
        assert.fail(`list 不应崩，但抛了: ${e.message}`);
    }
    // 期望正确行为：过滤掉 null，返回有效记录
    assert.ok(Array.isArray(list), '应返回数组');
});

// ════════════════════════════════════════════════════════════
// S1: normalizeDir 根目录边界
// ════════════════════════════════════════════════════════════
test('S1: normalizeDir 根目录（/ 或 C:/）不应产生空串', () => {
    // win32 上 normalizeDir('C:/') → resolve → C:\ → split/join → C: → 去尾斜杠(长度>1且不以/结尾) → 小写 → c:
    // 这本身不崩，但 C:/ 和 C: 是否一致？
    const a = normalizeDir('C:/');
    const b = normalizeDir('C:');
    assert.equal(a, b, 'C:/ 和 C: 应归一为同值');
    assert.ok(a.length > 0, '不应为空串');
});

// ════════════════════════════════════════════════════════════
// S7: _doSave rename 失败后 tmp 文件残留
// ════════════════════════════════════════════════════════════
test('S7: saveIndex 成功后无 .tmp 残留文件', async () => {
    const { home, mgr } = newManager('s7');
    await mgr.saveIndex({ workspaces: [] });
    const files = fs.readdirSync(home);
    const tmpFiles = files.filter(f => f.startsWith('workspaces.json.tmp'));
    assert.equal(tmpFiles.length, 0, '不应有 .tmp 残留');
});

// ════════════════════════════════════════════════════════════
// S7b: saveIndex 失败后链不断裂（_transaction 仍能工作）
// ════════════════════════════════════════════════════════════
test('S7b: saveIndex 失败后，后续 _transaction 仍能工作（链不断裂）', async () => {
    const { mgr } = newManager('s7b');
    const proj = newTmpProjectDir('s7b');

    // 模拟 saveIndex 失败：替换 _doSave 让它抛错一次
    const origDoSave = mgr._doSave.bind(mgr);
    let failNext = true;
    mgr._doSave = async function(index) {
        if (failNext) {
            failNext = false;
            throw new Error('模拟 I/O 错误');
        }
        return origDoSave(index);
    };

    // saveIndex 失败
    await assert.rejects(() => mgr.saveIndex({ workspaces: [] }), /模拟 I\/O 错误/);

    // 恢复 _doSave
    mgr._doSave = origDoSave;

    // _transaction 应仍能工作（链未断裂）
    const { workspace } = await mgr.create('test', proj);
    assert.ok(workspace, 'saveIndex 失败后 create 仍应成功');
    const list = await mgr.list();
    assert.equal(list.length, 1, '索引应有 1 条');
});

// ════════════════════════════════════════════════════════════
// S3: POST 空 body → resolve({}) → create(undefined, undefined) → "name 不能为空"
// 这其实是合理行为，验证一下
// ════════════════════════════════════════════════════════════
test('S3: POST 空 body → 400 含 name 不能为空', async () => {
    const home = newTmpHome('s3');
    const port = 11760;
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: 11434 });
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '',
        });
        assert.equal(r.status, 400);
        const data = await r.json();
        assert.match(data.error, /name 不能为空/);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S16: 错误分类正则脆弱性 — body 缺 dir（有 name）→ 应 400
// ════════════════════════════════════════════════════════════
test('S16: POST 有 name 无 dir → 400（dir 不能为空 应被正则匹配）', async () => {
    const home = newTmpHome('s16');
    const port = 11761;
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: 11434 });
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x' }), // 无 dir
        });
        assert.equal(r.status, 400, 'dir 不能为空 应匹配正则 → 400');
        const data = await r.json();
        assert.match(data.error, /dir 不能为空/);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S18: 网页 HTML 配置名 XSS — innerHTML 拼接用户可控的 c.name
// ════════════════════════════════════════════════════════════
test('S18: buildWorkspacesHtml 不应在配置渲染处直接 innerHTML 拼接（XSS）', async () => {
    const { buildWorkspacesHtml } = await import(pathToFileURL(
        resolve(__dirname, '..', '..', 'standalone', 'web', 'workspaces-html.js')
    ).href);
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11434 });
    // 修复后：配置渲染处应使用 textContent/createTextNode，不直接 innerHTML 拼接用户数据
    // 检查不再存在未转义的 c.innerHTML = 'Local 配置（' 拼接
    const hasUnsafeConfigInner = html.includes("c.innerHTML = 'Local 配置")
        || /\.innerHTML\s*=\s*['\"`].*\+\s*\(c\.name/i.test(html);
    assert.ok(!hasUnsafeConfigInner, '配置渲染处不应有未转义 innerHTML 拼接用户数据（已修）');
});

// ════════════════════════════════════════════════════════════
// S19: GET /api/workspaces/:id 的 :id 含特殊字符 / decodeURIComponent
// ════════════════════════════════════════════════════════════
test('S19: GET /api/workspaces/ws_test%2Fpath → 404（不匹配路由，不注入）', async () => {
    const home = newTmpHome('s19');
    const port = 11762;
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: 11434 });
    try {
        // %2F = /，decodeURIComponent 后 id = "ws_test/path"
        // 路由正则 ^/api/workspaces/([^/]+)$ 在 decode 前匹配
        // pathname 是 /api/workspaces/ws_test%2Fpath → [^/]+ 匹配 ws_test%2Fpath
        // decode 后 id = ws_test/path → get(id) → null → 404
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_test%2Fpath`);
        assert.equal(r.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S20: POST name/dir 为非字符串（数字/对象）→ String() 隐式转换
// ════════════════════════════════════════════════════════════
test('S20: POST name=数字 123 → 应被拒绝或正确处理（不隐式转 "123"）', async () => {
    const home = newTmpHome('s20');
    const port = 11763;
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: 11434 });
    const proj = newTmpProjectDir('s20');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 123, dir: proj }), // name 是数字
        });
        // 当前行为：String(123).trim() = "123" → 接受
        // 期望：name 应为字符串类型，数字应拒绝（或接受但记录为字符串）
        // 当前会接受 → workspace.name = "123"
        const data = await r.json();
        if (r.ok) {
            assert.equal(typeof data.workspace.name, 'string', 'name 应为字符串');
            assert.equal(data.workspace.name, '123');
        } else {
            assert.equal(r.status, 400);
        }
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S21: 并发 create + remove 同一 id → remove 可能在 create 前跑（时序）
// ════════════════════════════════════════════════════════════
test('S21: 并发 create + remove 混合 → 索引最终一致（不丢不重）', async () => {
    const { mgr } = newManager('s21');
    const projs = Array.from({ length: 10 }, (_, i) => newTmpProjectDir(`s21-${i}`));

    // 先 create 一个，拿 id
    const { workspace: w0 } = await mgr.create('p0', projs[0]);

    // 并发：create p1-p9 + remove w0
    const ops = [
        ...projs.slice(1).map((p, i) => mgr.create(`p${i + 1}`, p)),
        mgr.remove(w0.id),
    ];
    await Promise.all(ops);

    const list = await mgr.list();
    // 期望：9 个（p1-p9），w0 被删
    assert.equal(list.length, 9, `应剩 9 条，实际 ${list.length}`);
    assert.equal(list.find(w => w.id === w0.id), undefined, 'w0 应被删');
});

// ════════════════════════════════════════════════════════════
// S22: management API DELETE 并发同一 id → 第二个应 404 不 500
// ════════════════════════════════════════════════════════════
test('S22: 并发 DELETE 同一 id → 一个 200 一个 404，不 500', async () => {
    const home = newTmpHome('s22');
    const port = 11764;
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: 11434 });
    const proj = newTmpProjectDir('s22');
    try {
        const cr = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'del', dir: proj }),
        });
        const { workspace } = await cr.json();

        // 并发 DELETE 同一 id
        const [r1, r2] = await Promise.all([
            fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}`, { method: 'DELETE' }),
            fetch(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}`, { method: 'DELETE' }),
        ]);

        const statuses = [r1.status, r2.status].sort();
        // 期望：一个 200 一个 404
        // 但 managementServer 先 get 判断存在再 remove，两个并发请求都 get 到存在，
        // 都进 remove → 第二个 remove 抛"workspace 不存在" → 500（正则不匹配）
        // 这是 bug：并发 DELETE 同一 id 会 500
        assert.ok(statuses.includes(200), `至少一个应 200，实际 ${statuses}`);
        // 第二个不应 500（应是 404）
        const non200 = statuses.filter(s => s !== 200);
        for (const s of non200) {
            assert.equal(s, 404, `非 200 应为 404，实际 ${s}（并发 DELETE bug）`);
        }
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// S23: readJsonBody 超限后 req.destroy → 后续 data 事件不再触发（验证不崩）
// ════════════════════════════════════════════════════════════
test('S23: POST body >1MB → 400 请求体过大', async () => {
    const home = newTmpHome('s23');
    const port = 11765;
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: 11434 });
    try {
        const big = '{"name":"x","dir":"' + 'A'.repeat(2 * 1024 * 1024) + '"}';
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: big,
        });
        assert.equal(r.status, 400);
        const data = await r.json();
        assert.match(data.error, /请求体过大/);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});
