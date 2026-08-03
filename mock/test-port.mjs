// mock/test-port.mjs — 测代理监听端口可配置 + 平台默认 + kill
//
// 运行：node --test mock/test-port.mjs  （已纳入全量 node --test）
// 独立端口 11510（避开其他测试和运行中扩展）。
// 测的点：
//   1. GET /api/port 返回 port + defaultPort，defaultPort 按平台对
//   2. 非法端口（<1024 / >65535 / 非数字）→ 400，不改运行时，代理仍存活
//   3. POST 改端口 → 写回 config.json + kill 监听（放最后，因为会 kill 代理）
//
// 注意：CLI 测试无扩展心跳，不测"kill 后用新端口重启"——那需要扩展宿主，手动验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(__dirname, '..', 'proxy', 'server.js');
const PROXY_PORT = 11510;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

function newTmpDir() {
    const d = join(process.cwd(), '.test-tmp', `port-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
function writeConfig(dir, port) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', API_TIMEOUT_MS: '3000', ANTHROPIC_MODEL: 'm' },
        effortLevel: 'xhigh',
        proxy: { listenHost: '127.0.0.1', listenPort: port, maxAttempts: 5, backoffSec: 0.1, backoffMaxSec: 1, passthrough: false, retryOnStatus: [408, 429, 500, 502, 504], retryOnBodyErrorCode: [10310] },
    }, null, 2) + '\n', 'utf8');
    return join(dir, 'config.json');
}
async function waitHealth(url) {
    for (let i = 0; i < 100; i++) {
        try { const r = await fetch(url + '/healthz'); if (r.ok) return true; } catch {}
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('proxy did not become healthy');
}
async function isUp() {
    try { const r = await fetch(PROXY + '/healthz'); return r.ok; } catch { return false; }
}
async function getPort() { return (await (await fetch(PROXY + '/api/port')).json()); }
async function postPort(port) {
    return (await (await fetch(PROXY + '/api/port', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
    })).json());
}
function expectedDefault() {
    switch (process.platform) {
        case 'win32': return 11434;
        case 'darwin': return 11436;
        case 'linux': return 11435;
        default: return 11435;
    }
}

test('端口可配置 + 平台默认 + kill', async () => {
    const dir = newTmpDir();
    const configPath = writeConfig(dir, PROXY_PORT);
    const proxyProc = spawn(process.execPath, [SERVER_JS], {
        env: { ...process.env, CONFIG_PATH: configPath }, stdio: 'ignore',
    });
    proxyProc.on('error', (e) => { throw new Error(`proxy spawn failed: ${e.message}`); });
    try {
        await waitHealth(PROXY);

        // ── 1. GET /api/port ──
        const r = await getPort();
        assert.equal(typeof r.port, 'number', `port=${r.port}`);
        assert.equal(typeof r.defaultPort, 'number', `defaultPort=${r.defaultPort}`);
        assert.equal(r.defaultPort, expectedDefault(), `platform=${process.platform}`);
        assert.equal(r.port, PROXY_PORT, `当前端口应=配置端口`);

        // ── 2. 非法端口（不 kill，代理仍存活，放改端口之前）──
        assert.equal((await postPort(80)).ok, false);
        assert.equal((await postPort(70000)).ok, false);
        assert.equal((await postPort('abc')).ok, false);
        assert.equal(await isUp(), true, '非法端口后代理仍存活');
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
        assert.equal(cfg.proxy.listenPort, PROXY_PORT, 'config.json 未被非法值污染');

        // ── 3. POST 改端口（会 kill 监听，放最后）──
        const NEW_PORT = 11610;
        const r3 = await postPort(NEW_PORT);
        assert.equal(r3.ok, true && r3.port === NEW_PORT, JSON.stringify(r3));
        const cfg2 = JSON.parse(readFileSync(configPath, 'utf8'));
        assert.equal(cfg2.proxy.listenPort, NEW_PORT, 'config.json 写回新端口');
        await new Promise(r => setTimeout(r, 400));
        assert.equal(await isUp(), false, '改端口后 kill 生效（healthz 不通）');
    } finally {
        try { proxyProc.kill('SIGTERM'); } catch {}
        rmSync(dir, { recursive: true, force: true });
    }
});
