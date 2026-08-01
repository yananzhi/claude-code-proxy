/**
 * 派生虚拟配置节点（derived node）的纯逻辑——零 vscode / 零 http 依赖，只接 plain data。
 *
 * 抽出成独立模块的目的：可被 `test/derived-logic/test.mjs` 直接单测（编译后 import out/derivedLogic.js）。
 * VS Code 交互层（treeProvider/extension/webview）调用这些纯函数，自身不进单测。
 *
 * 设计依据：docs/claude code cli运行时model切换方案.md §6.2/§6.5/§6.6/§6.9.1。
 */
import type { LLMConfig, ConfigMode, ModelAliasMapping, DerivedSnapshot } from './types';
import { extractUpstream } from './upstream';

/**
 * 全部四档（含 main）。main 走 `ANTHROPIC_MODEL`，三档走 `ANTHROPIC_DEFAULT_*_MODEL`，
 * 但别名构造（`ccp-<tier>-N`）与映射同步逻辑同构，故遍历用此数组统一处理。
 */
const ALL_TIERS = ['main', 'haiku', 'sonnet', 'opus'] as const;

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
 * @param derivedIndex 派生节点专属编号 N
 * @param opts.with1m 是否带 [1m] 后缀（1M 上下文会话；CLI 按此算 contextWindow，约束 3）
 */
export function buildAliasEnv(derivedIndex: number, opts: { with1m?: boolean } = {}): Record<string, string> {
    const with1m = opts.with1m ?? false;
    return {
        ANTHROPIC_MODEL: aliasName('main', derivedIndex, with1m),
        ANTHROPIC_DEFAULT_HAIKU_MODEL: aliasName('haiku', derivedIndex, with1m),
        ANTHROPIC_DEFAULT_SONNET_MODEL: aliasName('sonnet', derivedIndex, with1m),
        ANTHROPIC_DEFAULT_OPUS_MODEL: aliasName('opus', derivedIndex, with1m),
    };
}

/**
 * 从父配置 content 解析派生节点的默认会话档位（优化 2，约束 3）。
 *
 * 规则：看父 `ANTHROPIC_MODEL` 是否带 `[1m]` 后缀（CLI `has1mContext` 用 `/\[1m\]/i` 识别，大小写不敏感）：
 * - 带 `[1m]` → true（派生节点别名带后缀，CLI 按 1M 算 contextWindow）。
 * - 不带 / 父无 ANTHROPIC_MODEL / content 无效 / 值非字符串 → false（保守 200K）。
 * - `[2m]`/`[500k]` 等 CLI 不识别的后缀 → false（只认 `[1m]`）。
 *
 * 派生节点可自行覆盖此默认（配置页选档位），此函数只提供继承初值。
 */
export function inheritSessionContext1m(parentContent: string): boolean {
    const parsed = extractUpstream(parentContent);
    if (!parsed) {
        return false;
    }
    const m = parsed.env.ANTHROPIC_MODEL;
    // 类型守卫：env 值可能非字符串（extractUpstream 强转），非字符串视为无后缀
    if (typeof m !== 'string' || !m) {
        return false;
    }
    // 与 CLI has1mContext 一致：/\[1m\]/i，仅 [1m] 识别，[2m] 等不识别
    return /\[1m\]/i.test(m);
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
 * 从所有已存配置聚合去重模型清单（§6.7 P9，webview 三档下拉候选）。
 * 来源：每条配置 content 里的 ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL，以及 derived 节点的 modelAliases 真实模型名。
 * 纯前端聚合，无需代理改动。空值/重复过滤。
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
                    const m = parsed.env[key];
                    // 类型守卫：extractUpstream 不保证 env 值是字符串（obj.env 强转），此处兜底
                    if (typeof m === 'string' && m.trim()) {
                        set.add(m.trim());
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
export type { ModelAliasMapping, DerivedSnapshot, ConfigMode };
