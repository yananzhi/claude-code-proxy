// standalone/terminalApi.js — 终端 spawn env 构建 + 派生别名同步（ESM JS）
//
// 职责：
//   - buildTerminalEnv(cfg, parentCfg, proxyPort, deps) → { env, configDir }
//     按 config 类型（normal-direct / normal-proxy / derived）构建 spawn env：
//       normal：env 注入 ANTHROPIC_BASE_URL/TOKEN/MODEL（终端走 env，不读 settings.json）
//       derived：env 注入 BASE_URL/token + 四档别名 env，configDir 共享 {ws}/.claude_proxy
//   - syncDerivedAliases(cfg, proxyPort, deps) → 派生别名补齐到代理全局表（幂等）
//
// 复用 out/（与 configApi.js 同模式）：extractUpstream / buildAliasEnv / resolveDerivedUpstream /
//   computeAliasSyncActions；configApi.js 的 proxyForward + error 类。

import * as path from 'node:path';
import * as fs from 'node:fs';
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
 * - normal（direct/proxy）：env 注入 ANTHROPIC_BASE_URL/TOKEN/MODEL（+ 可选 SMALL_FAST_MODEL/TIMEOUT），
 *   configDir 共享 {ws}/.claude_proxy（与 derived 一致，防 settings.json 覆盖 env）。
 *   不再依赖 settings.json——所有终端统一走 env。
 *   - direct：BASE_URL = 上游真实地址，不碰代理。
 *   - proxy：BASE_URL = http://127.0.0.1:proxyPort，起终端前注入 upstream 到代理。
 * - derived：env 注入 BASE_URL=proxy + TOKEN + 四档别名 env，configDir 共享 {ws}/.claude_proxy。
 *   启动前注入 upstream + 同步别名表。
 *
 * @param {object} cfg LLMConfig（normal 或 derived）
 * @param {object|null} parentCfg 父 LLMConfig（derived 必传，normal 忽略）
 * @param {number} proxyPort 代理端口
 * @param {object} opts
 *   @param {string} opts.workspaceDir workspace 磁盘目录（算 configDir 用）
 *   @param {string} opts.terminalId 终端 id（算 configDir）
 *   @param {Function} [opts.proxyForwardFn] 注入的 proxyForward（测试 mock），默认用 configApi 的
 *   @param {Function} [opts.log]
 * @returns {Promise<{ env: object, configDir: string }>}
 *   env = spawn env 覆盖层（含 ANTHROPIC_* 配置特定 key）
 *   configDir = 共享 CLAUDE_CONFIG_DIR 路径
 * @throws {ValidationError} direct/proxy 缺 BASE_URL/TOKEN、derived 无法解上游
 * @throws {ProxyUnavailableError} proxy/derived 模式代理不可达/拒绝 upstream/别名同步失败
 */
export async function buildTerminalEnv(cfg, parentCfg, proxyPort, opts = {}) {
    const workspaceDir = opts.workspaceDir;
    const terminalId = opts.terminalId;
    const fwd = opts.proxyForwardFn || proxyForward;
    const log = opts.log || (() => {});

    const isDerived = cfg && cfg.derivedFrom !== undefined;

    // configDir 共享 {ws}/.claude_proxy（与插件 claudeLauncher 一致）：
    // 终端走 env 注入（settings.json 不写 env），故共享目录的 settings.json 不会覆盖 env。
    // 共享让 CLI 的 onboarding 标记/numStartups/主题/skipDangerousModePermissionPrompt 跨终端复用，
    // 避免每个终端首次启动都重走引导（per-terminal 旧做法导致每次都进 onboarding）。
    const configDir = path.join(workspaceDir, WORKSPACE_CONFIG_DIR);

    // ⚠ 终端走 env 注入 modelname，settings.json 的 env 会覆盖进程 env（CLI Object.assign 语义，
    // 仅覆盖 settings.env 里存在的 key）。CLI 自己写的 settings.json（{theme, skipDangerous...}）
    // 无 env 字段，不冲突，是引导完成标记，应放行（否则第二次起终端会被误拒）。
    // 仅当 settings.json 的 env 含会覆盖 modelname/路由的 key 时才拒绝（多为旧 activateConfig 残留或用户手动改过；
    // 插件 workspace-local 终端已改纯 env，不再写路由 key）。
    const CONFLICT_KEYS = [
        'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ];
    const settingsPath = path.join(configDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
        let conflictKey = null;
        try {
            const raw = fs.readFileSync(settingsPath, 'utf8');
            const parsed = JSON.parse(raw);
            const env = (parsed && typeof parsed === 'object' && parsed.env) ? parsed.env : null;
            if (env && typeof env === 'object') {
                conflictKey = CONFLICT_KEYS.find(k => env[k] !== undefined && env[k] !== '');
            }
        } catch { /* settings.json 损坏无法解析 → 不视为冲突，让 CLI 自己处理 */ }
        if (conflictKey) {
            throw new ValidationError(
                `检测到 ${settingsPath} 的 env.${conflictKey} 会覆盖终端注入的 modelname。` +
                `当前终端通过 env 注入，settings.json 的 env.${conflictKey} 不支持共存，请删除该 key 后重试。`,
            );
        }
    }

    // ── normal：env 注入 ANTHROPIC_* 真实配置，不再读 settings.json ──
    if (!isDerived) {
        const parsed = extractUpstream(cfg.content);
        if (!parsed) throw new ValidationError('config content 不是有效 JSON，无法解析 env');
        const baseUrl = parsed.env.ANTHROPIC_BASE_URL;
        const token = parsed.env.ANTHROPIC_AUTH_TOKEN;
        // 类型守卫：extractUpstream 把 obj.env 强转为 Record<string,string>，但实际值可能是数字/对象。
        // 非字符串的 baseUrl/token 视为缺失（与 derived 的 resolveDerivedUpstream typeof 守卫一致），
        // 避免数字/对象值穿透 truthy 校验注入脏 env（{} truthy → [object Object]）。
        if (typeof baseUrl !== 'string' || !baseUrl || typeof token !== 'string' || !token) {
            throw new ValidationError('config 缺少 env.ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN');
        }

        // timeoutSec：API_TIMEOUT_MS 毫秒→秒，空/非数/非正→undefined（与 derived normalizeTimeoutSec 一致）
        const tNum = Number(parsed.env.API_TIMEOUT_MS);
        const timeoutSec = Number.isFinite(tNum) && tNum > 0 ? Math.round(tNum / 1000) : undefined;

        // proxy 模式：起终端前注入 upstream 到代理（全局共享 last-write-wins）；direct 不碰代理
        if (cfg.mode === 'proxy') {
            log(`[terminal] normal-proxy 配置 '${cfg.name}' 注入代理上游: ${baseUrl}（代理全局共享，并发不同上游会串味）`);
            const upBody = { upstream: { baseUrl, token } };
            if (typeof parsed.env.ANTHROPIC_MODEL === 'string' && parsed.env.ANTHROPIC_MODEL) upBody.upstream.model = parsed.env.ANTHROPIC_MODEL;
            if (typeof parsed.env.ANTHROPIC_SMALL_FAST_MODEL === 'string' && parsed.env.ANTHROPIC_SMALL_FAST_MODEL) upBody.upstream.smallFastModel = parsed.env.ANTHROPIC_SMALL_FAST_MODEL;
            if (timeoutSec != null) upBody.upstream.timeoutSec = timeoutSec;
            const r = await fwd(proxyPort, '/api/upstream', 'POST', upBody);
            if (r.status < 200 || r.status >= 300) {
                const detail = (r.body && r.body.error) ? r.body.error : `proxy 返回 ${r.status}`;
                throw new ProxyUnavailableError(`代理拒绝 upstream: ${detail}`);
            }
        }

        // env 注入：direct → BASE_URL=上游真实地址；proxy → BASE_URL=代理地址
        const env = {
            ANTHROPIC_BASE_URL: cfg.mode === 'proxy' ? `http://127.0.0.1:${proxyPort}` : baseUrl,
            ANTHROPIC_AUTH_TOKEN: token,
        };
        // MODEL/SMALL_FAST_MODEL：仅字符串非空才注入（防数字/对象脏值，与 upstream body 注入一致）
        if (typeof parsed.env.ANTHROPIC_MODEL === 'string' && parsed.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = parsed.env.ANTHROPIC_MODEL;
        if (typeof parsed.env.ANTHROPIC_SMALL_FAST_MODEL === 'string' && parsed.env.ANTHROPIC_SMALL_FAST_MODEL) env.ANTHROPIC_SMALL_FAST_MODEL = parsed.env.ANTHROPIC_SMALL_FAST_MODEL;
        // API_TIMEOUT_MS：与 derived 殊途同归——从 timeoutSec 反推毫秒字符串，保证 proxy 模式下
        // CLI env 与代理 timeoutSec*1000 严格一致（不因小数毫秒差 500ms）。
        if (timeoutSec != null) env.API_TIMEOUT_MS = String(timeoutSec * 1000);
        return { env, configDir };
    }

    // ── derived：env 注入 BASE_URL=proxy/token/别名，configDir 共享 {ws}/.claude_proxy ──
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

    // configDir 已在顶部统一算（共享 {ws}/.claude_proxy）

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
