// test/standalone/terminal-env.test.mjs — buildTerminalEnv + syncDerivedAliases 测试
//
// 运行：node --test test/standalone/terminal-env.test.mjs
//
// 维度：
//   D1 normal-direct env 构建
//   D2 normal-proxy env 构建（注入 upstream 到代理）
//   D3 derived env 构建（注入 upstream + 别名 env + 共享 configDir）
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
// （重设计：env 注入 ANTHROPIC_* 真实配置 + 共享 configDir，不再读 settings.json）
// ════════════════════════════════════════════════════════════
test('D1a: direct config → env 含上游 BASE_URL/TOKEN/MODEL + 共享 configDir + 不碰代理', async () => {
    const wsDir = newTmpDir('d1a');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const fwd = makeMockForward();
    const { env, configDir } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd });
    // direct env 注入上游真实地址 + token + model（不再靠 settings.json）
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://up.test');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-direct');
    assert.equal(env.ANTHROPIC_MODEL, 'real-model');
    // configDir 用 per-terminal 空目录（与 derived 一致，防 settings.json 覆盖 env）
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

test('D1e: direct content 无 MODEL → env 不含 ANTHROPIC_MODEL（不报错）', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_MODEL: undefined }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d1e'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_MODEL, undefined, '无 MODEL 不应注入');
    // BASE_URL/TOKEN 仍在
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://up.test');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-direct');
});

test('D1f: direct content 无 SMALL_FAST_MODEL/TIMEOUT → env 不含', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_SMALL_FAST_MODEL: undefined, API_TIMEOUT_MS: undefined }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d1f'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    assert.equal(env.API_TIMEOUT_MS, undefined);
});

test('D1g: direct → env 含 SMALL_FAST_MODEL + TIMEOUT（毫秒字符串）', async () => {
    // directContent 已含 SMALL_FAST_MODEL=fast-model + API_TIMEOUT_MS=30000
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d1g'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'fast-model');
    // 30000ms → 保持毫秒字符串（与 derived timeoutSec*1000 一致：秒→毫秒字符串）
    assert.equal(env.API_TIMEOUT_MS, '30000');
});

// ════════════════════════════════════════════════════════════
// D2 normal-proxy
// （重设计：env BASE_URL 指向代理 + 共享 configDir + 注入 upstream）
// ════════════════════════════════════════════════════════════
test('D2a: proxy config → env BASE_URL=代理 + TOKEN + MODEL + 共享 configDir + 注入 upstream', async () => {
    const wsDir = newTmpDir('d2a');
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env, configDir } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd });
    // proxy env BASE_URL 指向代理（不是上游真实地址）
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11444');
    // token 仍是上游 token（代理透传时用）
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-proxy');
    assert.equal(env.ANTHROPIC_MODEL, 'proxy-model');
    // configDir per-terminal 空目录
    assert.equal(configDir, join(wsDir, '.claude_proxy'));
    // 注入了 upstream（真实上游地址）
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

test('D2c: proxy → upstream body 含 model/smallFastModel/timeoutSec', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ ANTHROPIC_SMALL_FAST_MODEL: 'fast-m', API_TIMEOUT_MS: '60000' }), mode: 'proxy' };
    const fwd = makeMockForward();
    await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d2c'), terminalId: 't1', proxyForwardFn: fwd });
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.ok(upCall);
    assert.equal(upCall.body.upstream.model, 'proxy-model');
    assert.equal(upCall.body.upstream.smallFastModel, 'fast-m');
    assert.equal(upCall.body.upstream.timeoutSec, 60, '60000ms → 60s');
});

// ════════════════════════════════════════════════════════════
// 代码审查 TDD 怀疑点（S1-S6）
// ════════════════════════════════════════════════════════════

// S1（类型安全）：ANTHROPIC_BASE_URL 为非字符串（数字/对象）时，normal 分支应拒绝或视为缺失，
// 与 derived 的 resolveDerivedUpstream typeof 守卫一致。怀疑：数字/对象值 truthy 会穿透 !baseUrl 校验。
test('S1a: direct content BASE_URL 是数字 → 应拒绝（与 derived typeof 守卫一致）', async () => {
    const cfg = { id: 'c1', name: 'n', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 123, ANTHROPIC_AUTH_TOKEN: 'tok' } }), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s1a'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_BASE_URL|ValidationError/i,
    );
});

// S1b：对象型 BASE_URL（{} truthy）更危险——会穿透校验注入 [object Object]
test('S1b: direct content BASE_URL 是对象 {} → 应拒绝（{} truthy 穿透）', async () => {
    const cfg = { id: 'c1', name: 'n', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: {}, ANTHROPIC_AUTH_TOKEN: 'tok' } }), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s1b'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_BASE_URL|ValidationError/i,
    );
});

// S2（类型安全）：ANTHROPIC_MODEL 为非字符串（数字）时，env 应不含或拒绝，不应原样注入数字
test('S2: direct content MODEL 是数字 → env 不应含数字型 MODEL', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_MODEL: 42 }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s2'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    // 期望：要么不含，要么是字符串；不应是数字 42
    assert.equal(typeof env.ANTHROPIC_MODEL === 'undefined' || typeof env.ANTHROPIC_MODEL === 'string', true,
        `MODEL 应为 undefined 或 string，实际: ${typeof env.ANTHROPIC_MODEL} = ${JSON.stringify(env.ANTHROPIC_MODEL)}`);
});

// S3（边界）：API_TIMEOUT_MS 非法值（0/负/NaN/空串）→ env 不含
test('S3a: direct content API_TIMEOUT_MS=0 → env 不含', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ API_TIMEOUT_MS: '0' }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s3a'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.API_TIMEOUT_MS, undefined, '0ms 应视为无效不注入');
});

test('S3b: direct content API_TIMEOUT_MS=-5 → env 不含', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ API_TIMEOUT_MS: '-5' }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s3b'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.API_TIMEOUT_MS, undefined, '负数应视为无效不注入');
});

test('S3c: direct content API_TIMEOUT_MS="abc" → env 不含', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ API_TIMEOUT_MS: 'abc' }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s3c'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.API_TIMEOUT_MS, undefined, '非数字字符串应视为无效不注入');
});

// S4（一致性）：proxy 模式 + API_TIMEOUT_MS 非法 → upstream body 不含 timeoutSec，但仍注入 upstream + env 不含
test('S4: proxy + API_TIMEOUT_MS 非法 → upstream body 无 timeoutSec + env 无 API_TIMEOUT_MS', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ API_TIMEOUT_MS: 'abc' }), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s4'), terminalId: 't1', proxyForwardFn: fwd });
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.ok(upCall);
    assert.equal(upCall.body.upstream.timeoutSec, undefined, '非法 timeout → upstream body 不应含 timeoutSec');
    assert.equal(env.API_TIMEOUT_MS, undefined, '非法 timeout → env 不应含 API_TIMEOUT_MS');
});

// S5（错误路径）：proxy 模式 fwd 抛异常（网络错误等）→ buildTerminalEnv 应抛出（不吞）
test('S5: proxy 模式 fwd reject → buildTerminalEnv 应 reject（不吞异常）', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const throwingFwd = async () => { throw new Error('proxy 不可达: ECONNREFUSED'); };
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s5'), terminalId: 't1', proxyForwardFn: throwingFwd }),
        /ECONNREFUSED|不可达/i,
    );
});

// S6（一致性/状态）：proxy 模式小数毫秒 timeout → CLI env 与 proxy timeoutSec 应一致（不差 500ms）
test('S6: proxy + API_TIMEOUT_MS=30500 → env API_TIMEOUT_MS 与 proxy timeoutSec*1000 一致', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ API_TIMEOUT_MS: '30500' }), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s6'), terminalId: 't1', proxyForwardFn: fwd });
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    const proxyTimeoutMs = upCall.body.upstream.timeoutSec * 1000;
    const cliTimeoutMs = Number(env.API_TIMEOUT_MS);
    assert.equal(cliTimeoutMs, proxyTimeoutMs,
        `CLI env API_TIMEOUT_MS(${cliTimeoutMs}) 应与 proxy timeoutSec*1000(${proxyTimeoutMs}) 一致，不应差 500ms`);
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
    assert.equal(configDir, join(wsDir, '.claude_proxy'));
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

// ════════════════════════════════════════════════════════════
// D5 configDir 共享假设约束（修复问题2：避免重复引导）
// ════════════════════════════════════════════════════════════
test('D5a: 同 workspace 两次起终端 → configDir 路径相同（共享，onboarding 复用）', async () => {
    // 约束假设：共享 configDir 是避免重复引导的前提。若两次 configDir 不同，共享失效。
    const wsDir = newTmpDir('d5a');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const fwd = makeMockForward();
    const r1 = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't_aaa', proxyForwardFn: fwd });
    const r2 = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't_bbb', proxyForwardFn: fwd });
    assert.equal(r1.configDir, r2.configDir, '同 workspace 不同 terminalId 应共享 configDir');
    assert.equal(r1.configDir, join(wsDir, '.claude_proxy'), '应为 {ws}/.claude_proxy');
    assert.notEqual(r1.configDir, join(wsDir, '.claude_proxy', 'sessions', 't_aaa'), '不应是 per-terminal');
});

test('D5b: 不同 workspace → configDir 不同（隔离，不串引导）', async () => {
    const ws1 = newTmpDir('d5b1');
    const ws2 = newTmpDir('d5b2');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const fwd = makeMockForward();
    const r1 = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: ws1, terminalId: 't1', proxyForwardFn: fwd });
    const r2 = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: ws2, terminalId: 't1', proxyForwardFn: fwd });
    assert.notEqual(r1.configDir, r2.configDir, '不同 workspace 应隔离 configDir');
});

// ════════════════════════════════════════════════════════════
// D6 settings.json 检测覆盖所有 config 类型（修复问题2 附加：env 与 settings.json 不共存）
// ════════════════════════════════════════════════════════════
test('D6a: 普通代理模式 + settings.json 存在 → throw（不因代理模式跳过检测）', async () => {
    const wsDir = newTmpDir('d6a');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"env":{"ANTHROPIC_MODEL":"stale-m"}}', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const fwd = makeMockForward({ 'POST /api/upstream': { status: 200, body: {} } });
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd }),
        /settings\.json.*存在|不支持共存|ValidationError/i,
    );
});

test('D6b: 派生配置 + settings.json 存在 → throw（不因派生模式跳过检测）', async () => {
    const wsDir = newTmpDir('d6b');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"env":{"ANTHROPIC_MODEL":"stale-m"}}', 'utf8');
    const cfg = derivedCfg();
    const fwd = makeMockForward({
        'POST /api/upstream': { status: 200, body: {} },
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd }),
        /settings\.json.*存在|不支持共存|ValidationError/i,
    );
});

test('D6c: settings.json 仅 theme/skipDangerous（无 env 冲突 key）→ 放行（不 throw）', async () => {
    // CLI 自己写的引导标记，无 env，不冲突，放行（第二次起终端能成功的保证）
    const wsDir = newTmpDir('d6c');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"theme":"dark","skipDangerousModePermissionPrompt":true}', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const { env, configDir } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_MODEL, 'real-model', '无冲突 key 应放行，env 正常注入');
    assert.ok(configDir);
});

test('D6d: settings.json env 含 ANTHROPIC_BASE_URL → throw（冲突 key 覆盖路由）', async () => {
    const wsDir = newTmpDir('d6d');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"env":{"ANTHROPIC_BASE_URL":"http://stale"}}', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_BASE_URL|覆盖.*modelname|不支持共存/i,
    );
});

test('D6e: settings.json 损坏（非 JSON）→ 不 throw（让 CLI 自己处理）', async () => {
    const wsDir = newTmpDir('d6e');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{ not valid json', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_MODEL, 'real-model', '损坏 settings.json 不视为冲突，放行');
});

// ════════════════════════════════════════════════════════════
// D7 自定义 env 透传（CLAUDE_CODE_AUTO_COMPACT_WINDOW 等）
// 证明：4 启动入口当前只透传路由 key，丢自定义 env key。
// 修复前这些用例失败（env 无自定义 key），修复后通过。
// 根因见 plan twinkling-forging-sunset：customEnv 未注入 shell env，
// 仅靠 settings.json 残留泄漏，CLI 重写 settings.json 后丢失。
// ════════════════════════════════════════════════════════════

// D1-custom：direct content 含自定义 env key → env 应透传
test('D1-custom: direct content 含 CLAUDE_CODE_AUTO_COMPACT_WINDOW + FOO → env 透传', async () => {
    const cfg = {
        id: 'c1', name: 'n',
        content: directContent({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000', FOO: 'bar' }),
        mode: 'direct',
    };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d1c-custom'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000', '自定义 env key 应透传到 spawn env');
    assert.equal(env.FOO, 'bar', '其余自定义 env key 也应透传');
    // 路由 key 仍在（不被 customEnv 影响）
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://up.test');
    assert.equal(env.ANTHROPIC_MODEL, 'real-model');
});

// D3-custom：derived 父 proxyContent 含自定义 env key → 派生 env 应透传
test('D3-custom: derived 父 content 含 CLAUDE_CODE_AUTO_COMPACT_WINDOW → 派生 env 透传', async () => {
    const cfg = derivedCfg();
    const parent = { id: 'c-parent', content: proxyContent({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000' }), mode: 'proxy' };
    const fwd = makeMockForward({
        'POST /api/upstream': { status: 200, body: {} },
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    const { env } = await buildTerminalEnv(cfg, parent, 11444, { workspaceDir: newTmpDir('d3c-custom'), terminalId: 't1', proxyForwardFn: fwd });
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000', '派生应从父 content 继承自定义 env key 透传');
    // 派生路由 key 仍在
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11444');
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-3');
});

// D1-conflict-excluded：customEnv 排除路由 key，不覆盖显式构造值
test('D1-conflict-excluded: direct content ANTHROPIC_MODEL=x + 自定义 key → MODEL 仍是显式值 + 含自定义 key', async () => {
    // directContent 的 ANTHROPIC_MODEL=real-model 被 over 覆盖成 'x'，customEnv 应排除 ANTHROPIC_MODEL
    // （由 normal 分支显式注入 parsed.env.ANTHROPIC_MODEL='x'），同时透传 CLAUDE_CODE_AUTO_COMPACT_WINDOW
    const cfg = {
        id: 'c1', name: 'n',
        content: directContent({ ANTHROPIC_MODEL: 'x', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000' }),
        mode: 'direct',
    };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('d1c-conflict'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    // ANTHROPIC_MODEL 来自显式构造（parsed.env.ANTHROPIC_MODEL='x'），不被 customEnv 干扰
    assert.equal(env.ANTHROPIC_MODEL, 'x', 'ANTHROPIC_MODEL 应由显式构造，不被 customEnv 覆盖');
    // 自定义 key 仍透传
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000');
});

// D3-alias-excluded：customEnv 排除派生别名 key，不覆盖 buildAliasEnv 构造的别名
test('D3-alias-excluded: derived 父 content 含 ANTHROPIC_DEFAULT_SONNET_MODEL → 别名不被覆盖', async () => {
    // 父 proxyContent 注入 ANTHROPIC_DEFAULT_SONNET_MODEL='parent-sonnet'（over 覆盖），
    // customEnv 应排除该 key，buildAliasEnv 构造的 ccp-sonnet-3[1m] 不受影响
    const cfg = derivedCfg();
    const parent = { id: 'c-parent', content: proxyContent({ ANTHROPIC_DEFAULT_SONNET_MODEL: 'parent-sonnet' }), mode: 'proxy' };
    const fwd = makeMockForward({
        'POST /api/upstream': { status: 200, body: {} },
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    const { env } = await buildTerminalEnv(cfg, parent, 11444, { workspaceDir: newTmpDir('d3c-alias'), terminalId: 't1', proxyForwardFn: fwd });
    // ANTHROPIC_DEFAULT_SONNET_MODEL 来自 buildAliasEnv（ccp-sonnet-3[1m]，sessionContext1m.sonnet=true），不被父 env 同名 key 覆盖
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-3[1m]', '派生别名应由 buildAliasEnv 构造，不被父 env 同名 key 覆盖');
    assert.notEqual(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'parent-sonnet', '父 content 的同名 key 不应泄漏覆盖别名');
});

// ════════════════════════════════════════════════════════════
// TDD 审查：6 类高风险怀疑点
// ════════════════════════════════════════════════════════════

// TDD-S2 (Cat 6 不一致): customEnv 透传 CLAUDE_CONFIG_DIR/CLAUDE_BIN 等进程控制 key
// 怀疑：extractCustomEnv 只排除 8 个路由/别名 key，不排除 CLAUDE_CONFIG_DIR/CLAUDE_BIN 等
// 进程控制 key。若父 content.env 含这些 key，customEnv 会透传它们。
// 在 claudeLauncher.ts launchDerived 里 env 字面量顺序是 CLAUDE_CONFIG_DIR/CLAUDE_BIN 在前、
// ...customEnv 在后，customEnv 会覆盖 CLAUDE_CONFIG_DIR/CLAUDE_BIN——导致终端用错配置目录或二进制。
// standalone buildTerminalEnv 不设 CLAUDE_CONFIG_DIR（configDir 是返回值），但若调用方把 customEnv
// 与 CLAUDE_CONFIG_DIR 合并也可能被覆盖。验证 standalone 侧 customEnv 是否透传这些 key。
test('TDD-S2: derived 父 content 含 CLAUDE_CONFIG_DIR → customEnv 透传该 key（潜在覆盖风险）', async () => {
    const cfg = derivedCfg();
    const parent = {
        id: 'c-parent',
        content: proxyContent({ CLAUDE_CONFIG_DIR: '/malicious/path', CLAUDE_BIN: '/bad/binary' }),
        mode: 'proxy',
    };
    const fwd = makeMockForward({
        'POST /api/upstream': { status: 200, body: {} },
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    const { env } = await buildTerminalEnv(cfg, parent, 11444, { workspaceDir: newTmpDir('s2'), terminalId: 't1', proxyForwardFn: fwd });
    // 怀疑 bug：customEnv 透传了 CLAUDE_CONFIG_DIR/CLAUDE_BIN
    // 断言"bug 存在"：env 应含 CLAUDE_CONFIG_DIR（从父 content 透传）
    // 若已修复（这些 key 应被排除）：env 不含 CLAUDE_CONFIG_DIR
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined, 'CLAUDE_CONFIG_DIR 不应从父 content 透传（会覆盖调用方设的配置目录）');
    assert.equal(env.CLAUDE_BIN, undefined, 'CLAUDE_BIN 不应从父 content 透传（会覆盖调用方设的二进制路径）');
});

// TDD-S5 (Cat 4 状态迁移): customEnv 覆盖调用方显式设的 key（normal 分支）
// 怀疑：normal 分支里 env 先构造路由 key，再 Object.assign(env, extractCustomEnv(parsed.env))。
// extractCustomEnv 排除 8 个路由 key + CLAUDE_CONFIG_DIR/CLAUDE_BIN，但不排除其他可能被调用方
// 设的 key。standalone buildTerminalEnv 不设 CCP_DERIVED_ID，但 claudeLauncher launchDerived 设。
// 更直接的风险：若 content.env 含 PATH/HOME/NODE_OPTIONS 等系统 env key，customEnv 会透传它们
// 覆盖调用方/系统的 env。验证：customEnv 是否透传 PATH（潜在安全/功能风险）。
test('TDD-S5: normal content 含 PATH → customEnv 透传 PATH（潜在系统 env 覆盖风险）', async () => {
    const cfg = {
        id: 'c1', name: 'n',
        content: directContent({ PATH: '/usr/malicious/bin', HOME: '/bad/home', NODE_OPTIONS: '--inspect' }),
        mode: 'direct',
    };
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s5'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    // 怀疑 bug：customEnv 透传了 PATH/HOME/NODE_OPTIONS
    // 断言"bug 存在"：env 应含 PATH（从 content 透传）
    // 若已修复（系统 env key 应被排除）：env 不含 PATH
    assert.equal(env.PATH, undefined, 'PATH 不应从 content.env 透传（会覆盖系统 PATH）');
    assert.equal(env.HOME, undefined, 'HOME 不应从 content.env 透传（会覆盖系统 HOME）');
    assert.equal(env.NODE_OPTIONS, undefined, 'NODE_OPTIONS 不应从 content.env 透传（会覆盖系统 NODE_OPTIONS）');
});

// TDD-S7 (Cat 6 不一致): derived 分支 parentCfg=null（孤儿靠快照）→ customEnv 为空，不崩
// 怀疑：terminalApi.js derived 分支 `if (parentCfg && parentCfg.content)` 守卫 parentCfg=null，
// 但 claudeLauncher.ts launchDerived 用 `parentCfg && parentCfg.content ? ... : {}`。
// 两者对 parentCfg=null 都应产出 customEnv={}。验证 standalone 侧孤儿节点 customEnv 为空。
test('TDD-S7: derived parentCfg=null（孤儿靠快照）→ customEnv 为空，不崩', async () => {
    const cfg = derivedCfg();  // derivedSnapshot 自洽（baseUrl/token/mode）
    const fwd = makeMockForward({
        'POST /api/upstream': { status: 200, body: {} },
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    const { env } = await buildTerminalEnv(cfg, null, 11444, { workspaceDir: newTmpDir('s7'), terminalId: 't1', proxyForwardFn: fwd });
    // 孤儿靠快照解上游，customEnv 应为空（无父 content 可提取）
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined, '孤儿节点无父 content，customEnv 应为空');
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11444', '路由 key 仍正常注入');
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-3', '别名仍正常构造');
});

// TDD-S8 (Cat 6 不一致): derived 分支 parentCfg.content 非法 JSON → customEnv 为空，不崩
// 怀疑：terminalApi.js derived 分支 extractUpstream(parentCfg.content) 对非法 JSON 返回 null，
// `if (parentParsed)` 跳过 customEnv。但 resolveDerivedUpstream 先于 customEnv 调用，
// 若父 content 非法且无快照，resolveDerivedUpstream 返回 null → 早已 throw ValidationError。
// 有快照时 resolveDerivedUpstream 用快照解上游（不读父 content），customEnv 仍尝试解父 content。
// 验证：父 content 非法 JSON + 有快照 → 上游用快照、customEnv 为空、不崩。
test('TDD-S8: derived 父 content 非法 JSON + 有快照 → 上游用快照、customEnv 为空、不崩', async () => {
    const cfg = derivedCfg();  // derivedSnapshot 自洽
    const parent = { id: 'c-parent', content: '{ not valid json', mode: 'proxy' };
    const fwd = makeMockForward({
        'POST /api/upstream': { status: 200, body: {} },
        'GET /api/config': { status: 200, body: { modelAliases: {} } },
        'POST /api/model-alias': { status: 200, body: {} },
    });
    const { env } = await buildTerminalEnv(cfg, parent, 11444, { workspaceDir: newTmpDir('s8'), terminalId: 't1', proxyForwardFn: fwd });
    // 上游用快照（https://up.snap），customEnv 为空（父 content 非法 JSON 解不出 env）
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11444', 'BASE_URL 指向代理');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-snap', 'token 来自快照');
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined, '父 content 非法 → customEnv 为空');
});
