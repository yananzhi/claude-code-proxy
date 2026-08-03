// mock/test-logs.mjs — 测日志目录可配置 + 四档过滤 + attempts 摘要 + kill
//
// 运行：node --test mock/test-logs.mjs  （已纳入全量 node --test）
// 独立端口 PROXY_PORT=11512 / MOCK_PORT=8792（避开其他测试和运行中扩展）。
// 起 mock 上游 + 代理，发请求造 trace，再断言。纯 HTTP + 文件系统，不依赖扩展宿主。
//
// 测的点：
//   1. 默认 logsDir：GET 返回 dir + configured=false
//   2. 改目录：POST → 回读一致 + configured=true + 目录被 mkdir
//   3. 改完后 trace 写到新目录
//   4. 四档过滤：构造 success-direct / success-after-retry / failed / pass-through，验证各档命中数
//   5. attempts 摘要带回来（数组，不含 body，带 status/verdict/reason）
//   6. 恢复默认（空 dir）
//   7. 非法路径：返回错误，不改运行时
//   8. /api/kill：关闭监听，healthz 不通
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, unlinkSync, rmSync, existsSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(__dirname, '..', 'proxy', 'server.js');
const MOCK_JS = join(__dirname, 'mock-server.js');
const PROXY_PORT = 11512;
const MOCK_PORT = 8792;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

const CONFIG_BODY = JSON.stringify({
    env: {
        ANTHROPIC_AUTH_TOKEN: 'mock-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        API_TIMEOUT_MS: '3000',
        ANTHROPIC_MODEL: 'mock-model',
    },
    effortLevel: 'xhigh',
    proxy: {
        listenHost: '127.0.0.1',
        listenPort: PROXY_PORT,
        maxAttempts: 5,
        backoffSec: 0.1,
        backoffMaxSec: 1,
        passthrough: false,
        retryOnStatus: [408, 429, 500, 502, 504],
        retryOnBodyErrorCode: [10310],
    },
}, null, 2);

const TMP_LOGS = join(tmpdir(), `claude-code-proxy-logs-test-${process.pid}-${Date.now()}`);

function newTmpDir() {
    const d = join(process.cwd(), '.test-tmp', `logs-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
function writeConfig(dir) {
    writeFileSync(join(dir, 'config.json'), CONFIG_BODY + '\n', 'utf8');
    return join(dir, 'config.json');
}
function kill(p) { if (p) { try { p.kill('SIGTERM'); } catch {} } }

async function waitHealth(url, label) {
    for (let i = 0; i < 100; i++) {
        try { const r = await fetch(url + '/healthz'); if (r.ok) return true; } catch {}
        await sleep(100);
    }
    throw new Error(`${label} did not become healthy`);
}

async function setMockSequence(seq) {
    await fetch(MOCK + '/__mock/control', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sequence: seq }),
    });
}

async function sendMessages() {
    const r = await fetch(PROXY + '/v1/messages?beta=true', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'mock-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { status: r.status, body: await r.text() };
}

async function makeTrace(seq) { await setMockSequence(seq); return sendMessages(); }

async function tracesFiles(dir) {
    await sleep(50);
    try { return readdirSync(dir).filter(f => /^traces-.*\.jsonl$/.test(f)); } catch { return []; }
}

async function readAllTraces(dir) {
    const files = await tracesFiles(dir);
    const all = [];
    for (const f of files) {
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { all.push(JSON.parse(line)); } catch {}
        }
    }
    return all;
}

async function getLogsDir() { return (await (await fetch(PROXY + '/api/logs-dir')).json()); }
async function postLogsDir(dir) {
    return (await (await fetch(PROXY + '/api/logs-dir', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir }),
    })).json());
}
async function listTraces(mode) {
    return (await (await fetch(PROXY + `/api/traces?limit=500&mode=${encodeURIComponent(mode || 'all')}`)).json());
}

test('日志目录可配置 + 四档过滤 + attempts 摘要 + kill', async () => {
    // 清理并准备临时日志目录
    try { rmSync(TMP_LOGS, { recursive: true, force: true }); } catch {}
    mkdirSync(TMP_LOGS, { recursive: true });

    const dir = newTmpDir();
    const configPath = writeConfig(dir);
    const mockProc = spawn(process.execPath, [MOCK_JS], {
        env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: 'ignore',
    });
    mockProc.on('error', (e) => { throw new Error(`mock spawn failed: ${e.message}`); });
    const proxyProc = spawn(process.execPath, [SERVER_JS], {
        env: { ...process.env, CONFIG_PATH: configPath, CCP_LOGS_DIR: dir }, stdio: 'ignore',
    });
    proxyProc.on('error', (e) => { throw new Error(`proxy spawn failed: ${e.message}`); });
    try {
        await waitHealth(MOCK, 'mock');
        await waitHealth(PROXY, 'proxy');

        // ── 1. 默认 logsDir（CLI 模式无 logsConfigPath，默认 = 代码目录内 logs）──
        {
            const r = await getLogsDir();
            assert.ok(!!r.dir, `1.1 默认 GET 返回 dir got=dir=${r.dir}`);
            assert.equal(r.configured, false, `1.2 默认 configured=false got=configured=${r.configured}`);
        }

        // ── 2. 改目录 ──
        {
            const r = await postLogsDir(TMP_LOGS);
            assert.ok(r.ok === true && r.dir === TMP_LOGS, `2.1 POST 改目录 ok got=${JSON.stringify(r)}`);
            const g = await getLogsDir();
            assert.equal(g.dir, TMP_LOGS, `2.2 GET 回读一致 got=${g.dir}`);
            assert.equal(g.configured, true, `2.3 configured=true got=configured=${g.configured}`);
            assert.ok(existsSync(TMP_LOGS), '2.4 目录被 mkdir dir missing');
        }

        // ── 3. 改完目录后 trace 写到新目录 ──
        {
            const before = (await tracesFiles(TMP_LOGS)).length;
            await makeTrace(['success']);
            const after = (await tracesFiles(TMP_LOGS)).length;
            assert.ok(after > before, `3.1 新目录出现 trace 文件 got=before=${before} after=${after}`);
            const traces = await readAllTraces(TMP_LOGS);
            assert.ok(traces.length > 0, `3.2 trace 内容在新目录 got=count=${traces.length}`);
            assert.ok(traces.some(t => t.outcome === 'success-direct'), `3.3 有 success-direct got=outcomes=${traces.map(t => t.outcome).join(',')}`);
        }

        // ── 4. 四档过滤 ──
        // 清空当前目录，确保只看这一轮构造的
        for (const f of await tracesFiles(TMP_LOGS)) { try { unlinkSync(join(TMP_LOGS, f)); } catch {} }
        //   a) success-direct：1 次成功
        //   b) success-after-retry：503,503,success
        //   c) failed：5×503 耗尽
        //   d) pass-through 非2xx：503-other（503 但 code 非 10310，透传不重试）
        await makeTrace(['success']);
        await makeTrace(['503', '503', 'success']);
        await makeTrace(['503', '503', '503', '503', '503']);
        await makeTrace(['503-other']);
        {
            const all = await listTraces('all');
            assert.equal(all.length, 4, `4.1 mode=all 命中 4 条 got=${all.length}`);
            const retried = await listTraces('retried');
            // retried: b(attempts=3) + c(attempts=5) = 2。a(1)、d(1) 不算
            assert.equal(retried.length, 2, `4.2 mode=retried 命中 2 条 got=${retried.length} atts=${retried.map(t => t.attempts.length).join(',')}`);
            assert.ok(retried.every(t => t.attempts.length > 1), '4.3 retried 都是 attempts>1');
            const failed = await listTraces('failed');
            // failed: 只 c
            assert.equal(failed.length, 1, `4.4 mode=failed 命中 1 条 got=${failed.length}`);
            const llmErr = await listTraces('llm-error');
            // llm-error: b(503×2) + c(503×5) + d(503 非2xx) = 3。a(全200) 不算
            assert.equal(llmErr.length, 3, `4.5 mode=llm-error 命中 3 条 got=${llmErr.length}`);
            assert.ok(!llmErr.some(t => t.outcome === 'success-direct' && t.attempts.length === 1), '4.6 llm-error 不含纯成功 a');
        }

        // ── 5. attempts 摘要 ──
        {
            const retried = await listTraces('retried');
            const b = retried.find(t => t.attempts.length === 3);
            assert.ok(Array.isArray(b?.attempts), `5.1 attempts 是数组 got=type=${typeof b?.attempts}`);
            assert.ok(b && b.attempts.every(a => a.upstreamRequestBody === undefined && a.upstreamResponseBody === undefined), '5.2 摘要不含 body leaked body');
            assert.ok(b && b.attempts.every(a => a.status !== undefined && a.verdict !== undefined && a.reason !== undefined), '5.3 带 status/verdict/reason');
        }

        // ── 6. 恢复默认（空 dir）──
        {
            const r = await postLogsDir('');
            assert.ok(r.ok === true, `6.1 空目录恢复默认 ok got=${JSON.stringify(r)}`);
            const g = await getLogsDir();
            assert.equal(g.configured, false, `6.2 configured=false got=configured=${g.configured}`);
        }

        // ── 7. 非法路径 ──
        {
            const r = await postLogsDir('bad\0path');
            assert.equal(r.ok, false, `7.1 非法路径返回错误 got=${JSON.stringify(r)}`);
            const g = await getLogsDir();
            assert.equal(g.configured, false, `7.2 非法路径不改运行时 got=configured=${g.configured} (应仍默认)`);
        }

        // ── 8. /api/kill ──
        {
            const r = await (await fetch(PROXY + '/api/kill', { method: 'POST' })).json();
            assert.ok(r.ok === true, `8.1 /api/kill 返回 ok got=${JSON.stringify(r)}`);
            await sleep(300);
            let up = true;
            try { const h = await fetch(PROXY + '/healthz'); up = h.ok; } catch { up = false; }
            assert.equal(up, false, `8.2 kill 后 healthz 不通 got=still up=${up}`);
        }
    } finally {
        kill(mockProc); kill(proxyProc);
        rmSync(dir, { recursive: true, force: true });
        try { rmSync(TMP_LOGS, { recursive: true, force: true }); } catch {}
    }
});
