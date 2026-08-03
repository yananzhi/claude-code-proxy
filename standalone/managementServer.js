// standalone/managementServer.js — workspace management HTTP API（ESM JS）
//
// 职责（阶段 2）：
//   - http.createServer 监听单独端口（platformPort+100，或 CCP_MGMT_PORT 覆盖）
//   - 路由 workspace CRUD + serve 管理网页
//   - 不污染 proxy/server.js（proxy 只管转发）
//
// 设计依据：docs/standalone-backend-plan.md 阶段 2
// 正交设计：plan/tmp/2026-08-03-stage2-workspace-manager.md
//
// 路由：
//   GET    /api/workspaces        → 列出
//   POST   /api/workspaces        → 创建 {name, dir}
//   GET    /api/workspaces/:id    → 单个（含 local configs）
//   DELETE /api/workspaces/:id    → 删除
//   GET    /                      → 管理网页 HTML

import * as http from 'node:http';
import { WorkspaceManager } from './workspaceManager.js';
import { managementPort } from './ports.js';
import { buildWorkspacesHtml } from './web/workspaces-html.js';

/**
 * 启动 management API server。
 * @returns {Promise<{ server, port, stop }>}
 */
export async function startManagementServer(opts = {}) {
    const manager = new WorkspaceManager({ homeDir: opts.homeDir, log: opts.log });
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

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
            resolve({
                server,
                port,
                stop: () => new Promise(r => server.close(() => r())),
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
