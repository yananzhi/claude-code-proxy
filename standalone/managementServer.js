// standalone/managementServer.js — workspace management HTTP API + CLI 会话（ESM JS）
//
// 职责：
//   - http.createServer 监听单独端口（platformPort+100，或 CCP_MGMT_PORT 覆盖）
//   - 路由 workspace CRUD + serve 管理网页
//   - CLI 会话路由（POST/DELETE/GET /api/workspaces/:id/claude-session）
//   - WebSocket /api/workspaces/:id/claude-session/ws 双向流 PTY → xterm.js
//   - 不污染 proxy/server.js（proxy 只管转发）
//
// 设计依据：docs/standalone-backend-plan.md 阶段 2/3
// 正交设计：plan/tmp/2026-08-03-stage2-workspace-manager.md, 2026-08-03-stage3-cli-session.md

import * as http from 'node:http';
import { createRequire } from 'node:module';
import { WorkspaceManager } from './workspaceManager.js';
import { ClaudeSessionManager } from './claudeSession.js';
import { resolveClaudeBinaryStandalone } from './claudeBinaryStandalone.js';
import { managementPort } from './ports.js';
import { buildWorkspacesHtml, buildTerminalHtml } from './web/workspaces-html.js';

// ws 是 CJS 模块
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

/**
 * 启动 management API server。
 * @returns {Promise<{ server, port, stop }>}
 */
export async function startManagementServer(opts = {}) {
    const manager = new WorkspaceManager({ homeDir: opts.homeDir, log: opts.log });
    const sessions = new ClaudeSessionManager({ log: opts.log });
    const port = opts.port || managementPort(process.platform);

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const pathname = url.pathname;
        const method = req.method;

        // CORS（管理网页可能从 proxy 端口或 file:// 访问，宽松允许本机）
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        try {
            // GET / → 管理网页
            if (method === 'GET' && pathname === '/') {
                const html = buildWorkspacesHtml({ apiBase: '', proxyPort: opts.proxyPort });
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            }

            // GET /api/workspaces
            if (method === 'GET' && pathname === '/api/workspaces') {
                const list = await manager.list();
                sendJson(res, 200, { workspaces: list });
                return;
            }

            // POST /api/workspaces
            if (method === 'POST' && pathname === '/api/workspaces') {
                const body = await readJsonBody(req);
                const { workspace, created } = await manager.create(body.name, body.dir);
                sendJson(res, 201, { workspace, created });
                return;
            }

            // ── CLI 会话路由（阶段 3）──────────────────────────────────
            // GET /workspace/:id/terminal → 终端页 HTML（xterm.js + WS）
            const mTermPage = pathname.match(/^\/workspace\/([^/]+)\/terminal$/);
            if (method === 'GET' && mTermPage) {
                const id = decodeURIComponent(mTermPage[1]);
                const ws = await manager.get(id);
                if (!ws) {
                    sendJson(res, 404, { error: `workspace 不存在: ${id}` });
                    return;
                }
                const html = buildTerminalHtml({ workspaceId: id, workspaceName: ws.name, apiBase: '' });
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            }

            // POST /api/workspaces/:id/claude-session → 启动会话
            const mStart = pathname.match(/^\/api\/workspaces\/([^/]+)\/claude-session$/);
            if (method === 'POST' && mStart) {
                const id = decodeURIComponent(mStart[1]);
                const ws = await manager.get(id);
                if (!ws) {
                    sendJson(res, 404, { error: `workspace 不存在: ${id}` });
                    return;
                }
                // 探测二进制（用户覆盖可从 config 读，阶段 3 首版用默认探测）
                const binaryPath = resolveClaudeBinaryStandalone({ log: opts.log });
                if (!binaryPath) {
                    sendJson(res, 400, { error: '未找到 Claude Code CLI 二进制。请安装 Claude Code，或在系统 PATH 中配置 claude。' });
                    return;
                }
                try {
                    const result = await sessions.start(id, { dir: ws.dir, binaryPath });
                    sendJson(res, 201, result);
                } catch (e) {
                    sendJson(res, 400, { error: e.message || String(e) });
                }
                return;
            }

            // GET /api/workspaces/:id/claude-session → 会话状态
            const mStatus = pathname.match(/^\/api\/workspaces\/([^/]+)\/claude-session$/);
            if (method === 'GET' && mStatus) {
                const id = decodeURIComponent(mStatus[1]);
                const s = sessions.status(id);
                sendJson(res, 200, { session: s });
                return;
            }

            // DELETE /api/workspaces/:id/claude-session → 停止会话
            const mStop = pathname.match(/^\/api\/workspaces\/([^/]+)\/claude-session$/);
            if (method === 'DELETE' && mStop) {
                const id = decodeURIComponent(mStop[1]);
                const stopped = await sessions.stop(id);
                sendJson(res, 200, { stopped });
                return;
            }
            // ── /CLI 会话路由 ──────────────────────────────────────────

            // GET /api/workspaces/:id
            const mGet = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
            if (method === 'GET' && mGet) {
                const id = decodeURIComponent(mGet[1]);
                const ws = await manager.get(id);
                if (!ws) {
                    sendJson(res, 404, { error: `workspace 不存在: ${id}` });
                    return;
                }
                const configs = await manager.getLocalConfigs(id);
                sendJson(res, 200, { workspace: ws, configs });
                return;
            }

            // DELETE /api/workspaces/:id
            const mDel = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
            if (method === 'DELETE' && mDel) {
                const id = decodeURIComponent(mDel[1]);
                // 先判断存在（不存在 → 404，区别于 400 校验错误）
                const ws = await manager.get(id);
                if (!ws) {
                    sendJson(res, 404, { error: `workspace 不存在: ${id}` });
                    return;
                }
                try {
                    await manager.remove(id);
                } catch (e) {
                    // 并发竞态：get 与 remove 之间被另一请求删了 → 404 而非 500
                    if (/workspace 不存在/.test(e.message || '')) {
                        sendJson(res, 404, { error: `workspace 不存在: ${id}` });
                        return;
                    }
                    throw e;
                }
                sendJson(res, 200, { ok: true });
                return;
            }

            // 未知路由
            sendJson(res, 404, { error: `未知路由: ${method} ${pathname}` });
        } catch (err) {
            const msg = err.message || String(err);
            // 业务校验错误（dir 不存在/已注册/缺 name/body 非法）→ 400
            const isValidation = /不能为空|目录不存在|已注册|不是有效 JSON|请求体过大|不是目录/.test(msg);
            sendJson(res, isValidation ? 400 : 500, { error: msg });
        }
    });

    // WebSocket 升级：/api/workspaces/:id/claude-session/ws
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const m = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/claude-session\/ws$/);
        if (!m) {
            socket.destroy();
            return;
        }
        const id = decodeURIComponent(m[1]);
        wss.handleUpgrade(req, socket, head, (ws) => {
            // 会话不存在 → 拒绝（要求先 POST 启动）。
            // 注意 TOCTOU：status 检查与 attachWs 之间会话可能被 stop。
            // 因此以 attachWs 返回值为准（false = 会话已删），关 ws 防孤儿。
            if (!sessions.status(id) || !sessions.attachWs(id, ws)) {
                try {
                    ws.send(JSON.stringify({ type: 'error', error: '会话不存在，请先 POST 启动' }));
                    ws.close(1008, 'session not found');
                } catch {}
                return;
            }
        });
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
            resolve({
                server,
                port,
                stop: async () => {
                    await sessions.stopAll();
                    wss.close();
                    return new Promise(r => server.close(() => r()));
                },
            });
        });
    });
}

/** 读 JSON body（限 1MB，防滥用）。 */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', (c) => {
            if (tooLarge) return; // 已超限，丢弃后续数据（不 destroy，保连接可写响应）
            size += c.length;
            if (size > 1024 * 1024) {
                tooLarge = true;
                reject(new Error('请求体过大（>1MB）'));
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (tooLarge) return; // 已 reject，不再 resolve
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error('请求体不是有效 JSON'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}
