// test/standalone/terminal-env.test.mjs — buildTerminalEnv + syncDerivedAliases 测试
//
// 运行：node --test test/standalone/terminal-env.test.mjs
//
// 维度：
//   D1 normal-direct env 构建
//   D2 normal-proxy env 构建（注入 upstream 到代理）
//   D3 derived env 构建（注入 upstream + 别名 env + per-terminal configDir）
//   D4 syncDerivedAliases（幂等/补全/代理不可达）
//
// 代理用 mock proxyForward（spy），不连真实代理。D4d 集成用例用临时代理子进程（端口 11621）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TA_JS = resolve(__dirname, '..', '..', 'standalone', 'terminalApi.js');
const { buildTerminalEnv, syncDerivedAliases } = await import(pathToFileURL(TA_JS).href);

function newTmpDir(label) {
    return mkdtempSync(join(tmpdir(), `te-${label}-`));
}

// 一个合法的 normal config content
function directContent(over = {}) {
    return JSON.stringify({
        env: {
            ANTHROPIC_BASE_URL: 'https://up.test',
            ANTHROPIC_AUTH_TOKEN: 'tok-direct',
            ANTHROPIC_MODEL: 'real-model',
            ANTHROPIC_SMALL_FAST_MODEL: 'fast-model',
            API_TIMEOUT_MS: '30000',
            ...over,
        },
    });
}

function proxyContent(over = {}) {
    return JSON.stringify({
        env: {
            ANTHROPIC_BASE_URL: 'https://up.proxy',
            ANTHROPIC_AUTH_TOKEN: 'tok-proxy',
            ANTHROPIC_MODEL: 'proxy-model',
            ...over,
        },
    });
}

function derivedCfg(over = {}) {
    return {
        id: 'c-deriv',
        name: 'derived-1',
        content: proxyContent(),
        mode: 'proxy',
        derivedFrom: 'c-parent',
        derivedIndex: 3,
        modelAliases: { main: 'glm-5', sonnet: 'claude-sonnet' },
        sessionContext1m: { main: false, haiku: false, sonnet: true, opus: false },
        derivedSnapshot: { baseUrl: 'https://up.snap', token: 'tok-snap', mode: 'proxy' },
        ...over,
    };
}

// mock proxyForward：按 path 返回不同 canned 响应
function makeMockForward(responses = {}) {
    const calls = [];
    const fwd = async (port, p, method, body) => {
        calls.push({ port, path: p, method, body });
        const key = `${method} ${p}`;
        if (responses[key]) return responses[key];
        if (responses[p]) return responses[p];
        return { status: 200, body: {} };
    };
    fwd.calls = calls;
    return fwd;
}

// ════════════════════════════════════════════════════════════
// D1 normal-direct
// ════════════════════════════════════════════════════════════
test('D1a: direct config → env 只含 CLAUDE_CONFIG_DIR（LLM 配置走 settings.json）', async () => {
    const wsDir = newTmpDir('d1a');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const fwd = makeMockForward();
    const { env, configDir } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd });
    // normal 终端 env 不应含 LLM 配置（让 settings.json 生效）
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_MODEL, undefined);
    // configDir 指向 {ws.dir}/.claude_proxy（共享 settings.json）
    assert.equal(configDir, join(wsDir, '.claude_proxy'));
    // direct 不碰代理
    assert.equal(fwd.calls.length, 0);
});

test('D1b: direct config 缺 BASE_URL → throw ValidationError', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_BASE_URL: '' }), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d1b'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_BASE_URL|ValidationError/i,
    );
});

test('D1c: direct config 缺 TOKEN → throw ValidationError', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_AUTH_TOKEN: '' }), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d1c'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_AUTH_TOKEN|ValidationError/i,
    );
});

test('D1d: direct config content 非法 JSON → throw', async () => {
    const cfg = { id: 'c1', name: 'n', content: '{not json', mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d1d'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /JSON|ValidationError/i,
    );
});

// ════════════════════════════════════════════════════════════
// D2 normal-proxy
// ════════════════════════════════════════════════════════════
test('D2a: proxy config → 注入 upstream 到代理（POST /api/upstream）', async () => {
    const wsDir = newTmpDir('d2a');
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env, configDir } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd });
    // normal-proxy env 也只含 CLAUDE_CONFIG_DIR（LLM 走 settings.json，upstream 已注入代理）
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(configDir, join(wsDir, '.claude_proxy'));
    // 注入了 upstream
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.ok(upCall, '应 POST /api/upstream');
    assert.equal(upCall.body.upstream.baseUrl, 'https://up.proxy');
    assert.equal(upCall.body.upstream.token, 'tok-proxy');
});

test('D2b: proxy config + 代理返回非2xx → throw ProxyUnavailableError', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const fwd = makeMockForward({ 'POST /api/upstream': { status: 502, body: { error: 'bad' } } });
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d2b'), terminalId: 't1', proxyForwardFn: fwd }),
        /代理拒绝|ProxyUnavailable/i,
    );
});

// ════════════════════════════════════════════════════════════
// D3 derived
// ════════════════════════════════════════════════════════════
test('D3a: derived config → env 含 BASE_URL=proxy + token + 四档别名', async () => {
    const wsDir = newTmpDir('d3a');
    const cfg = derivedCfg();
    const fwd = makeMockForward({
        'POST /api/upstream': { status: 200, body: {} },
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    const { env, configDir } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't7', proxyForwardFn: fwd });
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11444');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-snap');
    // 四档别名（derivedIndex=3）
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-3');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-3');
    // sonnet 1m=true → 带 [1m]
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-3[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-3');
    // 不设 SMALL_FAST_MODEL（derived 用别名）
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    // configDir 用 per-terminal 独立目录
    assert.equal(configDir, join(wsDir, '.claude_proxy', 'sessions', 't7'));
    // 注入了 upstream（用快照 baseUrl/token）
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.ok(upCall);
    assert.equal(upCall.body.upstream.baseUrl, 'https://up.snap');
    assert.equal(upCall.body.upstream.token, 'tok-snap');
});

test('D3b: derived 无快照 → 从父 content 解上游', async () => {
    const cfg = derivedCfg({ derivedSnapshot: undefined });
    const parent = { id: 'c-parent', content: proxyContent(), mode: 'proxy' };
    const fwd = makeMockForward({
        'POST /api/upstream': { status: 200, body: {} },
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    const { env } = await buildTerminalEnv(cfg, parent, 11444, { workspaceDir: newTmpDir('d3b'), terminalId: 't1', proxyForwardFn: fwd });
    // token 来自父 content
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-proxy');
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.equal(upCall.body.upstream.baseUrl, 'https://up.proxy');
});

test('D3c: derived 无快照 + 父 null → throw', async () => {
    const cfg = derivedCfg({ derivedSnapshot: undefined });
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d3c'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /解析上游|ValidationError/i,
    );
});

test('D3d: derived sessionContext1m.main=true → ANTHROPIC_MODEL 带 [1m]', async () => {
    const cfg = derivedCfg({ sessionContext1m: { main: true, haiku: false, sonnet: false, opus: false } });
    const fwd = makeMockForward({
        'POST /api/upstream': { status: 200, body: {} },
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d3d'), terminalId: 't1', proxyForwardFn: fwd });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-3[1m]');
});

// ════════════════════════════════════════════════════════════
// D4 syncDerivedAliases
// ════════════════════════════════════════════════════════════
test('D4a: 代理表空 → 补全部已配档（main + sonnet）', async () => {
    const cfg = derivedCfg(); // modelAliases: { main: 'glm-5', sonnet: 'claude-sonnet' }
    const fwd = makeMockForward({
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    await syncDerivedAliases(cfg, 11444, { proxyForwardFn: fwd });
    const setCalls = fwd.calls.filter(c => c.path === '/api/model-alias' && c.method === 'POST');
    // main + sonnet 两档
    assert.equal(setCalls.length, 2);
    const aliases = setCalls.map(c => c.body.alias).sort();
    assert.deepEqual(aliases, ['ccp-main-3', 'ccp-sonnet-3']);
});

test('D4b: 代理表已有正确别名 → 0 补（幂等）', async () => {
    const cfg = derivedCfg();
    const fwd = makeMockForward({
        'GET /api/config': { status: 200, body: {
            modelAliases: { 'ccp-main-3': 'glm-5', 'ccp-sonnet-3': 'claude-sonnet' },
        } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    await syncDerivedAliases(cfg, 11444, { proxyForwardFn: fwd });
    const setCalls = fwd.calls.filter(c => c.path === '/api/model-alias' && c.method === 'POST');
    assert.equal(setCalls.length, 0, '代理表已含正确别名，不应再 POST');
});

test('D4c: 代理 GET /api/config 不可达 → throw', async () => {
    const cfg = derivedCfg();
    const fwd = makeMockForward({ 'GET /api/config': { status: 502, body: { error: 'down' } } });
    await assert.rejects(
        () => syncDerivedAliases(cfg, 11444, { proxyForwardFn: fwd }),
        /GET \/api\/config|ProxyUnavailable/i,
    );
});

// ════════════════════════════════════════════════════════════
// D4d 集成：真实临时代理子进程（端口 11621，绝不连真实 11434）
// ════════════════════════════════════════════════════════════
test('D4d: 真实临时代理 → syncDerivedAliases 写入别名表', { skip: !await hasRealProxyDeps() }, async () => {
    const { spawn } = await import('node:child_process');
    const SERVER_JS = resolve(__dirname, '..', '..', 'proxy', 'server.js');
    const home = newTmpDir('d4d-proxy');
    const tmpProxyPort = 11621;
    writeFileSync(join(home, 'proxy-config.json'), JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', API_TIMEOUT_MS: '600000', ANTHROPIC_MODEL: '' },
        effortLevel: 'max',
        proxy: { listenHost: '127.0.0.1', listenPort: tmpProxyPort, maxAttempts: 5, backoffSec: 1, backoffMaxSec: 16, passthrough: true, retryRules: [] },
        modelAliases: {},
    }));
    mkdirSync(join(home, 'logs'), { recursive: true });
    const child = spawn(process.execPath, [SERVER_JS], {
        env: { ...process.env, CCP_CONFIG_PATH: join(home, 'proxy-config.json'), CCP_LOGS_DIR: join(home, 'logs'), CCP_LOGS_CONFIG_PATH: join(home, 'logs', 'logs-config.json'), ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    try {
        await waitForPort(tmpProxyPort, 5000);
        const cfg = derivedCfg();
        await syncDerivedAliases(cfg, tmpProxyPort, {}); // 用默认 proxyForward
        const r = await fetch(`http://127.0.0.1:${tmpProxyPort}/api/config`);
        const data = await r.json();
        assert.equal(data.modelAliases['ccp-main-3'], 'glm-5');
        assert.equal(data.modelAliases['ccp-sonnet-3'], 'claude-sonnet');
    } finally {
        try { child.kill('SIGTERM'); } catch {}
        rmSync(home, { recursive: true, force: true });
    }
});

async function hasRealProxyDeps() {
    const { existsSync } = await import('node:fs');
    return existsSync(resolve(__dirname, '..', '..', 'proxy', 'server.js'));
}

async function waitForPort(port, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ok = await new Promise((res) => {
            fetch(`http://127.0.0.1:${port}/healthz`).then(r => res(r.ok)).catch(() => res(false));
        });
        if (ok) return;
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(`proxy port ${port} 未就绪`);
}
