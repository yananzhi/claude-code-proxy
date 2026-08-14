// test/standalone/terminal-env.test.mjs — buildTerminalEnv 测试
//
// 运行：node --test test/standalone/terminal-env.test.mjs
//
// 回退 2026-08-14（settings.json 唯一事实源）后的语义：
//   D1 normal-direct：env 恒为空（不注入路由 key），configDir 共享，不碰代理；
//                     仍校验 BASE_URL/TOKEN（缺失 → ValidationError）。
//   D2 normal-proxy：env 空 + 插入 upstream（幂等，防代理重启丢失）；
//                    代理拒绝/不可达 → ProxyUnavailableError。
//   S1-S6 代码审查 TDD 怀疑点（类型安全/边界/一致性/错误路径）
//   D5 configDir 共享约束（避免重复引导）
//   D6 settings.json 共存检测已删除（坏 JSON / env 含路由 key 均不再拒绝）
//   D7 自定义 env key 透传已删除（CLAUDE_CODE_AUTO_COMPACT_WINDOW 等走 settings.json）
//
// 代理用 mock proxyForward（spy），不连真实代理。
// 派生配置（derived/别名）功能已移除（2026-08），无对应分支测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TA_JS = resolve(__dirname, '..', '..', 'standalone', 'terminalApi.js');
const { buildTerminalEnv } = await import(pathToFileURL(TA_JS).href);

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
// （settings.json 唯一事实源：env 为空，不注入路由 key；共享 configDir；不碰代理）
// ════════════════════════════════════════════════════════════
test('D1a: direct config → env 为空（不注入路由 key）+ 共享 configDir + 不碰代理', async () => {
    const wsDir = newTmpDir('d1a');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const fwd = makeMockForward();
    const { env, configDir } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd });
    // 回退后：路由配置全走 settings.json，env 不注入任何 LLM 配置
    assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'BASE_URL 不注入 env');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, 'TOKEN 不注入 env');
    assert.equal(env.ANTHROPIC_MODEL, undefined, 'MODEL 不注入 env');
    assert.deepEqual(env, {}, 'env 应为空对象');
    // configDir 共享 {ws}/.claude_proxy（CLI 读激活时写的 settings.json）
    assert.equal(configDir, join(wsDir, '.claude_proxy'));
    // direct 不碰代理
    assert.equal(fwd.calls.length, 0);
});

test('D1b: direct config 缺 BASE_URL → throw ValidationError', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_BASE_URL: '' }), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1b'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_BASE_URL|ValidationError/i,
    );
});

test('D1c: direct config 缺 TOKEN → throw ValidationError', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_AUTH_TOKEN: '' }), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1c'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_AUTH_TOKEN|ValidationError/i,
    );
});

test('D1d: direct config content 非法 JSON → throw', async () => {
    const cfg = { id: 'c1', name: 'n', content: '{not json', mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1d'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /JSON|ValidationError/i,
    );
});

test('D1e: direct content 无 MODEL → 不报错（env 空，不注入）', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_MODEL: undefined }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1e'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.deepEqual(env, {}, '无 MODEL 不注入，env 仍为空');
});

test('D1f: direct content 无 SMALL_FAST_MODEL/TIMEOUT → env 空（不报错）', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_SMALL_FAST_MODEL: undefined, API_TIMEOUT_MS: undefined }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1f'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.deepEqual(env, {});
});

// ════════════════════════════════════════════════════════════
// D2 normal-proxy
// （env 空 + 共享 configDir + 幂等注入 upstream）
// ════════════════════════════════════════════════════════════
test('D2a: proxy config → env 为空 + 共享 configDir + 注入 upstream（幂等）', async () => {
    const wsDir = newTmpDir('d2a');
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env, configDir } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd });
    // 回退后：env 不再指向代理地址（CLI 读 settings.json，BASE_URL 由合成结果指代理）
    assert.deepEqual(env, {}, 'env 应为空');
    // configDir 共享目录
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
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d2b'), terminalId: 't1', proxyForwardFn: fwd }),
        /代理拒绝|ProxyUnavailable/i,
    );
});

test('D2c: proxy → upstream body 含 model/smallFastModel/timeoutSec', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ ANTHROPIC_SMALL_FAST_MODEL: 'fast-m', API_TIMEOUT_MS: '60000' }), mode: 'proxy' };
    const fwd = makeMockForward();
    await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d2c'), terminalId: 't1', proxyForwardFn: fwd });
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.ok(upCall);
    assert.equal(upCall.body.upstream.model, 'proxy-model');
    assert.equal(upCall.body.upstream.smallFastModel, 'fast-m');
    assert.equal(upCall.body.upstream.timeoutSec, 60, '60000ms → 60s');
});

// ════════════════════════════════════════════════════════════
// 代码审查 TDD 怀疑点（S1-S6）
// ════════════════════════════════════════════════════════════

// S1（类型安全）：ANTHROPIC_BASE_URL 为非字符串（数字/对象）时，应拒绝或视为缺失。
// 怀疑：数字/对象值 truthy 会穿透 !baseUrl 校验。
test('S1a: direct content BASE_URL 是数字 → 应拒绝', async () => {
    const cfg = { id: 'c1', name: 'n', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 123, ANTHROPIC_AUTH_TOKEN: 'tok' } }), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s1a'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_BASE_URL|ValidationError/i,
    );
});

// S1b：对象型 BASE_URL（{} truthy）更危险——会穿透校验注入 [object Object]
test('S1b: direct content BASE_URL 是对象 {} → 应拒绝（{} truthy 穿透）', async () => {
    const cfg = { id: 'c1', name: 'n', content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: {}, ANTHROPIC_AUTH_TOKEN: 'tok' } }), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s1b'), terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_BASE_URL|ValidationError/i,
    );
});

// S2（类型安全）：ANTHROPIC_MODEL 为非字符串（数字）时，不应原样注入（env 空，天然满足）
test('S2: direct content MODEL 是数字 → env 仍为空，不注入数字', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_MODEL: 42 }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s2'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.deepEqual(env, {}, 'env 为空，不泄漏数字型 MODEL');
});

// S3（边界）：API_TIMEOUT_MS 非法值（0/负/NaN/空串）→ 不影响（env 空；
//  proxy 模式 upstream body 不含 timeoutSec）
test('S3a: direct content API_TIMEOUT_MS=0 → env 空（不注入无效值）', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ API_TIMEOUT_MS: '0' }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s3a'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.deepEqual(env, {});
});

test('S3b: proxy content API_TIMEOUT_MS=-5 → upstream body 无 timeoutSec', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ API_TIMEOUT_MS: '-5' }), mode: 'proxy' };
    const fwd = makeMockForward();
    await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s3b'), terminalId: 't1', proxyForwardFn: fwd });
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.ok(upCall, 'proxy 模式仍应注入 upstream');
    assert.equal(upCall.body.upstream.timeoutSec, undefined, '负数 timeout 不注入');
});

test('S3c: proxy content API_TIMEOUT_MS="abc" → upstream body 无 timeoutSec', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ API_TIMEOUT_MS: 'abc' }), mode: 'proxy' };
    const fwd = makeMockForward();
    await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s3c'), terminalId: 't1', proxyForwardFn: fwd });
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.ok(upCall);
    assert.equal(upCall.body.upstream.timeoutSec, undefined, '非数字字符串 timeout 不注入');
});

// S4（一致性）：proxy 模式 + API_TIMEOUT_MS 非法 → upstream body 不含 timeoutSec，但注入仍进行
test('S4: proxy + API_TIMEOUT_MS 非法 → upstream body 无 timeoutSec，upstream 仍注入', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ API_TIMEOUT_MS: 'abc' }), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s4'), terminalId: 't1', proxyForwardFn: fwd });
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.ok(upCall, '非法 timeout 不应阻断 upstream 注入');
    assert.equal(upCall.body.upstream.timeoutSec, undefined, '非法 timeout → upstream body 不应含 timeoutSec');
    assert.deepEqual(env, {});
});

// S5（错误路径）：proxy 模式 fwd 抛异常（网络错误等）→ buildTerminalEnv 应抛出（不吞）
test('S5: proxy 模式 fwd reject → buildTerminalEnv 应 reject（不吞异常）', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const throwingFwd = async () => { throw new Error('proxy 不可达: ECONNREFUSED'); };
    await assert.rejects(
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s5'), terminalId: 't1', proxyForwardFn: throwingFwd }),
        /ECONNREFUSED|不可达/i,
    );
});

// S6（一致性/状态）：proxy 模式小数毫秒 timeout → proxy timeoutSec 为四舍五入秒（env 空不注入）
test('S6: proxy + API_TIMEOUT_MS=30500 → timeoutSec=31（四舍五入），env 不注入 API_TIMEOUT_MS', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ API_TIMEOUT_MS: '30500' }), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s6'), terminalId: 't1', proxyForwardFn: fwd });
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    assert.equal(upCall.body.upstream.timeoutSec, 31, '30500ms → 30.5s → 四舍五入 31s');
    assert.equal(env.API_TIMEOUT_MS, undefined, 'CLI env 不注入 timeout（走 settings.json）');
});

// ════════════════════════════════════════════════════════════
// D5 configDir 共享假设约束（问题2：避免重复引导）
// ════════════════════════════════════════════════════════════
test('D5a: 同 workspace 两次起终端 → configDir 路径相同（共享，onboarding 复用）', async () => {
    // 约束假设：共享 configDir 是避免重复引导的前提。若两次 configDir 不同，共享失效。
    const wsDir = newTmpDir('d5a');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const fwd = makeMockForward();
    const r1 = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't_aaa', proxyForwardFn: fwd });
    const r2 = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't_bbb', proxyForwardFn: fwd });
    assert.equal(r1.configDir, r2.configDir, '同 workspace 不同 terminalId 应共享 configDir');
    assert.equal(r1.configDir, join(wsDir, '.claude_proxy'), '应为 {ws}/.claude_proxy');
    assert.notEqual(r1.configDir, join(wsDir, '.claude_proxy', 'sessions', 't_aaa'), '不应是 per-terminal');
});

test('D5b: 不同 workspace → configDir 不同（隔离，不串引导）', async () => {
    const ws1 = newTmpDir('d5b1');
    const ws2 = newTmpDir('d5b2');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const fwd = makeMockForward();
    const r1 = await buildTerminalEnv(cfg, 11444, { workspaceDir: ws1, terminalId: 't1', proxyForwardFn: fwd });
    const r2 = await buildTerminalEnv(cfg, 11444, { workspaceDir: ws2, terminalId: 't1', proxyForwardFn: fwd });
    assert.notEqual(r1.configDir, r2.configDir, '不同 workspace 应隔离 configDir');
});

// ════════════════════════════════════════════════════════════
// D6 settings.json 共存检测已删除
// （回退 2026-08-14：settings.json 就是唯一事实源，不再"env 注入与 settings.json 不共存"，
//  无论 settings.json 是否有 env 路由 key / 是否损坏，buildTerminalEnv 都不再拒绝）
// ════════════════════════════════════════════════════════════
test('D6a: proxy 模式 + settings.json 含 env 路由 key → 不 throw（settings.json 是事实源）', async () => {
    const wsDir = newTmpDir('d6a');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"env":{"ANTHROPIC_MODEL":"stale-m"}}', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const fwd = makeMockForward({ 'POST /api/upstream': { status: 200, body: {} } });
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd });
    assert.deepEqual(env, {}, '不再因 settings.json 共存而拒绝');
});

test('D6c: settings.json 仅 theme/skipDangerous（无 env 冲突 key）→ 放行', async () => {
    // CLI 自己的引导标记，无 env，不冲突，放行（第二次起终端能成功的保证）
    const wsDir = newTmpDir('d6c');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"theme":"dark","skipDangerousModePermissionPrompt":true}', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const { env, configDir } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.deepEqual(env, {}, '无冲突 key 放行');
    assert.ok(configDir);
});

test('D6d: settings.json env 含 ANTHROPIC_BASE_URL → 不 throw（路由由 settings.json 承载）', async () => {
    const wsDir = newTmpDir('d6d');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:11434"}}', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.deepEqual(env, {}, '不再拒绝（env 空，无覆盖冲突）');
});

test('D6e: settings.json 损坏（非 JSON）→ 不 throw（让 CLI 自己处理）', async () => {
    const wsDir = newTmpDir('d6e');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{ not valid json', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.deepEqual(env, {}, '损坏 settings.json 不视为冲突，放行');
});

// ════════════════════════════════════════════════════════════
// D7 自定义 env 透传已删除
// （回退 2026-08-14：所有配置走 settings.json，custom env key 不再注入 spawn env；
//  验证 env 恒为空、不透传任何自定义或系统 key）
// ════════════════════════════════════════════════════════════

test('D7a: direct content 含 CLAUDE_CODE_AUTO_COMPACT_WINDOW + FOO → env 不透传（走 settings.json）', async () => {
    const cfg = {
        id: 'c1', name: 'n',
        content: directContent({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000', FOO: 'bar' }),
        mode: 'direct',
    };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d7a'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.deepEqual(env, {}, '自定义 env key 不注入 spawn env（由 settings.json 承载）');
});

test('D7b: content 含 PATH/HOME/NODE_OPTIONS → env 不透传系统 key', async () => {
    const cfg = {
        id: 'c1', name: 'n',
        content: directContent({ PATH: '/usr/malicious/bin', HOME: '/bad/home', NODE_OPTIONS: '--inspect' }),
        mode: 'direct',
    };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d7b'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.deepEqual(env, {}, '系统 env key 不注入（不会覆盖调用方/系统的 PATH/HOME/NODE_OPTIONS）');
});