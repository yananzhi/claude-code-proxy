// mock/test-stream-incremental.mjs — 验证代理对 SSE 流式响应的「增量转发」
//
// 运行：node --test mock/test-stream-incremental.mjs  （已纳入全量 node --test）
// 独立端口 PROXY_PORT=11515 / MOCK_PORT=8795（避开其他测试和运行中扩展）。
//
// mock 用 success-slow 模式每 300ms 发一个 SSE chunk。代理若是缓冲式（旧实现），
// 会把全部 chunk 攒到上游 end 后一次性吐，客户端只看到一次到达；流式改造后应看到
// 多次到达、间隔 ~300ms。
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
const PROXY_PORT = 11515;
const MOCK_PORT = 8796;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

function newTmpDir() {
    const d = join(process.cwd(), '.test-tmp', `incr-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
function writeConfig(dir) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: MOCK, API_TIMEOUT_MS: '10000', ANTHROPIC_MODEL: 'm' },
        effortLevel: '',
        proxy: { listenHost: '127.0.0.1', listenPort: PROXY_PORT, maxAttempts: 1, backoffSec: 0.2, backoffMaxSec: 2, passthrough: false, retryRules: [] },
    }, null, 2) + '\n', 'utf8');
    return join(dir, 'config.json');
}
function kill(p) { try { p?.kill('SIGTERM'); } catch {} }
async function waitHealth(u, l) {
    for (let i = 0; i < 100; i++) {
        try { const r = await fetch(u + '/healthz'); if (r.ok) return true; } catch {}
        await sleep(100);
    }
    throw new Error(l + ' unhealthy');
}
async function setSeq(seq) {
    await fetch(MOCK + '/__mock/control', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sequence: seq }),
    });
}

test('SSE 流式增量转发（mock 每 300ms 发一个 chunk，代理应多次到达非缓冲）', async () => {
    const dir = newTmpDir();
    const configPath = writeConfig(dir);
    const mockProc = spawn(process.execPath, [MOCK_JS], {
        env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
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
        await sleep(300);
        await setSeq(['success-slow']);

        const t0 = Date.now();
        const r = await fetch(PROXY + '/v1/messages?beta=true', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
            body: JSON.stringify({ model: 'm', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        });

        // read body as a stream, timestamp each chunk arrival
        const arrivals = [];
        for await (const chunk of r.body) {
            arrivals.push({ t: Date.now() - t0, len: chunk.length });
        }

        // verdict：多次到达 + spread > 1000ms 视为流式正常；单次到达 = 缓冲式失败
        const first = arrivals[0]?.t ?? -1;
        const last = arrivals[arrivals.length - 1]?.t ?? -1;
        const spread = last - first;
        const multi = arrivals.length > 1;

        // 原脚本逻辑：multi && spread > 1000 → PASS；arrivals.length === 1 → FAIL（缓冲式）；
        // 否则 AMBIGUOUS（多次但 spread 不足）。这里把 PASS 条件作为断言。
        assert.ok(multi && spread > 1000,
            `chunks 应增量到达（multi=${multi}, spread=${spread}ms, arrivals=${arrivals.length}）`
            + `；若 arrivals=1 则代理缓冲了整个响应。first=+${first}ms last=+${last}ms`);
    } finally {
        kill(mockProc); kill(proxyProc);
        rmSync(dir, { recursive: true, force: true });
    }
});
