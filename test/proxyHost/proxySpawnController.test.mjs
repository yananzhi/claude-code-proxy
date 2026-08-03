// test/proxyHost/proxySpawnController.test.mjs — spawnProxyChild 控制器测试
//
// 直接 import out/proxySpawnController.js 的真 spawnProxyChild + healthz + cleanEnv，
// spawn 真实 server.js 子进程，验证：
//   基本跑通 / crash 恢复 / 反复 re-spawn TIME_WAIT / EADDRINUSE / 多窗口端口冲突
//
// 覆盖之前手动验证（F5 + 装插件）的 ① 多窗口 ② EADDRINUSE ④ re-spawn TIME_WAIT 项。
// 运行：node --test test/proxyHost/proxySpawnController.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(__dirname, '..', '..', 'proxy', 'server.js');

const OUT = join(process.cwd(), 'out', 'proxySpawnController.js');
const OUT_CLEAN = join(process.cwd(), 'out', 'cleanEnv.js');
if (!existsSync(OUT) || !existsSync(OUT_CLEAN)) {
    console.error('out/proxySpawnController.js 或 out/cleanEnv.js 不存在，请先 npm run compile');
    process.exit(1);
}
const require = createRequire(import.meta.url);
const { spawnProxyChild, healthz, waitForPortReady, killChild } = require(OUT);
const { cleanEnv } = require(OUT_CLEAN);

// ── helpers ────────────────────────────────────────────────
function newTmpDir(label) {
    const d = join(process.cwd(), '.test-tmp', `ctrl-${label}-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
function writeConfig(dir, port) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', ANTHROPIC_AUTH_TOKEN: 't' },
        effortLevel: '',
        proxy: { listenHost: '127.0.0.1', listenPort: port, passthrough: true },
    }), 'utf8');
    return join(dir, 'config.json');
}
// spawnProxyChild 的 env：用 cleanEnv 净化 + CCP_*。但 cleanEnv 读 process.env，
// 测试进程是纯 Node（无 VSCODE_* 注入），净化后基本等于 process.env + ELECTRON_RUN_AS_NODE。
// 注意：纯 Node 下 ELECTRON_RUN_AS_NODE 无害（process.execPath 是 node.exe，不是 Code.exe）。
function makeEnv(configPath, logsDir) {
    return cleanEnv({ configPath, logsDir, logsConfigPath: join(logsDir, 'logs-config.json') });
}

// ════════════════════════════════════════════════════════════
// 基本：spawnProxyChild spawn 真实 server.js → 就绪 → handle 返回
// ════════════════════════════════════════════════════════════
test('基本：spawnProxyChild spawn server.js → 就绪返回 handle', async () => {
    const dir = newTmpDir('basic');
    const port = 11501;
    const configPath = writeConfig(dir, port);
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logs = [];
    const exits = [];

    const handle = await spawnProxyChild({
        serverPath: SERVER_JS,
        port,
        env: makeEnv(configPath, logsDir),
        callbacks: { onLog: (l) => logs.push(l), onExit: (c, code, sig) => exits.push({ code, sig }) },
    });
    try {
        assert.ok(handle, '应返回 handle（就绪）');
        assert.equal(handle.port, port);
        assert.ok(handle.child.pid, 'child.pid 存在');
        assert.equal(await healthz(port), true, 'healthz 通');
        assert.ok(logs.some(l => l.includes('proxy listening')), `应有 listen 日志，logs=${JSON.stringify(logs.slice(0, 3))}`);
    } finally {
        if (handle) await handle.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// crash 恢复：kill 子进程 → onExit 触发 → 再次 spawnProxyChild 成功
// ════════════════════════════════════════════════════════════
test('crash 恢复：kill 子进程 → onExit 触发 → re-spawn 成功', async () => {
    const dir = newTmpDir('crash');
    const port = 11502;
    const configPath = writeConfig(dir, port);
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const exits = [];

    const h1 = await spawnProxyChild({
        serverPath: SERVER_JS, port,
        env: makeEnv(configPath, logsDir),
        callbacks: { onLog: () => {}, onExit: (c, code, sig) => exits.push({ code, sig }) },
    });
    assert.ok(h1, '第一次 spawn 成功');
    const pid1 = h1.child.pid;

    // kill 子进程（模拟 crash）
    h1.child.kill();
    // 等 onExit 触发
    await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('onExit 2s 未触发')), 2000);
        const check = () => { if (exits.length > 0) { clearTimeout(t); res(); } };
        const iv = setInterval(() => { if (exits.length > 0) { clearInterval(iv); res(); } }, 50);
    });
    assert.equal(exits.length, 1, 'onExit 应触发一次');

    // re-spawn（等端口释放）
    await new Promise(r => setTimeout(r, 300));
    const h2 = await spawnProxyChild({
        serverPath: SERVER_JS, port,
        env: makeEnv(configPath, logsDir),
        callbacks: { onLog: () => {}, onExit: () => {} },
    });
    try {
        assert.ok(h2, 're-spawn 成功');
        assert.notEqual(h2.child.pid, pid1, '新 pid 不同');
        assert.equal(await healthz(port), true, 're-spawn 后 healthz 通');
    } finally {
        if (h2) await h2.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// 反复 re-spawn TIME_WAIT：循环 10 次 kill + re-spawn，无端口冲突
// ════════════════════════════════════════════════════════════
test('反复 re-spawn 10 次：每次就绪、pid 不同、无 TIME_WAIT 冲突', async () => {
    const dir = newTmpDir('respawn10');
    const port = 11503;
    const configPath = writeConfig(dir, port);
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const pids = [];

    try {
        for (let i = 0; i < 10; i++) {
            const h = await spawnProxyChild({
                serverPath: SERVER_JS, port,
                env: makeEnv(configPath, logsDir),
                callbacks: { onLog: () => {}, onExit: () => {} },
                readyTimeoutMs: 4000,
            });
            assert.ok(h, `第 ${i + 1} 次 spawn 应就绪`);
            assert.ok(!pids.includes(h.child.pid), `第 ${i + 1} 次 pid=${h.child.pid} 不应重复`);
            pids.push(h.child.pid);
            assert.equal(await healthz(port), true, `第 ${i + 1} 次 healthz 应通`);
            // kill 触发 exit，等端口释放
            h.child.kill();
            await new Promise(r => h.child.on('exit', r));
            await new Promise(r => setTimeout(r, 200));
        }
        assert.equal(pids.length, 10, '10 次都成功');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// EADDRINUSE：端口被无关进程占 → spawnProxyChild 返回 null + 子进程 exit(1)
// ════════════════════════════════════════════════════════════
test('EADDRINUSE：端口被占 → 返回 null + 子进程 exit(1)', async () => {
    const dir = newTmpDir('eaddrinuse');
    const port = 11504;
    const configPath = writeConfig(dir, port);
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });

    // 占位进程占住端口
    const holder = net.createServer((s) => { s.on('data', () => {}); s.on('error', () => {}); });
    await new Promise((r) => holder.listen(port, '127.0.0.1', r));

    const exits = [];
    const childPids = [];
    const handle = await spawnProxyChild({
        serverPath: SERVER_JS, port,
        env: makeEnv(configPath, logsDir),
        callbacks: {
            onLog: () => {},
            onExit: (c, code, sig) => { exits.push({ code, sig }); childPids.push(c.pid); },
        },
        readyTimeoutMs: 2000, // 缩短，加快测试
    });
    try {
        assert.equal(handle, null, '端口被占应返回 null（未就绪）');
        // spawnProxyChild 内部 kill 了未就绪的子进程，等 exit
        await new Promise((res) => {
            const iv = setInterval(() => { if (exits.length > 0) { clearInterval(iv); res(); } }, 50);
            setTimeout(() => { clearInterval(iv); res(); }, 3000);
        });
        assert.ok(exits.length >= 1, `子进程应 exit，exits=${JSON.stringify(exits)}`);
        // server.js EADDRINUSE 时 exit(1)
        assert.ok(exits.some(e => e.code === 1), `应有 exit(1)，exits=${JSON.stringify(exits)}`);
    } finally {
        holder.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// 早期 exit 快速返回：子进程 listen 失败立即 exit(1)，spawnProxyChild 不应等满
// readyTimeoutMs（否则心跳被 spawning 守卫卡住整段超时，延迟恢复 + 日志刷屏）。
// 修复前：waitForPortReady 不感知子进程 exit，等满 5s。
// 修复后：waitForPortReadyOrExit 在 child.exitCode !== null 时立即返回 false。
// ════════════════════════════════════════════════════════════
test('早期 exit 快速返回：子进程 exit 后 spawnProxyChild 不等满 readyTimeoutMs', async () => {
    const dir = newTmpDir('earlyexit');
    const port = 11506;
    const configPath = writeConfig(dir, port);
    const logsDir = join(dir, 'logs');
    mkdirSync(logsDir, { recursive: true });

    // 占位进程占住端口，让 server.js spawn 后立即 EADDRINUSE exit(1)
    const holder = net.createServer((s) => { s.on('data', () => {}); s.on('error', () => {}); });
    await new Promise((r) => holder.listen(port, '127.0.0.1', r));

    const exits = [];
    const t0 = Date.now();
    const handle = await spawnProxyChild({
        serverPath: SERVER_JS, port,
        env: makeEnv(configPath, logsDir),
        callbacks: {
            onLog: () => {},
            onExit: (c, code, sig) => exits.push({ code, sig }),
        },
        readyTimeoutMs: 5000, // 故意设大，验证不会等满
    });
    const elapsed = Date.now() - t0;
    try {
        assert.equal(handle, null, '端口被占应返回 null');
        // 修复后：子进程 exit 后应在 <1.5s 返回（不等满 5s）
        assert.ok(elapsed < 1500, `子进程早期 exit 后应快速返回，实际 ${elapsed}ms（应 <1500，readyTimeoutMs=5000）`);
    } finally {
        holder.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// 多窗口端口冲突：先起 A 占端口，再 spawn B → B 的 server.js EADDRINUSE exit(1)，A 仍存活
//
// 注意：spawnProxyChild 的就绪检测靠轮询 healthz，但 healthz 通不能区分「自己 listen」vs
// 「别人在 listen」。所以 B 调 spawnProxyChild 时，healthz 因 A 在跑而通，spawnProxyChild
// 会返回 handle（误判就绪）。但 B 的 server.js 实际 listen 失败 EADDRINUSE → exit(1)。
// 这个测试验证的是「B 子进程最终 exit(1) + A 仍存活」，而非 spawnProxyChild 返回 null。
// （spawnProxyChild 的契约是「端口空闲时 spawn」，调用方 tryBecomeHost 先 healthz 探测挡从机。）
// ════════════════════════════════════════════════════════════
test('多窗口端口冲突：B spawn 同端口 → B 子进程 exit(1)，A 仍存活', async () => {
    const dirA = newTmpDir('multiA');
    const dirB = newTmpDir('multiB');
    const port = 11505;
    const cfgA = writeConfig(dirA, port);
    const cfgB = writeConfig(dirB, port);
    const logsA = join(dirA, 'logs'); mkdirSync(logsA, { recursive: true });
    const logsB = join(dirB, 'logs'); mkdirSync(logsB, { recursive: true });
    const exitsB = [];

    // A 先起
    const hA = await spawnProxyChild({
        serverPath: SERVER_JS, port,
        env: makeEnv(cfgA, logsA),
        callbacks: { onLog: () => {}, onExit: () => {} },
    });
    assert.ok(hA, 'A 应就绪');
    const pidA = hA.child.pid;

    // B 同端口起：spawnProxyChild 可能因 healthz 通（A 在跑）误判就绪返回 handle，
    // 但 B 的 server.js listen 会 EADDRINUSE → exit(1)
    const hB = await spawnProxyChild({
        serverPath: SERVER_JS, port,
        env: makeEnv(cfgB, logsB),
        callbacks: { onLog: () => {}, onExit: (c, code, sig) => exitsB.push({ code, sig }) },
        readyTimeoutMs: 2000,
    });
    try {
        // B 的 server.js 应 EADDRINUSE exit(1)（即使 spawnProxyChild 可能误返回 handle）
        await new Promise((res) => {
            const iv = setInterval(() => { if (exitsB.length > 0) { clearInterval(iv); res(); } }, 50);
            setTimeout(() => { clearInterval(iv); res(); }, 4000);
        });
        assert.ok(exitsB.some(e => e.code === 1), `B 子进程应 exit(1)（EADDRINUSE），exitsB=${JSON.stringify(exitsB)}`);
        // A 仍存活
        assert.equal(await healthz(port), true, 'A 应仍存活 healthz 通');
        assert.equal(hA.child.exitCode, null, 'A 子进程未退出');
        assert.equal(hA.child.pid, pidA, 'A pid 不变');
    } finally {
        if (hA) await hA.stop();
        if (hB) { try { await hB.stop(); } catch {} }
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
    }
});
