// standalone/configApi.js — local config CRUD + derived 创建 + proxy 转发（ESM JS）
//
// 阶段 4：配置编辑页迁移的后端逻辑。
// - local config CRUD 复用 LocalConfigStore（从 out/ 加载）
// - derived 创建复用 derivedLogic 纯函数（snapshot/inherit/catalog）
// - 别名即时生效转发到 proxy /api/model-alias（management → proxy HTTP）

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);
let LocalConfigStore, LocalActiveStateStore, newId;
let aggregateModelCatalog, inheritAliasesFromParent, inheritSessionContext1m, normalizeSessionContext1m;
let extractUpstream, synthesizeProxySettings;
let writeSettings;
try {
    ({ LocalConfigStore, LocalActiveStateStore, newId } = require(path.join(PROJECT_ROOT, 'out', 'localConfigStore.js')));
    // newId 实际从 configStore 导出，localConfigStore re-export 了
    // derivedLogic 纯函数
    const derivedLogic = require(path.join(PROJECT_ROOT, 'out', 'derivedLogic.js'));
    ({ aggregateModelCatalog, inheritAliasesFromParent, inheritSessionContext1m, normalizeSessionContext1m } = derivedLogic);
    const upstreamMod = require(path.join(PROJECT_ROOT, 'out', 'upstream.js'));
    ({ extractUpstream, synthesizeProxySettings } = upstreamMod);
    const claudeConfig = require(path.join(PROJECT_ROOT, 'out', 'claudeConfig.js'));
    ({ writeSettings } = claudeConfig);
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

/** 从父配置提取上游快照（防父删/改断链）。父 content 无效或缺 baseUrl/token → undefined。 */
function snapshotFromParent(parentContent, parentMode) {
    const parsed = extractUpstream(parentContent);
    if (!parsed) return undefined;
    const baseUrl = parsed.env.ANTHROPIC_BASE_URL;
    const token = parsed.env.ANTHROPIC_AUTH_TOKEN;
    if (!baseUrl || !token) return undefined;
    const tNum = Number(parsed.env.API_TIMEOUT_MS);
    const timeoutSec = Number.isFinite(tNum) && tNum > 0 ? Math.round(tNum / 1000) : undefined;
    return { baseUrl, token, timeoutSec, mode: parentMode === 'proxy' ? 'proxy' : 'direct' };
}

/**
 * 新建 local config（普通或 derived）。
 * @param manager WorkspaceManager
 * @param workspaceId
 * @param body {name, mode, content} 普通配置 / 或 derived 创建体 {name, derivedFrom, derivedIndex}
 * @returns {Promise<{config, created: boolean}>}
 */
export async function createLocalConfig(manager, workspaceId, body) {
    const ctx = await getStoreForWorkspace(manager, workspaceId);
    if (!ctx) throw new NotFoundError(`workspace 不存在: ${workspaceId}`);
    const { store } = ctx;

    const name = body?.name;
    if (!name || !String(name).trim()) throw new ValidationError('name 不能为空');

    // derived 创建
    if (body.derivedFrom !== undefined) {
        if (typeof body.derivedFrom !== 'string' || !body.derivedFrom.trim()) {
            throw new ValidationError('derivedFrom 必须是非空字符串（父配置 id）');
        }
        const parent = await store.get(body.derivedFrom);
        if (!parent) throw new ValidationError(`父配置不存在: ${body.derivedFrom}`);
        const derivedIndex = body.derivedIndex;
        if (typeof derivedIndex !== 'number' || !Number.isInteger(derivedIndex) || derivedIndex < 1) {
            throw new ValidationError('derivedIndex 必须是 >=1 的整数');
        }
        const snapshot = snapshotFromParent(parent.content, parent.mode);
        const inheritedAliases = inheritAliasesFromParent(parent.content);
        const inherited1m = inheritSessionContext1m(parent.content);
        const cfg = {
            id: newId(),
            name: String(name).trim(),
            content: parent.content, // derived content 只读继承父
            mode: 'proxy', // derived 强制 proxy（V7）
            updatedAt: new Date().toISOString(),
            derivedFrom: parent.id,
            derivedIndex,
            modelAliases: inheritedAliases,
            sessionContext1m: inherited1m,
            derivedSnapshot: snapshot,
        };
        await store.upsert(cfg);
        return { config: cfg, created: true };
    }

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

/** 更新 local config（保留 derived 字段）。 */
export async function updateLocalConfig(manager, workspaceId, cfgId, body) {
    const ctx = await getStoreForWorkspace(manager, workspaceId);
    if (!ctx) throw new NotFoundError(`workspace 不存在: ${workspaceId}`);
    const { store } = ctx;
    const existing = await store.get(cfgId);
    if (!existing) throw new NotFoundError(`config 不存在: ${cfgId}`);

    const name = body?.name;
    if (!name || !String(name).trim()) throw new ValidationError('name 不能为空');

    const isDerived = existing.derivedFrom !== undefined;
    // derived: content 只读不改；普通: content 可改 + 校验 JSON
    let content = existing.content;
    let mode = existing.mode;
    if (!isDerived) {
        const newContent = body?.content;
        if (newContent !== undefined) {
            if (!String(newContent).trim()) throw new ValidationError('content 不能为空');
            try { JSON.parse(newContent); } catch (e) { throw new ValidationError(`content 不是有效 JSON: ${e.message}`); }
            content = String(newContent);
        }
        if (body?.mode !== undefined) mode = body.mode === 'proxy' ? 'proxy' : 'direct';
    }

    // derived: sessionContext1m 可由前端 1m checkbox 改（per-tier 1m 开关，影响别名后缀）
    let sessionContext1m = existing.sessionContext1m;
    if (isDerived && body?.sessionContext1m !== undefined) {
        sessionContext1m = normalizeSessionContext1m(body.sessionContext1m)
            ?? { main: false, haiku: false, sonnet: false, opus: false };
    }

    const updated = {
        ...existing,
        name: String(name).trim(),
        content,
        mode,
        // modelAliases 由独立 alias 转发路由改（经 proxy），update 不碰
        sessionContext1m,
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

/** 聚合模型清单（local configs 的模型名 + 别名映射值）。 */
export async function getModelCatalog(manager, workspaceId) {
    const ctx = await getStoreForWorkspace(manager, workspaceId);
    if (!ctx) return []; // workspace 不存在 → 空清单
    const configs = await ctx.store.load();
    return aggregateModelCatalog(configs);
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

/**
 * 激活某 workspace 的某 local config：写 .claude_proxy/settings.json + （proxy 模式）注入 upstream + active 标记。
 *
 * - direct 模式：writeSettings 原样 content。
 * - proxy 模式：extractUpstream → 校验 baseUrl/token → proxyForward 注入 upstream → synthesizeProxySettings → writeSettings。
 * - 写 LocalActiveStateStore 标记 + ensureProjectPermissions + ensureGitignore。
 *
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
    constructor(msg) { super(msg); this.name = 'ValidationError'; }
}
/** 资源不存在（→ 404）。 */
export class NotFoundError extends Error {
    constructor(msg) { super(msg); this.name = 'NotFoundError'; }
}
/** proxy 不可达（→ 502）。 */
export class ProxyUnavailableError extends Error {
    constructor(msg) { super(msg); this.name = 'ProxyUnavailableError'; }
}
