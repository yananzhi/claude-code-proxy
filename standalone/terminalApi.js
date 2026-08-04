// standalone/terminalApi.js — 终端 spawn env 构建 + 派生别名同步（ESM JS）
//
// 职责：
//   - buildTerminalEnv(cfg, parentCfg, proxyPort, deps) → { env, configDir }
//     按 config 类型（normal-direct / normal-proxy / derived）构建 spawn env：
//       normal：env 只注入 CLAUDE_CONFIG_DIR，LLM 配置走 settings.json（由 activateConfig 写）
//       derived：env 注入 BASE_URL/token + 四档别名 env，configDir 用 per-terminal 空目录
//   - syncDerivedAliases(cfg, proxyPort, deps) → 派生别名补齐到代理全局表（幂等）
//
// 复用 out/（与 configApi.js 同模式）：extractUpstream / buildAliasEnv / resolveDerivedUpstream /
//   computeAliasSyncActions；configApi.js 的 proxyForward + error 类。

import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);
let buildAliasEnv, resolveDerivedUpstream, computeAliasSyncActions;
let extractUpstream;
try {
    const derivedLogic = require(path.join(PROJECT_ROOT, 'out', 'derivedLogic.js'));
    ({ buildAliasEnv, resolveDerivedUpstream, computeAliasSyncActions } = derivedLogic);
    const upstreamMod = require(path.join(PROJECT_ROOT, 'out', 'upstream.js'));
    ({ extractUpstream } = upstreamMod);
} catch (e) {
    console.error('[terminalApi] 加载 out/ 模块失败，请先 npm run compile:', e.message);
    process.exit(1);
}

// 从 configApi.js 复用 proxyForward + error 类（避免重复实现 HTTP 转发 + 超时）
// 注：error 类与 configApi 导出的是同一引用，managementServer 的 instanceof 检查成立。
const configApi = require(path.join(PROJECT_ROOT, 'standalone', 'configApi.js'));
const { proxyForward, ValidationError, ProxyUnavailableError } = configApi;

/** workspace 下独立配置目录名（与 configApi/launcher 一致）。 */
const WORKSPACE_CONFIG_DIR = '.claude_proxy';

/**
 * 构建终端 spawn env + configDir。
 *
 * - normal（direct/proxy）：env 只注入 CLAUDE_CONFIG_DIR（指向 {ws.dir}/.claude_proxy，复用 active 写的 settings.json）。
 *   LLM 配置（BASE_URL/TOKEN/MODEL）走 settings.json，env 不覆盖——normal 本就靠 settings.json。
 *   ⚠ 调用方需先 activateConfig 写好 settings.json，否则 CLI 无配置可用。
 * - derived：env 注入 BASE_URL=proxy + TOKEN + 四档别名 env，configDir 用 per-terminal 空目录
 *   （{ws.dir}/.claude_proxy/sessions/{terminalId}/，防 settings.json 覆盖别名 env）。启动前同步别名表。
 *
 * @param {object} cfg LLMConfig（normal 或 derived）
 * @param {object|null} parentCfg 父 LLMConfig（derived 必传，normal 忽略）
 * @param {number} proxyPort 代理端口
 * @param {object} opts
 *   @param {string} opts.workspaceDir workspace 磁盘目录（算 configDir 用）
 *   @param {string} opts.terminalId 终端 id（derived 用，算 per-terminal configDir）
 *   @param {Function} [opts.proxyForwardFn] 注入的 proxyForward（测试 mock），默认用 configApi 的
 *   @param {Function} [opts.log]
 * @returns {Promise<{ env: object, configDir: string }>}
 *   env = spawn env 覆盖层（含 CLAUDE_CONFIG_DIR + 配置特定 key）
 *   configDir = 该终端的 CLAUDE_CONFIG_DIR 路径
 * @throws {ValidationError} direct 缺 BASE_URL/TOKEN、derived 无法解上游
 * @throws {ProxyUnavailableError} proxy/derived 模式代理不可达/拒绝 upstream/别名同步失败
 */
export async function buildTerminalEnv(cfg, parentCfg, proxyPort, opts = {}) {
    const workspaceDir = opts.workspaceDir;
    const terminalId = opts.terminalId;
    const fwd = opts.proxyForwardFn || proxyForward;
    const log = opts.log || (() => {});

    const isDerived = cfg && cfg.derivedFrom !== undefined;

    // ── normal：靠 settings.json，env 只注入 CLAUDE_CONFIG_DIR ──
    if (!isDerived) {
        const configDir = path.join(workspaceDir, WORKSPACE_CONFIG_DIR);
        const parsed = extractUpstream(cfg.content);
        if (!parsed) throw new ValidationError('config content 不是有效 JSON，无法解析 env');
        const baseUrl = parsed.env.ANTHROPIC_BASE_URL;
        const token = parsed.env.ANTHROPIC_AUTH_TOKEN;
        if (!baseUrl || !token) {
            throw new ValidationError('config 缺少 env.ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN');
        }
        // proxy 模式：开终端前确保代理 upstream 已注入（settings.json 由 activateConfig 写过则代理已设；
        // 但允许不 activate 直接开终端，故这里兜底注入。direct 不碰代理）
        if (cfg.mode === 'proxy') {
            const timeoutRaw = parsed.env.API_TIMEOUT_MS;
            const tNum = Number(timeoutRaw);
            const timeoutSec = Number.isFinite(tNum) && tNum > 0 ? Math.round(tNum / 1000) : undefined;
            log(`[terminal] normal-proxy 配置 '${cfg.name}' 注入代理上游: ${baseUrl}（代理全局共享，并发不同上游会串味）`);
            const upBody = { upstream: { baseUrl, token } };
            if (parsed.env.ANTHROPIC_MODEL) upBody.upstream.model = parsed.env.ANTHROPIC_MODEL;
            if (parsed.env.ANTHROPIC_SMALL_FAST_MODEL) upBody.upstream.smallFastModel = parsed.env.ANTHROPIC_SMALL_FAST_MODEL;
            if (timeoutSec != null) upBody.upstream.timeoutSec = timeoutSec;
            const r = await fwd(proxyPort, '/api/upstream', 'POST', upBody);
            if (r.status < 200 || r.status >= 300) {
                const detail = (r.body && r.body.error) ? r.body.error : `proxy 返回 ${r.status}`;
                throw new ProxyUnavailableError(`代理拒绝 upstream: ${detail}`);
            }
        }
        // normal 终端 env 不注入 LLM 配置（让 settings.json 生效），只注入 CLAUDE_CONFIG_DIR
        return { env: {}, configDir };
    }

    // ── derived：env 注入 BASE_URL/token/别名，configDir 用 per-terminal 空目录 ──
    const upstream = resolveDerivedUpstream(cfg, parentCfg);
    if (!upstream) {
        throw new ValidationError(
            `派生配置 '${cfg.name}' 无法解析上游：父配置已删且无快照，或父 content 无效。` +
            `请在配置页重建派生节点，或确保父配置有效。`,
        );
    }

    // 注入 upstream 到代理（全局共享 last-write-wins，记警告）
    log(`[terminal] 派生配置 '${cfg.name}' 注入代理上游: ${upstream.baseUrl}（代理全局共享，并发不同上游会串味）`);
    const upBody = { upstream: { baseUrl: upstream.baseUrl, token: upstream.token } };
    if (upstream.timeoutSec != null) upBody.upstream.timeoutSec = upstream.timeoutSec;
    const r = await fwd(proxyPort, '/api/upstream', 'POST', upBody);
    if (r.status < 200 || r.status >= 300) {
        const detail = (r.body && r.body.error) ? r.body.error : `proxy 返回 ${r.status}`;
        throw new ProxyUnavailableError(`代理拒绝 upstream: ${detail}`);
    }

    // 同步别名表（缺则补，幂等）
    await syncDerivedAliases(cfg, proxyPort, { proxyForwardFn: fwd, log });

    // per-terminal 空 configDir（防 settings.json 覆盖别名 env）
    const configDir = path.join(workspaceDir, WORKSPACE_CONFIG_DIR, 'sessions', terminalId);

    // env 注入 BASE_URL=proxy + token + 四档别名
    const aliasEnv = buildAliasEnv(cfg.derivedIndex, { sessionContext1m: cfg.sessionContext1m });
    const env = {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
        ANTHROPIC_AUTH_TOKEN: upstream.token,
        ...aliasEnv,
    };
    if (upstream.timeoutSec != null) {
        env.API_TIMEOUT_MS = String(upstream.timeoutSec * 1000);
    }
    return { env, configDir };
}

/**
 * 同步派生配置别名到代理全局表（启动前调用，幂等）。
 * 1. GET /api/config 取代理现表 modelAliases
 * 2. computeAliasSyncActions 算 diff
 * 3. 对每条 toSet POST /api/model-alias
 *
 * @param {object} cfg derived LLMConfig
 * @param {number} proxyPort
 * @param {object} opts { proxyForwardFn, log }
 * @throws {ProxyUnavailableError} 代理不可达/同步失败
 */
export async function syncDerivedAliases(cfg, proxyPort, opts = {}) {
    const fwd = opts.proxyForwardFn || proxyForward;
    const log = opts.log || (() => {});

    const r = await fwd(proxyPort, '/api/config', 'GET');
    if (r.status < 200 || r.status >= 300) {
        const detail = (r.body && r.body.error) ? r.body.error : `proxy 返回 ${r.status}`;
        throw new ProxyUnavailableError(`代理 GET /api/config 失败: ${detail}`);
    }
    const proxyAliases = (r.body && r.body.modelAliases) ? r.body.modelAliases : {};
    const { toSet } = computeAliasSyncActions(cfg, proxyAliases);
    for (const { alias, model } of toSet) {
        const rr = await fwd(proxyPort, '/api/model-alias', 'POST', { alias, model });
        if (rr.status < 200 || rr.status >= 300) {
            const detail = (rr.body && rr.body.error) ? rr.body.error : `proxy 返回 ${rr.status}`;
            throw new ProxyUnavailableError(`代理拒绝别名同步 ${alias}=${model}: ${detail}`);
        }
    }
    if (toSet.length > 0) {
        log(`[terminal] 派生配置 '${cfg.name}' 已补 ${toSet.length} 条别名映射到代理表`);
    }
}
