/**
 * 独立 Server 子进程控制器（不依赖 vscode）。
 *
 * 把 ProxyHost.tryBecomeHost 里的「spawn + 就绪检测 + child.on('exit') 回调 + stdio 转发」
 * 抽成纯 Node 函数，便于单测（proxyHost.ts 顶部 import vscode，纯 Node 测试加载不了）。
 *
 * 设计：
 * - `spawnProxyChild` 只负责「spawn 一次 + 轮询 healthz 就绪 + 注册 exit 回调 + stdio forward」。
 * - **不**自动 re-spawn（那是 ProxyHost 心跳的职责），通过 onExit 回调通知调用方。
 * - **不**含 spawning/disposed/toggle 守卫（依赖 vscode 状态，留 ProxyHost）。
 * - healthz/waitForPortReady/killChild/forwardStdio 全部 export，测试直接 import 真函数
 *   （消除之前 spawn-helpers/stdio-forward 测试内联复制源码不同步的风险）。
 */
import * as net from 'net';
import { spawn, type ChildProcess } from 'child_process';

/** healthz 单次探测超时（ms）。 */
export const HEALTH_TIMEOUT_MS = 500;
/** spawn 子进程后轮询 healthz 就绪的超时（ms）。server.js 启动通常 <1s，留 5s 余量。 */
export const SPAWN_READY_TIMEOUT_MS = 5000;

/** 探测本地代理是否在跑（GET /healthz，只看 status 200）。用裸 socket，不依赖扩展宿主 http 栈。 */
export function healthz(port: number): Promise<boolean> {
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

/** 轮询 healthz 直到通或超时。供 spawnProxyChild 判断子进程是否 listen 就绪。 */
export function waitForPortReady(port: number, timeoutMs: number): Promise<boolean> {
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

/**
 * 轮询 healthz，但子进程 exit 时立即返回 false（不等满超时）。
 *
 * 解决 EADDRINUSE 等场景：server.js listen 失败后 process.exit(1)（通常 <100ms），
 * 若仍等满 readyTimeoutMs（默认 5s），ProxyHost 心跳被 spawning 守卫卡住整段超时，
 * 延迟恢复 + 日志刷屏。子进程 exit 后 healthz 必然不通，等下去毫无意义。
 */
export function waitForPortReadyOrExit(port: number, timeoutMs: number, child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const poll = async (): Promise<boolean> => {
        while (Date.now() < deadline) {
            // 子进程已 exit → 不必再轮询（healthz 必然不通）
            if (child.exitCode !== null || child.signalCode !== null) return false;
            if (await healthz(port)) return true;
            await new Promise(r => setTimeout(r, 100));
        }
        return false;
    };
    return poll();
}

/** kill 子进程并等其退出。Windows 无信号，child.kill() 走 TerminateProcess。 */
export function killChild(child: ChildProcess): Promise<void> {
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
            setTimeout(() => {
                child.removeListener('exit', onExit);
                resolve();
            }, 1000);
        }, 3000);
    });
}

/** 子进程句柄。stop = killChild。port 供心跳自检。 */
export interface ProxyChildHandle {
    child: ChildProcess;
    port: number;
    stop: () => Promise<void>;
}

/** spawnProxyChild 的回调依赖（由 ProxyHost 注入，避免直接依赖 vscode）。 */
export interface SpawnCallbacks {
    /** 日志输出（ProxyHost 注入 this.log → OutputChannel）。 */
    onLog: (line: string) => void;
    /** 子进程 exit 回调（ProxyHost 清 handle + updateStatusBar）。child 参数供调用方判断是否当前 handle。 */
    onExit: (child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * 转发子进程 stdout/stderr 到 onLog，独立 lineBuf 行缓冲。
 * 残行（无换行结尾）在 stream 'end'/'close' 时 flush（覆盖 exit 后 stdio 还有缓冲 data 的极端情况）。
 * 返回 flush 函数（exit 时调一次，幂等）。
 */
export function forwardStdio(
    child: ChildProcess,
    callbacks: SpawnCallbacks,
): { flushStdout: () => void; flushStderr: () => void } {
    const forward = (stream: NodeJS.ReadableStream | null, prefix: string): (() => void) => {
        if (!stream) return () => {};
        let lineBuf = '';
        const flush = () => { if (lineBuf.length) { callbacks.onLog(`${prefix}${lineBuf}`); lineBuf = ''; } };
        stream.on('data', (c: Buffer) => {
            lineBuf += c.toString('utf8');
            let nl: number;
            while ((nl = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, nl);
                lineBuf = lineBuf.slice(nl + 1);
                if (line.length) callbacks.onLog(`${prefix}${line}`);
            }
        });
        stream.on('end', flush);
        stream.on('close', flush);
        return flush;
    };
    return {
        flushStdout: forward(child.stdout, ''),
        flushStderr: forward(child.stderr, '[stderr] '),
    };
}

/**
 * spawn 独立子进程跑 proxy/server.js + 轮询 healthz 就绪 + 注册 exit/stdio。
 *
 * @returns 就绪返回 ProxyChildHandle；未就绪（子进程 exit 或 5s 超时）返回 null（子进程已被 kill 清理）。
 *
 * 不含 spawning/disposed/toggle 守卫（留 ProxyHost）。不自动 re-spawn（onExit 回调通知调用方）。
 */
export async function spawnProxyChild(opts: {
    serverPath: string;
    port: number;
    env: Record<string, string>;
    callbacks: SpawnCallbacks;
    readyTimeoutMs?: number;
}): Promise<ProxyChildHandle | null> {
    const { serverPath, port, env, callbacks, readyTimeoutMs = SPAWN_READY_TIMEOUT_MS } = opts;
    const child = spawn(process.execPath, [serverPath], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const { flushStdout, flushStderr } = forwardStdio(child, callbacks);
    // 子进程 crash/exit：flush 残行 + 通知调用方（ProxyHost 清 handle + re-spawn 由心跳负责）
    child.on('exit', (code, signal) => {
        flushStdout(); flushStderr();
        callbacks.onExit(child, code, signal ?? null);
    });
    // 就绪检测：轮询 healthz（裸 socket）。子进程提前 exit（如 EADDRINUSE）时立即终止轮询，
    // 不等满 readyTimeoutMs——否则心跳被 spawning 守卫卡住整段超时，延迟恢复。
    const ready = await waitForPortReadyOrExit(port, readyTimeoutMs, child);
    if (ready && child.exitCode === null && child.signalCode === null) {
        return {
            child,
            port,
            stop: () => killChild(child),
        };
    }
    // 未就绪：子进程可能已 exit（onExit 已通知调用方）或卡死 → killChild 清理（含 SIGKILL 兜底，
    // 防 POSIX 上忽略 SIGTERM 的子进程僵死占端口）。子进程已 exit 时 killChild 立即 resolve。
    callbacks.onLog(`代理子进程 ${readyTimeoutMs}ms 内未就绪（exitCode=${child.exitCode}），kill 并重试`);
    try { await killChild(child); } catch {}
    return null;
}
