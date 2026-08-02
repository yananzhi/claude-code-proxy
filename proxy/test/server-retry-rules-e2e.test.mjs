// proxy/test/server-retry-rules-e2e.test.mjs — retryRules 判定逻辑端到端（真代理 + mock 上游）
//
// 运行：node --test proxy/test/server-retry-rules-e2e.test.mjs
// 起 mock 上游（按序列返回故障）+ 起 proxy server，发真实 /v1/messages 请求，验证：
//   D1/D2 规则匹配（具体 status+code / status+all / *+code）
//   D4 决断时机（all 规则响应头即决断，修复 retryOnStatus 被流式吞掉的 bug）
//   D5 重试预算（success-direct / success-after-retry / failed）
//   D6 拦截重试模式 vs 透传模式
//   D3 body 形态（error JSON / 成功 SSE / 非 error 结构）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

// 每个顶层测试分配独立端口对（node --test 顶层 test 默认并发跑，避免 EADDRINUSE）。
let _portSeq = 0;
function nextPorts() {
    _portSeq += 1;
    return { proxyPort: 11510 + _portSeq * 2, upstreamPort: 11511 + _portSeq * 2 };
}

// 构造一个按序列返回响应的 mock 上游。每个序列项是一个响应生成器函数 (req, res, body) => void。
// sequence 存在闭包外层对象上（self.sequence），server 读 self.sequence 拿最新值（支持 reset 后重设）。
function startMockUpstream(initialSequence, port) {
    const self = { sequence: initialSequence, received: [], cursor: 0 };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            self.received.push({ method: req.method, url: req.url, headers: req.headers, body });
            const seq = self.sequence;
            const mode = self.cursor < seq.length ? seq[self.cursor] : seq[seq.length - 1];
            self.cursor++;
            if (typeof mode !== 'function') {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: `mock: sequence exhausted or mode not a function (cursor=${self.cursor})` }));
                return;
            }
            mode(req, res, self.received.length, body);
        });
    });
    return {
        server,
        get received() { return self.received; },
        start: () => new Promise((r) => server.listen(port, '127.0.0.1', r)),
        reset: () => { self.cursor = 0; self.received.length = 0; },
        set sequence(v) { self.sequence = v; },
    };
}

// ── 响应生成器 ──
const resp = {
    // 讯飞 system busy：503 + code 10310
    busy503: (_req, res, n) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            error: { code: 10310, message: 'The system is busy, please try again later.', type: 'api_error' },
            id: `cht_mock_${n}`, type: 'error',
        }));
    },
    // 假成功：200 + code 10310
    busy200: (_req, res, n) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            error: { code: 10310, message: 'The system is busy, please try again later.', type: 'api_error' },
            id: `cht_mock_${n}`, type: 'error',
        }));
    },
    // 讯飞网关鉴权失败：429 + code 11210
    auth429: (_req, res, n) => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            error: { code: 11210, message: 'authorization failed', type: 'invalid_request_error' },
            id: `cht_mock_${n}`, type: 'error',
        }));
    },
    // 普通 429（非规则 code，Claude Code 能处理）：429 + body 无匹配 code
    plain429: (_req, res, n) => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'rate limited (non-rule code)' },
            id: `cht_mock_${n}`,
        }));
    },
    // 503 但 body 是别的 code（非规则）
    other503: (_req, res, n) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            error: { code: 50399, message: 'other 503', type: 'api_error' },
            id: `cht_mock_${n}`, type: 'error',
        }));
    },
    // 成功非流式 JSON
    success: (_req, res, n, receivedBody) => {
        let model = 'mock-model';
        try { model = JSON.parse(receivedBody || '{}').model || model; } catch {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            id: `msg_mock_${n}`, type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'ok' }], model,
            stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }));
    },
};

async function startProxy(configPath, logsDir) {
    const mod = await import('../server.js');
    return mod.startServer({ configPath, logsDir, logsConfigPath: join(logsDir, 'logs-config.json') });
}

async function postMessages(port) {
    const body = { model: 'mock-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-token' },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

async function getLatestTrace(port) {
    const r = await fetch(`http://127.0.0.1:${port}/api/traces?limit=1`);
    const arr = await r.json();
    return arr[0] ?? null;
}

async function updateRetryRules(port, retryRules) {
    await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proxy: { retryRules } }),
    });
}

function newTmpDir(prefix) {
    const d = join(process.cwd(), '.test-tmp', `rr-e2e-${prefix}-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}

function makeConfig(dir, upstreamPort, proxyPort, { passthrough = false, retryRules } = {}) {
    return {
        env: {
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
            ANTHROPIC_AUTH_TOKEN: 'test-token',
        },
        effortLevel: '',
        // 退避用极小值：重试测试要跑多次 attempt，默认 1s/16s 会撑爆 test timeout。
        proxy: { listenHost: '127.0.0.1', listenPort: proxyPort, passthrough, backoffSec: 0.05, backoffMaxSec: 0.1, ...(retryRules ? { retryRules } : {}) },
    };
}

// ════════════════════════════════════════════════════════════════
// 测试串 1：默认规则 + 拦截重试模式
// ════════════════════════════════════════════════════════════════
test('e2e retryRules: 默认规则（503+10310 / 200+10310）', async (t) => {
    const { proxyPort: PROXY_PORT, upstreamPort: UPSTREAM_PORT } = nextPorts();
    const dir = newTmpDir('default');
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(makeConfig(dir, UPSTREAM_PORT, PROXY_PORT, { passthrough: false })));
    const upstream = startMockUpstream([], UPSTREAM_PORT);
    await upstream.start();
    const proxy = await startProxy(join(dir, 'config.json'), logsDir);

    await t.test('D5a: 503+10310 ×2 → success（重试后成功，attempts=3）', async () => {
        upstream.reset();
        upstream.sequence = [resp.busy503, resp.busy503, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.outcome, 'success-after-retry');
        assert.equal(tr.attempts.length, 3);
    });

    await t.test('D3a: 200+10310 假成功 → 重试（默认规则含 200+10310）', async () => {
        upstream.reset();
        upstream.sequence = [resp.busy200, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.outcome, 'success-after-retry');
        assert.equal(tr.attempts.length, 2);
    });

    await t.test('D5b: 503+10310 重试预算耗尽 → failed（末次透传 503）', async () => {
        upstream.reset();
        // 全部 503，maxAttempts 默认 5 → 耗尽
        upstream.sequence = [resp.busy503, resp.busy503, resp.busy503, resp.busy503, resp.busy503];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 503);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.outcome, 'failed');
        assert.equal(tr.attempts.length, 5);
    });

    await t.test('D2c: 普通 429（非规则 code）→ 透传不重试', async () => {
        upstream.reset();
        upstream.sequence = [resp.plain429, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 429);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.attempts.length, 1, '不重试，1 次 attempt');
    });

    await t.test('D1c: 503 但 code 非 10310（50399）→ 不重试透传', async () => {
        upstream.reset();
        upstream.sequence = [resp.other503, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 503);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.attempts.length, 1, '非规则 503 不重试');
    });

    await proxy.stop();
    upstream.server.close();
    rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════
// 测试串 2：用户自定义规则（429+11210）+ all 通配 + * 通配
// ════════════════════════════════════════════════════════════════
test('e2e retryRules: 自定义规则 + 通配', async (t) => {
    const { proxyPort: PROXY_PORT, upstreamPort: UPSTREAM_PORT } = nextPorts();
    const dir = newTmpDir('custom');
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(makeConfig(dir, UPSTREAM_PORT, PROXY_PORT, { passthrough: false })));
    const upstream = startMockUpstream([], UPSTREAM_PORT);
    await upstream.start();
    const proxy = await startProxy(join(dir, 'config.json'), logsDir);

    await t.test('D1a/D2a: 429+11210 规则 → 重试后成功', async () => {
        await updateRetryRules(PROXY_PORT, [{ status: 429, code: 11210 }]);
        upstream.reset();
        upstream.sequence = [resp.auth429, resp.auth429, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.outcome, 'success-after-retry');
        assert.equal(tr.attempts.length, 3);
    });

    await t.test('D2b: 503+all 规则 → 所有 503 都重试（响应头即决断，修复核心 bug）', async () => {
        // 只配 503+all，不含 503+10310。验证 all 通配不看 body code 也能重试。
        await updateRetryRules(PROXY_PORT, [{ status: 503, code: 'all' }]);
        upstream.reset();
        upstream.sequence = [resp.other503, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.outcome, 'success-after-retry');
        assert.equal(tr.attempts.length, 2, '503+all 规则对非 10310 的 503 也重试');
    });

    await t.test('D1b: status="*"+code 通配 → 任意状态码 + 该 code 都重试', async () => {
        // 配 *+11210：429+11210 和 503+11210 都应重试
        await updateRetryRules(PROXY_PORT, [{ status: '*', code: 11210 }]);
        upstream.reset();
        upstream.sequence = [resp.auth429, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.outcome, 'success-after-retry');
    });

    await t.test('D5c: maxAttempts=1 + 可重试规则 → 不重试直接透传', async () => {
        await updateRetryRules(PROXY_PORT, [{ status: 429, code: 11210 }]);
        // 改 maxAttempts=1
        await fetch(`http://127.0.0.1:${PROXY_PORT}/api/config`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ proxy: { maxAttempts: 1 } }),
        });
        upstream.reset();
        upstream.sequence = [resp.auth429, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 429, 'maxAttempts=1 不重试，直接透传 429');
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.attempts.length, 1);
        // 复位 maxAttempts
        await fetch(`http://127.0.0.1:${PROXY_PORT}/api/config`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ proxy: { maxAttempts: 5 } }),
        });
    });

    await proxy.stop();
    upstream.server.close();
    rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════
// 测试串 3：透传模式不判规则 + 空规则表
// ════════════════════════════════════════════════════════════════
test('e2e retryRules: 透传模式 + 空规则', async (t) => {
    const { proxyPort: PROXY_PORT, upstreamPort: UPSTREAM_PORT } = nextPorts();
    const dir = newTmpDir('passthru');
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(makeConfig(dir, UPSTREAM_PORT, PROXY_PORT, { passthrough: true })));
    const upstream = startMockUpstream([], UPSTREAM_PORT);
    await upstream.start();
    const proxy = await startProxy(join(dir, 'config.json'), logsDir);

    await t.test('D6b: 透传模式 + 503+10310 → 不重试直接透传 503', async () => {
        upstream.reset();
        upstream.sequence = [resp.busy503, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 503);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.attempts.length, 1, '透传模式不重试');
    });

    await proxy.stop();
    upstream.server.close();
    rmSync(dir, { recursive: true, force: true });
});

test('e2e retryRules: 空规则表不重试任何', async (t) => {
    const { proxyPort: PROXY_PORT, upstreamPort: UPSTREAM_PORT } = nextPorts();
    const dir = newTmpDir('emptyrules');
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(makeConfig(dir, UPSTREAM_PORT, PROXY_PORT, {
        passthrough: false, retryRules: [],
    })));
    const upstream = startMockUpstream([], UPSTREAM_PORT);
    await upstream.start();
    const proxy = await startProxy(join(dir, 'config.json'), logsDir);

    await t.test('D7g: 空 retryRules + 503+10310 → 不重试透传', async () => {
        upstream.reset();
        upstream.sequence = [resp.busy503, resp.success];
        const r = await postMessages(PROXY_PORT);
        assert.equal(r.status, 503);
        const tr = await getLatestTrace(PROXY_PORT);
        assert.equal(tr.attempts.length, 1, '空规则表不重试');
    });

    await proxy.stop();
    upstream.server.close();
    rmSync(dir, { recursive: true, force: true });
});
