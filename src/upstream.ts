/**
 * 从 LLMConfig content 解析上游 env、合成代理 settings、提取透传自定义 env 的纯函数。
 * 独立成模块以避免 extension.ts ↔ claudeLauncher.ts 的循环依赖：
 * extension.ts（doSwitch）、claudeLauncher.ts 都从这里 import；
 * standalone（configApi.js/terminalApi.js）编译后从 out/upstream.js 引入同一套逻辑。
 */

/** 从配置 content 解出上游 env（代理模式用） */
export function extractUpstream(content: string): { env: Record<string, string>; obj: Record<string, unknown> } | null {
    try {
        const obj = JSON.parse(content) as Record<string, unknown>;
        const env = (obj.env ?? {}) as Record<string, string>;
        return { env, obj };
    } catch {
        return null;
    }
}

/** 代理模式：把 content 的 baseUrl 改成指向代理，作为写到 settings.json 的内容 */
export function synthesizeProxySettings(content: string, port: number): string | null {
    const parsed = extractUpstream(content);
    if (!parsed) return null;
    parsed.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    parsed.obj.env = parsed.env;
    return JSON.stringify(parsed.obj, null, 2);
}

/**
 * 透传到终端 shell env 时需排除的 key（路由 key + 特殊处理 key + 进程控制 key + 系统/运行时 key）。
 *
 * 这些 key 由各启动入口显式构造（路由 key：BASE_URL/TOKEN/MODEL/SMALL_FAST_MODEL/TIMEOUT；
 * 进程控制：CLAUDE_CONFIG_DIR/CLAUDE_BIN 由 claudeLauncher 的 terminalOptions.env 显式设置），
 * 若再从 content.env 原样透传会覆盖显式构造的值（如父 content 的 ANTHROPIC_MODEL 真名，
 * 或父 content 残留的 CLAUDE_CONFIG_DIR 覆盖调用方设的配置目录）。
 * 系统/运行时 key（PATH/HOME/NODE_OPTIONS 等）影响进程解析与 Node 运行时，不应从 content.env 透传。
 * 其余 env key（如 CLAUDE_CODE_AUTO_COMPACT_WINDOW）是用户自定义、各路径不显式构造，应透传。
 */
const CUSTOM_ENV_EXCLUDE_KEYS = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'API_TIMEOUT_MS',
    // 进程控制 key：由启动入口（claudeLauncher/standalone spawn）显式构造，不从 content.env 透传——
    // 否则父 content 残留的 CLAUDE_CONFIG_DIR/CLAUDE_BIN 会覆盖调用方设的配置目录/二进制路径。
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_BIN',
    // 系统/运行时 env key：不从 content.env 透传——这些 key 影响进程解析/Node 运行时/shell 行为，
    // 若被 content 残留值覆盖会改变终端进程行为（PATH 劫持二进制解析、NODE_OPTIONS 注入 --require、
    // HOME 改变 ~ 展开、ELECTRON_RUN_AS_NODE 影响 VS Code 宿主等）。用户自定义 LLM/CLI key 不在此列。
    'PATH',
    'HOME',
    'NODE_OPTIONS',
    'NODE_PATH',
    'ELECTRON_RUN_AS_NODE',
    'SHELL',
];

/**
 * 从 content.env 提取**非冲突自定义 env key**，供终端 shell env 透传（CLAUDE_CODE_AUTO_COMPACT_WINDOW 等）。
 *
 * 排除 `CUSTOM_ENV_EXCLUDE_KEYS`（路由 key + 特殊处理 key + 进程控制 key + 系统/运行时 key
 * ——各路径已显式构造或影响进程行为），保留其余**字符串非空**值。非字符串值（数字/对象/布尔）不透传——
 * 与 `extractUpstream` typeof 守卫一致，防数字/对象脏值穿透（{} truthy → [object Object]）。
 * 数组入参返回 {}（防 Object.keys(array) 产出数字索引 key）。
 *
 * 用于 2 个启动入口（插件 + standalone）把自定义 env 从 content.env 注入 shell env，
 * 不再依赖 settings.json 残留（CLI 重写 settings.json 会丢 env）。
 *
 * @param env content.env（extractUpstream 返回的 parsed.env，或直接传入的对象）
 * @returns 排除冲突 key 后的字符串非空 env 副本（空对象安全——不修改入参）
 */
export function extractCustomEnv(env: Record<string, unknown> | null | undefined): Record<string, string> {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
    const out: Record<string, string> = {};
    for (const key of Object.keys(env)) {
        if (CUSTOM_ENV_EXCLUDE_KEYS.includes(key)) continue;
        const v = env[key];
        if (typeof v === 'string' && v) {
            out[key] = v;
        }
    }
    return out;
}
