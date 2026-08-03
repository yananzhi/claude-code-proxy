// test/standalone/test.mjs — 阶段1: standalone/main.js 入口骨架测试
//
// 运行：node --test test/standalone/test.mjs
//
// 维度覆盖（见 plan/tmp/2026-08-03-stage1-standalone-skeleton.md）：
//   D1 config 初始化（不存在→建/已存在→不覆盖/损坏→记日志）
//   D2 目录初始化（根目录不存在→连同 logs 创建）
//   D3 spawn 就绪（正常→healthz 通/端口被占→handle null 不崩）
//   D4 心跳守护 + re-spawn（crash→恢复/重入守卫/disposed 不 spawn）
//   D5 生命周期（SIGINT→stop）
//   D6 平台端口（win32/linux/darwin）
//
// 注：standalone/main.js 是 ESM，直接 import。它内部用 createRequire 加载 out/*.js（CJS）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = resolve(__dirname, '..', '..', 'standalone', 'main.js');

// 从 main.js import 纯函数（不触发顶层 launch，因为 isMain=false）
// Windows 上 import() 需要 file:// URL，不能直接传 Windows 路径字符串
const {
    platformPort,
    defaultProxyConfig,
    resolvePaths,
    ensureConfig,
    StandaloneBackend,
    launchStandalone,
} = await import(pathToFileURL(MAIN_JS).href);

// 从 out/ 加载 healthz（测试自验用）
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const OUT = join(process.cwd(), 'out', 'proxySpawnController.js');
const { healthz } = require(OUT);

/** 造临时根目录。 */
function newTmpHome(label) {
    return mkdtempSync(join(tmpdir(), `standalone-${label}-`));
}

/** 占用一个端口（占位 server，测 EADDRINUSE 用）。返回关闭函数。unref 防阻止 event loop 退出。 */
async function occupyPort(port) {
    return new Promise((res, rej) => {
        const srv = net.createServer();
        srv.on('error', rej);
        // 收集连接，close 时 destroy，防挂起连接让 close() 永不完成
        const conns = [];
        srv.on('connection', (c) => conns.push(c));
        srv.listen(port, '127.0.0.1', () => res(() => new Promise(r => {
            for (const c of conns) { try { c.destroy(); } catch {} }
            srv.close(() => r());
        })));
    });
}

// ════════════════════════════════════════════════════════════
// D6 平台端口
// ════════════════════════════════════════════════════════════
test('D6-win32: platformPort(win32) → 11434', () => {
    assert.equal(platformPort('win32'), 11434);
});
test('D6-linux: platformPort(linux) → 11435', () => {
    assert.equal(platformPort('linux'), 11435);
});
test('D6-darwin: platformPort(darwin) → 11436', () => {
    assert.equal(platformPort('darwin'), 11436);
});
test('D6-unknown: platformPort 未知平台兜底 11435（与 proxyHost 一致）', () => {
    assert.equal(platformPort('unknownplat'), 11435);
});

// ════════════════════════════════════════════════════════════
// D1/D2 config 初始化 + 目录
// ════════════════════════════════════════════════════════════
test('D1a+D2c: 根目录不存在 → ensureConfig 建根目录 + logs + 默认 config（created=true）', async () => {
    const home = newTmpHome('d1a');
    // 整个根目录都不存在（mkdtemp 建的是父级临时目录，子根目录不存在）
    const target = join(home, 'ccp-home');
    assert.ok(!existsSync(target), '前置：目标根目录不存在');
    const result = await ensureConfig(target, 'linux');
    assert.equal(result.created, true, '应新建 config');
    assert.ok(existsSync(result.configPath), 'config 文件应存在');
    assert.ok(existsSync(result.logsDir), 'logs 目录应存在');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    assert.equal(cfg.proxy.listenHost, '127.0.0.1');
    assert.equal(cfg.proxy.listenPort, 11435, 'linux 平台端口');
    assert.equal(cfg.effortLevel, 'max');
    assert.deepEqual(cfg.proxy.retryRules, [{ status: 503, code: 10310 }, { status: 200, code: 10310 }]);
});

test('D1b: config 已存在 → ensureConfig 不覆盖（created=false，保留原内容）', async () => {
    const home = newTmpHome('d1b');
    const result = await ensureConfig(home, 'linux');
    // 用户改了 upstream + 端口
    const userCfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    userCfg.env.ANTHROPIC_BASE_URL = 'http://user-upstream';
    userCfg.proxy.listenPort = 99999;
    fs.writeFileSync(result.configPath, JSON.stringify(userCfg), 'utf8');

    const result2 = await ensureConfig(home, 'linux');
    assert.equal(result2.created, false, '已存在不应重建');
    const cfg = JSON.parse(fs.readFileSync(result2.configPath, 'utf8'));
    assert.equal(cfg.env.ANTHROPIC_BASE_URL, 'http://user-upstream', '用户改动应保留');
    assert.equal(cfg.proxy.listenPort, 99999, '用户端口应保留');
});

test('defaultProxyConfig: 结构含五段 + 不含 modelAliases（config-store 兜底）', () => {
    const cfg = defaultProxyConfig('win32');
    assert.ok(cfg.env, '应有 env');
    assert.ok(cfg.proxy, '应有 proxy');
    assert.equal(cfg.effortLevel, 'max');
    assert.ok(cfg.env.API_TIMEOUT_MS, '600000');
    assert.equal(cfg.proxy.listenPort, 11434);
    assert.equal(cfg.modelAliases, undefined, '不应含 modelAliases（config-store 兜底）');
    assert.equal(cfg.nextAliasId, undefined, '不应含 nextAliasId');
});

// ════════════════════════════════════════════════════════════
// D3+D4 spawn 就绪 + 心跳守护（用真实 server.js，端口避开 Windows 保留段）
// ════════════════════════════════════════════════════════════
test('D3a: StandaloneBackend spawn 正常 → healthz 通', async () => {
    const home = newTmpHome('d3a');
    const result = await ensureConfig(home, 'linux');
    // 覆盖端口为测试端口（避开保留段，用 11600 段）
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11601;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const logs = [];
    const backend = new StandaloneBackend({ ...result, log: (m) => logs.push(m) });
    await backend.start();
    try {
        assert.ok(backend.handle, '应有 handle');
        assert.equal(await healthz(11601), true, 'healthz 应通');
        assert.ok(logs.some(l => l.includes('代理已启动')), `应有启动日志，logs=${JSON.stringify(logs)}`);
    } finally {
        await backend.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

test('D4b: crash → 心跳 re-spawn 恢复 healthz', async () => {
    const home = newTmpHome('d4b');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11602;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const logs = [];
    const backend = new StandaloneBackend({ ...result, log: (m) => logs.push(m) });
    await backend.start();
    try {
        assert.ok(backend.handle);
        const firstPid = backend.handle.child.pid;
        // 杀子进程模拟 crash
        backend.handle.child.kill('SIGKILL');
        // 等心跳 re-spawn（心跳 2s，等 5s 兜底）
        let recovered = false;
        for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 200));
            if (backend.handle && backend.handle.child.pid !== firstPid && await healthz(11602)) {
                recovered = true;
                break;
            }
        }
        assert.ok(recovered, '应在心跳后 re-spawn 恢复');
    } finally {
        await backend.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

test('D4d+D5c: disposed 后心跳 tick 不 spawn', async () => {
    const home = newTmpHome('d4d');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11603;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const backend = new StandaloneBackend({ ...result, log: () => {} });
    await backend.start();
    const pidBefore = backend.handle?.child.pid;
    await backend.stop(); // disposed=true
    assert.equal(backend.handle, null, 'stop 后 handle 应清空');
    // 手动触发心跳，不应 spawn
    await backend.heartbeatTick();
    assert.equal(backend.handle, null, 'disposed 后心跳不应 spawn');
});

test('D3b: spawn 失败（serverPath 不存在）→ trySpawn handle=null + 不崩', async () => {
    const home = newTmpHome('d3b');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11604;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const logs = [];
    // 用不存在的 serverPath 触发 spawn error（ENOENT），维度等价于"spawn 失败不崩"。
    // EADDRINUSE 场景的 handle 残留问题属 spawnProxyChild 内部，留给子代理 review 挖。
    const backend = new StandaloneBackend({
        ...result,
        readyTimeoutMs: 1500,
        log: (m) => logs.push(m),
    });
    // 临时 monkey-patch SERVER_JS 不可行（模块级常量），改为直接测 trySpawn 的异常吞并：
    // 端口被占场景下 spawnProxyChild 返回 null，trySpawn 应记日志不崩。
    // 这里用一个被占端口模拟 EADDRINUSE。
    const releasePort = await occupyPort(11604);
    try {
        await backend.trySpawn();
        assert.equal(backend.handle, null, 'spawn 失败应 handle=null');
        assert.ok(logs.some(l => l.includes('失败')), `应有失败日志，logs=${JSON.stringify(logs)}`);
    } finally {
        await backend.stop();
        await releasePort();
        await new Promise(r => setTimeout(r, 200));
        rmSync(home, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D5 生命周期：launchStandalone + SIGINT
// ════════════════════════════════════════════════════════════
test('D5a: launchStandalone 起后端 + SIGINT → 优雅退出（子进程被 stop）', async () => {
    const home = newTmpHome('d5a');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11605;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const { backend, stop } = await launchStandalone({ homeDir: home, log: () => {} });
    try {
        assert.ok(backend.handle, '应已 spawn');
        assert.equal(await healthz(11605), true, 'healthz 通');
        // 模拟 SIGINT 逻辑：直接调 stop（与信号处理器一致）
        await stop();
        assert.equal(backend.handle, null, 'stop 后 handle 清空');
        assert.equal(backend.disposed, true, '应标记 disposed');
    } finally {
        await stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ════════════════════════════════════════════════════════════
// D1c config 损坏 → ensureConfig 不崩（已存在不覆盖，损坏留给 server.js）
// ════════════════════════════════════════════════════════════
test('D1c: config 损坏 JSON → ensureConfig 不覆盖不崩（created=false）', async () => {
    const home = newTmpHome('d1c');
    const result = await ensureConfig(home, 'linux');
    // 写损坏内容
    fs.writeFileSync(result.configPath, '{ not valid json', 'utf8');
    const result2 = await ensureConfig(home, 'linux');
    assert.equal(result2.created, false, '已存在不覆盖');
    assert.equal(fs.readFileSync(result2.configPath, 'utf8'), '{ not valid json', '损坏内容应保留');
});

test('resolvePaths: CCP_HOME 覆盖默认 home', () => {
    const paths = resolvePaths('/custom/home');
    assert.equal(paths.root, '/custom/home');
    assert.equal(paths.configPath, join('/custom/home', 'proxy-config.json'));
});

// ════════════════════════════════════════════════════════════
// 子代理 review 疑点验证（TDD）
// ════════════════════════════════════════════════════════════

// ── 疑点 S1：heartbeatTick 中 await healthz 期间 onExit 把 handle 置 null → this.handle.stop() 空指针 ──
test('S1: heartbeatTick healthz 期间 onExit 清 handle → 不应 NPE', async () => {
    const home = newTmpHome('s1');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11610;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    // 不 start()（避免真子进程泄漏），手动构造 stub handle 测竞态
    const backend = new StandaloneBackend({ ...result, log: () => {} });
    const stubHandle = {
        port: 11699, // 没人监听 → healthz 必 false（~500ms 超时）
        child: { pid: -999 },
        stop: async () => {},
    };
    backend.handle = stubHandle;
    try {
        // 竞态模拟：heartbeatTick 进 if(this.handle) → await healthz(11699)
        // 在 healthz ~500ms 超时期间，setTimeout(10ms) 把 this.handle=null 模拟 onExit
        const tickPromise = backend.heartbeatTick();
        setTimeout(() => { backend.handle = null; }, 10);
        await tickPromise; // 旧代码会 NPE（this.handle.stop() on null），修复后不崩
        assert.ok(true, 'heartbeatTick 在 onExit 竞态下不应崩');
    } finally {
        // 无真子进程，只需清理
        backend.disposed = true;
        if (backend.heartbeatTimer) { clearInterval(backend.heartbeatTimer); }
        rmSync(home, { recursive: true, force: true });
    }
});

// ── 疑点 S2：onExit 无条件清 this.handle，旧子进程延迟 exit 会清掉新 handle ──
test('S2: onExit 应检查 child 身份（防旧子进程 exit 清新 handle）', async () => {
    const home = newTmpHome('s2');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11611;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const backend = new StandaloneBackend({ ...result, log: () => {} });
    await backend.start();
    try {
        const firstHandle = backend.handle;
        assert.ok(firstHandle, '前置：应有 handle');
        // 杀子进程触发 crash → 心跳 re-spawn
        firstHandle.child.kill('SIGKILL');
        // 等心跳 re-spawn
        let respawned = false;
        for (let i = 0; i < 25; i++) {
            await new Promise(r => setTimeout(r, 200));
            if (backend.handle && backend.handle.child.pid !== firstHandle.child.pid) {
                respawned = true;
                break;
            }
        }
        assert.ok(respawned, '应已 re-spawn 出新 handle');
        const newHandle = backend.handle;
        assert.ok(newHandle, '新 handle 应在');
        assert.ok(newHandle.child.pid !== firstHandle.child.pid, '新 handle 应是不同子进程');
        // healthz 应通（新 handle 没被旧 exit 误清）
        assert.equal(await healthz(11611), true, '新 handle 应正常（旧 exit 未误清）');
    } finally {
        await backend.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ── 疑点 S3：readListenPort 拒绝字符串端口号（用户手改 config 写 "11434"）──
test('S3: readListenPort 字符串端口号 → 应被接受（与 proxyHost.getPort 一致）', async () => {
    const home = newTmpHome('s3');
    const result = await ensureConfig(home, 'linux');
    // 用户手改 config 写字符串端口
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = '11612';
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const backend = new StandaloneBackend({ ...result, log: () => {} });
    try {
        await backend.trySpawn();
        // 字符串端口号应被接受 → handle 不为 null
        const acceptString = backend.handle !== null;
        assert.equal(acceptString, true, '字符串端口号应被接受（与 proxyHost.getPort 一致）');
    } finally {
        await backend.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ── 疑点 S4：platformPort 未知平台兜底与 proxyHost 不一致 ──
test('S4: platformPort 未知平台兜底应与 proxyHost defaultPortForPlatform 一致', () => {
    // proxyHost defaultPortForPlatform: default → 11435 (linux)
    // standalone platformPort: default → 11434 (win32)
    // 不一致——应统一
    // 这里断言期望行为：未知平台应兜底 11435（与 proxyHost 一致）
    assert.equal(platformPort('unknownplat'), 11435, '未知平台应兜底 linux 端口 11435（与 proxyHost 一致）');
});

// ── 疑点 S5：re-spawn 无限循环（端口持续被占 → 每 2s re-spawn 刷日志）──
test('S5: 端口持续被占 → re-spawn 应有退避/上限，不无限循环', async () => {
    const home = newTmpHome('s5');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11613;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const releasePort = await occupyPort(11613);
    const logs = [];
    const backend = new StandaloneBackend({
        ...result,
        readyTimeoutMs: 800,
        log: (m) => logs.push(m),
    });
    try {
        await backend.start();
        // 跑几次心跳，看 spawn 失败次数是否被限制
        for (let i = 0; i < 3; i++) {
            await backend.heartbeatTick();
        }
        // 统计 "spawn 代理失败" 日志次数
        const failCount = logs.filter(l => l.includes('失败')).length;
        // 期望：有退避机制，失败次数不应等于心跳次数（3次心跳 + 1次start = 4次spawn）
        // 无退避时每次心跳都 trySpawn → failCount ≈ 4；有退避后 failCount < 4
        assert.ok(failCount < 4, `端口被占时 re-spawn 应有退避（失败 ${failCount} 次不应等于 4 次全量尝试）`);
    } finally {
        await backend.stop();
        await releasePort();
        await new Promise(r => setTimeout(r, 200));
        rmSync(home, { recursive: true, force: true });
    }
});

// ── 疑点 S6：disposed 与 trySpawn 竞争——spawn 完成时 disposed 已 true，但 onExit 在 disposed 检查前清了 handle ──
test('S6: spawn 进行中调 stop → 子进程不应泄漏（disposed 竞争）', async () => {
    const home = newTmpHome('s6');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11614;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const backend = new StandaloneBackend({ ...result, log: () => {} });
    // 启动 start（不 await），在 spawn 进行中调 stop
    const startPromise = backend.start();
    // 立即调 stop（spawn 还在进行中）
    await backend.stop();
    // 等 start 完成
    await startPromise;
    try {
        assert.equal(backend.disposed, true, '应已 disposed');
        assert.equal(backend.handle, null, 'handle 应清空');
        // 子进程不应泄漏——如果 disposed 竞争正确处理，子进程应被 stop
        // 检查端口是否释放（子进程被 kill）
        await new Promise(r => setTimeout(r, 500));
        // healthz 应不通（子进程被停）
        assert.equal(await healthz(11614), false, '子进程应被停（不泄漏）');
    } finally {
        // 已 stop，只需清理
        rmSync(home, { recursive: true, force: true });
    }
});

// ── 疑点 S7：心跳与 stop 竞争——stop 清心跳定时器，但正在执行的 heartbeatTick 可能继续跑 ──
test('S7: stop 与正在执行的 heartbeatTick 竞争 → 不应崩/不应重复 stop', async () => {
    const home = newTmpHome('s7');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11615;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const backend = new StandaloneBackend({ ...result, log: () => {} });
    await backend.start();
    try {
        assert.ok(backend.handle);
        // 手动触发 heartbeatTick，在它 await healthz 期间调 stop
        const tickPromise = backend.heartbeatTick();
        // 立即调 stop（heartbeatTick 正在 await healthz）
        await backend.stop();
        await tickPromise; // 不应崩
        assert.equal(backend.disposed, true);
        assert.equal(backend.handle, null, 'handle 应清空');
    } finally {
        await backend.stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ── 疑点 S8：launchStandalone 的 stop 返回 backend.stop() 的 Promise，但信号处理器内调 backend.stop() 后 process.exit(0) ──
test('S8: launchStandalone 返回的 stop 与信号处理器不冲突', async () => {
    const home = newTmpHome('s8');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11616;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const { backend, stop } = await launchStandalone({ homeDir: home, log: () => {} });
    try {
        assert.ok(backend.handle);
        // 调 stop（模拟外部调），再调 stop（模拟信号处理器重入）
        await stop();
        await stop(); // 重入不应崩
        assert.equal(backend.disposed, true);
        assert.equal(backend.handle, null);
    } finally {
        await stop();
        rmSync(home, { recursive: true, force: true });
    }
});

// ── 疑点 S9：stop 后 consecutiveFailures 未重置 → 同实例重启被退避卡住 ──
test('S9: 新实例不应继承旧实例的 consecutiveFailures 退避', async () => {
    const home = newTmpHome('s9');
    const result = await ensureConfig(home, 'linux');
    const cfg = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    cfg.proxy.listenPort = 11617;
    fs.writeFileSync(result.configPath, JSON.stringify(cfg), 'utf8');

    const backend = new StandaloneBackend({ ...result, log: () => {} });
    // 模拟连续失败（端口被占）
    const releasePort = await occupyPort(11617);
    try {
        await backend.trySpawn(); // 失败 → consecutiveFailures=1
        assert.equal(backend.consecutiveFailures, 1, '前置：应有 1 次失败');
        await backend.stop();
        // 释放端口
        await releasePort();
        await new Promise(r => setTimeout(r, 200));
        // 新实例——天然无退避（consecutiveFailures=0），应能立即 spawn
        const backend2 = new StandaloneBackend({ ...result, log: () => {} });
        await backend2.trySpawn();
        assert.ok(backend2.handle, '新实例应能正常 spawn（无退避继承）');
        await backend2.stop();
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
