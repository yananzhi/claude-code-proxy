// test/standalone/activate-config.test.mjs — 阶段6: 激活弱化为默认配置标记测试
//
// 运行：node --test test/standalone/activate-config.test.mjs
//
// 重设计（目标2）：终端统一走 env 后，激活从"写 settings.json + 注入 upstream +
// permissions/gitignore"降级为"只写默认配置标记"。
// activateConfig 原函数保留给 VS Code 侧，standalone 路由改调 markDefaultConfig。
//
// 维度覆盖（见 plan/tmp/2026-08-04-goal2-activate-weaken.md）：
//   A 标记行为（正常/404/派生可标记）
//   B 副作用零（不写 settings.json/permissions/gitignore/不注入 upstream）
//   C 标记读取（GET /active）
//   D 幂等
//   E 边界（content 非法/缺字段仍可标记）

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
    // proxyPort 默认 19998（无人监听）——标记不调代理，proxyPort 仅占位
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
// A 标记行为
// ════════════════════════════════════════════════════════════
test('A1: 标记正常 config → marked:true + active 写入', async () => {
    const { handle, port, home } = await startMgmt('a1');
    const { wsId, proj } = await createWorkspace(port, 'a1');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.marked, true);
        assert.equal(data.cfgId, cfg.id);
        assert.equal(data.mode, 'direct');
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

test('A4: 派生配置可标记为默认（标记只是指针，与旧"派生不能 active"约束无关）', async () => {
    const { handle, port, home } = await startMgmt('a4');
    const { wsId, proj } = await createWorkspace(port, 'a4');
    const parent = await createConfig(port, wsId, { name: 'parent', mode: 'proxy', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://up', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'pm' } }) });
    // 手写派生 config（绕过依赖代理 next-alias-id 的创建流程）
    const derivedId = 'derived-test-a4';
    injectDerivedConfig(proj, {
        id: derivedId, name: 'deriv', content: parent.content, mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: parent.id, derivedIndex: 1,
        modelAliases: { main: 'pm' },
        sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'http://up', token: 'tok', mode: 'proxy' },
    });
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}/activate`, { method: 'POST' });
        assert.equal(r.status, 200);
        const data = await r.json();
        assert.equal(data.marked, true);
        assert.equal(data.cfgId, derivedId);
        assert.equal(data.mode, 'proxy');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// B 副作用零（核心验证：不再写 settings.json/permissions/gitignore/不注入 upstream）
// ════════════════════════════════════════════════════════════
test('B1: 标记后 .claude_proxy/settings.json 不被创建', async () => {
    const { handle, port, home } = await startMgmt('b1');
    const { wsId, proj } = await createWorkspace(port, 'b1');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.ok(!existsSync(join(proj, '.claude_proxy', 'settings.json')), '标记不应写 settings.json');
        // .claude_proxy 目录可能因 workspace 注册时创建，但 settings.json 文件不应存在
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('B2: 标记后 .claude/settings.local.json 未被创建（无 permissions 写入）', async () => {
    const { handle, port, home } = await startMgmt('b2');
    const { wsId, proj } = await createWorkspace(port, 'b2');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.ok(!existsSync(join(proj, '.claude', 'settings.local.json')), '标记不应写 .claude/settings.local.json');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('B3: 标记后 .gitignore 未被创建', async () => {
    const { handle, port, home } = await startMgmt('b3');
    const { wsId, proj } = await createWorkspace(port, 'b3');
    mkdirSync(join(proj, '.git'), { recursive: true }); // 造 git 仓库（旧实现会写 .gitignore）
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.ok(!existsSync(join(proj, '.gitignore')), '标记不应创建 .gitignore');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('B4: 标记后代理无 upstream 注入（标记不调代理）', async () => {
    // proxyPort 指向无人监听端口；若标记调代理会 ECONNREFUSED → 502。
    // 期望 200（不调代理）。这是标记与旧 activateConfig 的本质区别。
    const { handle, port, home } = await startMgmt('b4', { proxyPort: 19997 });
    const { wsId, proj } = await createWorkspace(port, 'b4');
    const cfg = await createConfig(port, wsId, { name: 'p', mode: 'proxy', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://up', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'pm' } }) });
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.equal(r.status, 200, 'proxy 模式标记也不应调代理（不会 502）');
        assert.ok(!existsSync(join(proj, '.claude_proxy', 'settings.json')));
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// C 标记读取
// ════════════════════════════════════════════════════════════
test('C1: 标记后 GET /active 返回标记', async () => {
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

test('C2: 无标记 → GET /active 返回 null', async () => {
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

test('C3: 切换标记到另一 config → active 更新', async () => {
    const { handle, port, home } = await startMgmt('c3');
    const { wsId, proj } = await createWorkspace(port, 'c3');
    const cfg1 = await createConfig(port, wsId, { name: 'c1', mode: 'direct', content: DIRECT_CONTENT });
    const cfg2 = await createConfig(port, wsId, { name: 'c2', mode: 'direct', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://c2', ANTHROPIC_AUTH_TOKEN: 't' } }) });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg1.id}/activate`, { method: 'POST' });
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg2.id}/activate`, { method: 'POST' });
        const data = await (await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/active`)).json();
        assert.equal(data.active.id, cfg2.id, '应切换到 cfg2');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D 幂等
// ════════════════════════════════════════════════════════════
test('D1: 重复标记同 config → active 不变（幂等）', async () => {
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
// E 边界（标记不校验 content，与旧 activateConfig 不同）
// ════════════════════════════════════════════════════════════
test('E1: content 非法 JSON 的 config 仍可标记（标记不校验 content）', async () => {
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
        assert.equal(r.status, 200, '坏 content 也应可标记（标记不解析 content）');
        const data = await r.json();
        assert.equal(data.marked, true);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

test('E2: 缺 BASE_URL 的 config 仍可标记（标记 ≠ 启动，启动时才校验）', async () => {
    const { handle, port, home } = await startMgmt('e2');
    const { wsId, proj } = await createWorkspace(port, 'e2');
    // content 合法 JSON 但缺 BASE_URL（旧 activateConfig proxy 模式会 400，标记不会）
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'tok' } }) });
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        assert.equal(r.status, 200, '缺 BASE_URL 也应可标记');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// F 审查 TDD：边界/状态转换/一致性
// ════════════════════════════════════════════════════════════

// F1（怀疑点4·状态转换一致性）：派生配置可标记为默认，但起终端路由拒绝派生 active。
// 断言"bug 存在"：标记派生为默认后，POST /terminals 应 400（路由 line 132-135 拒绝派生 active）。
test('F1: 派生配置标记为默认后，workspace 级起终端被拒（400）— 标记与起终端入口不一致', async () => {
    const { handle, port, home } = await startMgmt('f1');
    const { wsId, proj } = await createWorkspace(port, 'f1');
    const parent = await createConfig(port, wsId, { name: 'parent', mode: 'proxy', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://up', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'pm' } }) });
    const derivedId = 'derived-test-f1';
    injectDerivedConfig(proj, {
        id: derivedId, name: 'deriv', content: parent.content, mode: 'proxy',
        updatedAt: '2026-01-01T00:00:00Z', derivedFrom: parent.id, derivedIndex: 1,
        modelAliases: { main: 'pm' },
        sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
        derivedSnapshot: { baseUrl: 'http://up', token: 'tok', mode: 'proxy' },
    });
    try {
        // 标记派生为默认（A4 已验证可标记）
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${derivedId}/activate`, { method: 'POST' });
        assert.equal(r.status, 200, '派生应可标记为默认');
        // 起终端：路由拒绝派生 active → 400
        const r2 = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/terminals`, { method: 'POST' });
        assert.equal(r2.status, 400, 'workspace 级起终端应拒绝派生 active（路由 line 132-135）');
        const data = await r2.json();
        assert.ok(/派生配置/.test(data.error), `错误应提及派生配置，实际: ${data.error}`);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// F2（怀疑点1·边界条件）：标记 config 后删除该 config → active 标记变悬空指针。
// 断言"bug 存在"：删除后 GET /active 仍返回已删除 config 的 id（悬空指针未清理）。
test('F2: 标记后删除 config → active 标记悬空（GET /active 返回已删 id）', async () => {
    const { handle, port, home } = await startMgmt('f2');
    const { wsId, proj } = await createWorkspace(port, 'f2');
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'direct', content: DIRECT_CONTENT });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        // 删除被标记的 config
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

// F3（怀疑点3·类型安全）：markDefaultConfig 对 mode 字段缺省/异常值的兜底。
// config.mode 缺省 → 默认 'direct'（line 361 三元）。验证不抛错、mode 正确兜底。
test('F3: config.mode 缺省时标记 → mode 兜底 direct（类型安全）', async () => {
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
        assert.equal(r.status, 200, 'mode 缺省也应可标记');
        const data = await r.json();
        assert.equal(data.mode, 'direct', 'mode 缺省应兜底为 direct');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// F4（怀疑点6·错误处理一致性）：markDefaultConfig 对 store.get 抛异常（如 local-configs.json 损坏）的处理。
// 非 bug：store.load 损坏时 catch 返回空列表 → store.get 返回 null → NotFoundError → 404（优雅降级）。
test('F4: local-configs.json 损坏时标记 → 404（store 优雅降级，不 500）', async () => {
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

// F5（怀疑点5·并发竞态）：标记与删除并发 → 可能写入悬空指针。
// 此测试验证当前行为（不防竞态）：先 get 到 config，write 前被删，仍写入悬空标记。
// 由于纯 HTTP 测试难以精确卡时序，这里验证"标记已删 config"的 404 路径（get 返回 null → NotFoundError）。
test('F5: 标记不存在的 config → 404（get 返回 null 时 NotFoundError）', async () => {
    const { handle, port, home } = await startMgmt('f5');
    const { wsId, proj } = await createWorkspace(port, 'f5');
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/cfg_ghost/activate`, { method: 'POST' });
        assert.equal(r.status, 404, '不存在的 config 标记应 404');
        const data = await r.json();
        assert.ok(/config 不存在/.test(data.error), `错误应提及 config 不存在，实际: ${data.error}`);
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});

// F6（怀疑点·副作用完整性）：标记后 local-active.json 写入但无其他文件副作用。
// 验证"零副作用"的完整面：settings.json / .claude/settings.local.json / .gitignore 全无。
test('F6: 标记后仅 local-active.json 存在，其余文件均未创建（副作用完整性）', async () => {
    const { handle, port, home } = await startMgmt('f6');
    const { wsId, proj } = await createWorkspace(port, 'f6');
    mkdirSync(join(proj, '.git'), { recursive: true });
    const cfg = await createConfig(port, wsId, { name: 'd', mode: 'proxy', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://up', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'm' } }) });
    try {
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/configs/${cfg.id}/activate`, { method: 'POST' });
        // local-active.json 应存在
        assert.ok(existsSync(join(proj, '.claude_proxy', 'local-active.json')), 'local-active.json 应被创建');
        // 其余文件均不应存在
        assert.ok(!existsSync(join(proj, '.claude_proxy', 'settings.json')), '不应写 settings.json');
        assert.ok(!existsSync(join(proj, '.claude', 'settings.local.json')), '不应写 .claude/settings.local.json');
        assert.ok(!existsSync(join(proj, '.gitignore')), '不应写 .gitignore');
    } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        rmSync(proj, { recursive: true, force: true });
    }
});
