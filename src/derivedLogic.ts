/**
 * 派生虚拟配置节点（derived node）的纯逻辑——零 vscode / 零 http 依赖，只接 plain data。
 *
 * 抽出成独立模块的目的：可被 `test/derived-logic/test.mjs` 直接单测（编译后 import out/derivedLogic.js）。
 * VS Code 交互层（treeProvider/extension/webview）调用这些纯函数，自身不进单测。
 *
 * 设计依据：docs/claude code cli运行时model切换方案.md §6.2/§6.5/§6.6/§6.9.1。
 */
import type { LLMConfig, ConfigMode, ModelAliasMapping, DerivedSnapshot, PerTier1m } from './types';
import { extractUpstream } from './upstream';

/**
 * 全部四档（含 main）。main 走 `ANTHROPIC_MODEL`，三档走 `ANTHROPIC_DEFAULT_*_MODEL`，
 * 但别名构造（`ccp-<tier>-N`）与映射同步逻辑同构，故遍历用此数组统一处理。
 */
const ALL_TIERS = ['main', 'haiku', 'sonnet', 'opus'] as const;

/**
 * 四档默认 200K 的会话档位对象（per-tier 全 false）。
 * inheritSessionContext1m 在父不带 [1m] / 无 model / content 无效时返回此值。
 */
const PER_TIER_200K: PerTier1m = { main: false, haiku: false, sonnet: false, opus: false };

/**
 * 构造档位别名串：`ccp-<tier>-N`，可选 `[1m]` 后缀。
 * - tier 必须是 main/haiku/sonnet/opus 之一（main 走 ANTHROPIC_MODEL，三档走 ANTHROPIC_DEFAULT_*，
 *   §6.9.1；避让 CLI 保留词 opus/sonnet/haiku/best/opusplan——这些是 /model 参数名，不是别名 tier）。
 * - N>=1（编号全局递增不回收，§6.9）。
 * - `[1m]` 统一输出小写：CLI `has1mContext` 用 `/\[1m\]/i` 识别大小写，但统一小写避免歧义；
 *   代理 rewriteModel 剥离用 `/\[1m\]/gi`（config-store.js）。
 */
export function aliasName(tier: string, index: number, with1m = false): string {
    if (!ALL_TIERS.includes(tier as typeof ALL_TIERS[number])) {
        throw new Error(`tier 必须是 ${ALL_TIERS.join('/')} 之一，得到: ${tier}`);
    }
    if (!Number.isInteger(index) || index < 1) {
        throw new Error(`index 必须是 >=1 的整数，得到: ${index}`);
    }
    const suffix = with1m ? '[1m]' : '';
    return `ccp-${tier}-${index}${suffix}`;
}

/**
 * 构造注入终端 shell env 的四档别名（§6.6 + 优化 2 主模型别名）。
 * - main 档 → `ANTHROPIC_MODEL`（主对话模型别名，覆盖父真名；§3.3/约束 1）。
 * - 三档 → `ANTHROPIC_DEFAULT_*_MODEL`（子 agent alias 解析输入源，§6.6）。
 * BASE_URL/token 走 settings.env（不进 shell，防进程列表可见），故返回对象绝不含这两类 key（测试 4 断言）。
 *
 * per-tier 1m（每档独立选 200K/1M）：opts.sessionContext1m 是对象时，各档按自身 1m 决定别名是否带 [1m]。
 * 向后兼容：opts.with1m（布尔）展开成四档同值；sessionContext1m 对象优先于 with1m。两者都缺 → 四档 200K。
 *
 * @param derivedIndex 派生节点专属编号 N
 * @param opts.sessionContext1m per-tier 1m 对象（{main,haiku,sonnet,opus}）
 * @param opts.with1m 兼容旧调用：布尔，四档同值
 */
export function buildAliasEnv(derivedIndex: number, opts: { with1m?: boolean; sessionContext1m?: PerTier1m | boolean } = {}): Record<string, string> {
    // sessionContext1m 优先（对象或布尔都接受——布尔是老数据，normalizeSessionContext1m 会迁移成四档同值）；
    // 否则用 with1m 布尔展开四档同值；都缺 → 四档 false（200K）。
    // 注意：sessionContext1m 若是布尔 true，typeof !== 'object' 会被旧逻辑误判落 with1m 分支（with1m 缺→200K），
    // 静默丢失老数据的 1M 设置。故这里对"布尔或对象"都走 normalize（normalize 兼容两者）。
    const normalized = opts.sessionContext1m !== undefined
        ? normalizeSessionContext1m(opts.sessionContext1m)
        : undefined;
    const perTier: PerTier1m = normalized
        ?? { main: !!opts.with1m, haiku: !!opts.with1m, sonnet: !!opts.with1m, opus: !!opts.with1m };
    return {
        ANTHROPIC_MODEL: aliasName('main', derivedIndex, perTier.main === true),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: aliasName('haiku', derivedIndex, perTier.haiku === true),
        ANTHROPIC_DEFAULT_SONNET_MODEL: aliasName('sonnet', derivedIndex, perTier.sonnet === true),
        ANTHROPIC_DEFAULT_OPUS_MODEL: aliasName('opus', derivedIndex, perTier.opus === true),
    };
}

/**
 * 透传到终端 shell env 时需排除的 key（路由 key + 派生四档别名 key + 特殊处理 key + 进程控制 key + 系统/运行时 key）。
 *
 * 这些 key 由各启动入口显式构造（路由 key：BASE_URL/TOKEN/MODEL/SMALL_FAST_MODEL/TIMEOUT；
 * 派生别名：buildAliasEnv 构造四档 ANTHROPIC_DEFAULT_*_MODEL；进程控制：CLAUDE_CONFIG_DIR/CLAUDE_BIN
 * 由 claudeLauncher 的 terminalOptions.env 显式设置），若再从 content.env 原样透传会
 * 覆盖显式构造的值（如父 content 的 ANTHROPIC_MODEL 真名覆盖派生别名 ccp-main-N，
 * 或父 content 残留的 CLAUDE_CONFIG_DIR 覆盖调用方设的配置目录）。
 * 系统/运行时 key（PATH/HOME/NODE_OPTIONS 等）影响进程解析与 Node 运行时，不应从 content.env 透传。
 * 其余 env key（如 CLAUDE_CODE_AUTO_COMPACT_WINDOW）是用户自定义、各路径不显式构造，应透传。
 *
 * 与 standalone/terminalApi.js 的 CONFLICT_KEYS（5 个路由 key，settings 冲突检测用）的关系：
 * CONFLICT_KEYS 是此清单的子集（不含 AUTH_TOKEN/TIMEOUT/SMALL_FAST_MODEL——它们不覆盖 modelname，
 * settings 冲突检测语义只检路由 modelname）。此清单额外含派生别名 key + 特殊处理 key + 进程控制 key + 系统 key。
 */
const CUSTOM_ENV_EXCLUDE_KEYS = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'API_TIMEOUT_MS',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
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
 * 排除 `CUSTOM_ENV_EXCLUDE_KEYS`（路由 key + 派生别名 key + 特殊处理 key + 进程控制 key + 系统/运行时 key
 * ——各路径已显式构造或影响进程行为），保留其余**字符串非空**值。非字符串值（数字/对象/布尔）不透传——
 * 与 `extractUpstream` typeof 守卫一致，防数字/对象脏值穿透（{} truthy → [object Object]）。
 * 数组入参返回 {}（防 Object.keys(array) 产出数字索引 key）。
 *
 * 用于 4 个启动入口（插件 normal/derived + standalone normal/derived）把自定义 env 从 content.env
 * 注入 shell env，不再依赖 settings.json 残留（CLI 重写 settings.json 会丢 env，见 plan twinkling-forging-sunset）。
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

/**
 * 从父配置 content 解析派生节点的默认会话档位（优化 2，约束 3）。
 *
 * 规则：看父 `ANTHROPIC_MODEL` 是否带 `[1m]` 后缀（CLI `has1mContext` 用 `/\[1m\]/i` 识别，大小写不敏感）：
 * - 带 `[1m]` → 四档都 true（派生节点别名带后缀，CLI 按 1M 算 contextWindow）。
 * - 不带 / 父无 ANTHROPIC_MODEL / content 无效 / 值非字符串 → 四档都 false（保守 200K）。
 * - `[2m]`/`[500k]` 等 CLI 不识别的后缀 → 四档 false（只认 `[1m]`）。
 *
 * per-tier：四档默认都从父继承（同值）。用户可在编辑器里逐档覆盖。
 * 返回 per-tier 对象（{main,haiku,sonnet,opus}），调用方直接用作派生节点 sessionContext1m 初值。
 */
export function inheritSessionContext1m(parentContent: string): PerTier1m {
    const parsed = extractUpstream(parentContent);
    if (!parsed) {
        return { ...PER_TIER_200K };
    }
    const m = parsed.env.ANTHROPIC_MODEL;
    // 类型守卫：env 值可能非字符串（extractUpstream 强转），非字符串视为无后缀
    if (typeof m !== 'string' || !m) {
        return { ...PER_TIER_200K };
    }
    // 与 CLI has1mContext 一致：/\[1m\]/i，仅 [1m] 识别，[2m] 等不识别
    const with1m = /\[1m\]/i.test(m);
    return { main: with1m, haiku: with1m, sonnet: with1m, opus: with1m };
}

/**
 * 从父配置 content 解出派生节点新建时的四档默认映射（§6.7 P3 + 优化 2 main 档）。
 * 派生节点新建时继承父的四档配置，省得用户每档重填。
 *
 * **四档都剥 `[1m]` 后缀**（约束 3：映射 value 是真实模型名，不带 `[1m]`）。
 * `[1m]` 只是 CLI 侧 contextWindow 档位标记，不是模型名一部分；带后缀的真实模型名
 * 发到上游会 model not found。main 档原本就剥，三档（haiku/sonnet/opus）历史上漏剥
 * （bug：父 `ANTHROPIC_DEFAULT_*_MODEL` 带 `[1m]` 时原样继承进 `modelAliases` value）。
 *
 * - main：从父 `ANTHROPIC_MODEL` 继承，剥 `[1m]`。
 * - 三档：从父 `ANTHROPIC_DEFAULT_*_MODEL` 继承，剥 `[1m]`。
 * - 剥后缀用 `/\[1m\]/gi`（全局 + 大小写不敏感，与 main 档现状及 CLI `has1mContext` `/\[1m\]/i` 一致）。
 * - `[2m]`/`[500k]` 等 CLI 不认的后缀不剥（只剥 `[1m]`）。
 * - 非字符串值（extractUpstream 强转但实际可能是数字/对象）视为缺失，不崩。
 * - 剥后 trim；trim 后空串视为未配，不进结果。
 * - 父 content 非法 JSON / 无 env → `{}`。
 */
export function inheritAliasesFromParent(parentContent: string): { main?: string; haiku?: string; sonnet?: string; opus?: string } {
    const parsed = extractUpstream(parentContent);
    if (!parsed) return {};
    const env = parsed.env ?? {};
    const aliases: { main?: string; haiku?: string; sonnet?: string; opus?: string } = {};
    // 统一剥 [1m]：四档同逻辑，用共享 strip1mSuffix（全局剥 + trim + 空串视为未配）。
    const main = strip1mSuffix(env.ANTHROPIC_MODEL);
    const haiku = strip1mSuffix(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
    const sonnet = strip1mSuffix(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
    const opus = strip1mSuffix(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
    if (main) aliases.main = main;
    if (haiku) aliases.haiku = haiku;
    if (sonnet) aliases.sonnet = sonnet;
    if (opus) aliases.opus = opus;
    return aliases;
}

/**
 * 归一化 sessionContext1m：把任意输入规整成合法 per-tier 对象（或 undefined）。
 * - undefined → undefined（保持未填，调用方会用继承初值）。
 * - 布尔 true → 四档 true；布尔 false → 四档 false（老派生节点数据迁移）。
 * - 对象 → 各档 value 非 strict-true 转 false（防脏数据 string/number/null），缺档补 false。
 * - 非对象非布尔脏数据（string/null/number/array）→ 四档 false。
 *
 * 用途：读取派生节点 sessionContext1m 时规整（防老数据/手动编辑脏数据）。
 */
export function normalizeSessionContext1m(raw: unknown): PerTier1m | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw === 'boolean') {
        return { main: raw, haiku: raw, sonnet: raw, opus: raw };
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const o = raw as Record<string, unknown>;
        return {
            main: o.main === true,
            haiku: o.haiku === true,
            sonnet: o.sonnet === true,
            opus: o.opus === true,
        };
    }
    // 非对象非布尔脏数据 → 四档 false
    return { ...PER_TIER_200K };
}


/**
 * 解析派生节点启动时用的上游（§6.5 继承机制）。
 * 优先级：derivedSnapshot（父上游快照，防父删/改断链）→ 父 content 解（extractUpstream）→ null。
 * - 快照存在：用快照值（父 token 轮换不自动同步，正是用户预期"这条会话用当时配的上游"）。
 * - 快照缺：从父 content 解 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/API_TIMEOUT_MS。
 * - 父也缺 / content 无效：返回 null（调用方报错中止）。
 */
export function resolveDerivedUpstream(
    derived: Pick<LLMConfig, 'derivedSnapshot'>,
    parent: Pick<LLMConfig, 'content' | 'mode'> | null | undefined,
): { baseUrl: string; token: string; timeoutSec?: number; mode: ConfigMode } | null {
    const snap = derived.derivedSnapshot;
    // 类型守卫：防快照数据损坏（非字符串 baseUrl/token）——与父 content 路径一致
    if (snap && typeof snap.baseUrl === 'string' && snap.baseUrl && typeof snap.token === 'string' && snap.token) {
        // timeoutSec 归一：快照存的是秒（snapshotFromParent 已除过 1000），这里只校验是 finite 正数，
        // 防 NaN/字符串/非正数透传污染 settings.json（不再除 1000，否则把 300 秒当毫秒算成 0）。
        const snapTimeout = typeof snap.timeoutSec === 'number' && Number.isFinite(snap.timeoutSec) && snap.timeoutSec > 0
            ? snap.timeoutSec : undefined;
        return { baseUrl: snap.baseUrl, token: snap.token, timeoutSec: snapTimeout, mode: snap.mode };
    }
    if (!parent) {
        return null;
    }
    const parsed = extractUpstream(parent.content);
    if (!parsed) {
        return null;
    }
    const baseUrl = parsed.env.ANTHROPIC_BASE_URL;
    const token = parsed.env.ANTHROPIC_AUTH_TOKEN;
    // 类型守卫：extractUpstream 把 obj.env 强转为 Record<string,string>，但实际值可能是数字/对象。
    // 非字符串的 baseUrl/token 视为缺失（返回 null），避免把数字当 URL 写进 settings.env。
    if (typeof baseUrl !== 'string' || !baseUrl || typeof token !== 'string' || !token) {
        return null;
    }
    // API_TIMEOUT_MS 归一：非数字/空串/0/负数/NaN → undefined。
    // 原实现 Number("abc")=NaN、Number("")=0 会产生 NaN/0 写进 settings（NaN 脏值、0=立即超时）。
    const timeoutSec = normalizeTimeoutSec(parsed.env.API_TIMEOUT_MS);
    return { baseUrl, token, timeoutSec, mode: parent.mode === 'proxy' ? 'proxy' : 'direct' };
}

/**
 * 把 API_TIMEOUT_MS（ms，字符串/数字）归一为 timeoutSec（秒，正整数 finite）。
 * 非数字/空串/0/负数/NaN/Infinity → undefined（视为缺失，不写进 settings.json）。
 * 防 Number("abc")=NaN、Number("")=0 污染 settings（NaN→"NaN" 脏值；0→0ms 立即超时）。
 */
function normalizeTimeoutSec(raw: unknown): number | undefined {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return undefined;
    }
    return Math.round(n / 1000);
}

/**
 * 判定派生节点是否孤儿（父配置已删，§6.5 P1）。
 * 孤儿与快照有无无关：父删即孤儿（树标 ⚠ 禁启动），即便快照自洽能解上游也仍标孤儿。
 */
export function isOrphan(
    derived: Pick<LLMConfig, 'derivedFrom'>,
    parent: Pick<LLMConfig, 'id'> | null | undefined,
): boolean {
    return !parent;
}

/**
 * 比对代理现表与派生节点 modelAliases，算出启动前需补的 set 动作（§6.5 步骤6 / §6.8）。
 *
 * 规则：
 * - 遍历四档（main/haiku/sonnet/opus），派生节点**已配**该档（modelAliases[tier] 非空）且
 *   代理表里该别名缺失或值不一致 → toSet。main 档别名 `ccp-main-N` 与三档同构，走同一套逻辑。
 * - 派生节点未配的档 → 不补（该档别名将原样透传，不命中映射表，§3.6 白名单）。
 * - 不清代理表里别的编号残留（编号不回收，§6.9）—— toRemove 始终为空（保留接口字段供未来用）。
 * - 幂等：同输入同输出。
 * - 映射别名 key 一律不带 `[1m]`（约束 3：rewriteModel 剥后缀查表）。
 */
export function computeAliasSyncActions(
    derived: Pick<LLMConfig, 'derivedIndex' | 'modelAliases'>,
    proxyAliases: Record<string, string>,
): { toSet: { alias: string; model: string }[]; toRemove: string[] } {
    const idx = derived.derivedIndex;
    // 派生节点缺编号或编号非法（0/负数/非整数）：无法构造合法别名（aliasName 要求 N>=1），
    // 无动作返回（调用方应在更早处拦截）。与 null 同处理，避免内部 aliasName 抛错。
    if (idx == null || !Number.isFinite(idx) || idx < 1 || !Number.isInteger(idx)) {
        return { toSet: [], toRemove: [] };
    }
    const mapping = derived.modelAliases ?? {};
    const toSet: { alias: string; model: string }[] = [];
    for (const tier of ALL_TIERS) {
        const raw = mapping[tier];
        // 类型守卫：防非字符串值崩 .trim()；空串/纯空白视为未配
        if (typeof raw !== 'string' || !raw.trim()) {
            continue; // 未配该档，不补
        }
        const model = raw.trim(); // 归一化：比较与设置都用 trim 后的值，避免尾空格导致多余 set
        const alias = aliasName(tier, idx);
        if (proxyAliases[alias] !== model) {
            toSet.push({ alias, model });
        }
    }
    return { toSet, toRemove: [] };
}

/**
 * 剥 [1m] 后缀（全局 + 大小写不敏感），剥后 trim，空串视为未配。
 * 与 inheritAliasesFromParent / 代理 rewriteModel 剥离规则一致（约束 3：value 是真实模型名）。
 * CLI 唯一识别的长度标记是 [1m]（has1mContext /\[1m\]/i），[2m]/[500k] 等不剥。
 */
function strip1mSuffix(v: unknown): string | undefined {
    if (typeof v !== 'string' || !v) return undefined;
    const stripped = v.replace(/\[1m\]/gi, '').trim();
    return stripped || undefined;
}

/**
 * 从所有已存配置聚合去重模型清单（§6.7 P9，webview 三档下拉候选）。
 * 来源：每条配置 content 里的 ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL，以及 derived 节点的 modelAliases 真实模型名。
 * 纯前端聚合，无需代理改动。空值/重复过滤。
 *
 * **剥 [1m] 后缀**（约束 3：候选是真实模型名，[1m] 只是 CLI contextWindow 标记不是模型名一部分）。
 * content 侧 env 值可能带 [1m]（父配置原样存），modelAliases 侧已是剥后的（inheritAliasesFromParent 出口剥）。
 * 不剥会导致同一模型在目录里同时出现 'glm' 和 'glm[1m]'（重复候选）。
 */
export function aggregateModelCatalog(configs: Pick<LLMConfig, 'content' | 'modelAliases'>[]): string[] {
    const set = new Set<string>();
    for (const cfg of configs) {
        if (cfg.modelAliases) {
            for (const tier of ALL_TIERS) {
                const m = cfg.modelAliases[tier];
                // 类型守卫：防手动编辑/损坏数据带入非字符串值（数字/对象等）导致 .trim() 崩溃
                if (typeof m === 'string' && m.trim()) {
                    set.add(m.trim());
                }
            }
        }
        if (cfg.content) {
            const parsed = extractUpstream(cfg.content);
            if (parsed) {
                for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'] as const) {
                    // 剥 [1m]：content env 值可能带后缀，与 modelAliases 侧（已剥）统一，避免重复候选
                    const m = strip1mSuffix(parsed.env[key]);
                    if (m) {
                        set.add(m);
                    }
                }
            }
        }
    }
    return Array.from(set);
}

/**
 * 树 description 摘要：`M:.. · S:.. · H:.. · O:..`（§6.3 + 优化 2 main 档）。
 * main 档用 `M:` 前缀（主对话模型），三档 S/H/O。未配的档不显示。全空返回空串。
 */
export function summarizeAliases(modelAliases: ModelAliasMapping | undefined): string {
    if (!modelAliases) {
        return '';
    }
    const parts: string[] = [];
    // 类型守卫：防损坏数据（非字符串值）导致 .trim() 崩溃
    if (typeof modelAliases.main === 'string' && modelAliases.main.trim()) parts.push(`M:${modelAliases.main}`);
    if (typeof modelAliases.sonnet === 'string' && modelAliases.sonnet.trim()) parts.push(`S:${modelAliases.sonnet}`);
    if (typeof modelAliases.haiku === 'string' && modelAliases.haiku.trim()) parts.push(`H:${modelAliases.haiku}`);
    if (typeof modelAliases.opus === 'string' && modelAliases.opus.trim()) parts.push(`O:${modelAliases.opus}`);
    return parts.join(' · ');
}

/**
 * 过滤出"父 local 配置"——排除派生节点（derivedFrom 非空）。
 *
 * 派生节点存在 local-configs.json 同数组里（靠 derivedFrom 区分）。treeProvider 渲染
 * local 分组时若不过滤，会把派生节点当普通 local 配置也渲染一遍，导致重复项
 * （派生节点既在父节点下展开、又作为普通 local 项出现）。此函数集中过滤逻辑、
 * 可单测防回归。
 */
export function filterParentConfigs<T extends Pick<LLMConfig, 'derivedFrom'>>(configs: T[]): T[] {
    return configs.filter(c => !c.derivedFrom);
}

/**
 * 本地兜底编号：扫已存派生节点 derivedIndex 取 max+1（§6.2）。
 * 权威编号向代理 nextAliasId 申请；此函数仅用于无代理时本地预览/兜底。
 * 无派生节点 → 1。非派生节点（无 derivedIndex）忽略。
 */
export function nextDerivedIndex(configs: Pick<LLMConfig, 'derivedIndex'>[]): number {
    let max = 0;
    for (const c of configs) {
        if (typeof c.derivedIndex === 'number' && Number.isFinite(c.derivedIndex) && c.derivedIndex > max) {
            max = c.derivedIndex;
        }
    }
    return max + 1;
}

// 重新导出派生节点相关类型，供交互层统一 import
export type { ModelAliasMapping, DerivedSnapshot, ConfigMode, PerTier1m };
