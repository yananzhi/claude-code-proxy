// proxy/test/retry-rules-review.test.mjs — 子代理审查 TDD 确认用例
//
// 运行：node --test --test-timeout=15000 proxy/test/retry-rules-review.test.mjs
//
// 来源：dev-with-tdd-review Step 5 隔离子代理审查的怀疑点。
//   S1 真 bug：code='all' 规则只在 resp.on('data') 调 tryDecide，空 body 的非 2xx
//      （如 503 Content-Length:0）data 事件不触发 → all 规则不评估 → 透传而非重试。
//      修复后应重试。
//   S2/S3/S4/S5 非 bug：翻转成正向回归用例，确认边界行为正确。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

let _portSeq = 100;
function nextPorts() {
    _portSeq += 1;
    return { proxyPort: 11610 + _portSeq * 2, upstreamPort: 11611 + _portSeq * 2 };
}

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
                res.end(JSON.stringify({ error: `mock: sequence exhausted (cursor=${self.cursor})` }));
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

const resp = {
    // 空 body 的 503（Content-Length:0，无 data 事件）—— 触发 S1 bug
    empty503: (_req, res) => {
        res.writeHead(503, { 'content-type': 'application/json', 'content-length': '0' });
        res.end();
    },
    // 空 body 的 429
    empty429: (_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', 'content-length': '0' });
        res.end();
    },
    // 真 200 成功（非流式）
    success: (_req, res, n) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            id: `msg_mock_${n}`, type: 'message', role: 'assistant',
            content: [{ type: 'text', text: 'ok' }], model: 'mock-model',
            stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }));
    },
    // 200 + code 10310 假成功
    busy200: (_req, res, n) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            error: { code: 10310, message: 'busy', type: 'api_error' },
            id: `cht_mock_${n}`, type: 'error',
        }));
    },
    // 200 + code 11210（假成功的鉴权失败形态）
    auth200: (_req, res, n) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            error: { code: 11210, message: 'authorization failed', type: 'invalid_request_error' },
            id: `cht_mock_${n}`, type: 'error',
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
    const d = join(process.cwd(), '.test-tmp', `rr-rev-${prefix}-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}

function makeConfig(upstreamPort, proxyPort, retryRules) {
    return {
        env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`, ANTHROPIC_AUTH_TOKEN: 'test-token' },
        effortLevel: '',
        proxy: { listenHost: '127.0.0.1', listenPort: proxyPort, passthrough: false, backoffSec: 0.05, backoffMaxSec: 0.1, retryRules },
    };
}

async function setup(retryRules) {
    const { proxyPort, upstreamPort } = nextPorts();
    const dir = newTmpDir('rev');
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(makeConfig(upstreamPort, proxyPort, retryRules)));
    const upstream = startMockUpstream([], upstreamPort);
    await upstream.start();
    const proxy = await startProxy(join(dir, 'config.json'), logsDir);
    return { dir, proxyPort, upstreamPort, upstream, proxy };
}

function teardown(ctx) {
    ctx.proxy.stop();
    ctx.upstream.server.close();
    rmSync(ctx.dir, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════
// S1 真 bug：空 body 的 503 + code='all' 规则 → 应重试，修复后成功
// ════════════════════════════════════════════════════════════════
test('S1: 空 body 503 + 503+all 规则 → 应重试到成功（修复后）', async () => {
    const ctx = await setup([{ status: 503, code: 'all' }]);
    try {
        ctx.upstream.sequence = [resp.empty503, resp.empty503, resp.success];
        const r = await postMessages(ctx.proxyPort);
        assert.equal(r.status, 200, '空 body 503 应被 503+all 规则重试，最终成功');
        const tr = await getLatestTrace(ctx.proxyPort);
        assert.equal(tr.outcome, 'success-after-retry');
        assert.equal(tr.attempts.length, 3, '重试 3 次');
    } finally {
        teardown(ctx);
    }
});

// S1b 补充：空 body 的 429 + 429+all 规则 → 应重试
test('S1b: 空 body 429 + 429+all 规则 → 应重试（修复后）', async () => {
    const ctx = await setup([{ status: 429, code: 'all' }]);
    try {
        ctx.upstream.sequence = [resp.empty429, resp.success];
        const r = await postMessages(ctx.proxyPort);
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(ctx.proxyPort);
        assert.equal(tr.outcome, 'success-after-retry');
        assert.equal(tr.attempts.length, 2);
    } finally {
        teardown(ctx);
    }
});

// ════════════════════════════════════════════════════════════════
// S3 翻转回归：{200,'all'} 规则 → 真 200 成功也会被重试（用户配置语义，非 bug）
// 用户显式配 200+all 表示"所有 200 都重试"，自负其责。
// ════════════════════════════════════════════════════════════════
test('S3: {200,all} 规则 → 真 200 成功被重试 [翻转回归，用户配置语义]', async () => {
    const ctx = await setup([{ status: 200, code: 'all' }]);
    try {
        ctx.upstream.sequence = [resp.success, resp.success, resp.success];
        const r = await postMessages(ctx.proxyPort);
        // 配了 200+all，所有 200 都重试，预算耗尽后透传最后一个 200
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(ctx.proxyPort);
        assert.equal(tr.attempts.length, 5, 'maxAttempts=5 全重试耗尽');
        assert.equal(tr.outcome, 'failed', '预算耗尽（虽末次是 200，但被当 retryable 重试到耗尽）');
    } finally {
        teardown(ctx);
    }
});

// ════════════════════════════════════════════════════════════════
// S4 翻转回归：{'*',10310} → 200+10310 假成功也重试（任意状态码通配）
// ════════════════════════════════════════════════════════════════
test('S4: {* ,10310} 规则 → 200+10310 假成功重试 [翻转回归]', async () => {
    const ctx = await setup([{ status: '*', code: 10310 }]);
    try {
        ctx.upstream.sequence = [resp.busy200, resp.success];
        const r = await postMessages(ctx.proxyPort);
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(ctx.proxyPort);
        assert.equal(tr.outcome, 'success-after-retry');
    } finally {
        teardown(ctx);
    }
});

// ════════════════════════════════════════════════════════════════
// S4b 翻转回归：{'*',10310} → 200+11210（非 10310 code）不重试透传
// ════════════════════════════════════════════════════════════════
test('S4b: {* ,10310} 规则 + 200+11210 → 不重试（code 不匹配）[翻转回归]', async () => {
    const ctx = await setup([{ status: '*', code: 10310 }]);
    try {
        ctx.upstream.sequence = [resp.auth200, resp.success];
        const r = await postMessages(ctx.proxyPort);
        // 11210 != 10310，不命中，透传 200（auth200 是 200 状态）
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(ctx.proxyPort);
        assert.equal(tr.attempts.length, 1, 'code 不匹配不重试');
    } finally {
        teardown(ctx);
    }
});

// ════════════════════════════════════════════════════════════════
// S6 边界：多条规则同时命中同一响应（503+all 和 503+10310 都配）
// ════════════════════════════════════════════════════════════════
test('S6: 多条规则同时命中（503+all + 503+10310）→ 仍重试一次 [边界]', async () => {
    const ctx = await setup([{ status: 503, code: 'all' }, { status: 503, code: 10310 }]);
    try {
        ctx.upstream.sequence = [resp.empty503, resp.success];
        const r = await postMessages(ctx.proxyPort);
        assert.equal(r.status, 200);
        const tr = await getLatestTrace(ctx.proxyPort);
        assert.equal(tr.attempts.length, 2, '两条规则命中同一响应只重试一次');
    } finally {
        teardown(ctx);
    }
});
