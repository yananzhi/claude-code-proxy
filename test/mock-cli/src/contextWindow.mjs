// test/mock-cli/src/contextWindow.mjs — 等价真 CLI contextWindow + autocompact 阈值计算。
// 真 CLI:
//   utils/context.ts:51-98              getContextWindowForModel
//   services/compact/autoCompact.ts:33-49  getEffectiveContextWindowSize
//   services/compact/autoCompact.ts:62,72-91  AUTOCOMPACT_BUFFER_TOKENS / getAutoCompactThreshold
//   services/api/claude.ts:3399-3419    getMaxOutputTokensForModel（带 cap）
//   utils/context.ts:9,97              MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
//
// 阶段 0 精算（见 docs/mock-cli-impl-plan.md §2.6 / 主方案 §6.9.1）：
//   reservedTokens = min(maxOutputTokens, 20_000)；自定义模型名经 cap → maxOutputTokens = 8_000。
//   [1m] + window=600000 → threshold = min(1_000_000, 600_000) - 8_000 - 13_000 = 579_000
//   无[1m] + window=600000 → threshold = min(200_000, 600_000) - 8_000 - 13_000 = 179_000
import { has1mContext } from './modelResolver.mjs';

const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;
const CONTEXT_WINDOW_1M = 1_000_000;
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
// 真 CLI: CAPPED_DEFAULT_MAX_TOKENS（services/api/claude.ts）。自定义模型名经此 cap。
const CAPPED_DEFAULT_MAX_TOKENS = 8_000;

// getContextWindowForModel（context.ts:51-98）
// 阶段 0 只实现 has1mContext → 1M / 否则 200K 两条路径。
// ant override / capability 表 / growthbook sonnet1m 实验 全 TODO。
export function getContextWindowForModel(model) {
    if (has1mContext(model)) {
        return CONTEXT_WINDOW_1M;
    }
    return MODEL_CONTEXT_WINDOW_DEFAULT;
}

// getMaxOutputTokensForModel（claude.ts:3399-3419）
// 阶段 0 简化：自定义模型名（ccp-* 走不到已知档位）→ 经 cap = 8_000。
// 真 CLI: getModelMaxOutputTokens(model).default（context.ts:149-210 else 分支 defaultTokens=32_000），
// 再 Math.min(32_000, CAPPED_DEFAULT_MAX_TOKENS=8_000) = 8_000。
export function getMaxOutputTokensForModel(model) {
    return CAPPED_DEFAULT_MAX_TOKENS;
}

// getEffectiveContextWindowSize（autoCompact.ts:33-49）
//   reservedTokens = min(maxOutputTokens, 20_000)
//   contextWindow = getContextWindowForModel(model)
//   AUTO_COMPACT_WINDOW 存在且正 → contextWindow = min(contextWindow, parsed)
//   return contextWindow - reservedTokens
export function getEffectiveContextWindowSize(model) {
    const reservedTokensForSummary = Math.min(
        getMaxOutputTokensForModel(model),
        MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    );
    let contextWindow = getContextWindowForModel(model);

    const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    if (autoCompactWindow) {
        const parsed = parseInt(autoCompactWindow, 10);
        if (!isNaN(parsed) && parsed > 0) {
            contextWindow = Math.min(contextWindow, parsed);
        }
    }
    return contextWindow - reservedTokensForSummary;
}

// getAutoCompactThreshold（autoCompact.ts:72-91）
//   threshold = getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
//   CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 百分比覆盖（:79-87）——阶段 0 顺手做。
export function getAutoCompactThreshold(model) {
    const effectiveContextWindow = getEffectiveContextWindowSize(model);
    let threshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS;

    const pctOverride = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    if (pctOverride) {
        const pct = Number(pctOverride);
        if (!isNaN(pct)) {
            threshold = Math.floor(effectiveContextWindow * pct);
        }
    }
    return threshold;
}
