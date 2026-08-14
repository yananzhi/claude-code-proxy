// standalone/terminalApi.js — 终端 spawn env 构建（ESM JS）
//
// 职责：
//   - buildTerminalEnv(cfg, proxyPort, deps) → { env, configDir }
//     settings.json 是 CLI 会话路由的唯一事实源（回退 2026-08-14）：
//     env 只注入 CLAUDE_CONFIG_DIR（指向共享 {ws}/.claude_proxy），LLM 配置
//     （BASE_URL/TOKEN/MODEL）由 CLI 从激活时写的 settings.json 读取，env 不覆盖。
//     proxy 模式起终端前确保 upstream 已注入（激活时已注入，此处幂等防代理重启丢失）。
//   - 派生配置（derived）功能已移除（2026-08），无别名 env / 别名同步。
//
// 复用 out/（与 configApi.js 同模式）：extractUpstream；
// configApi.js 的 proxyForward + error 类。

import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);
let extractUpstream;
try {
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
 * settings.json 是 CLI 会话路由的唯一事实源：env 不注入 LLM 配置，CLI 读
 * `{ws}/.claude_proxy/settings.json`（由激活时 activateConfig 写入）做路由。
 * - direct：settings.json = 原样 content（真实上游），CLI 直连。
 * - proxy：起终端前确保 upstream 已注入代理（幂等，防代理重启后丢失；激活时已注入）。
 *
 * @param {object} cfg LLMConfig
 * @param {number} proxyPort 代理端口（proxy 模式保证 upstream 注入用）
 * @param {object} opts
 *   @param {string} opts.workspaceDir workspace 磁盘目录（算 configDir 用）
 *   @param {string} opts.terminalId 终端 id（占位，configDir 共享不依赖它）
 *   @param {Function} [opts.proxyForwardFn] 注入的 proxyForward（测试 mock），默认用 configApi 的
 *   @param {Function} [opts.log]
 * @returns {Promise<{ env: object, configDir: string }>}
 *   env = spawn env 覆盖层（空对象；CLAUDE_CONFIG_DIR 由 claudeSession 兜底注入）
 *   configDir = 共享 CLAUDE_CONFIG_DIR 路径
 * @throws {ValidationError} direct/proxy 缺 BASE_URL/TOKEN
 * @throws {ProxyUnavailableError} proxy 模式代理不可达/拒绝 upstream
 */
export async function buildTerminalEnv(cfg, proxyPort, opts = {}) {
    const workspaceDir = opts.workspaceDir;
    const fwd = opts.proxyForwardFn || proxyForward;
    const log = opts.log || (() => {});

    // configDir 共享 {ws}/.claude_proxy：CLI 读激活时写的 settings.json 做路由，
    // env 不注入路由 key（settings.json 是唯一事实源）。共享让 CLI 的 onboarding
    // 标记/numStartups/主题/skipDangerousModePermissionPrompt 跨终端复用，
    // 避免每个终端首次启动都重走引导。
    const configDir = path.join(workspaceDir, WORKSPACE_CONFIG_DIR);

    // 校验 content + 提取 baseUrl/token（类型守卫：extractUpstream 把 obj.env 强转为
    // Record<string,string>，但实际值可能是数字/对象，非字符串视为缺失防脏穿透）。
    const parsed = extractUpstream(cfg.content);
    if (!parsed) throw new ValidationError('config content 不是有效 JSON，无法解析 env');
    const baseUrl = parsed.env.ANTHROPIC_BASE_URL;
    const token = parsed.env.ANTHROPIC_AUTH_TOKEN;
    if (typeof baseUrl !== 'string' || !baseUrl || typeof token !== 'string' || !token) {
        throw new ValidationError('config 缺少 env.ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN');
    }

    // timeoutSec：API_TIMEOUT_MS 毫秒→秒，空/非数/非正→undefined
    const tNum = Number(parsed.env.API_TIMEOUT_MS);
    const timeoutSec = Number.isFinite(tNum) && tNum > 0 ? Math.round(tNum / 1000) : undefined;

    // proxy 模式：起终端前确保 upstream 已注入代理（全局共享 last-write-wins）。
    // 激活时 activateConfig 已注入过；此处幂等重注入，防代理进程重启后 upstream 丢失。
    if (cfg.mode === 'proxy') {
        log(`[terminal] proxy 配置 '${cfg.name}' 确保代理上游: ${baseUrl}（代理全局共享，并发不同上游会串味）`);
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

    // env 只含 CLAUDE_CONFIG_DIR（claudeSession.start 兜底注入 configDir）。
    // LLM 配置（BASE_URL/TOKEN/MODEL）不注入 env——CLI 从 settings.json 读取，env 覆盖反而会
    // 与唯一事实源冲突。custom env key（CLAUDE_CODE_AUTO_COMPACT_WINDOW 等）也走 settings.json。
    return { env: {}, configDir };
}
