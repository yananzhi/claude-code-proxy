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
let readSettings, writeSettings;
try {
    ({ LocalConfigStore, LocalActiveStateStore, newId } = require(path.join(PROJECT_ROOT, 'out', 'localConfigStore.js')));
    // newId 实际从 configStore 导出，localConfigStore re-export 了
    const claudeConfig = require(path.join(PROJECT_ROOT, 'out', 'claudeConfig.js'));
    ({ readSettings, writeSettings } = claudeConfig);
} catch (e) {
    console.error('[configApi] 加载 out/ 模块失败，请先 npm run compile:', e.message);
    process.exit(1);
}

/** workspace 下独立配置目录名。 */
const WORKSPACE_CONFIG_DIR = '.claude_proxy';

/**
 * settings.json 的 env 里会覆盖终端注入的冲突路由 key。
 * ⚠ 必须与 terminalApi.js 的 CONFLICT_KEYS（检测清单）保持同步——剥离与检测用同一份清单。
 * terminalApi 通过 createRequire 反向 require 本模块，故不能 ESM import 它（会成环致 require 报错），
 * 改为本地副本 + 同步注释。改动任一处必须同步另一处。
 */
const CONFLICT_KEYS = [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
];

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
 * 标记某 config 为 workspace 的默认配置（standalone 用，弱化版"激活"）。
 *
 * 终端统一走 env 后（目标1），起终端不再依赖 settings.json，激活从"写 settings +
 * 注入 upstream + permissions/gitignore"降级为"只写默认配置标记"——仅影响
 * 「+ 新建终端」下拉的默认高亮项。无文件副作用。
 *
 * 旧的 activateConfig（写 .claude_proxy/settings.json 的 env + 注入 upstream）已删除——
 * 插件 claudeLauncher 与 standalone 终端统一纯 shell env 注入，不再写 settings.json 路由 key
 * （CLAUDE.md「workspace-local 终端路由 key 一律走 shell env」），该函数是唯一残留的
 * settings.json env 写入点，属死代码。
 *
 * 与旧 activateConfig 的区别：
 * - 不写 settings.json、不注入代理 upstream、不碰 permissions/gitignore
 * - 不校验 content 有效（标记只是指针，config 可后编辑；启动时 buildTerminalEnv 才校验）
 * - 派生配置也可标记（旧约束"派生不能 active"针对的是"派生不写 settings"，现已都不写）
 *
 * @returns {Promise<{ marked: true, cfgId, mode }>}
 * @throws {NotFoundError} workspace/config 不存在
 */
export async function markDefaultConfig(manager, workspaceId, cfgId) {
    const ws = await manager.get(workspaceId);
    if (!ws) throw new NotFoundError(`workspace 不存在: ${workspaceId}`);
    const store = new LocalConfigStore(ws.dir);
    const cfg = await store.get(cfgId);
    if (!cfg) throw new NotFoundError(`config 不存在: ${cfgId}`);
    const mode = cfg.mode === 'proxy' ? 'proxy' : 'direct';
    const activeStore = new LocalActiveStateStore(ws.dir);
    await activeStore.write(cfgId, mode);
    return { marked: true, cfgId, mode };
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

/**
 * 从 workspace 的 .claude_proxy/settings.json 剥离会与终端 env 注入冲突的 key。
 *
 * 终端统一走 env 注入后，settings.json 的 env 里若残留路由 key（多为旧版插件 activateConfig 遗留
 * 或用户手动改过），会覆盖进程 env 致路由错乱——buildTerminalEnv 的冲突检测会拒绝起终端。
 * 本函数供前端「确认框 + 一键删除」调用：检测到冲突时弹框，用户确认后调本接口剥离冲突 key 再重试起终端。
 *
 * 剥离范围：
 * - CONFLICT_KEYS（5 个路由 key，与 terminalApi 检测清单同源）：ANTHROPIC_BASE_URL / ANTHROPIC_MODEL /
 *   ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL。
 * - ANTHROPIC_AUTH_TOKEN：token 残留不被 CONFLICT_KEYS 检测拦（检测只看 modelname/路由 key），但会留在
 *   文件里被 CLI 当 env 用、可能串味，一并清掉。
 *
 * 只删 env 下命中的 key，保留 env 里其余 key（如 CLAUDE_CODE_AUTO_COMPACT_WINDOW）+ 文件其余字段（theme 等）。
 * 若删完 env 变空对象，删掉 env 字段本身（避免留空 env:{}）。幂等：无命中 key 返回 removed:[] 不报错。
 *
 * @param manager WorkspaceManager
 * @param workspaceId
 * @returns {Promise<{ removed: string[], settingsPath: string }>}
 * @throws {NotFoundError} workspace 不存在
 * @throws {ValidationError} settings.json 不存在 / 无法解析
 */
export async function stripConflictKeysFromSettings(manager, workspaceId) {
    const ws = await manager.get(workspaceId);
    if (!ws) throw new NotFoundError(`workspace 不存在: ${workspaceId}`);
    const settingsPath = path.join(ws.dir, WORKSPACE_CONFIG_DIR, 'settings.json');
    const raw = await readSettings(settingsPath); // async：返回 string 或 null（ENOENT）
    if (raw === null) throw new ValidationError('settings.json 不存在，无需剥离');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new ValidationError(`settings.json 无法解析：${e.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ValidationError('settings.json 不是有效 JSON 对象');
    }
    // 剥离范围：CONFLICT_KEYS + ANTHROPIC_AUTH_TOKEN（token 残留一并清）
    const STRIP_KEYS = [...CONFLICT_KEYS, 'ANTHROPIC_AUTH_TOKEN'];
    const removed = [];
    if (parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)) {
        for (const k of STRIP_KEYS) {
            if (parsed.env[k] !== undefined && parsed.env[k] !== '') {
                delete parsed.env[k];
                removed.push(k);
            }
        }
        // env 删空了 → 删掉 env 字段本身，避免留空 env:{}
        if (Object.keys(parsed.env).length === 0) delete parsed.env;
    }
    if (removed.length > 0) {
        await writeSettings(settingsPath, JSON.stringify(parsed, null, 2));
    }
    return { removed, settingsPath };
}

/** 业务校验错误（→ 400）。可选 code 携带结构化信号（如 'CONFLICT_KEYS'），前端据此判定是否可一键修复重试。 */
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
