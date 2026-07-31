// proxy/test/server-alias-e2e.test.mjs — model aliasing 端到端（真代理 + mock 上游）
//
// 运行：node --test proxy/test/server-alias-e2e.test.mjs
// 起 mock 上游 + 起 proxy server，发真实 /v1/messages 请求，验证：
//   D3 rewriteModel 与 rewriteEffort 串联
//   D4 rewriteModel 不受 isMessagesMain 守卫（count_tokens 子路径也替换）
//   D5 trace 记 reqModel（原始别名）+ resolvedModel（真实模型）
//   D6 热更新接口（POST /api/model-alias、delete、GET next-id、GET /api/config 含 modelAliases）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

const PROXY_PORT = 11499;  // 避开 11434-11436 真实代理
const UPSTREAM_PORT = 11500;

async function startMockUpstream() {
    const received = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            received.push({ method: req.method, url: req.url, headers: req.headers, body });
            // 回个最简非流式 200 响应
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'msg_test', type: 'message', role: 'assistant',
                content: [{ type: 'text', text: 'ok' }],
                model: JSON.parse(body || '{}').model || '',
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
            }));
        });
    });
    await new Promise((r) => server.listen(UPSTREAM_PORT, '127.0.0.1', r));
    return { server, received };
}

async function startProxy(configPath, logsDir) {
    const mod = await import('../server.js');
    const handle = await mod.startServer({ configPath, logsDir, logsConfigPath: join(logsDir, 'logs-config.json') });
    return handle;
}

async function reqJson(port, method, path, body) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

async function postMessages(port, model, { stream = false } = {}) {
    const body = { model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
    if (stream) body.stream = true;
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'test-token' },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

function newTmpDir(prefix) {
    const d = join(process.cwd(), '.test-tmp', `e2e-${prefix}-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}

// 端到端测试串（顺序敏感：共享一个 proxy + upstream 实例，用子测试）
test('e2e: model aliasing 全链路', async (t) => {
    const dir = newTmpDir('e2e');
    const configPath = join(dir, 'config.json');
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
        env: {
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
            ANTHROPIC_AUTH_TOKEN: 'test-token',
        },
        effortLevel: '',  // 不改写 effort，隔离 model 逻辑
        proxy: { listenHost: '127.0.0.1', listenPort: PROXY_PORT, passthrough: true },  // 透传：不重试
    }));
    const upstream = await startMockUpstream();
    const proxy = await startProxy(configPath, logsDir);

    await t.test('D6a: POST /api/model-alias 加映射 → 200', async () => {
        const r = await reqJson(PROXY_PORT, 'POST', '/api/model-alias', { alias: 'ccp-sonnet-1', model: 'claude-sonnet-5' });
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, true);
        assert.equal(r.json.alias, 'ccp-sonnet-1');
    });

    await t.test('D6e: GET /api/config 含 modelAliases', async () => {
        const r = await reqJson(PROXY_PORT, 'GET', '/api/config', null);
        assert.equal(r.status, 200);
        assert.equal(r.json.modelAliases['ccp-sonnet-1'], 'claude-sonnet-5');
        assert.equal(typeof r.json.nextAliasId, 'number');
    });

    await t.test('D2a/D5: /v1/messages 带 ccp-sonnet-1 → 上游收到真实模型 + trace 记别名', async () => {
        upstream.received.length = 0;
        const r = await postMessages(PROXY_PORT, 'ccp-sonnet-1');
        assert.equal(r.status, 200);
        // 上游收到的 model 是替换后的真实模型
        const upstreamBody = JSON.parse(upstream.received[0].body);
        assert.equal(upstreamBody.model, 'claude-sonnet-5');
        // 响应里的 model 也是真实模型
        assert.equal(r.json.model, 'claude-sonnet-5');
    });

    await t.test('D2c: 带 [1m] 命中 → 上游收到不带后缀的真实模型', async () => {
        upstream.received.length = 0;
        const r = await postMessages(PROXY_PORT, 'ccp-sonnet-1[1m]');
        assert.equal(r.status, 200);
        const upstreamBody = JSON.parse(upstream.received[0].body);
        assert.equal(upstreamBody.model, 'claude-sonnet-5');  // 剥了 [1m]
    });

    await t.test('D2b: 不命中的 model → 上游原样收到', async () => {
        upstream.received.length = 0;
        await postMessages(PROXY_PORT, 'other-model');
        const upstreamBody = JSON.parse(upstream.received[0].body);
        assert.equal(upstreamBody.model, 'other-model');
    });

    await t.test('D4b: /v1/messages/count_tokens 子路径也替换', async () => {
        upstream.received.length = 0;
        const body = { model: 'ccp-sonnet-1', messages: [{ role: 'user', content: 'hi' }] };
        const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages/count_tokens`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'test-token' },
            body: JSON.stringify(body),
        });
        assert.equal(res.status, 200);
        const upstreamBody = JSON.parse(upstream.received[0].body);
        assert.equal(upstreamBody.model, 'claude-sonnet-5');  // 子路径也替换
    });

    await t.test('D6c: GET /api/model-alias/next-id 递增', async () => {
        const r1 = await reqJson(PROXY_PORT, 'GET', '/api/model-alias/next-id', null);
        const r2 = await reqJson(PROXY_PORT, 'GET', '/api/model-alias/next-id', null);
        assert.equal(r1.status, 200);
        assert.equal(r2.status, 200);
        assert.ok(r2.json.id > r1.json.id, 'next-id 递增');
    });

    await t.test('D6d: POST /api/model-alias 缺字段 → 400', async () => {
        const r = await reqJson(PROXY_PORT, 'POST', '/api/model-alias', { alias: 'x' });  // 缺 model
        assert.equal(r.status, 400);
        assert.ok(r.json.error);
    });

    await t.test('D6b: POST /api/model-alias/delete → 下个请求不替换', async () => {
        const r = await reqJson(PROXY_PORT, 'POST', '/api/model-alias/delete', { alias: 'ccp-sonnet-1' });
        assert.equal(r.status, 200);
        assert.equal(r.json.removed, true);
        upstream.received.length = 0;
        await postMessages(PROXY_PORT, 'ccp-sonnet-1');
        const upstreamBody = JSON.parse(upstream.received[0].body);
        assert.equal(upstreamBody.model, 'ccp-sonnet-1');  // 删映射后不再替换
    });

    await t.test('D3/D5: effort+model 串联 + trace 记 reqModel/resolvedModel', async () => {
        // 配 effort=high + 重新加别名映射，验串联改写 + trace 两个字段
        await reqJson(PROXY_PORT, 'POST', '/api/model-alias', { alias: 'ccp-sonnet-1', model: 'claude-sonnet-5' });
        await reqJson(PROXY_PORT, 'POST', '/api/effort', { level: 'high' });
        upstream.received.length = 0;
        // 请求带 output_config.effort=low + model=ccp-sonnet-1
        const body = {
            model: 'ccp-sonnet-1', max_tokens: 10, output_config: { effort: 'low' },
            messages: [{ role: 'user', content: 'hi' }],
        };
        const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'test-token' },
            body: JSON.stringify(body),
        });
        assert.equal(res.status, 200);
        const upstreamBody = JSON.parse(upstream.received[0].body);
        // 两者都改：effort low→high + model 别名→真实
        assert.equal(upstreamBody.output_config.effort, 'high', 'effort 串联改写生效');
        assert.equal(upstreamBody.model, 'claude-sonnet-5', 'model 替换生效');
        // trace 记 reqModel（原始别名）+ resolvedModel（真实）
        const traceRes = await reqJson(PROXY_PORT, 'GET', '/api/traces?limit=5', null);
        const latest = traceRes.json[0];
        assert.ok(latest, 'trace 列表非空');
        assert.equal(latest.model, 'ccp-sonnet-1', 'trace reqModel 记原始别名');
        assert.equal(latest.resolvedModel, 'claude-sonnet-5', 'trace resolvedModel 记真实模型');
        // 复位 effort
        await reqJson(PROXY_PORT, 'POST', '/api/effort', { level: '' });
    });

    await proxy.stop();
    upstream.server.close();
    rmSync(dir, { recursive: true, force: true });
});
