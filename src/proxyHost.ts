// ⚠️ 扩展宿主（Electron）的 http 栈对 127.0.0.1 响应 body 单向吞没——http.get/http.request/fetch
// 的 data 事件不投递，直接 end，客户端拿 status 200 + 空 body（rawLen=0）。
// 是 http 栈本身在扩展宿主里的行为，与 proxy-agent / chunked / Content-Length 均无关（都已诊断排除）：
//  - 不是 proxy-agent（系统 HTTP_PROXY 全 unset、NO_PROXY 兜底无效、proxy-agent 无劫持条件）
//  - 不是 chunked（服务端加 Content-Length 改发完整 body，http 栈仍吞 body）
//  - 不是服务端没发（裸 socket 拿到完整 body）
// 请求 body 不吞（上行正常），只有响应 body 被吞（单向）。命令行 node/curl 正常，只在扩展宿主复现。
// 治本：调代理的 wrapper 一律用裸 net socket（rawHttp 方法），绕过 http 栈，稳定拿 body。
// 新增 wrapper 照 rawHttp 模式写，不用 http.get/http.request/fetch。
// 代理侧 sendJson 等 res.end 出口仍显式写 Content-Length（对非扩展宿主如 web UI/命令行规范，
// 对扩展宿主虽无效但无害）。详见 CLAUDE.md「扩展宿主调本地 HTTP 服务的空 body 坑」。
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { cleanEnv } from './cleanEnv';
import { ProxyToggleStore } from './proxyToggle';

/** 解 HTTP chunked 编码：把 <size>\r\n<chunk>\r\n... 拼成连续 body。简单实现，够本地 API 用。 */
function dechunk(raw: string): string {
    let out = '';
    let i = 0;
    while (i < raw.length) {
        const cr = raw.indexOf('\r\n', i);
        if (cr < 0) break;
        const size = parseInt(raw.slice(i, cr), 16);
        if (!Number.isFinite(size) || size <= 0) break;
        out += raw.slice(cr + 2, cr + 2 + size);
        i = cr + 2 + size + 2; // 跳过 chunk + 尾 \r\n
    }
    return out;
}

const HEARTBEAT_MS = 2000;
const HEALTH_TIMEOUT_MS = 500;
/** spawn 子进程后轮询 healthz 就绪的超时（ms）。server.js 启动通常 <1s，留 5s 余量。 */
const SPAWN_READY_TIMEOUT_MS = 5000;

/**
 * 按平台给默认端口，避免 Windows + WSL 同机装时抢同一个 localhost 端口。
 * Windows ↔ WSL2 经 localhost 转发互通，同端口会串味，所以分开。
 * WSL 和原生 Linux 不区分（process.platform 都是 'linux'），统一 11435；
 * 原生 Linux 跟 Windows 本就不共享 localhost，不冲突。
 */
function defaultPortForPlatform(): number {
    switch (process.platform) {
        case 'win32': return 11434;
        case 'darwin': return 11436;
        case 'linux': return 11435;
        default: return 11435;
    }
}
const DEFAULT_PORT = defaultPortForPlatform();

/** spawn 出来的子进程句柄。stop = kill + 等退出。port 供心跳自检。 */
interface ProxyHandle {
    child: ChildProcess;
    port: number;
    stop: () => Promise<void>;
}

/** 注入代理的上游配置（从激活的"通过代理"配置 content.env 解出） */
export interface UpstreamEnv {
    baseUrl: string;
    token: string;
    model?: string;
    smallFastModel?: string;
    timeoutSec?: number;
}

/**
 * 独立进程 LLM 代理管理（控制器）。
 * - spawn 一个 Node 子进程跑 proxy/server.js（ESM），用 process.execPath（Code.exe）+
 *   净化 env + ELECTRON_RUN_AS_NODE。V1-f 验证此路径可用（详见 docs/server独立进程化调研.md）。
 * - 单例：靠端口 bind（别的窗口先起则本窗口当从机）。
 * - 心跳：每 2s 探测 /healthz；宿主自检、从机探测宿主，断了就接管。
 * - 生命周期：activate 起、deactivate 停（其他窗口心跳接管）。子进程 crash（exit 事件）
 *   主动清 handle，下次心跳 re-spawn。
 * - 通信：rawHttp（裸 socket）调代理接口，绕过扩展宿主 http 栈对本地响应 body 的吞没。
 */
export class ProxyHost {
    private statusBar: vscode.StatusBarItem;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private handle: ProxyHandle | null = null; // 非 null = 本窗口是宿主
    /** tryBecomeHost 正在进行中（spawn + waitForPortReady 期间）。防止心跳重入 spawn 多个子进程。 */
    private spawning = false;
    /** 扩展已卸载（deactivate）。阻止心跳 tick 在 deactivate 后继续 spawn 子进程（泄漏）。 */
    private disposed = false;
    private readonly configPath: string;
    private readonly logsDir: string;
    private readonly logsConfigPath: string;
    private readonly extensionPath: string;
    private readonly output: vscode.OutputChannel;
    private readonly toggle: ProxyToggleStore;

    constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel, toggle: ProxyToggleStore) {
        this.extensionPath = context.extensionPath;
        this.configPath = path.join(context.globalStorageUri.fsPath, 'proxy-config.json');
        this.logsDir = path.join(context.globalStorageUri.fsPath, 'logs');
        // logs-config.json 也放 globalStorage：存用户配置的 logsDir，代理重启后能重新读到
        this.logsConfigPath = path.join(context.globalStorageUri.fsPath, 'logs-config.json');
        this.output = output;
        this.toggle = toggle;

        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
        this.statusBar.command = 'claude-code-proxy.openProxyUI';
        context.subscriptions.push(this.statusBar);
    }

    async activate(): Promise<void> {
        // 先把状态栏亮出来，这样即使后续任一步失败，云朵图标（显示“未运行”）也在，
        // 用户能看到扩展活着、并能点开控制台。否则异常被 void 吞掉后啥都没有。
        this.statusBar.show();
        try {
            await fs.promises.mkdir(this.logsDir, { recursive: true });
            if (!fs.existsSync(this.configPath)) {
                fs.writeFileSync(this.configPath, JSON.stringify(DEFAULT_PROXY_CONFIG, null, 2) + '\n', 'utf8');
            }
            // backup proxy 开关为纯内存态（默认允许），tryBecomeHost 内部会再尊重它。
            // 开关关闭时本窗口不启动代理、心跳不接管；打开时复用其他窗口或自己起。
            await this.tryBecomeHost();
            this.heartbeatTimer = setInterval(() => { void this.heartbeatTick(); }, HEARTBEAT_MS);
        } catch (e: unknown) {
            // 兜底：任何未预期的异常都记日志，不被外层 void 静默吞掉。
            this.log('activate() 异常:', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
        }
    }

    async deactivate(): Promise<void> {
        this.disposed = true; // 先标记，阻止正在执行的心跳 tick 继续 spawn
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.handle) {
            this.log('扩展卸载，停止本窗口代理（其他窗口心跳会接管）');
            try { await this.handle.stop(); } catch {}
            this.handle = null;
        }
    }

    getPort(): number {
        try {
            const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            return cfg.proxy?.listenPort || DEFAULT_PORT;
        } catch {
            return DEFAULT_PORT;
        }
    }

    /** 确保代理在跑（不通则本窗口起；EADDRINUSE 则当从机）。开关关闭时抛错让调用方提示。 */
    async ensureRunning(): Promise<void> {
        if (!this.toggle.isEnabled()) {
            throw new Error('backup proxy 已被本窗口禁用（树视图开关为关）。请在侧边栏打开开关后再切到代理模式配置。');
        }
        await this.tryBecomeHost();
    }

    /**
     * 切换本窗口 backup proxy 开关。
     * - 开→关：若本窗口是宿主，停掉本窗口进程；心跳此后不再接管（本窗口变旁观者）。
     *           停掉后其他保活从机窗口会在 2s 内接管 —— 预期行为，本开关只控本窗口。
     * - 关→开：探 11434 —— 有其他窗口在跑则复用保心跳、自己不起；没有则自己起。
     * 返回切换后的状态字符串供 UI 提示。
     */
    async setEnabled(on: boolean): Promise<{ enabled: boolean; message: string }> {
        const prev = this.toggle.isEnabled();
        this.toggle.setEnabled(on);
        if (on === prev) {
            // 状态未变，仍刷新状态栏以反映真实运行态
            this.updateStatusBar();
            return { enabled: on, message: on ? 'backup proxy 已是开启状态' : 'backup proxy 已是关闭状态' };
        }
        if (!on) {
            // 开→关：停本窗口进程
            if (this.handle) {
                this.log('backup proxy 开关→关，停掉本窗口代理进程（其他窗口心跳将接管）');
                try { await this.handle.stop(); } catch {}
                this.handle = null;
            } else {
                this.log('backup proxy 开关→关（本窗口本非宿主，无需停进程）');
            }
            this.updateStatusBar();
            return { enabled: false, message: '已禁用本窗口 backup proxy。若其他窗口保活，它们会接管。' };
        }
        // 关→开：尝试成为宿主（复用/启动）
        this.log('backup proxy 开关→开，尝试复用或启动');
        await this.tryBecomeHost();
        this.updateStatusBar();
        const port = this.getPort();
        const runningElsewhere = !this.handle && await healthz(port);
        return {
            enabled: true,
            message: this.handle
                ? `已在本窗口启动 backup proxy (127.0.0.1:${this.handle.port})`
                : (runningElsewhere ? '已复用其他窗口的 backup proxy（本窗口保心跳）' : '已允许本窗口启动 backup proxy'),
        };
    }

    isToggleEnabled(): boolean {
        return this.toggle.isEnabled();
    }

    /**
     * Kill 代理：POST /api/kill 让运行中的代理关闭监听句柄。
     * 任意窗口都能调（不限于宿主）——只要 11434 上有代理在跑就发过去。
     * 关闭后宿主窗口心跳（≤2s）发现 healthz 不通，tryBecomeHost 重起一个。
     * 注意：重起的是宿主内存里已缓存的 proxyModule，改了 proxy 代码不会因此重新加载。
     */
    async kill(): Promise<{ ok: boolean; message: string }> {
        const port = this.getPort();
        // 先探一下有没有代理在跑，没在跑就直接说明
        const up = await healthz(port);
        if (!up) {
            return { ok: false, message: `代理未在运行（127.0.0.1:${port} 无监听），无需 kill` };
        }
        try {
            const { status } = await this.rawHttp('POST', '/api/kill');
            if (status !== 200) {
                throw new Error(`代理返回 ${status}`);
            }
            return { ok: true, message: `已关闭代理监听，宿主窗口心跳将在 2s 内自动重起` };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, message: `kill 失败: ${msg}` };
        }
    }

    /** 把上游配置注入运行中的代理（POST /api/upstream） */
    async setUpstream(env: UpstreamEnv): Promise<void> {
        const body = JSON.stringify({
            upstream: {
                baseUrl: env.baseUrl,
                token: env.token,
                model: env.model ?? '',
                smallFastModel: env.smallFastModel ?? '',
                timeoutSec: env.timeoutSec ?? 600,
            },
        });
        const { status } = await this.rawHttp('POST', '/api/upstream', body);
        if (status !== 200) {
            throw new Error(`代理返回 ${status}`);
        }
        this.log(`已注入上游: ${env.baseUrl} model=${env.model ?? '(unset)'}`);
    }

    /** 设置/更新一条别名映射（POST /api/model-alias）。照 setUpstream 模板。 */
    async setModelAlias(alias: string, model: string): Promise<void> {
        await this.postJson('/api/model-alias', { alias, model });
        this.log(`已设置别名映射: ${alias} → ${model}`);
    }

    /** 删除一条别名映射（POST /api/model-alias/delete）。 */
    async removeModelAlias(alias: string): Promise<void> {
        await this.postJson('/api/model-alias/delete', { alias });
        this.log(`已删除别名映射: ${alias}`);
    }

    /** 向代理申请下一个全局唯一编号 N（GET /api/model-alias/next-id）。 */
    async nextAliasId(): Promise<number> {
        const { status, body } = await this.rawHttp('GET', '/api/model-alias/next-id');
        if (status !== 200) {
            throw new Error(`代理返回 ${status}`);
        }
        try {
            const obj = JSON.parse(body) as { id: number };
            if (typeof obj.id !== 'number' || !Number.isFinite(obj.id)) {
                throw new Error(`代理返回的 id 非数字: ${body}`);
            }
            return obj.id;
        } catch (e) {
            this.log(`nextAliasId: 解析失败 body=${JSON.stringify(body.slice(0, 200))} err=${(e as Error).message}`);
            throw new Error(`解析 next-id 响应失败: ${(e as Error).message}`);
        }
    }

    /**
     * 诊断探针（临时，验证 proxy-agent 劫持假设用）：用 http.get 调本地代理指定路径，
     * 返回完整证据（status/headers/rawLen/raw 前若干字节/err），**不**做任何兜底解析。
     *
     * 关键：opts.withNoProxy 控制调用前是否临时清掉 NO_PROXY/no_proxy env，用于孤立
     * "NO_PROXY 是否在兜底"这一变量。清掉后恢复原值，避免污染后续请求。
     *
     * 用 http.get（被测对象）而非裸 socket——目的就是观测 proxy-agent 对 http 栈的实际影响。
     */
    async diagHttpGet(path: string, opts: { withNoProxy: boolean }): Promise<string> {
        const port = this.getPort();
        const savedNoProxy = process.env.NO_PROXY;
        const savedNo_proxy = process.env.no_proxy;
        if (!opts.withNoProxy) {
            // 模拟"无 NO_PROXY 兜底"：临时删除本地回环绕过，让 proxy-agent 按系统代理处理
            delete process.env.NO_PROXY;
            delete process.env.no_proxy;
        }
        const envSnapshot = {
            HTTP_PROXY: process.env.HTTP_PROXY ?? '(unset)',
            HTTPS_PROXY: process.env.HTTPS_PROXY ?? '(unset)',
            NO_PROXY: process.env.NO_PROXY ?? '(unset)',
            no_proxy: process.env.no_proxy ?? '(unset)',
        };
        return new Promise<string>((resolve) => {
            const tryFinish = (label: string, payload: Record<string, unknown>) => {
                // 恢复 env，避免污染后续请求
                process.env.NO_PROXY = savedNoProxy;
                process.env.no_proxy = savedNo_proxy;
                resolve(JSON.stringify({ label, path, withNoProxy: opts.withNoProxy, env: envSnapshot, ...payload }));
            };
            let raw = '';
            let req: http.ClientRequest;
            try {
                req = http.get(
                    `http://127.0.0.1:${port}${path}`,
                    { timeout: 3000 },
                    (res) => {
                        res.setEncoding('utf8');
                        res.on('data', (chunk: string) => { raw += chunk; });
                        res.on('end', () => {
                            tryFinish('ok', {
                                status: res.statusCode,
                                headers: res.headers,
                                rawLen: raw.length,
                                rawHead: raw.slice(0, 200),
                            });
                        });
                    },
                );
            } catch (e) {
                tryFinish('throw', { err: (e as Error).message });
                return;
            }
            req.on('error', (e) => {
                tryFinish('error', { err: e.message, rawLen: raw.length, rawHead: raw.slice(0, 200) });
            });
            req.on('timeout', () => { req.destroy(); tryFinish('timeout', { rawLen: raw.length }); });
        });
    }

    /**
     * 诊断探针 2：用裸 net socket GET 同一个路径，拿到原始字节流（含 chunked 编码字节），
     * 手动 dechunk 后得到明文 body。对照 diagHttpGet——若裸 socket 拿到完整 body 而 http.get 拿空，
     * 则证明服务端 body 完整、是 http 客户端吞了 chunked body，而非服务端没发。
     */
    async diagRawSocketGet(path: string): Promise<string> {
        const port = this.getPort();
        return new Promise<string>((resolve) => {
            const sock = net.connect(port, '127.0.0.1', () => {
                sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
            });
            let buf = Buffer.alloc(0);
            sock.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); });
            sock.on('end', () => {
                const text = buf.toString('utf8');
                const sep = text.indexOf('\r\n\r\n');
                if (sep < 0) { resolve(JSON.stringify({ label: 'nosep', rawTextHead: text.slice(0, 300) })); return; }
                const statusLine = text.slice(0, text.indexOf('\r\n'));
                const status = Number(statusLine.split(' ')[1]);
                const headerBlock = text.slice(0, sep);
                const bodyRaw = text.slice(sep + 4);
                const isChunked = /transfer-encoding:\s*chunked/i.test(headerBlock);
                const body = isChunked ? dechunk(bodyRaw) : bodyRaw;
                resolve(JSON.stringify({
                    label: 'ok',
                    path,
                    via: 'raw-socket',
                    status,
                    isChunked,
                    rawBytesLen: bodyRaw.length,
                    decodedLen: body.length,
                    decodedHead: body.slice(0, 200),
                }));
            });
            sock.on('error', (e) => { resolve(JSON.stringify({ label: 'error', err: e.message })); });
            sock.setTimeout(3000, () => { sock.destroy(); resolve(JSON.stringify({ label: 'timeout' })); });
        });
    }

    /**
     * 诊断探针 3：用 http.request POST 一个测试映射，观测响应（status/headers/rawLen）。
     * 目的：验证 POST 响应是否同样被吞 body，以及请求 body 是否送达（靠探针 4 读回验证）。
     * 用 http.request（被测对象），不用 postJson wrapper（那是它要验证的）。
     */
    async diagHttpPost(path: string, bodyObj: unknown): Promise<string> {
        const port = this.getPort();
        const body = JSON.stringify(bodyObj);
        return new Promise<string>((resolve) => {
            const tryFinish = (label: string, payload: Record<string, unknown>) => {
                resolve(JSON.stringify({ label, path, via: 'http.request-POST', reqBodyLen: body.length, ...payload }));
            };
            let raw = '';
            let req: http.ClientRequest;
            try {
                req = http.request(
                    `http://127.0.0.1:${port}${path}`,
                    { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 3000 },
                    (res) => {
                        res.setEncoding('utf8');
                        res.on('data', (chunk: string) => { raw += chunk; });
                        res.on('end', () => {
                            tryFinish('ok', { status: res.statusCode, headers: res.headers, rawLen: raw.length, rawHead: raw.slice(0, 200) });
                        });
                    },
                );
            } catch (e) {
                tryFinish('throw', { err: (e as Error).message });
                return;
            }
            req.on('error', (e) => { tryFinish('error', { err: e.message, rawLen: raw.length }); });
            req.on('timeout', () => { req.destroy(); tryFinish('timeout', { rawLen: raw.length }); });
            req.end(body);
        });
    }

    /** 取代理当前别名映射全表（GET /api/config 的 modelAliases 字段）。供上游一致性比对等用。 */
    async getModelAliases(): Promise<Record<string, string>> {
        const { status, body } = await this.rawHttp('GET', '/api/config');
        if (status !== 200) {
            throw new Error(`代理返回 ${status}`);
        }
        try {
            const obj = JSON.parse(body) as { modelAliases?: Record<string, string> };
            return obj.modelAliases ?? {};
        } catch (e) {
            throw new Error(`解析 /api/config 响应失败: ${(e as Error).message}`);
        }
    }

    /** POST JSON 到代理的通用封装。 */
    private async postJson(path: string, bodyObj: unknown): Promise<void> {
        const body = JSON.stringify(bodyObj);
        const { status } = await this.rawHttp('POST', path, body);
        if (status !== 200) {
            throw new Error(`代理返回 ${status}`);
        }
    }

    /**
     * 裸 net socket 调本地代理（绕过 VS Code 扩展宿主 http 栈对响应 body 的吞没）。
     * 用 net.connect + 手写 HTTP 请求行 + 手动解析响应（含 chunked 解码 dechunk）。
     * 所有调代理的 wrapper 都走此方法——扩展宿主 http 栈对 127.0.0.1 响应 body 一律吞
     *（无论 chunked 还是 Content-Length，data 事件都不投递），裸 socket 不被 hook、稳定拿到 body。
     *
     * @param method GET/POST
     * @param path 请求路径，如 /api/config
     * @param body POST 请求体（string）。GET 传 undefined。
     * @returns { status, body }——status 是 HTTP 状态码（number），body 是解 chunked 后的明文响应体
     */
    private rawHttp(method: 'GET' | 'POST', path: string, body?: string): Promise<{ status: number; body: string }> {
        const port = this.getPort();
        return new Promise<{ status: number; body: string }>((resolve, reject) => {
            const sock = net.connect(port, '127.0.0.1', () => {
                const reqHeaders = [
                    `${method} ${path} HTTP/1.1`,
                    `Host: 127.0.0.1:${port}`,
                    'Connection: close',
                ];
                if (body !== undefined) {
                    reqHeaders.push('content-type: application/json');
                    reqHeaders.push(`content-length: ${Buffer.byteLength(body)}`);
                }
                sock.write(`${reqHeaders.join('\r\n')}\r\n\r\n${body ?? ''}`);
            });
            let buf = Buffer.alloc(0);
            sock.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); });
            sock.on('end', () => {
                const text = buf.toString('utf8');
                // 响应格式：HTTP/1.1 200 OK\r\n<headers>\r\n\r\n<body>
                const sep = text.indexOf('\r\n\r\n');
                if (sep < 0) {
                    this.log(`rawHttp: 无 header/body 分隔 ${method} ${path} text=${text.slice(0, 300)}`);
                    reject(new Error('响应无 header/body 分隔'));
                    return;
                }
                const statusLine = text.slice(0, text.indexOf('\r\n'));
                const status = Number(statusLine.split(' ')[1]);
                const headerBlock = text.slice(0, sep);
                const bodyRaw = text.slice(sep + 4);
                // 处理 chunked（若 transfer-encoding: chunked）——服务端现在带 Content-Length 不分块，
                // 但保留 dechunk 以兼容老响应 / 历史数据
                let respBody = bodyRaw;
                if (/transfer-encoding:\s*chunked/i.test(headerBlock)) {
                    respBody = dechunk(bodyRaw);
                }
                resolve({ status, body: respBody });
            });
            sock.on('error', (e) => {
                this.log(`rawHttp: socket 错误 ${method} ${path} port=${port} err=${e.message}`);
                reject(e);
            });
            sock.setTimeout(3000, () => { sock.destroy(); reject(new Error(`${method} ${path} 超时（代理未运行？）`)); });
        });
    }

    private async tryBecomeHost(): Promise<void> {
        if (this.disposed) return; // 扩展已卸载，不再 spawn（防泄漏）
        if (!this.toggle.isEnabled()) return; // 开关关闭：本窗口不启动也不接管
        if (this.handle) return; // 已是宿主
        if (this.spawning) return; // 上次 tryBecomeHost 还在 spawn/等就绪，避免重入 spawn 多个子进程
        const port = this.getPort();
        if (await healthz(port)) return; // 别的窗口在跑
        this.spawning = true;
        try {
            // spawn 独立子进程跑 proxy/server.js。用 process.execPath（Code.exe / VS Code 自带 Node）+
            // 净化 env + ELECTRON_RUN_AS_NODE=1。V1-f 验证：不净化 env 会因 NODE_OPTIONS/VSCODE_*
            // 注入死锁（子进程不 listen 不 exit 零输出）；净化后正常。详见 docs/server独立进程化调研.md。
            const serverPath = path.join(this.extensionPath, 'proxy', 'server.js');
            const env = cleanEnv({ configPath: this.configPath, logsDir: this.logsDir, logsConfigPath: this.logsConfigPath });
            const child = spawn(process.execPath, [serverPath], {
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            // 子进程 stdout/stderr → OutputChannel（concise 日志 + FATAL 诊断）
            // 每个流独立 lineBuf：共享会让 stdout 半行 + stderr 半行混合、前缀错乱。
            // 残行 flush 在 stream 'end'/'close' 触发（exit 事件后 stdio 可能还有缓冲 data，
            // 在 stream 真正结束时 flush 才能拿到完整残行，如 FATAL + process.exit）。
            const forward = (stream: NodeJS.ReadableStream | null, prefix: string): (() => void) => {
                if (!stream) return () => {};
                let lineBuf = '';
                const flush = () => { if (lineBuf.length) { this.log(`${prefix}${lineBuf}`); lineBuf = ''; } };
                stream.on('data', (c: Buffer) => {
                    lineBuf += c.toString('utf8');
                    let nl: number;
                    while ((nl = lineBuf.indexOf('\n')) >= 0) {
                        const line = lineBuf.slice(0, nl);
                        lineBuf = lineBuf.slice(nl + 1);
                        if (line.length) this.log(`${prefix}${line}`);
                    }
                });
                // exit 后 stdio 可能还有 data；在流结束（end/close）时 flush 残行最全
                stream.on('end', flush);
                stream.on('close', flush);
                return flush;
            };
            const flushStdout = forward(child.stdout, '');
            const flushStderr = forward(child.stderr, '[stderr] ');
            // 子进程 crash/exit：主动清 handle，下次心跳 re-spawn（kill 导致的 exit 除外——kill 时已清）
            child.on('exit', (code, signal) => {
                // exit 时先 flush 一次（覆盖 exit 后 stdio 不会触发 end 的极端情况，如被 SIGKILL）；
                // stream 的 end/close 会再 flush（幂等，lineBuf 已清则 no-op）。
                flushStdout(); flushStderr();
                if (this.handle?.child === child) {
                    this.log(`代理子进程退出 code=${code} signal=${signal ?? '(none)'}，清 handle（下次心跳 re-spawn）`);
                    this.handle = null;
                    this.updateStatusBar();
                }
            });
            // 就绪检测：轮询 healthz（裸 socket，绕过扩展宿主 http 栈吞 body）
            const ready = await waitForPortReady(port, SPAWN_READY_TIMEOUT_MS);
            if (ready) {
                this.handle = {
                    child,
                    port,
                    stop: () => killChild(child),
                };
                this.log(`成为宿主，代理子进程在 127.0.0.1:${port} 运行（pid=${child.pid}）`);
            } else {
                // 未就绪：子进程可能已 exit（exit 事件已清 handle 设为 null，但 this.handle 此时本就 null）
                // 或卡死（5s 内既不 listen 也不 exit）→ kill 掉，下次心跳重试
                this.log(`代理子进程 ${SPAWN_READY_TIMEOUT_MS}ms 内未就绪（exitCode=${child.exitCode}），kill 并重试`);
                try { child.kill(); } catch {}
            }
        } catch (e: unknown) {
            this.log('启动代理子进程失败:', e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
        } finally {
            this.spawning = false;
        }
        this.updateStatusBar();
    }

    private async heartbeatTick(): Promise<void> {
        // 开关关闭：本窗口不持代理、不接管、只更新状态栏。保持空转心跳以便随时感知开关重开。
        if (!this.toggle.isEnabled()) {
            // 防御：若本窗口仍持着 handle（理论不会，setEnabled(false) 已 stop），强制清掉
            if (this.handle) {
                try { await this.handle.stop(); } catch {}
                this.handle = null;
            }
            this.updateStatusBar();
            return;
        }
        const port = this.getPort();
        if (this.handle) {
            // 宿主自检
            if (!(await healthz(this.handle.port))) {
                this.log('本窗口代理异常，尝试重启');
                try { await this.handle.stop(); } catch {}
                this.handle = null;
                await this.tryBecomeHost();
            }
            return;
        }
        // 从机：探测宿主是否还在，不在就接管
        if (!(await healthz(port))) {
            // spawning 期间不重复打印「尝试接管」——上次 spawn 还在等就绪（如 EADDRINUSE 退化时
            // 每次子进程 listen 失败 exit，waitForPortReady 要等满 5s 超时，期间 2s 心跳会多次
            // 触发这里但被 tryBecomeHost 的 spawning 守卫挡住，不打印避免日志刷屏）。
            if (!this.spawning) {
                this.log('探测到代理不在，尝试接管');
            }
            await this.tryBecomeHost();
        }
        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        if (!this.toggle.isEnabled()) {
            this.statusBar.text = '$(circle-slash) 代理:本窗口禁用';
            this.statusBar.tooltip = 'backup proxy 已在本窗口禁用（树视图开关为关）。\n其他窗口若保活会接管；本窗口不启动、不接管。\n点击打开控制台（若代理在别处运行）';
            return;
        }
        if (this.handle) {
            this.statusBar.text = '$(cloud) 代理:本窗口运行';
            this.statusBar.tooltip = `LLM 代理在本窗口运行 (127.0.0.1:${this.handle.port})\n点击打开控制台`;
        } else {
            this.statusBar.text = '$(cloud) 代理:检测中…';
            const port = this.getPort();
            healthz(port).then((up) => {
                if (this.handle) return;
                if (!this.toggle.isEnabled()) return; // 期间被禁用了，不覆盖禁用态
                this.statusBar.text = up ? '$(cloud) 代理:其他窗口运行' : '$(cloud) 代理:未运行';
                this.statusBar.tooltip = up
                    ? `代理在其他窗口运行 (127.0.0.1:${port})\n点击打开控制台`
                    : `代理未运行，下次心跳将尝试启动\n点击打开控制台`;
            });
        }
    }

    private log(...a: unknown[]): void {
        const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
        this.output.appendLine(line);
    }
}

/** 探测本地代理是否在跑（GET /healthz，只看 status 200）。用裸 socket，不依赖扩展宿主 http 栈。 */
function healthz(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        });
        let buf = Buffer.alloc(0);
        sock.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); });
        sock.on('end', () => {
            const text = buf.toString('utf8');
            const statusLine = text.slice(0, text.indexOf('\r\n'));
            const status = Number(statusLine.split(' ')[1]);
            finish(status === 200);
        });
        sock.on('error', () => finish(false));
        sock.setTimeout(HEALTH_TIMEOUT_MS, () => { sock.destroy(); finish(false); });
    });
}

/** 轮询 healthz 直到通或超时。供 tryBecomeHost 判断子进程是否 listen 就绪。 */
function waitForPortReady(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const poll = async (): Promise<boolean> => {
        while (Date.now() < deadline) {
            if (await healthz(port)) return true;
            await new Promise(r => setTimeout(r, 100));
        }
        return false;
    };
    return poll();
}

/** kill 子进程并等其退出。Windows 无信号，child.kill() 走 TerminateProcess。 */
function killChild(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) {
            resolve(); // 已退出
            return;
        }
        const onExit = () => resolve();
        child.once('exit', onExit);
        try { child.kill(); } catch {}
        // 兜底：3s 没退出则 SIGKILL 强杀（防忽略 SIGTERM 的子进程僵死占端口），
        // 再等最多 1s 让 exit 事件落地；仍未退出也 resolve（极端情况，不阻塞调用方）。
        setTimeout(() => {
            if (child.exitCode !== null || child.signalCode) { resolve(); return; }
            try { child.kill('SIGKILL'); } catch {}
            // SIGKILL 后再给 1s 让 exit 事件触发
            setTimeout(() => {
                child.removeListener('exit', onExit);
                resolve();
            }, 1000);
        }, 3000);
    });
}

const DEFAULT_PROXY_CONFIG = {
    env: {
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: '',
        API_TIMEOUT_MS: '600000',
        ANTHROPIC_MODEL: '',
    },
    effortLevel: 'max',
    proxy: {
        listenHost: '127.0.0.1',
        listenPort: DEFAULT_PORT,
        maxAttempts: 20,
        backoffSec: 3,
        backoffMaxSec: 16,
        passthrough: false,
        // 可配置组合重试规则：{status, code}。status 填状态码或 '*'；code 填数字或 'all'。
        // 默认 503+10310 / 200+10310（讯飞 system busy，含假成功 200+10310）。
        // 其他状态码 Claude Code 自己能处理，代理不插手（避免拖慢 + 叠加重试）。
        retryRules: [
            { status: 503, code: 10310 },
            { status: 200, code: 10310 },
        ],
    },
};
