// test/standalone/activate-config.test.mjs — 阶段6: 激活写 settings.json 测试
//
// 运行：node --test test/standalone/activate-config.test.mjs
//
// 重设计（回退 2026-08-14）：settings.json 是 CLI 会话路由的唯一事实源，激活即写文件。
// activateConfig：direct=原样 content；proxy=校验+注入 upstream+合成 localhost settings。
// 写 active 标记 + ensureProjectPermissions + ensureGitignore（与 VS Code 侧 launcher 对齐）。
//
// 维度覆盖（见 docs/plan/tmp/2026-08-14-revert-activate-settings.md D1-D3）：
//   A 激活行为（正常/404/legacy derived 剥离）
//   B 副作用（settings.json 写入 / permissions / gitignore / proxy 注入）
//   C 激活读取（GET /active）
//   D 幂等
//   E 边界（content 非法/direct 缺字段）
//   F 审查 TDD（悬空指针/类型安全/错误路径/副作用完整性）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MS_JS = resolve(__dirname, '..', '..', 'standalone', 'managementServer.js');
const { startManagementServer } = await import(pathToFileURL(MS_JS).href);

let mgmtSeq = 0;
async function startMgmt(label, opts = {}) {
    const home = mkdtempSync(join(tmpdir(), `s6-${label}-`));
    const port = 12000 + (mgmtSeq++ % 40);
    // proxyPort 默认 19998（无人监听）——proxy 模式激活会调 POST /api/upstream → 502。
    // direct 模式不调代理，proxyPort 仅占位。proxy 成功路径在 terminal-env.test.mjs 用 mock 覆盖。
    const handle = await startManagementServer({ homeDir: home, port, proxyPort: opts.proxyPort ?? 19998 });
    return { handle, home, port };
}
function newTmpProject(label) {
    return mkdtempSync(join(tmpdir(), `s6proj-${label}-`));
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
async function createConfig(port, wsId, cfg) {
    const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
    });
    return (await r.json()).config;
}
/** 手写派生 config 到 local-configs.json（绕过依赖代理 next-alias-id 的创建流程）。 */
function injectDerivedConfig(proj, derivedCfg) {
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    arr.push(derivedCfg);
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
}

const DIRECT_CONTENT = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://direct-up', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'm' } });

// ════════════════════════════════════════════════════════════
// A 激活行为
// ════════════════════════════════════════════════════════════
test('A1: 激活 normal config → activated:true + active 写入 + settings.json 原样写', async () => {
    const { handle, port, home } = await startMgmt('a1');
    const { wsId, proj } = await createWorkspace(port, 'a1');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.activated, true);
        assert.equal(data.mode, 'direct');
        assert.ok(data.settingsPath, '应返回 settingsPath');
        // settings.json 原样写 content（direct 唯一事实源）
        const written = JSON.parse(readFileSync(join(proj, '.claude_proxy', 'settings.json'), 'utf8'));
        assert.equal(written.env.ANTHROPIC_BASE_URL, 'http://direct-up', 'direct 应原样写上游真实地址');
        assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, 'tok');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('A2: config 不存在 → 404', async () => {
    const { handle, port, home } = await startMgmt('a2');
    const { wsId, proj } = await createWorkspace(port, 'a2');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/cfg_nope/activate`, { method: 'POST' });
        assert.equal(r.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('A3: workspace 不存在 → 404', async () => {
    const { handle, port, home } = await startMgmt('a3');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws_nope/configs/cfg_nope/activate`, { method: 'POST' });
        assert.equal(r.status, 404);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

test('A4: legacy derived 配置被 load 剥离 → 不可激活（404），父 config 正常可激活', async () => {
    const { handle, port, home } = await startMgmt('a4');
    const { wsId, proj } = await createWorkspace(port, 'a4');
    const parent = await createConfig(port, wsId, { name: 'parent', mode: 'proxy', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://up', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'pm' } }) });
    // 手写 legacy derived 配置到文件（派生已移除：load 时剥离 derivedFrom 非空节点）
    const derivedId = 'derived-test-a4';
    injectDerivedConfig(proj, {
        id: derivedId, name: 'deriv', content: parent.content, mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: parent.id, derivedIndex: 1,
        modelAliases: { main: 'pm' },
        sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'http://up', token: 'tok', mode: 'proxy' },
    });
    try {
        // legacy derived 配置在存储层不可见 → 激活 404
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}/activate`, { method: 'POST' });
        assert.equal(r.status, 404, 'legacy derived 配置应被剥离，不可激活');
        // 父 config 不受影响，正常可激活（proxy 模式走不可达代理 → 502，但应到注入环节而非 404）
        const r2 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${parent.id}/activate`, { method: 'POST' });
        assert.notEqual(r2.status, 404, '父 config 应能进入激活流程（proxy 注入失败 → 502 而非 404）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// B 副作用（核心验证：激活即写 settings.json + permissions + gitignore；proxy 注入 upstream）
// ════════════════════════════════════════════════════════════
test('B1: 激活后 .claude_proxy/settings.json 被创建（内容 = content）', async () => {
    const { handle, port, home } = await startMgmt('b1');
    const { wsId, proj } = await createWorkspace(port, 'b1');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.ok(existsSync(join(proj, '.claude_proxy', 'settings.json')), '激活应写 settings.json');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('B2: 激活后 .claude/settings.local.json 被创建（permissions 写入）', async () => {
    const { handle, port, home } = await startMgmt('b2');
    const { wsId, proj } = await createWorkspace(port, 'b2');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.ok(existsSync(join(proj, '.claude', 'settings.local.json')), '激活应写 .claude/settings.local.json');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('B3: git 仓库激活后 .gitignore 被创建（含 .claude_proxy/）', async () => {
    const { handle, port, home } = await startMgmt('b3');
    const { wsId, proj } = await createWorkspace(port, 'b3');
    mkdirSync(join(proj, '.git'), { recursive: true }); // 造 git 仓库
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.ok(existsSync(join(proj, '.gitignore')), 'git 仓库激活应创建 .gitignore');
        assert.ok(readFileSync(join(proj, '.gitignore'), 'utf8').includes('.claude_proxy'), '.gitignore 应含 .claude_proxy/');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('B4: proxy 模式激活 → 注入 upstream（代理不可达 → 502，不假成功）', async () => {
    // proxyPort 指向无人监听端口；proxy 激活调 POST /api/upstream → ECONNREFUSED → ProxyUnavailableError → 502。
    // 期望 502（代理不可达不假成功），且 settings.json 未被写（注入失败即中止）。
    const { handle, port, home } = await startMgmt('b4', { proxyPort: 19997 });
    const { wsId, proj } = await createWorkspace(port, 'b4');
    const cfg = await createConfig(port, wsId, { name: 'p', mode: 'proxy', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://up', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'pm' } }) });
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.equal(r.status, 502, 'proxy 模式代理不可达应 502（注入失败不假成功）');
        assert.ok(!existsSync(join(proj, '.claude_proxy', 'settings.json')), '注入失败不应写 settings.json');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// C 激活读取
// ════════════════════════════════════════════════════════════
test('C1: 激活后 GET /active 返回标记', async () => {
    const { handle, port, home } = await startMgmt('c1');
    const { wsId, proj } = await createWorkspace(port, 'c1');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        const data = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/active`)).json();
        assert.equal(data.active.id, cfg.id);
        assert.equal(data.active.mode, 'direct');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('C2: 无激活 → GET /active 返回 null', async () => {
    const { handle, port, home } = await startMgmt('c2');
    const { wsId, proj } = await createWorkspace(port, 'c2');
    try {
        const data = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/active`)).json();
        assert.equal(data.active, null);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('C3: 切换激活到另一 config → active 更新 + settings.json 更新', async () => {
    const { handle, port, home } = await startMgmt('c3');
    const { wsId, proj } = await createWorkspace(port, 'c3');
    const cfg1 = await createConfig(port, wsId, { name: 'c1', mode: 'direct', content: DIRECT_CONTENT });
    const cfg2 = await createConfig(port, wsId, { name: 'c2', mode: 'direct', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://c2', ANTHROPIC_AUTH_TOKEN: 't' } }) });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg1.id}/activate`, { method: 'POST' });
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg2.id}/activate`, { method: 'POST' });
        const data = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/active`)).json();
        assert.equal(data.active.id, cfg2.id, '应切换到 cfg2');
        const written = JSON.parse(readFileSync(join(proj, '.claude_proxy', 'settings.json'), 'utf8'));
        assert.equal(written.env.ANTHROPIC_BASE_URL, 'http://c2', 'settings.json 应跟随新激活配置');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D 幂等
// ════════════════════════════════════════════════════════════
test('D1: 重复激活同 config → active 不变（幂等）', async () => {
    const { handle, port, home } = await startMgmt('d1');
    const { wsId, proj } = await createWorkspace(port, 'd1');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        const data = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/active`)).json();
        assert.equal(data.active.id, cfg.id);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// E 边界（direct 不解析 content 原样写；proxy 校验 + 注入）
// ════════════════════════════════════════════════════════════
test('E1: direct content 非法 JSON → 原样写入 settings.json（direct 不解析 content）', async () => {
    const { handle, port, home } = await startMgmt('e1');
    const { wsId, proj } = await createWorkspace(port, 'e1');
    // 先建合法 config，再手改 local-configs.json 让 content 坏
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    // 直接改 local-configs.json 让 content 变坏 JSON
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    arr[0].content = '{ not valid json';
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        // direct 原样写 content（不解析校验），激活成功；content 坏 JSON 由 CLI 自己处理
        assert.equal(r.status, 200, 'direct 激活不解析 content（原样写，不报错）');
        const data = await r.json();
        assert.equal(data.activated, true);
        assert.equal(readFileSync(join(proj, '.claude_proxy', 'settings.json'), 'utf8'), '{ not valid json', 'settings.json 应原样写入坏 content');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('E2: proxy 缺 BASE_URL → 400（proxy 激活校验 content）', async () => {
    const { handle, port, home } = await startMgmt('e2');
    const { wsId, proj } = await createWorkspace(port, 'e2');
    // content 合法 JSON 但缺 BASE_URL（proxy 激活校验 → 400）
    const cfg = await createConfig(port, wsId, { name: 'p', mode: 'proxy', content: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'tok' } }) });
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.equal(r.status, 400, 'proxy 激活缺 BASE_URL 应 400');
        const d = await r.json();
        assert.match(d.error, /BASE_URL|TOKEN/, '应提示缺 BASE_URL/TOKEN');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// F 审查 TDD：边界/状态转换/一致性
// ════════════════════════════════════════════════════════════

// F1（派生已移除，2026-08）：legacy derived 节点被 load 剥离后，不干扰普通 config 的激活与 workspace 级起终端。
test('F1: legacy derived 残留条目不干扰普通 config 激活与读取', async () => {
    const { handle, port, home } = await startMgmt('f1');
    const { wsId, proj } = await createWorkspace(port, 'f1');
    const parent = await createConfig(port, wsId, { name: 'parent', mode: 'direct', content: DIRECT_CONTENT });
    const derivedId = 'derived-test-f1';
    injectDerivedConfig(proj, {
        id: derivedId, name: 'deriv', content: parent.content, mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: parent.id, derivedIndex: 1,
        modelAliases: { main: 'pm' },
        sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'http://up', token: 'tok', mode: 'proxy' },
    });
    try {
        // 激活普通 config：正常成功（不受文件里 derived 残留影响）
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${parent.id}/activate`, { method: 'POST' });
        assert.equal(r.status, 200, '普通 config 应可激活');
        // GET /active 返回被激活的普通 config（derived 残留不参与 active 判定）
        const data = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/active`)).json();
        assert.equal(data.active.id, parent.id, 'active 应为普通 config');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// F2（怀疑点1·边界条件）：激活 config 后删除该 config → active 标记变悬空指针。
test('F2: 激活后删除 config → active 标记悬空（GET /active 返回已删 id）', async () => {
    const { handle, port, home } = await startMgmt('f2');
    const { wsId, proj } = await createWorkspace(port, 'f2');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        // 删除被激活的 config
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}`, { method: 'DELETE' });
        // GET /active 仍返回已删 config 的 id（悬空指针）
        const data = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/active`)).json();
        assert.notEqual(data.active, null, 'active 标记未被清理（悬空指针存在）');
        assert.equal(data.active.id, cfg.id, '悬空指针指向已删 config');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// F3（怀疑点3·类型安全）：config.mode 缺省时激活 → mode 兜底 direct（类型安全）。
test('F3: config.mode 缺省时激活 → mode 兜底 direct（类型安全）', async () => {
    const { handle, port, home } = await startMgmt('f3');
    const { wsId, proj } = await createWorkspace(port, 'f3');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    // 手改 local-configs.json 去掉 mode 字段
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    const arr = JSON.parse(readFileSync(localCfgPath, 'utf8'));
    delete arr[0].mode;
    writeFileSync(localCfgPath, JSON.stringify(arr), 'utf8');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.equal(r.status, 200, 'mode 缺省也应可激活');
        const data = await r.json();
        assert.equal(data.mode, 'direct', 'mode 缺省应兜底为 direct');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// F4（怀疑点6·错误处理一致性）：store.get 抛异常（如 local-configs.json 损坏）的处理。
test('F4: local-configs.json 损坏时激活 → 404（store 优雅降级，不 500）', async () => {
    const { handle, port, home } = await startMgmt('f4');
    const { wsId, proj } = await createWorkspace(port, 'f4');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    // 手改 local-configs.json 让整体 JSON 损坏
    const localCfgPath = join(proj, '.claude_proxy', 'local-configs.json');
    writeFileSync(localCfgPath, '{ broken json !!!', 'utf8');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        // store.load catch → 空列表 → get null → NotFoundError → 404（不 500）
        assert.equal(r.status, 404, '损坏的 local-configs.json 应优雅降级为 404（不 500）');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// F5（怀疑点5·并发竞态）：激活不存在的 config → 404。
test('F5: 激活不存在的 config → 404（get 返回 null 时 NotFoundError）', async () => {
    const { handle, port, home } = await startMgmt('f5');
    const { wsId, proj } = await createWorkspace(port, 'f5');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/cfg_ghost/activate`, { method: 'POST' });
        assert.equal(r.status, 404, '不存在的 config 激活应 404');
        const data = await r.json();
        assert.ok(/config 不存在/.test(data.error), `错误应提及 config 不存在，实际: ${data.error}`);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// F6（怀疑点·副作用完整性）：激活后 settings.json / .claude/settings.local.json / .gitignore 全写入。
test('F6: 激活后 settings.json + permissions + gitignore 全写入（副作用完整性）', async () => {
    const { handle, port, home } = await startMgmt('f6');
    const { wsId, proj } = await createWorkspace(port, 'f6');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        // local-active.json + settings.json 应存在
        assert.ok(existsSync(join(proj, '.claude_proxy', 'local-active.json')), 'local-active.json 应被创建');
        assert.ok(existsSync(join(proj, '.claude_proxy', 'settings.json')), 'settings.json 应被创建');
        // permissions + gitignore 也应写入
        assert.ok(existsSync(join(proj, '.claude', 'settings.local.json')), '.claude/settings.local.json 应被创建');
        assert.ok(existsSync(join(proj, '.gitignore')), '.gitignore 应被创建');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});
