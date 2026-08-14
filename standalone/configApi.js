// standalone/configApi.js — local config CRUD + proxy 转发（ESM JS）
//
// 阶段 4：配置编辑页迁移的后端逻辑。
// - local config CRUD 复用 LocalConfigStore（从 out/ 加载）
// - 派生配置（derived）功能已移除（2026-08），无别名创建/转发

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);
let LocalConfigStore, LocalActiveStateStore, newId;
let writeSettings;
let extractUpstream, synthesizeProxySettings;
try {
    ({ LocalConfigStore, LocalActiveStateStore, newId } = require(path.join(PROJECT_ROOT, 'out', 'localConfigStore.js')));
    // newId 实际从 configStore 导出，localConfigStore re-export 了
    const claudeConfig = require(path.join(PROJECT_ROOT, 'out', 'claudeConfig.js'));
    ({ writeSettings } = claudeConfig);
    const upstreamMod = require(path.join(PROJECT_ROOT, 'out', 'upstream.js'));
    ({ extractUpstream, synthesizeProxySettings } = upstreamMod);
} catch (e) {
    console.error('[configApi] 加载 out/ 模块失败，请先 npm run compile:', e.message);
    process.exit(1);
}

/** workspace 下独立配置目录名。 */
const WORKSPACE_CONFIG_DIR = '.claude_proxy';

/** 取某 workspace 的 LocalConfigStore。workspace 不存在返回 null。 */
async function getStoreForWorkspace(manager, workspaceId) {
    const ws = await manager.get(workspaceId);
    if (!ws) return null;
    return { store: new LocalConfigStore(ws.dir), workspace: ws };
}

/**
 * 新建 local config。
 * @param manager WorkspaceManager
 * @param workspaceId
 * @param body {name, mode, content}
 * @returns {Promise<{config, created: boolean}>}
 */
export async function createLocalConfig(manager, workspaceId, body) {
    const ctx = await getStoreForWorkspace(manager, workspaceId);
    if (!ctx) throw new NotFoundError(`workspace 不存在: ${workspaceId}`);
    const { store } = ctx;

    const name = body?.name;
    if (!name || !String(name).trim()) throw new ValidationError('name 不能为空');

    // 普通 config
    const content = body?.content;
    if (!content || !String(content).trim()) throw new ValidationError('content 不能为空');
    try {
        JSON.parse(content);
    } catch (e) {
        throw new ValidationError(`content 不是有效 JSON: ${e.message}`);
    }
    const cfg = {
        id: newId(),
        name: String(name).trim(),
        content: String(content),
        mode: body.mode === 'proxy' ? 'proxy' : 'direct',
        updatedAt: new Date().toISOString(),
    };
    await store.upsert(cfg);
    return { config: cfg, created: true };
}

/** 更新 local config。 */
export async function updateLocalConfig(manager, workspaceId, cfgId, body) {
    const ctx = await getStoreForWorkspace(manager, workspaceId);
    if (!ctx) throw new NotFoundError(`workspace 不存在: ${workspaceId}`);
    const { store } = ctx;
    const existing = await store.get(cfgId);
    if (!existing) throw new NotFoundError(`config 不存在: ${cfgId}`);

    const name = body?.name;
    if (!name || !String(name).trim()) throw new ValidationError('name 不能为空');

    const newContent = body?.content;
    if (newContent !== undefined) {
        if (!String(newContent).trim()) throw new ValidationError('content 不能为空');
        try { JSON.parse(newContent); } catch (e) { throw new ValidationError(`content 不是有效 JSON: ${e.message}`); }
    }

    const updated = {
        ...existing,
        name: String(name).trim(),
        content: newContent !== undefined ? String(newContent) : existing.content,
        mode: body?.mode !== undefined ? (body.mode === 'proxy' ? 'proxy' : 'direct') : existing.mode,
        updatedAt: new Date().toISOString(),
    };
    await store.upsert(updated);
    return { config: updated };
}

/** 删除 local config。 */
export async function deleteLocalConfig(manager, workspaceId, cfgId) {
    const ctx = await getStoreForWorkspace(manager, workspaceId);
    if (!ctx) throw new NotFoundError(`workspace 不存在: ${workspaceId}`);
    const { store } = ctx;
    const existing = await store.get(cfgId);
    if (!existing) throw new NotFoundError(`config 不存在: ${cfgId}`);
    await store.remove(cfgId);
    return { ok: true };
}

/**
 * 往项目级 `.claude/settings.local.json` 合并 `permissions.defaultMode = bypassPermissions`。
 * 复制自 claudeLauncher.ts（避免改 src/ VS Code 形态）。已设别的 defaultMode 则尊重不覆盖。
 */
export async function ensureProjectPermissions(workspaceRoot, log = () => {}) {
    const projectClaudeDir = path.join(workspaceRoot, '.claude');
    const localSettingsPath = path.join(projectClaudeDir, 'settings.local.json');
    let obj = {};
    try {
        const raw = await fs.promises.readFile(localSettingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            obj = parsed;
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            log(`[activate] ${localSettingsPath} 解析失败，跳过 permissions 写入: ${err.message}`);
            return;
        }
    }
    const perms = (obj.permissions && typeof obj.permissions === 'object' && !Array.isArray(obj.permissions))
        ? obj.permissions : {};
    if (perms.defaultMode === 'bypassPermissions') return;
    if (perms.defaultMode !== undefined) {
        log(`[activate] ${localSettingsPath} 已设 permissions.defaultMode=${perms.defaultMode}，保留用户选择`);
        return;
    }
    perms.defaultMode = 'bypassPermissions';
    obj.permissions = perms;
    await fs.promises.mkdir(projectClaudeDir, { recursive: true });
    await fs.promises.writeFile(localSettingsPath, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * 若 workspace 是 git 仓库且 .gitignore 未忽略 .claude_proxy/，则追加。
 * 复制自 claudeLauncher.ts。非 git 仓库不创建 .gitignore。
 */
export async function ensureGitignore(workspaceRoot, log = () => {}) {
    try {
        if (!fs.existsSync(path.join(workspaceRoot, '.git'))) return;
        const gitignorePath = path.join(workspaceRoot, '.gitignore');
        let existing = '';
        try {
            existing = await fs.promises.readFile(gitignorePath, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
        const normalize = (s) => s.trim().replace(/\/+$/, '').replace(/^\.\//, '');
        const target = normalize('.claude_proxy/');
        const present = existing.split(/\r?\n/).some(l => normalize(l) === target);
        if (present) return;
        const prefix = (existing.length > 0 && !existing.endsWith('\n')) ? '\n' : '';
        await fs.promises.writeFile(gitignorePath, `${existing}${prefix}.claude_proxy/\n`, 'utf8');
    } catch (err) {
        log(`[activate] 写 .gitignore 失败（忽略）: ${err.message}`);
    }
}

/** 读某 workspace 的 active 标记。无 → null。 */
export async function getActiveConfig(manager, workspaceId) {
    const ws = await manager.get(workspaceId);
    if (!ws) return null;
    const activeStore = new LocalActiveStateStore(ws.dir);
    const active = await activeStore.load();
    if (!active) return null;
    return active;
}

/**
 * 激活某 workspace 的某 local config：写 .claude_proxy/settings.json + （proxy 模式）注入 upstream + active 标记。
 *
 * - direct 模式：writeSettings 原样 content。
 * - proxy 模式：extractUpstream → 校验 baseUrl/token → proxyForward 注入 upstream → synthesizeProxySettings → writeSettings。
 * - 写 LocalActiveStateStore 标记 + ensureProjectPermissions + ensureGitignore。
 *
 * settings.json 是 CLI 会话路由的唯一事实源（终端走 CLAUDE_CONFIG_DIR，CLI 读 settings.json），
 * 故激活即写文件——不写 settings.json 的终端 env 注入方案已废除（回退 2026-08-14）。
 *
 * @param manager WorkspaceManager
 * @param proxyPort 代理端口（proxy 模式注入 upstream + 合成 BASE_URL 用）
 * @param workspaceId
 * @param cfgId
 * @param opts { log } 日志回调
 * @returns {Promise<{activated: true, mode, settingsPath, note}>}
 * @throws {NotFoundError} workspace/config 不存在
 * @throws {ValidationError} proxy 模式缺 baseUrl/token、content 非法
 * @throws {ProxyUnavailableError} upstream 注入失败
 */
export async function activateConfig(manager, proxyPort, workspaceId, cfgId, opts = {}) {
    const log = opts.log || (() => {});
    const ws = await manager.get(workspaceId);
    if (!ws) throw new NotFoundError(`workspace 不存在: ${workspaceId}`);
    const store = new LocalConfigStore(ws.dir);
    const cfg = await store.get(cfgId);
    if (!cfg) throw new NotFoundError(`config 不存在: ${cfgId}`);

    const configDir = path.join(ws.dir, WORKSPACE_CONFIG_DIR);
    const settingsPath = path.join(configDir, 'settings.json');
    const mode = cfg.mode === 'proxy' ? 'proxy' : 'direct';
    let note = '';

    if (mode === 'direct') {
        // direct：原样 content
        await writeSettings(settingsPath, cfg.content);
    } else {
        // proxy：注入 upstream + 合成 settings
        const parsed = extractUpstream(cfg.content);
        if (!parsed) throw new ValidationError('config content 不是有效 JSON，无法解析 upstream');
        const baseUrl = parsed.env.ANTHROPIC_BASE_URL;
        const token = parsed.env.ANTHROPIC_AUTH_TOKEN;
        if (!baseUrl || !token) {
            throw new ValidationError('proxy 模式 config 缺少 env.ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN');
        }
        // timeoutSec：API_TIMEOUT_MS 毫秒→秒，空/非数/非正→不传
        const timeoutRaw = parsed.env.API_TIMEOUT_MS;
        let timeoutSec;
        const tNum = Number(timeoutRaw);
        if (Number.isFinite(tNum) && tNum > 0) timeoutSec = Math.round(tNum / 1000);

        // upstream 全局共享单例（last-write-wins），并发激活不同上游会串味——记警告
        log(`[activate] 注入代理上游: baseUrl=${baseUrl}（代理进程全局共享，并发不同上游会串味）`);

        const upstream = { baseUrl, token };
        if (parsed.env.ANTHROPIC_MODEL) upstream.model = parsed.env.ANTHROPIC_MODEL;
        if (parsed.env.ANTHROPIC_SMALL_FAST_MODEL) upstream.smallFastModel = parsed.env.ANTHROPIC_SMALL_FAST_MODEL;
        if (timeoutSec != null) upstream.timeoutSec = timeoutSec;

        // 注入 upstream（proxy 不在→抛 ProxyUnavailableError → 502；
        // proxy 返回非 2xx（如 baseUrl 格式错误→400）→ 抛 ProxyUnavailableError → 502，不假成功）
        const r = await proxyForward(proxyPort, '/api/upstream', 'POST', { upstream });
        if (r.status < 200 || r.status >= 300) {
            const detail = (r.body && r.body.error) ? r.body.error : `proxy 返回 ${r.status}`;
            throw new ProxyUnavailableError(`代理拒绝 upstream: ${detail}`);
        }

        // 合成指向 localhost:proxyPort 的 settings
        const synthesized = synthesizeProxySettings(cfg.content, proxyPort);
        if (!synthesized) throw new ValidationError('config content 无法合成代理 settings');
        await writeSettings(settingsPath, synthesized);
        note = `upstream 已注入代理，CLI BASE_URL 指向 http://127.0.0.1:${proxyPort}`;
    }

    // active 标记
    const activeStore = new LocalActiveStateStore(ws.dir);
    await activeStore.write(cfgId, mode);

    // permissions + gitignore（与 VS Code launcher 对齐）
    await ensureProjectPermissions(ws.dir, log);
    await ensureGitignore(ws.dir, log);

    note = note || (mode === 'direct' ? '直连模式，CLI 直连上游' : '');
    return {
        activated: true,
        mode,
        settingsPath,
        note: note + '（新 spawn 或重启的 CLI 会话读 settings.json 生效）',
    };
}

/**
 * 转发请求到 proxy（别名即时生效 / upstream 注入）。
 * @param proxyPort proxy 端口
 * @param proxyPath 路径（如 /api/model-alias）
 * @param method HTTP method
 * @param body 请求体（对象，会 JSON.stringify）
 * @returns {Promise<{status, body}>} proxy 响应
 */
/** proxy 转发超时（ms）。与 proxyHost.rawHttp 的 3s 一致，防代理 TCP 连通但不响应时路由挂死。 */
const PROXY_FORWARD_TIMEOUT_MS = 3000;

export async function proxyForward(proxyPort, proxyPath, method, body) {
    const bodyStr = body !== undefined ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (bodyStr !== null) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: proxyPort,
            path: proxyPath,
            method,
            headers,
            timeout: PROXY_FORWARD_TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed;
                try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new ProxyUnavailableError(`proxy 超时（${PROXY_FORWARD_TIMEOUT_MS}ms 无响应）`)); });
        req.on('error', (e) => {
            // timeout 已 reject 过（destroy 触发的 error 被吞掉，不重复 reject）
            if (req.destroyed) return;
            reject(new ProxyUnavailableError(`proxy 不可达: ${e.message}`));
        });
        if (bodyStr !== null) req.write(bodyStr);
        req.end();
    });
}

/** 业务校验错误（→ 400）。 */
export class ValidationError extends Error {
    constructor(msg, code) { super(msg); this.name = 'ValidationError'; this.code = code; }
}
/** 资源不存在（→ 404）。 */
export class NotFoundError extends Error {
    constructor(msg) { super(msg); this.name = 'NotFoundError'; }
}
/** proxy 不可达（→ 502）。 */
export class ProxyUnavailableError extends Error {
    constructor(msg) { super(msg); this.name = 'ProxyUnavailableError'; }
}
