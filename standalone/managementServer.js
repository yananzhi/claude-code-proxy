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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WorkspaceManager } from './workspaceManager.js';
import { ClaudeSessionManager } from './claudeSession.js';
import { resolveClaudeBinaryStandalone } from './claudeBinaryStandalone.js';
import {
    createLocalConfig, updateLocalConfig, deleteLocalConfig, getModelCatalog,
    proxyForward, activateConfig, getActiveConfig,
    ensureProjectPermissions, ensureGitignore,
    ValidationError, NotFoundError, ProxyUnavailableError,
} from './configApi.js';
import { buildTerminalEnv } from './terminalApi.js';
import { managementPort } from './ports.js';
import { buildWorkspacesHtml, buildTerminalHtml, buildConfigEditorHtml } from './web/workspaces-html.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ws 是 CJS 模块
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

/**
 * 启动 management API server。
 * @returns {Promise<{ server, port, stop }>}
 */
export async function startManagementServer(opts = {}) {
    const manager = new WorkspaceManager({ homeDir: opts.homeDir, log: opts.log });
    const sessions = new ClaudeSessionManager({ log: opts.log, pty: opts.sessionPty });
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

            // GET /vendor/* → 静态资源（xterm.js 等，本地 vendored 不依赖 CDN）
            if (method === 'GET' && pathname.startsWith('/vendor/')) {
                const rel = pathname.slice('/vendor/'.length);
                if (rel.includes('..')) { sendJson(res, 400, { error: '非法路径' }); return; }
                const full = path.join(__dirname, 'web', 'vendor', rel);
                const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.map': 'application/json' };
                try {
                    const data = fs.readFileSync(full);
                    const ext = path.extname(full);
                    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
                    res.end(data);
                    return;
                } catch {
                    sendJson(res, 404, { error: `资源不存在: ${rel}` });
                    return;
                }
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

            // ── 终端路由（per-config / active 驱动，keyed by terminalId）──────────
            // GET /terminal/:tid → 终端页 HTML（xterm.js + WS）。终端已存在时打开此页重入。
            const mTermPage = pathname.match(/^\/terminal\/([^/]+)$/);
            if (method === 'GET' && mTermPage) {
                const tid = decodeURIComponent(mTermPage[1]);
                const html = buildTerminalHtml({ terminalId: tid, apiBase: '' });
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(html);
                return;
            }

            // POST /api/workspaces/:id/terminals → 基于当前 active normal config 开终端
            const mWsTerm = pathname.match(/^\/api\/workspaces\/([^/]+)\/terminals$/);
            if (method === 'POST' && mWsTerm) {
                const id = decodeURIComponent(mWsTerm[1]);
                const ws = await manager.get(id);
                if (!ws) { sendJson(res, 404, { error: `workspace 不存在: ${id}` }); return; }
                // 取 active normal config
                const active = await getActiveConfig(manager, id);
                if (!active) {
                    sendJson(res, 400, { error: '当前 workspace 无 active 配置，请先激活一个 local config 再开终端' });
                    return;
                }
                const configs = await manager.getLocalConfigs(id);
                const cfg = configs.find(c => c.id === active.id);
                if (!cfg) {
                    sendJson(res, 400, { error: `active 配置 ${active.id} 已不存在，请重新激活` });
                    return;
                }
                if (cfg.derivedFrom !== undefined) {
                    sendJson(res, 400, { error: '当前 active 配置是派生配置，请在该派生配置节点下开终端' });
                    return;
                }
                const binaryPath = resolveClaudeBinaryStandalone({ log: opts.log });
                if (!binaryPath) {
                    sendJson(res, 400, { error: '未找到 Claude Code CLI 二进制。请安装 Claude Code，或在系统 PATH 中配置 claude。' });
                    return;
                }
                const terminalId = sessions.newTerminalId();
                const { env, configDir } = await buildTerminalEnv(cfg, null, opts.proxyPort, {
                    workspaceDir: ws.dir, terminalId, log: opts.log,
                });
                await ensureProjectPermissions(ws.dir, opts.log);
                await ensureGitignore(ws.dir, opts.log);
                const result = await sessions.start(terminalId, {
                    cwd: ws.dir, binaryPath, env, configDir,
                    workspaceId: id, configId: cfg.id, startedConfigName: cfg.name, kind: 'normal',
                });
                sendJson(res, 201, { ...result, kind: 'normal', startedConfigName: cfg.name, configId: cfg.id, workspaceId: id });
                return;
            }

            // GET /api/workspaces/:id/terminals → 列 workspace 的 normal 活终端
            if (method === 'GET' && mWsTerm) {
                const id = decodeURIComponent(mWsTerm[1]);
                const terminals = sessions.listByWorkspace(id);
                sendJson(res, 200, { terminals });
                return;
            }

            // POST /api/workspaces/:id/configs/:cfgId/terminals → 开派生终端
            const mCfgTerm = pathname.match(/^\/api\/workspaces\/([^/]+)\/configs\/([^/]+)\/terminals$/);
            if (method === 'POST' && mCfgTerm) {
                const id = decodeURIComponent(mCfgTerm[1]);
                const cfgId = decodeURIComponent(mCfgTerm[2]);
                const ws = await manager.get(id);
                if (!ws) { sendJson(res, 404, { error: `workspace 不存在: ${id}` }); return; }
                const configs = await manager.getLocalConfigs(id);
                const cfg = configs.find(c => c.id === cfgId);
                if (!cfg) { sendJson(res, 404, { error: `config 不存在: ${cfgId}` }); return; }
                if (cfg.derivedFrom === undefined) {
                    sendJson(res, 400, { error: '普通配置请用 workspace 级「新建终端」入口（基于 active 配置启动）' });
                    return;
                }
                const parent = cfg.derivedFrom ? configs.find(c => c.id === cfg.derivedFrom) : null;
                const binaryPath = resolveClaudeBinaryStandalone({ log: opts.log });
                if (!binaryPath) {
                    sendJson(res, 400, { error: '未找到 Claude Code CLI 二进制。请安装 Claude Code，或在系统 PATH 中配置 claude。' });
                    return;
                }
                const terminalId = sessions.newTerminalId();
                const { env, configDir } = await buildTerminalEnv(cfg, parent, opts.proxyPort, {
                    workspaceDir: ws.dir, terminalId, log: opts.log,
                });
                await ensureProjectPermissions(ws.dir, opts.log);
                await ensureGitignore(ws.dir, opts.log);
                const result = await sessions.start(terminalId, {
                    cwd: ws.dir, binaryPath, env, configDir,
                    workspaceId: id, configId: cfg.id, startedConfigName: cfg.name, kind: 'derived',
                });
                sendJson(res, 201, { ...result, kind: 'derived', startedConfigName: cfg.name, configId: cfg.id, workspaceId: id });
                return;
            }

            // GET /api/workspaces/:id/configs/:cfgId/terminals → 列 config（派生）活终端
            if (method === 'GET' && mCfgTerm) {
                const cfgId = decodeURIComponent(mCfgTerm[2]);
                const terminals = sessions.listByConfig(cfgId);
                sendJson(res, 200, { terminals });
                return;
            }

            // DELETE /api/terminals/:tid → 停止终端
            const mTermStop = pathname.match(/^\/api\/terminals\/([^/]+)$/);
            if (method === 'DELETE' && mTermStop) {
                const tid = decodeURIComponent(mTermStop[1]);
                const stopped = await sessions.stop(tid);
                sendJson(res, 200, { stopped });
                return;
            }
            // ── /终端路由 ──────────────────────────────────────────

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
                // 警告：若 workspace 下已有存活 normal 终端，提示用户已开的 session 可能受影响（settings.json 已被覆盖），
                // 建议退出后通过 resume 再进入。
                const liveTerminals = sessions.listByWorkspace(id);
                if (liveTerminals.length > 0) {
                    result.warning = `workspace 下已有 ${liveTerminals.length} 个存活终端（基于之前的 active 配置启动）。` +
                        `本次激活已覆盖 settings.json，已开的 session 可能受影响，建议退出后通过 resume 再进入。`;
                }
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

    // WebSocket 升级：/api/terminals/:tid/ws（按 terminalId 重入/连接）
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const m = url.pathname.match(/^\/api\/terminals\/([^/]+)\/ws$/);
        if (!m) {
            socket.destroy();
            return;
        }
        const tid = decodeURIComponent(m[1]);
        wss.handleUpgrade(req, socket, head, (ws) => {
            // 终端不存在 → 拒绝（终端由 POST 创建，此处仅重入）。
            // 注意 TOCTOU：status 检查与 attachWs 之间终端可能被 stop。
            // 因此以 attachWs 返回值为准（false = 终端已删），关 ws 防孤儿。
            if (!sessions.status(tid) || !sessions.attachWs(tid, ws)) {
                try {
                    ws.send(JSON.stringify({ type: 'error', error: '终端不存在，请先在管理页新建终端' }));
                    ws.close(1008, 'terminal not found');
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
