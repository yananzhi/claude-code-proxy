// mock/test-model.mjs — 验证 trace 的 model 字段提取：起 mock + 代理，发不同请求，从 /api/traces 检查 model 落盘。
//
// 运行：node --test mock/test-model.mjs  （已纳入全量 node --test）
// 独立端口 PROXY_PORT=11513 / MOCK_PORT=8793（避开其他测试和运行中扩展）。
//
// 测的点：
//   A. 正常 JSON 请求带 model → 列表 + 详情都有该 model
//   B. 真实 Claude model 名（带日期后缀）原样落盘（前端才缩短，trace 存原值）
//   C. JSON 请求无 model 字段 → model 为空串
//   D. 非 JSON content-type → model 为空串（不解析）
//   E. 坏 JSON body → model 为空串（不抛、不阻断转发）
//   F. count_tokens 端点的请求 → 也能提取 model
//   G. effort 改写不影响 model 提取（model 取自原始 body，改写后仍正确）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(__dirname, '..', 'proxy', 'server.js');
const MOCK_JS = join(__dirname, 'mock-server.js');
const PROXY_PORT = 11513;
const MOCK_PORT = 8793;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

function newTmpDir() {
    const d = join(process.cwd(), '.test-tmp', `model-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
function writeConfig(dir) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
        env: {
            ANTHROPIC_AUTH_TOKEN: 'mock-token',
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
            API_TIMEOUT_MS: '3000',
            ANTHROPIC_MODEL: 'mock-model',
        },
        effortLevel: '', // 不改写，原样透传；场景 G 临时热改
        proxy: {
            listenHost: '127.0.0.1',
            listenPort: PROXY_PORT,
            maxAttempts: 2,
            backoffSec: 0.1,
            backoffMaxSec: 0.5,
            passthrough: true, // 透传，直接落盘，不走重试
            retryOnStatus: [],
            retryOnBodyErrorCode: [],
        },
    }, null, 2) + '\n', 'utf8');
    return join(dir, 'config.json');
}
function kill(p) { if (p) try { p.kill('SIGTERM'); } catch {} }
async function waitHealth(url, label) {
    for (let i = 0; i < 100; i++) {
        try { const r = await fetch(url + '/healthz'); if (r.ok) return true; } catch {}
        await sleep(100);
    }
    throw new Error(`${label} did not become healthy`);
}

// 取最近一条匹配 path 的 trace 的 model 字段（先查列表，再查详情拿原值）
let sinceTs = 0;
async function lastTraceModel(pathMatch) {
    const r = await fetch(PROXY + `/api/traces?limit=20&since=${encodeURIComponent(new Date(sinceTs).toISOString())}`);
    const j = await r.json();
    const arr = j.items ?? j ?? [];
    for (const t of arr) {
        if (t.path && (pathMatch ? t.path === pathMatch : t.path.includes('messages'))) {
            // 列表摘要已带 model（summarize 抽出），直接用；同时核对详情一致
            const listModel = t.model;
            const rd = await fetch(PROXY + `/api/traces/${t.id}`);
            const jd = await rd.json();
            return { listModel, detailModel: jd.model ?? '', requestBody: jd.requestBody ?? '' };
        }
    }
    return { listModel: '(no trace)', detailModel: '(no trace)', requestBody: '' };
}

async function send(body, headers = {}) {
    return fetch(PROXY + '/v1/messages?beta=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

test('trace 的 model 字段提取：7 场景（正常/无model/非JSON/坏JSON/count_tokens/effort共存）', async () => {
    const dir = newTmpDir();
    const configPath = writeConfig(dir);
    const mockProc = spawn(process.execPath, [MOCK_JS], {
        env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SEQUENCE: 'success' },
        stdio: 'ignore',
    });
    mockProc.on('error', (e) => { throw new Error(`mock spawn failed: ${e.message}`); });
    const proxyProc = spawn(process.execPath, [SERVER_JS], {
        env: { ...process.env, CONFIG_PATH: configPath, CCP_LOGS_DIR: dir },
        stdio: 'ignore',
    });
    proxyProc.on('error', (e) => { throw new Error(`proxy spawn failed: ${e.message}`); });
    try {
        await waitHealth(MOCK, 'mock');
        await waitHealth(PROXY, 'proxy');

        // 场景 A：正常请求带 model="claude-sonnet-4-6" → 列表 + 详情都有
        sinceTs = Date.now() - 1000;
        await send({ model: 'claude-sonnet-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
        await sleep(300);
        let m = await lastTraceModel('/v1/messages?beta=true');
        assert.equal(m.listModel, 'claude-sonnet-4-6', 'A: 列表 model=claude-sonnet-4-6');
        assert.equal(m.detailModel, 'claude-sonnet-4-6', 'A: 详情 model=claude-sonnet-4-6');

        // 场景 B：带日期后缀的真实 model 名 → 原样落盘（trace 存原值，前端缩短是另一回事）
        sinceTs = Date.now() - 1000;
        await send({ model: 'claude-opus-4-8-20250610', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
        await sleep(300);
        m = await lastTraceModel('/v1/messages?beta=true');
        assert.equal(m.detailModel, 'claude-opus-4-8-20250610', 'B: 带 date 后缀原样落盘');

        // 场景 C：JSON 请求无 model 字段 → model 为空串
        sinceTs = Date.now() - 1000;
        await send({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
        await sleep(300);
        m = await lastTraceModel('/v1/messages?beta=true');
        assert.ok(m.listModel === '' && m.detailModel === '', `C: 无 model 字段 → 空串 got=${JSON.stringify(m)}`);

        // 场景 D：非 JSON content-type → 不解析，model 为空串
        sinceTs = Date.now() - 1000;
        await fetch(PROXY + '/v1/messages?beta=true', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: 'plain text body not json',
        });
        await sleep(300);
        m = await lastTraceModel('/v1/messages?beta=true');
        assert.equal(m.listModel, '', 'D: 非 JSON → model 空串');

        // 场景 E：坏 JSON body → 不抛、不阻断，model 空串
        sinceTs = Date.now() - 1000;
        await fetch(PROXY + '/v1/messages?beta=true', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{not valid json',
        });
        await sleep(300);
        m = await lastTraceModel('/v1/messages?beta=true');
        assert.equal(m.listModel, '', 'E: 坏 JSON → model 空串');

        // 场景 F：count_tokens 端点 → 也能提取 model
        sinceTs = Date.now() - 1000;
        await fetch(PROXY + '/v1/messages/count_tokens?beta=true', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }),
        });
        await sleep(300);
        m = await lastTraceModel('/v1/messages/count_tokens?beta=true');
        assert.equal(m.detailModel, 'claude-haiku-4-5', 'F: count_tokens 也能提取 model');

        // 场景 G：effort 改写开启时，model 仍取自原始 body 且正确
        sinceTs = Date.now() - 1000;
        await fetch(PROXY + '/api/effort', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ level: 'high' }),
        });
        await send({ model: 'claude-sonnet-4-6', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'low' } });
        await sleep(300);
        m = await lastTraceModel('/v1/messages?beta=true');
        assert.equal(m.detailModel, 'claude-sonnet-4-6', 'G: effort 改写时 model 仍正确');
        // 同时确认 effort 确实被改写了（model 提取不应破坏改写）
        let effort = '(no output_config.effort)';
        try { effort = JSON.parse(m.requestBody)?.output_config?.effort ?? effort; } catch {}
        assert.equal(effort, 'high', 'G: effort 被改写成 high');
    } finally {
        kill(mockProc); kill(proxyProc);
        rmSync(dir, { recursive: true, force: true });
    }
});
