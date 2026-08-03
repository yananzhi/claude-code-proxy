// standalone/main.js — 独立后端入口（ESM JS，不进 tsc）
//
// 职责（阶段 1 骨架）：
//   1. 加载/初始化公共 proxy-config（不存在则写默认，幂等）
//   2. mkdir logsDir
//   3. cleanEnv 生成 env（从 out/cleanEnv.js 加载）
//   4. spawnProxyChild spawn proxy/server.js（从 out/proxySpawnController.js 加载）
//   5. 单进程守护：2s 心跳 healthz 自检，崩了 re-spawn
//   6. 不 serve 网页（server.js 自己 serve proxy/web/，浏览器访问端口即可）
//
// 设计依据：docs/standalone-backend-plan.md 阶段 1
// 正交设计：plan/tmp/2026-08-03-stage1-standalone-skeleton.md
//
// 运行：node standalone/main.js
// 环境变量：CCP_HOME（自定义根目录，默认 ~/.claude-code-proxy/）

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { platformPort } from './ports.js';

// platformPort re-export 供外部 import（阶段 1 测试依赖 main.js 的导出面）
export { platformPort };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(PROJECT_ROOT, 'proxy', 'server.js');

// 从 out/ 加载编译后的 TS 产物（CJS）。需先 npm run compile。
const require = createRequire(import.meta.url);
let spawnProxyChild, healthz, cleanEnv;
try {
    ({ spawnProxyChild, healthz } = require(path.join(PROJECT_ROOT, 'out', 'proxySpawnController.js')));
    ({ cleanEnv } = require(path.join(PROJECT_ROOT, 'out', 'cleanEnv.js')));
} catch (e) {
    console.error('[standalone] 加载 out/proxySpawnController.js 或 out/cleanEnv.js 失败，请先 npm run compile:', e.message);
    process.exit(1);
}

/** 心跳间隔（与 proxyHost 一致）。 */
const HEARTBEAT_MS = 2000;
/** spawn 连续失败后的退避基数（ms），实际退避 = BASE * 2^(failures-1)，封顶 MAX。 */
const SPAWN_BACKOFF_BASE_MS = 2000;
const SPAWN_BACKOFF_MAX_MS = 30000;

/**
 * 默认 proxy-config 模板（照 proxyHost.ts DEFAULT_PROXY_CONFIG 复刻）。
 * 不写 modelAliases/nextAliasId（config-store 兜底 {} / 0）。
 */
export function defaultProxyConfig(platform = process.platform) {
    return {
        env: {
            ANTHROPIC_AUTH_TOKEN: '',
            ANTHROPIC_BASE_URL: '',
            API_TIMEOUT_MS: '600000',
            ANTHROPIC_MODEL: '',
        },
        effortLevel: 'max',
        proxy: {
            listenHost: '127.0.0.1',
            listenPort: platformPort(platform),
            maxAttempts: 20,
            backoffSec: 3,
            backoffMaxSec: 16,
            passthrough: false,
            retryRules: [
                { status: 503, code: 10310 },
                { status: 200, code: 10310 },
            ],
        },
    };
}

/**
 * 解析根目录与各子路径。
 * @param homeDir 根目录（默认 ~/.claude-code-proxy/，或 CCP_HOME env）
 */
export function resolvePaths(homeDir) {
    const root = homeDir || process.env.CCP_HOME || path.join(os.homedir(), '.claude-code-proxy');
    return {
        root,
        configPath: path.join(root, 'proxy-config.json'),
        logsDir: path.join(root, 'logs'),
        logsConfigPath: path.join(root, 'logs', 'logs-config.json'),
    };
}

/**
 * 确保根目录、logsDir 存在；config 不存在则写默认（幂等，已存在不覆盖）。
 * @returns {Promise<{configPath, logsDir, logsConfigPath, created: boolean}>} created=是否新建了 config
 */
export async function ensureConfig(homeDir, platform = process.platform) {
    const paths = resolvePaths(homeDir);
    await fs.promises.mkdir(paths.logsDir, { recursive: true });
    let created = false;
    if (!fs.existsSync(paths.configPath)) {
        await fs.promises.writeFile(
            paths.configPath,
            JSON.stringify(defaultProxyConfig(platform), null, 2) + '\n',
            'utf8',
        );
        created = true;
    }
    return { ...paths, created };
}

/**
 * 从 config 文件读监听端口（spawn 前需要知道预期端口做就绪检测）。
 * 文件不存在/损坏 → 返回 null（调用方应先 ensureConfig）。
 * 接受 number 或数字字符串（用户手改 config 可能写 "11434"），与 proxyHost.getPort() 的 || 行为一致。
 */
function readListenPort(configPath) {
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const port = cfg?.proxy?.listenPort;
        if (typeof port === 'number') return port;
        if (typeof port === 'string' && /^\d+$/.test(port)) return Number(port);
        return null;
    } catch {
        return null;
    }
}

/**
 * 独立后端控制器：spawn 代理子进程 + 心跳守护。
 *
 * 去掉多窗口协调（无从机探测、无 toggle 开关），保留：
 * - spawning 重入守卫（防心跳并发 spawn 多子进程）
 * - disposed 守卫（防退出后心跳继续 spawn 泄漏）
 * - 心跳 healthz 自检 + crash re-spawn
 */
export class StandaloneBackend {
    constructor(opts) {
        this.configPath = opts.configPath;
        this.logsDir = opts.logsDir;
        this.logsConfigPath = opts.logsConfigPath;
        this.readyTimeoutMs = opts.readyTimeoutMs; // 可选，未传则用 spawnProxyChild 默认 5000
        this.log = opts.log || ((...a) => console.log('[standalone]', ...a));
        this.handle = null;
        this.spawning = false;
        this.disposed = false;
        this.heartbeatTimer = null;
        // spawn 连续失败退避（防端口持续被占时无限 re-spawn 刷日志）
        this.consecutiveFailures = 0;
        this.lastFailTime = 0;
    }

    /** 启动：spawn 代理 + 启心跳。 */
    async start() {
        await this.trySpawn();
        // spawn 期间可能已调 stop（disposed=true），不应再启心跳定时器（否则泄漏）
        if (this.disposed) return;
        this.heartbeatTimer = setInterval(() => { void this.heartbeatTick(); }, HEARTBEAT_MS);
    }

    /** 尝试 spawn 代理子进程。已 spawn / 正在 spawn / 已 disposed → 跳过。 */
    async trySpawn() {
        if (this.disposed) return;
        if (this.handle) return;
        if (this.spawning) return;
        // 连续失败退避：指数退避，防端口持续被占时每 2s re-spawn 一次刷日志
        if (this.consecutiveFailures > 0) {
            const backoff = Math.min(
                SPAWN_BACKOFF_BASE_MS * Math.pow(2, this.consecutiveFailures - 1),
                SPAWN_BACKOFF_MAX_MS,
            );
            const elapsed = Date.now() - this.lastFailTime;
            if (elapsed < backoff) return; // 退避期内，跳过本次尝试
        }

        const port = readListenPort(this.configPath);
        if (!port) {
            this.log('config 无有效 proxy.listenPort，无法 spawn（请检查', this.configPath, '）');
            return;
        }

        this.spawning = true;
        try {
            const env = cleanEnv({
                configPath: this.configPath,
                logsDir: this.logsDir,
                logsConfigPath: this.logsConfigPath,
            });
            const handle = await spawnProxyChild({
                serverPath: SERVER_JS,
                port,
                env,
                callbacks: {
                    onLog: (line) => this.log('[proxy]', line),
                    onExit: (child, code, signal) => {
                        // 只清当前 handle（防旧子进程延迟 exit 清掉新 re-spawn 的 handle，
                        // 与 proxyHost onExit 的 child === this.handle?.child 守卫一致）
                        if (this.handle?.child === child) {
                            this.log(`[proxy] 子进程退出 code=${code} signal=${signal}`);
                            this.handle = null;
                        }
                    },
                },
                ...(this.readyTimeoutMs ? { readyTimeoutMs: this.readyTimeoutMs } : {}),
            });
            if (!handle) {
                this.consecutiveFailures++;
                this.lastFailTime = Date.now();
                this.log(`spawn 代理失败（就绪超时或子进程早期退出），连续 ${this.consecutiveFailures} 次`);
                return;
            }
            // spawn 期间可能已 disposed（退出与 spawn 竞争），立即停掉避免泄漏
            if (this.disposed) {
                this.log('spawn 完成但已 disposed，立即停止子进程');
                try { await handle.stop(); } catch {}
                return;
            }
            this.handle = handle;
            this.consecutiveFailures = 0; // 成功，重置退避
            this.log(`代理已启动：http://127.0.0.1:${handle.port}/ （浏览器访问控制台）`);
        } catch (e) {
            this.consecutiveFailures++;
            this.lastFailTime = Date.now();
            this.log('trySpawn 异常:', e?.message || String(e));
        } finally {
            this.spawning = false;
        }
    }

    /** 心跳：handle 在跑则 healthz 自检，不通则清 handle 触发 re-spawn；handle 不在则 trySpawn。 */
    async heartbeatTick() {
        if (this.disposed) return;
        try {
            if (this.handle) {
                const handle = this.handle; // 快照引用，防 await 期间 onExit 清 null 后 NPE
                const ok = await healthz(handle.port);
                if (!ok && !this.disposed) {
                    this.log('心跳检测代理不通，清理 handle 准备 re-spawn');
                    // onExit 可能已清 this.handle=null，只在仍持有时 stop
                    if (this.handle === handle) {
                        try { await handle.stop(); } catch {}
                        this.handle = null;
                    }
                }
            } else {
                await this.trySpawn();
            }
        } catch (e) {
            this.log('heartbeatTick 异常:', e?.message || String(e));
        }
    }

    /** 优雅关闭：标记 disposed + 清心跳 + stop handle。 */
    async stop() {
        this.disposed = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.handle) {
            this.log('停止代理子进程');
            try { await this.handle.stop(); } catch {}
            this.handle = null;
        }
    }
}

/**
 * 启动独立后端（顶层入口用）。返回 { backend, mgmt, stop }。
 * mgmt = management API server（workspace 管理 + 网页），监听 platformPort+100。
 */
export async function launchStandalone(opts = {}) {
    const { configPath, logsDir, logsConfigPath, created } = await ensureConfig(opts.homeDir);
    const log = opts.log || ((...a) => console.log('[standalone]', ...a));
    if (created) log('已创建默认配置:', configPath);
    log('配置:', configPath);
    log('日志:', logsDir);

    const backend = new StandaloneBackend({ configPath, logsDir, logsConfigPath, log });
    await backend.start();

    // management API server（workspace 管理 + 网页）
    const { startManagementServer } = await import('./managementServer.js');
    const proxyPort = readListenPort(configPath) || platformPort(process.platform);
    const mgmtPort = opts.mgmtPort || Number(process.env.CCP_MGMT_PORT) || (platformPort(process.platform) + 100);
    let mgmt = null;
    try {
        mgmt = await startManagementServer({ homeDir: opts.homeDir, port: mgmtPort, proxyPort, log });
        log(`workspace 管理 API + 网页：http://127.0.0.1:${mgmt.port}/`);
    } catch (e) {
        log('management server 启动失败（不影响代理转发）:', e?.message || String(e));
    }

    // 信号处理：SIGINT/SIGTERM → 优雅关闭
    let stopping = false;
    const handleSignal = async (sig) => {
        if (stopping) return;
        stopping = true;
        log(`收到 ${sig}，正在关闭...`);
        try { if (mgmt) await mgmt.stop(); } catch {}
        await backend.stop();
        process.exit(0);
    };
    process.on('SIGINT', () => void handleSignal('SIGINT'));
    process.on('SIGTERM', () => void handleSignal('SIGTERM'));

    return {
        backend,
        mgmt,
        stop: async () => {
            try { if (mgmt) await mgmt.stop(); } catch {}
            await backend.stop();
        },
    };
}

// ── 直接运行入口（仿 server.js isMainModule 模式）──────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    launchStandalone().catch((e) => {
        console.error('[standalone] 启动失败:', e);
        process.exit(1);
    });
}
