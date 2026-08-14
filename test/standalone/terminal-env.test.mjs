// test/standalone/terminal-env.test.mjs — buildTerminalEnv 测试
//
// 运行：node --test test/standalone/terminal-env.test.mjs
//
// 维度：
//   D1 normal-direct env 构建
//   D2 normal-proxy env 构建（注入 upstream 到代理）
//   S1-S6 代码审查 TDD 怀疑点（类型安全/边界/一致性/错误路径）
//   D5 configDir 共享约束（避免重复引导）
//   D6 settings.json 冲突检测
//   D7 自定义 env 透传（CLAUDE_CODE_AUTO_COMPACT_WINDOW 等）
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
// （env 注入 ANTHROPIC_* 真实配置 + 共享 configDir，不再读 settings.json）
// ════════════════════════════════════════════════════════════
test('D1a: direct config → env 含上游 BASE_URL/TOKEN/MODEL + 共享 configDir + 不碰代理', async () => {
    const wsDir = newTmpDir('d1a');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const fwd = makeMockForward();
    const { env, configDir } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd });
    // direct env 注入上游真实地址 + token + model（不再靠 settings.json）
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://up.test');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-direct');
    assert.equal(env.ANTHROPIC_MODEL, 'real-model');
    // configDir 共享 {ws}/.claude_proxy（防 settings.json 覆盖 env）
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

test('D1e: direct content 无 MODEL → env 不含 ANTHROPIC_MODEL（不报错）', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_MODEL: undefined }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1e'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_MODEL, undefined, '无 MODEL 不应注入');
    // BASE_URL/TOKEN 仍在
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://up.test');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-direct');
});

test('D1f: direct content 无 SMALL_FAST_MODEL/TIMEOUT → env 不含', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_SMALL_FAST_MODEL: undefined, API_TIMEOUT_MS: undefined }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1f'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    assert.equal(env.API_TIMEOUT_MS, undefined);
});

test('D1g: direct → env 含 SMALL_FAST_MODEL + TIMEOUT（毫秒字符串）', async () => {
    // directContent 已含 SMALL_FAST_MODEL=fast-model + API_TIMEOUT_MS=30000
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1g'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, 'fast-model');
    // 30000ms → 保持毫秒字符串（与 timeoutSec*1000 一致）
    assert.equal(env.API_TIMEOUT_MS, '30000');
});

// ════════════════════════════════════════════════════════════
// D2 normal-proxy
// （env BASE_URL 指向代理 + 共享 configDir + 注入 upstream）
// ════════════════════════════════════════════════════════════
test('D2a: proxy config → env BASE_URL=代理 + TOKEN + MODEL + 共享 configDir + 注入 upstream', async () => {
    const wsDir = newTmpDir('d2a');
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env, configDir } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd });
    // proxy env BASE_URL 指向代理（不是上游真实地址）
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11444');
    // token 仍是上游 token（代理透传时用）
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-proxy');
    assert.equal(env.ANTHROPIC_MODEL, 'proxy-model');
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

// S2（类型安全）：ANTHROPIC_MODEL 为非字符串（数字）时，env 应不含或拒绝，不应原样注入数字
test('S2: direct content MODEL 是数字 → env 不应含数字型 MODEL', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ ANTHROPIC_MODEL: 42 }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s2'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    // 期望：要么不含，要么是字符串；不应是数字 42
    assert.equal(typeof env.ANTHROPIC_MODEL === 'undefined' || typeof env.ANTHROPIC_MODEL === 'string', true,
        `MODEL 应为 undefined 或 string，实际: ${typeof env.ANTHROPIC_MODEL} = ${JSON.stringify(env.ANTHROPIC_MODEL)}`);
});

// S3（边界）：API_TIMEOUT_MS 非法值（0/负/NaN/空串）→ env 不含
test('S3a: direct content API_TIMEOUT_MS=0 → env 不含', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ API_TIMEOUT_MS: '0' }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s3a'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.API_TIMEOUT_MS, undefined, '0ms 应视为无效不注入');
});

test('S3b: direct content API_TIMEOUT_MS=-5 → env 不含', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ API_TIMEOUT_MS: '-5' }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s3b'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.API_TIMEOUT_MS, undefined, '负数应视为无效不注入');
});

test('S3c: direct content API_TIMEOUT_MS="abc" → env 不含', async () => {
    const cfg = { id: 'c1', name: 'n', content: directContent({ API_TIMEOUT_MS: 'abc' }), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s3c'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.API_TIMEOUT_MS, undefined, '非数字字符串应视为无效不注入');
});

// S4（一致性）：proxy 模式 + API_TIMEOUT_MS 非法 → upstream body 不含 timeoutSec，但仍注入 upstream + env 不含
test('S4: proxy + API_TIMEOUT_MS 非法 → upstream body 无 timeoutSec + env 无 API_TIMEOUT_MS', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ API_TIMEOUT_MS: 'abc' }), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s4'), terminalId: 't1', proxyForwardFn: fwd });
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
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s5'), terminalId: 't1', proxyForwardFn: throwingFwd }),
        /ECONNREFUSED|不可达/i,
    );
});

// S6（一致性/状态）：proxy 模式小数毫秒 timeout → CLI env 与 proxy timeoutSec 应一致（不差 500ms）
test('S6: proxy + API_TIMEOUT_MS=30500 → env API_TIMEOUT_MS 与 proxy timeoutSec*1000 一致', async () => {
    const cfg = { id: 'c1', name: 'n', content: proxyContent({ API_TIMEOUT_MS: '30500' }), mode: 'proxy' };
    const fwd = makeMockForward();
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s6'), terminalId: 't1', proxyForwardFn: fwd });
    const upCall = fwd.calls.find(c => c.path === '/api/upstream' && c.method === 'POST');
    const proxyTimeoutMs = upCall.body.upstream.timeoutSec * 1000;
    const cliTimeoutMs = Number(env.API_TIMEOUT_MS);
    assert.equal(cliTimeoutMs, proxyTimeoutMs,
        `CLI env API_TIMEOUT_MS(${cliTimeoutMs}) 应与 proxy timeoutSec*1000(${proxyTimeoutMs}) 一致，不应差 500ms`);
});

// ════════════════════════════════════════════════════════════
// D5 configDir 共享假设约束（修复问题2：避免重复引导）
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
// D6 settings.json 检测（env 注入与 settings.json 不共存）
// ════════════════════════════════════════════════════════════
test('D6a: 普通代理模式 + settings.json 存在 → throw（不因代理模式跳过检测）', async () => {
    const wsDir = newTmpDir('d6a');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"env":{"ANTHROPIC_MODEL":"stale-m"}}', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: proxyContent(), mode: 'proxy' };
    const fwd = makeMockForward({ 'POST /api/upstream': { status: 200, body: {} } });
    await assert.rejects(
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: fwd }),
        /settings\.json.*存在|不支持共存|ValidationError/i,
    );
});

test('D6c: settings.json 仅 theme/skipDangerous（无 env 冲突 key）→ 放行（不 throw）', async () => {
    // CLI 自己写的引导标记，无 env，不冲突，放行（第二次起终端能成功的保证）
    const wsDir = newTmpDir('d6c');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"theme":"dark","skipDangerousModePermissionPrompt":true}', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const { env, configDir } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_MODEL, 'real-model', '无冲突 key 应放行，env 正常注入');
    assert.ok(configDir);
});

test('D6d: settings.json env 含 ANTHROPIC_BASE_URL → throw（冲突 key 覆盖路由）', async () => {
    const wsDir = newTmpDir('d6d');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{"env":{"ANTHROPIC_BASE_URL":"http://stale"}}', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    await assert.rejects(
        () => buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: makeMockForward() }),
        /ANTHROPIC_BASE_URL|覆盖.*modelname|不支持共存/i,
    );
});

test('D6e: settings.json 损坏（非 JSON）→ 不 throw（让 CLI 自己处理）', async () => {
    const wsDir = newTmpDir('d6e');
    mkdirSync(join(wsDir, '.claude_proxy'), { recursive: true });
    writeFileSync(join(wsDir, '.claude_proxy', 'settings.json'), '{ not valid json', 'utf8');
    const cfg = { id: 'c1', name: 'n', content: directContent(), mode: 'direct' };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: wsDir, terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.ANTHROPIC_MODEL, 'real-model', '损坏 settings.json 不视为冲突，放行');
});

// ════════════════════════════════════════════════════════════
// D7 自定义 env 透传（CLAUDE_CODE_AUTO_COMPACT_WINDOW 等）
// 证明：启动入口当前只透传路由 key，丢自定义 env key。
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
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1c-custom'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000', '自定义 env key 应透传到 spawn env');
    assert.equal(env.FOO, 'bar', '其余自定义 env key 也应透传');
    // 路由 key 仍在（不被 customEnv 影响）
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://up.test');
    assert.equal(env.ANTHROPIC_MODEL, 'real-model');
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
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('d1c-conflict'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    // ANTHROPIC_MODEL 来自显式构造（parsed.env.ANTHROPIC_MODEL='x'），不被 customEnv 干扰
    assert.equal(env.ANTHROPIC_MODEL, 'x', 'ANTHROPIC_MODEL 应由显式构造，不被 customEnv 覆盖');
    // 自定义 key 仍透传
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000');
});

// ════════════════════════════════════════════════════════════
// TDD 审查：高风险怀疑点（保留 non-derived 部分）
// ════════════════════════════════════════════════════════════

// TDD-S5 (Cat 4 状态迁移): customEnv 覆盖调用方显式设的 key（normal 分支）
// 怀疑：normal 分支里 env 先构造路由 key，再 Object.assign(env, extractCustomEnv(parsed.env))。
// extractCustomEnv 排除路由 key，但不排除其他可能被调用方设的 key。
// 更直接的风险：若 content.env 含 PATH/HOME/NODE_OPTIONS 等系统 env key，customEnv 会透传它们
// 覆盖调用方/系统的 env。验证：customEnv 是否透传 PATH（潜在安全/功能风险）。
test('TDD-S5: normal content 含 PATH → customEnv 透传 PATH（潜在系统 env 覆盖风险）', async () => {
    const cfg = {
        id: 'c1', name: 'n',
        content: directContent({ PATH: '/usr/malicious/bin', HOME: '/bad/home', NODE_OPTIONS: '--inspect' }),
        mode: 'direct',
    };
    const { env } = await buildTerminalEnv(cfg, 11444, { workspaceDir: newTmpDir('s5'), terminalId: 't1', proxyForwardFn: makeMockForward() });
    // 怀疑 bug：customEnv 透传了 PATH/HOME/NODE_OPTIONS
    // 断言"bug 存在"：env 应含 PATH（从 content 透传）
    // 若已修复（系统 env key 应被排除）：env 不含 PATH
    assert.equal(env.PATH, undefined, 'PATH 不应从 content.env 透传（会覆盖系统 PATH）');
    assert.equal(env.HOME, undefined, 'HOME 不应从 content.env 透传（会覆盖系统 HOME）');
    assert.equal(env.NODE_OPTIONS, undefined, 'NODE_OPTIONS 不应从 content.env 透传（会覆盖系统 NODE_OPTIONS）');
});
