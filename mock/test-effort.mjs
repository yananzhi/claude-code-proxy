// mock/test-effort.mjs — 验证 effort 改写：起 mock + 代理，发不同请求，从 /api/traces 检查发给上游的 effort。
//
// 运行：node --test mock/test-effort.mjs  （已纳入全量 node --test）
// 独立端口 PROXY_PORT=11511 / MOCK_PORT=8791（避开其他测试和运行中扩展）。
//
// 测的点（9 场景）：
//   A. effort=high → 应改成 max
//   B. effort=xhigh → 应改成 max
//   C. 无 output_config → 原样透传，不注入 effort
//   D. output_config 有 format 无 effort → 不注入
//   E. count_tokens 端点 → 不改写（非 /v1/messages 主路径）
//   F. 热重载 /api/effort {level:'high'} → 新请求改成 high
//   G. /api/config 应返回 effortLevel
//   H. level='' 不改写，effort 原样透传
//   I. 非法 effort 值应被拒绝 400
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
const PROXY_PORT = 11511;
const MOCK_PORT = 8791;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

function newTmpDir() {
    const d = join(process.cwd(), '.test-tmp', `effort-${process.pid}-${Date.now()}`);
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
        effortLevel: 'max',
        proxy: {
            listenHost: '127.0.0.1',
            listenPort: PROXY_PORT,
            maxAttempts: 2,
            backoffSec: 0.1,
            backoffMaxSec: 0.5,
            passthrough: true, // 透传，不走重试，直接看 mock 收到啥
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
function extractEffort(bodyStr) {
    try {
        const b = JSON.parse(bodyStr);
        return b?.output_config?.effort ?? '(no output_config.effort)';
    } catch { return '(parse error)'; }
}

// 从代理 trace 拿最近一条匹配 path 的完整 requestBody（=发给上游的 body，已改写）
// /api/traces 列表只给 preview，要用 /api/traces/{id} 拿完整 body
// sinceTs：只取测试开始后的 trace，隔离历史 trace 污染
let sinceTs = 0;
async function lastTraceBody(pathMatch) {
    const r = await fetch(PROXY + `/api/traces?limit=20&since=${encodeURIComponent(new Date(sinceTs).toISOString())}`);
    const j = await r.json();
    // /api/traces 已按 startedAt 降序（最近在前），取第一条匹配 path 的
    const arr = j.items ?? j ?? [];
    for (const t of arr) {
        if (t.path && (pathMatch ? t.path === pathMatch : t.path.includes('messages'))) {
            const id = t.id;
            const rd = await fetch(PROXY + `/api/traces/${id}`);
            const jd = await rd.json();
            return jd.requestBody ?? '';
        }
    }
    return '';
}

async function send(body, headers = {}) {
    return fetch(PROXY + '/v1/messages?beta=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

test('effort 改写：9 场景（high→max / 热重载 / 非法值拒绝）', async () => {
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

        // 记录开始时间，用 since 过滤历史 trace，避免跨测试残留污染断言
        sinceTs = Date.now();

        // 场景 A：effort=high → 应改成 max
        await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'high' } });
        await sleep(300);
        let body = await lastTraceBody('/v1/messages?beta=true');
        assert.equal(extractEffort(body), 'max', 'A: high → max');

        // 场景 B：effort=xhigh → 应改成 max
        await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'xhigh' } });
        await sleep(300);
        body = await lastTraceBody('/v1/messages?beta=true');
        assert.equal(extractEffort(body), 'max', 'B: xhigh → max');

        // 场景 C：无 output_config → 原样透传，不应注入 effort
        await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
        await sleep(300);
        body = await lastTraceBody('/v1/messages?beta=true');
        assert.equal(extractEffort(body), '(no output_config.effort)', 'C: no output_config → 不注入');

        // 场景 D：output_config 有 format 但无 effort → 不注入 effort（只改已存在的 effort）
        await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } });
        await sleep(300);
        body = await lastTraceBody('/v1/messages?beta=true');
        assert.equal(extractEffort(body), '(no output_config.effort)', 'D: output_config 有 format 无 effort → 不注入');

        // 场景 E：count_tokens 端点 → 不应改写（非 /v1/messages 主路径）
        await fetch(PROXY + '/v1/messages/count_tokens?beta=true', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'high' } }),
        });
        await sleep(300);
        const ctBody = await lastTraceBody('/v1/messages/count_tokens?beta=true');
        const ctEffort = extractEffort(ctBody);
        assert.equal(ctEffort, 'high', 'E: count_tokens 不改写（仍 high）');

        // 场景 F：热重载 API——POST /api/effort {level:'high'}，新请求应改成 high（无需重启）
        sinceTs = Date.now();
        const rf = await fetch(PROXY + '/api/effort', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ level: 'high' }),
        });
        const jf = await rf.json();
        assert.ok(jf.ok && jf.effortLevel === 'high', `F: /api/effort 返回 ok+effortLevel got=${JSON.stringify(jf)}`);
        await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'low' } });
        await sleep(300);
        body = await lastTraceBody('/v1/messages?beta=true');
        assert.equal(extractEffort(body), 'high', 'F: 热重载 high 生效（low→high）');

        // 场景 G：/api/config 应返回 effortLevel
        const rc = await fetch(PROXY + '/api/config');
        const jc = await rc.json();
        assert.equal(jc.effortLevel, 'high', 'G: /api/config 返回 effortLevel=high');

        // 场景 H：切到"不改写"（level=''），effort 原样透传不强制改
        sinceTs = Date.now();
        const rh = await fetch(PROXY + '/api/effort', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ level: '' }),
        });
        const jh = await rh.json();
        assert.equal(jh.effortLevel, '', `H: /api/effort level="" 返回 effortLevel="" got=${JSON.stringify(jh)}`);
        await send({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], output_config: { effort: 'high' } });
        await sleep(300);
        body = await lastTraceBody('/v1/messages?beta=true');
        assert.equal(extractEffort(body), 'high', 'H: 不改写时 effort 原样透传（仍 high）');

        // 场景 I：非法 effort 值应被拒绝（400）
        const ri = await fetch(PROXY + '/api/effort', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ level: 'ultracode-xhigh+workflows' }),
        });
        assert.equal(ri.status, 400, `I: 非法 effort 值拒绝 400 got=status${ri.status}`);
    } finally {
        kill(mockProc); kill(proxyProc);
        rmSync(dir, { recursive: true, force: true });
    }
});
