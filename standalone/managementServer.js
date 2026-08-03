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
import {
    createLocalConfig, updateLocalConfig, deleteLocalConfig, getModelCatalog,
    proxyForward, activateConfig, getActiveConfig,
    ValidationError, NotFoundError, ProxyUnavailableError,
} from './configApi.js';
import { managementPort } from './ports.js';
import { buildWorkspacesHtml, buildTerminalHtml, buildConfigEditorHtml } from './web/workspaces-html.js';

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
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

            // ── 配置编辑路由（阶段 4）─────────────────────────────────
            // GET /api/workspaces/:id/configs → 列 local configs
            const mCfgList = pathname.match(/^\/api\/workspaces\/([^/]+)\/configs$/);
            if (method === 'GET' && mCfgList) {
                const id = decodeURIComponent(mCfgList[1]);
                const ws = await manager.get(id);
                if (!ws) { sendJson(res, 404, { error: `workspace 不存在: ${id}` }); return; }
                const configs = await manager.getLocalConfigs(id);
                sendJson(res, 200, { configs });
                return;
            }
            // POST /api/workspaces/:id/configs → 新建（普通或 derived）
            if (method === 'POST' && mCfgList) {
                const id = decodeURIComponent(mCfgList[1]);
                const body = await readJsonBody(req);
                const { config, created } = await createLocalConfig(manager, id, body);
                sendJson(res, 201, { config, created });
                return;
            }

            // GET /api/workspaces/:id/configs/:cfgId → 单个 config
            const mCfgOne = pathname.match(/^\/api\/workspaces\/([^/]+)\/configs\/([^/]+)$/);
            if (method === 'GET' && mCfgOne) {
                const id = decodeURIComponent(mCfgOne[1]);
                const cfgId = decodeURIComponent(mCfgOne[2]);
                const configs = await manager.getLocalConfigs(id);
                const cfg = configs.find(c => c.id === cfgId);
                if (!cfg) { sendJson(res, 404, { error: `config 不存在: ${cfgId}` }); return; }
                sendJson(res, 200, { config: cfg });
                return;
            }
            // PUT /api/workspaces/:id/configs/:cfgId → 更新
            if (method === 'PUT' && mCfgOne) {
                const id = decodeURIComponent(mCfgOne[1]);
                const cfgId = decodeURIComponent(mCfgOne[2]);
                const body = await readJsonBody(req);
                const { config } = await updateLocalConfig(manager, id, cfgId, body);
                sendJson(res, 200, { config });
                return;
            }
            // DELETE /api/workspaces/:id/configs/:cfgId → 删除
            if (method === 'DELETE' && mCfgOne) {
                const id = decodeURIComponent(mCfgOne[1]);
                const cfgId = decodeURIComponent(mCfgOne[2]);
                await deleteLocalConfig(manager, id, cfgId);
                sendJson(res, 200, { ok: true });
                return;
            }

            // POST /api/workspaces/:id/configs/:cfgId/alias → 转发 proxy 设置别名（即时生效）
            const mAlias = pathname.match(/^\/api\/workspaces\/([^/]+)\/configs\/([^/]+)\/alias$/);
            if (method === 'POST' && mAlias) {
                const id = decodeURIComponent(mAlias[1]);
                const cfgId = decodeURIComponent(mAlias[2]);
                const err = await checkDerivedForAlias(manager, id, cfgId);
                if (err) { sendJson(res, err.status, { error: err.error }); return; }
                const body = await readJsonBody(req);
                const r = await proxyForward(opts.proxyPort, '/api/model-alias', 'POST', body);
                res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(r.body));
                return;
            }
            // POST /api/workspaces/:id/configs/:cfgId/alias/delete → 转发 proxy 删别名
            const mAliasDel = pathname.match(/^\/api\/workspaces\/([^/]+)\/configs\/([^/]+)\/alias\/delete$/);
            if (method === 'POST' && mAliasDel) {
                const id = decodeURIComponent(mAliasDel[1]);
                const cfgId = decodeURIComponent(mAliasDel[2]);
                const err = await checkDerivedForAlias(manager, id, cfgId);
                if (err) { sendJson(res, err.status, { error: err.error }); return; }
                const body = await readJsonBody(req);
                const r = await proxyForward(opts.proxyPort, '/api/model-alias/delete', 'POST', body);
                res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(r.body));
                return;
            }

            // GET /api/workspaces/:id/model-catalog → 聚合模型清单
            const mCatalog = pathname.match(/^\/api\/workspaces\/([^/]+)\/model-catalog$/);
            if (method === 'GET' && mCatalog) {
                const id = decodeURIComponent(mCatalog[1]);
                const catalog = await getModelCatalog(manager, id);
                sendJson(res, 200, { catalog });
                return;
            }
            // GET /api/workspaces/:id/next-alias-id → 转发 proxy 取下一个派生编号
            const mNextId = pathname.match(/^\/api\/workspaces\/([^/]+)\/next-alias-id$/);
            if (method === 'GET' && mNextId) {
                const r = await proxyForward(opts.proxyPort, '/api/model-alias/next-id', 'GET');
                res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(r.body));
                return;
            }

            // POST /api/workspaces/:id/configs/:cfgId/activate → 激活 config（阶段 6）
            const mActivate = pathname.match(/^\/api\/workspaces\/([^/]+)\/configs\/([^/]+)\/activate$/);
            if (method === 'POST' && mActivate) {
                const id = decodeURIComponent(mActivate[1]);
                const cfgId = decodeURIComponent(mActivate[2]);
                const result = await activateConfig(manager, opts.proxyPort, id, cfgId, { log: opts.log });
                sendJson(res, 200, result);
                return;
            }

            // GET /api/workspaces/:id/active → 读当前激活的 config
            const mActive = pathname.match(/^\/api\/workspaces\/([^/]+)\/active$/);
            if (method === 'GET' && mActive) {
                const id = decodeURIComponent(mActive[1]);
                const ws = await manager.get(id);
                if (!ws) { sendJson(res, 404, { error: `workspace 不存在: ${id}` }); return; }
                const active = await getActiveConfig(manager, id);
                sendJson(res, 200, { active });
                return;
            }

            // GET /workspace/:id/configs/new/edit → 新建配置编辑网页（必须在 :cfgId/edit 之前，避免 new 被当 cfgId）
            const mNewPage = pathname.match(/^\/workspace\/([^/]+)\/configs\/new\/edit$/);
            if (method === 'GET' && mNewPage) {
                const id = decodeURIComponent(mNewPage[1]);
                const ws = await manager.get(id);
                if (!ws) { sendJson(res, 404, { error: `workspace 不存在: ${id}` }); return; }
                const catalog = await getModelCatalog(manager, id);
                const html = buildConfigEditorHtml({
                    workspaceId: id, workspaceName: ws.name, config: null, catalog, apiBase: '',
                });
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            }
            // GET /workspace/:id/configs/:cfgId/edit → 配置编辑网页
            const mEditPage = pathname.match(/^\/workspace\/([^/]+)\/configs\/([^/]+)\/edit$/);
            if (method === 'GET' && mEditPage) {
                const id = decodeURIComponent(mEditPage[1]);
                const cfgId = decodeURIComponent(mEditPage[2]);
                const ws = await manager.get(id);
                if (!ws) { sendJson(res, 404, { error: `workspace 不存在: ${id}` }); return; }
                const configs = await manager.getLocalConfigs(id);
                const cfg = configs.find(c => c.id === cfgId);
                if (!cfg) { sendJson(res, 404, { error: `config 不存在: ${cfgId}` }); return; }
                const catalog = await getModelCatalog(manager, id);
                const html = buildConfigEditorHtml({
                    workspaceId: id, workspaceName: ws.name, config: cfg, catalog, apiBase: '',
                });
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            }
            // ── /配置编辑路由 ─────────────────────────────────────────

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
            // 类型化错误（configApi 抛出）→ 对应状态码
            if (err instanceof NotFoundError) {
                sendJson(res, 404, { error: msg });
            } else if (err instanceof ProxyUnavailableError) {
                sendJson(res, 502, { error: msg });
            } else if (err instanceof ValidationError
                || /不能为空|目录不存在|已注册|不是有效 JSON|请求体过大|不是目录/.test(msg)) {
                sendJson(res, 400, { error: msg });
            } else {
                sendJson(res, 500, { error: msg });
            }
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

/** 校验 cfgId 对应的 config 是否 derived（仅 derived 可设/删别名）。返回 null=通过，{status,error}=拒绝。 */
async function checkDerivedForAlias(manager, workspaceId, cfgId) {
    const ws = await manager.get(workspaceId);
    if (!ws) return { status: 404, error: `workspace 不存在: ${workspaceId}` };
    const configs = await manager.getLocalConfigs(workspaceId);
    const cfg = configs.find(c => c.id === cfgId);
    if (!cfg) return { status: 404, error: `config 不存在: ${cfgId}` };
    if (cfg.derivedFrom === undefined) {
        return { status: 400, error: '仅派生节点可设置别名（普通配置无别名映射）' };
    }
    return null;
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
