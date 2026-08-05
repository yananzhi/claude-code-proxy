// standalone/claudeSession.js — CLI 终端会话管理（node-pty + WebSocket，ESM JS）
//
// 职责：
//   - 每个终端一个独立 PTY 会话（按 terminalId 索引，不再 per-workspace 单会话）
//   - normal 终端：基于 active 配置的 settings.json 启动（env 只注入 CLAUDE_CONFIG_DIR）
//   - derived 终端：env 注入 BASE_URL/token/四档别名，configDir 用 per-terminal 空目录
//   - WebSocket 双向流：PTY onData → 广播 WS；WS message → PTY write / resize
//   - 会话状态 Map 内存管理 + 退出/断线清理 + listByWorkspace/listByConfig
//
// 设计依据：docs/standalone-backend-plan.md；plan: .claude_proxy/plans/ancient-greeting-puddle.md
//
// 注：真实 PTY/conqty 集成（含 xterm.js 端到端）由手动 smoke 验证，不进 node --test 套件
// （node-pty 的 conqty handle 进程退出后不自动释放，会让 event loop 不空卡死套件）。

import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
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

/** 默认 terminalId 生成器：'t_' + 8 hex。测试可注入 opts.newId 覆盖。 */
export function defaultNewId() {
    return 't_' + randomBytes(4).toString('hex');
}

/**
 * Claude 终端会话管理器：每个 terminalId 一个独立 PTY 会话。
 *
 * 与旧版（per-workspace 单会话、reuse-on-exist）区别：
 *   - start 永远 spawn 新 PTY（不 reuse）——支持同一 workspace/config 多终端
 *   - handle 多存 configId/workspaceId/startedConfigName/kind/configDir，供 listBy* 查询
 *   - 不清理 configDir（目标1 后共享 {ws}/.claude_proxy，删它丢 local-configs.json + CLI 引导标记）
 */
export class ClaudeSessionManager {
    constructor(opts = {}) {
        /** @type {Map<string, TerminalHandle>} terminalId → handle */
        this.sessions = new Map();
        this.log = opts.log || (() => {});
        // pty 实现可注入（测试用 mock，默认用 node-pty）
        this.pty = opts.pty || defaultPty;
        this.newId = opts.newId || defaultNewId;
    }

    /**
     * Spawn 一个新终端（永不 reuse）。调用方保证 terminalId 唯一。
     * @param {string} terminalId 终端唯一 id（调用方生成，或用 mgr.newId()）
     * @param {object} params
     *   @param {string} params.cwd workspace 磁盘目录（PTY cwd）
     *   @param {string} params.binaryPath claude 二进制路径
     *   @param {object} params.env spawn env 覆盖层（含 CLAUDE_CONFIG_DIR + 配置特定 key）
     *   @param {string} params.configDir CLAUDE_CONFIG_DIR 路径（per-terminal，spawn 前 mkdir）
     *   @param {string} params.workspaceId 所属 workspace id（listByWorkspace 用）
     *   @param {string} params.configId 所属 config id（listByConfig 用）
     *   @param {string} params.startedConfigName 启动时所基于的配置名（normal 终端显示用）
     *   @param {'normal'|'derived'} params.kind 终端类型
     * @returns {Promise<{ terminalId: string, pid: number }>}
     * @throws {Error} binaryPath 为空 / cwd 为空 / spawn 失败
     */
    async start(terminalId, params) {
        if (!params?.binaryPath) {
            throw new Error('claude 二进制未找到（请安装 Claude Code CLI 或在设置中指定路径）');
        }
        if (!params?.cwd) {
            throw new Error('workspace 目录无效');
        }

        // 确保 per-terminal configDir 存在（派生终端的独立空目录；normal 终端指向 .claude_proxy，已存在也无所谓）
        const configDir = params.configDir;
        if (configDir) {
            try {
                fs.mkdirSync(configDir, { recursive: true });
            } catch (e) {
                this.log(`[claudeSession] mkdir configDir 失败（忽略）: ${e?.message || String(e)}`);
            }
        }

        const env = {
            ...process.env,
            CLAUDE_CONFIG_DIR: configDir,
            ...params.env,
        };

        let ptyProcess;
        try {
            ptyProcess = this.pty.spawn(params.binaryPath, [], {
                cwd: params.cwd,
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
            id: terminalId,
            pty: ptyProcess,
            pid: ptyProcess.pid,
            startedAt: new Date().toISOString(),
            /** @type {Set<import('ws').WebSocket>} 连接的 WS 客户端 */
            wsClients: new Set(),
            disposed: false,
            workspaceId: params.workspaceId,
            configId: params.configId,
            startedConfigName: params.startedConfigName,
            kind: params.kind || 'normal',
            configDir,
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
            this.log(`[claudeSession] 终端 ${terminalId} 退出 code=${exitCode} signal=${signal}`);
            handle.disposed = true; // 防 ws message 在 close 前仍写死 PTY
            this.sessions.delete(terminalId);
            // ⚠ 不 rmSync configDir：目标1 后 configDir 共享 {ws}/.claude_proxy（含 local-configs.json
            // + CLI 的 .claude.json/onboarding 标记），删它会导致配置丢失 + 重新引导。per-terminal 时代的
            // 清理逻辑已不适用（共享目录不能删）。CLI 会在 configDir 写状态，但不该被我们清。
            // 通知所有 WS 客户端
            for (const ws of handle.wsClients) {
                if (ws.readyState === ws.OPEN) {
                    try { ws.send(JSON.stringify({ type: 'exit', exitCode, signal })); } catch {}
                    try { ws.close(1000, 'claude exited'); } catch {}
                }
            }
            handle.wsClients.clear();
        });

        this.sessions.set(terminalId, handle);
        this.log(`[claudeSession] 终端已启动 ${terminalId} pid=${handle.pid} kind=${handle.kind} configId=${handle.configId}`);
        return { terminalId: handle.id, pid: handle.pid };
    }

    /**
     * 生成新 terminalId（便捷方法，调用方可不用、自己生成）。
     */
    newTerminalId() {
        return this.newId();
    }

    /** 取终端详情。不存在 → null。 */
    get(terminalId) {
        const h = this.sessions.get(terminalId);
        if (!h) return null;
        return {
            terminalId,
            pid: h.pid,
            kind: h.kind || 'normal',
            configId: h.configId,
            startedConfigName: h.startedConfigName,
            workspaceId: h.workspaceId,
            startedAt: h.startedAt,
        };
    }

    /** 停止某终端（kill PTY + 移除 + 清理 configDir）。不存在 → false。 */
    async stop(terminalId) {
        const handle = this.sessions.get(terminalId);
        if (!handle) return false;
        handle.disposed = true;
        try {
            // node-pty 的 kill 默认 SIGTERM，Windows 用 TerminateProcess
            handle.pty.kill();
        } catch (e) {
            this.log(`[claudeSession] kill ${terminalId} 异常: ${e?.message || String(e)}`);
        }
        this.sessions.delete(terminalId);
        // ⚠ 不 rmSync configDir：configDir 共享 {ws}/.claude_proxy（含 local-configs.json），
        // 删它会丢配置。per-terminal 时代的清理已不适用。
        // 关闭所有 WS
        for (const ws of handle.wsClients) {
            if (ws.readyState === ws.OPEN) {
                try { ws.close(1000, 'session stopped'); } catch {}
            }
        }
        handle.wsClients.clear();
        return true;
    }

    /** 取终端状态。不存在 → null。 */
    status(terminalId) {
        const h = this.sessions.get(terminalId);
        if (!h) return null;
        return {
            terminalId: h.id,
            pid: h.pid,
            startedAt: h.startedAt,
            running: true,
            workspaceId: h.workspaceId,
            configId: h.configId,
            startedConfigName: h.startedConfigName,
            kind: h.kind,
        };
    }

    /** 列某 workspace 的所有活终端（normal 终端用）。 */
    listByWorkspace(workspaceId) {
        const out = [];
        for (const h of this.sessions.values()) {
            if (h.workspaceId === workspaceId) {
                out.push({
                    terminalId: h.id, pid: h.pid, startedAt: h.startedAt,
                    configId: h.configId, startedConfigName: h.startedConfigName,
                    kind: h.kind, workspaceId: h.workspaceId,
                });
            }
        }
        return out;
    }

    /** 列某 config 的所有活终端（derived 终端用）。 */
    listByConfig(configId) {
        const out = [];
        for (const h of this.sessions.values()) {
            if (h.configId === configId) {
                out.push({
                    terminalId: h.id, pid: h.pid, startedAt: h.startedAt,
                    configId: h.configId, startedConfigName: h.startedConfigName,
                    kind: h.kind, workspaceId: h.workspaceId,
                });
            }
        }
        return out;
    }

    /**
     * 注册一个 WS 客户端到某终端（接收 PTY 输出 + 发送输入）。
     * 终端不存在 → 返回 false（调用方应拒绝升级）。
     * 重入：同一终端可 attach 多个 WS 客户端（广播 fan-out）。
     */
    attachWs(terminalId, ws) {
        const handle = this.sessions.get(terminalId);
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

    /** 停止所有终端（standalone 退出时调）。 */
    async stopAll() {
        const ids = [...this.sessions.keys()];
        for (const id of ids) {
            await this.stop(id);
        }
    }
}
