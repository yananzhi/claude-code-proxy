// standalone/claudeSession.js — CLI 会话管理（node-pty + WebSocket，ESM JS）
//
// 职责（阶段 3）：
//   - 每 workspace 一个 claude CLI 会话（node-pty spawn，TUI 不降级）
//   - CLAUDE_CONFIG_DIR 指向 workspace 的 .claude_proxy/，cwd=workspace dir
//   - WebSocket 双向流：PTY onData → 广播 WS；WS message → PTY write
//   - 会话状态 Map 内存管理 + 退出/断线清理
//
// 设计依据：docs/standalone-backend-plan.md 阶段 3
// 正交设计：plan/tmp/2026-08-03-stage3-cli-session.md
//
// 范围收缩：阶段 3 spawn "裸 claude 会话"（CLAUDE_CONFIG_DIR + cwd + env，不预写 settings.json）。
// 完整 settings.json 合成（proxy 模式 upstream 注入 + 派生节点别名）留后续。

import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// node-pty 是 native CJS 模块，用 createRequire 加载
const require = createRequire(import.meta.url);
let _pty;
try {
    _pty = require('node-pty');
} catch (e) {
    console.error('[claudeSession] 加载 node-pty 失败：', e.message);
    console.error('请先 npm install node-pty');
    process.exit(1);
}
/** 默认 pty 实现（可被 ClaudeSessionManager 构造函数 opts.pty 覆盖，便于测试 mock）。 */
export const defaultPty = _pty;

/** workspace 下独立配置目录名（与 localConfigStore/launcher 一致）。 */
const WORKSPACE_CONFIG_DIR = '.claude_proxy';

/**
 * Claude 会话管理器：每 workspace 一个 PTY 会话。
 */
export class ClaudeSessionManager {
    constructor(opts = {}) {
        /** @type {Map<string, SessionHandle>} workspaceId → handle */
        this.sessions = new Map();
        this.log = opts.log || (() => {});
        // pty 实现可注入（测试用 mock，默认用 node-pty）
        this.pty = opts.pty || defaultPty;
    }

    /**
     * 启动（或复用）某 workspace 的 claude 会话。
     * @param {string} workspaceId
     * @param {{dir: string, binaryPath: string}} workspace workspace 磁盘目录 + claude 二进制路径
     * @returns {Promise<{ sessionId: string, pid: number, reused: boolean }>}
     * @throws {Error} binaryPath 为空 / spawn 失败
     */
    async start(workspaceId, workspace) {
        if (!workspace?.binaryPath) {
            throw new Error('claude 二进制未找到（请安装 Claude Code CLI 或在设置中指定路径）');
        }
        if (!workspace?.dir) {
            throw new Error('workspace 目录无效');
        }

        // 已有会话 → 复用
        const existing = this.sessions.get(workspaceId);
        if (existing) {
            return { sessionId: existing.id, pid: existing.pty.pid, reused: true };
        }

        const configDir = path.join(workspace.dir, WORKSPACE_CONFIG_DIR);
        const env = {
            ...process.env,
            CLAUDE_CONFIG_DIR: configDir,
        };

        let ptyProcess;
        try {
            ptyProcess = this.pty.spawn(workspace.binaryPath, [], {
                cwd: workspace.dir,
                env,
                // PTY 初始尺寸：与 xterm 默认对齐，避免 claude CLI 按 80x24 渲染而 xterm 按容器宽渲染致错位。
                // 实际尺寸由前端 fit 后通过 WS resize 消息同步（pty.resize）。
                cols: 80,
                rows: 24,
            });
        } catch (e) {
            throw new Error(`spawn claude 失败: ${e.message || String(e)}`);
        }

        const handle = {
            id: workspaceId,
            pty: ptyProcess,
            pid: ptyProcess.pid,
            startedAt: new Date().toISOString(),
            /** @type {Set<import('ws').WebSocket>} 连接的 WS 客户端 */
            wsClients: new Set(),
            disposed: false,
        };

        // PTY 输出 → 广播到所有 WS 客户端（发 binary frame，前端 binaryType=arraybuffer 接 Uint8Array，
        // 避免 string 双重 UTF-8 解码致 CJK 损坏）
        ptyProcess.onData((data) => {
            const buf = Buffer.from(data, 'utf-8');
            for (const ws of handle.wsClients) {
                if (ws.readyState === ws.OPEN) {
                    try {
                        ws.send(buf);
                    } catch (e) {
                        this.log(`[claudeSession] 广播 WS 异常: ${e?.message || String(e)}`);
                    }
                }
            }
        });

        // PTY 退出 → 清理 + 通知 WS 客户端
        ptyProcess.onExit(({ exitCode, signal }) => {
            this.log(`[claudeSession] 会话 ${workspaceId} 退出 code=${exitCode} signal=${signal}`);
            handle.disposed = true; // 防 ws message 在 close 前仍写死 PTY
            this.sessions.delete(workspaceId);
            // 通知所有 WS 客户端
            for (const ws of handle.wsClients) {
                if (ws.readyState === ws.OPEN) {
                    try { ws.send(JSON.stringify({ type: 'exit', exitCode, signal })); } catch {}
                    try { ws.close(1000, 'claude exited'); } catch {}
                }
            }
            handle.wsClients.clear();
        });

        this.sessions.set(workspaceId, handle);
        this.log(`[claudeSession] 会话已启动 ${workspaceId} pid=${handle.pid}`);
        return { sessionId: handle.id, pid: handle.pid, reused: false };
    }

    /** 停止某 workspace 会话（kill PTY + 移除）。不存在 → 无操作。 */
    async stop(workspaceId) {
        const handle = this.sessions.get(workspaceId);
        if (!handle) return false;
        handle.disposed = true;
        try {
            // node-pty 的 kill 默认 SIGTERM，Windows 用 TerminateProcess
            handle.pty.kill();
        } catch (e) {
            this.log(`[claudeSession] kill ${workspaceId} 异常: ${e?.message || String(e)}`);
        }
        this.sessions.delete(workspaceId);
        // 关闭所有 WS
        for (const ws of handle.wsClients) {
            if (ws.readyState === ws.OPEN) {
                try { ws.close(1000, 'session stopped'); } catch {}
            }
        }
        handle.wsClients.clear();
        return true;
    }

    /** 取会话状态。不存在 → null。 */
    status(workspaceId) {
        const h = this.sessions.get(workspaceId);
        if (!h) return null;
        return { sessionId: h.id, pid: h.pid, startedAt: h.startedAt, running: true };
    }

    /**
     * 注册一个 WS 客户端到某会话（接收 PTY 输出 + 发送输入）。
     * 会话不存在 → 返回 false（调用方应拒绝升级）。
     */
    attachWs(workspaceId, ws) {
        const handle = this.sessions.get(workspaceId);
        if (!handle) return false;

        handle.wsClients.add(ws);

        // WS 收到消息 → resize 控制（text JSON）或 写入 PTY（用户输入 string/binary）
        ws.on('message', (data, isBinary) => {
            if (handle.disposed) return;
            // text frame：可能是 resize 控制消息（JSON {type:'resize',...}）或 string 输入
            if (!isBinary) {
                const text = data.toString('utf8');
                if (text.startsWith('{')) {
                    try {
                        const obj = JSON.parse(text);
                        if (obj.type === 'resize' && Number.isFinite(obj.cols) && Number.isFinite(obj.rows)) {
                            try {
                                // 像素尺寸（Windows conpty 高 DPI 按 pixel 缩放，不传会渲染错位）
                                const opts = {};
                                if (Number.isFinite(obj.pixelWidth) && Number.isFinite(obj.pixelHeight)) {
                                    opts.width = obj.pixelWidth;
                                    opts.height = obj.pixelHeight;
                                }
                                handle.pty.resize(Math.max(1, obj.cols|0), Math.max(1, obj.rows|0), opts);
                            } catch (e) {
                                this.log(`[claudeSession] pty.resize 异常: ${e?.message || String(e)}`);
                            }
                            return;
                        }
                    } catch { /* 非 JSON，按用户输入处理 */ }
                }
                // 非 resize 的 text = 用户 string 输入
                try { handle.pty.write(text); } catch (e) {
                    this.log(`[claudeSession] write PTY 异常: ${e?.message || String(e)}`);
                }
                return;
            }
            // binary frame = xterm onBinary（IME/Alt 序列/paste 非文本），直接写 PTY
            try { handle.pty.write(Buffer.from(data)); } catch (e) {
                this.log(`[claudeSession] write PTY(binary) 异常: ${e?.message || String(e)}`);
            }
        });

        // WS 关闭 → 从客户端集合移除（PTY 保持，可重连）
        ws.on('close', () => {
            handle.wsClients.delete(ws);
        });

        ws.on('error', () => {
            handle.wsClients.delete(ws);
        });

        return true;
    }

    /** 停止所有会话（standalone 退出时调）。 */
    async stopAll() {
        const ids = [...this.sessions.keys()];
        for (const id of ids) {
            await this.stop(id);
        }
    }
}
