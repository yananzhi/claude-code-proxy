// test/mock-cli/src/betas.mjs — 等价真 CLI getAllModelBetas（memoize）+ 1M beta header。
// 真 CLI: utils/betas.ts:234-256
//   getAllModelBetas = memoize((model) => ...)
//     !isHaiku → push 'claude-code-20250219'
//     has1mContext(model) → push 'context-1m-2025-08-07'
//   getAllModelBetas.cache?.clear?.()（betas.ts:430-434 clearBetasCaches）
// 真 CLI memoize 用 lodash-es/memoize.js（betas.ts:2），mock 手写。
import { has1mContext } from './modelResolver.mjs';
import { memoize } from './memoize.mjs';

const CLAUDE_CODE_20250219_BETA_HEADER = 'claude-code-20250219';
const CONTEXT_1M_BETA_HEADER = 'context-1m-2025-08-07';

// getAllModelBetas（betas.ts:234-256）
// 阶段 0 简化：非 haiku → [claude-code-20250219]；has1mContext 追加 context-1m-2025-08-07。
// 其它 beta（interleaved thinking / redact / provider / growthbook / ISP）TODO。
// isHaiku 判定 TODO（canonical name 解析未实现，ccp-haiku-1 会被当非 haiku → 带 20250219，
// 与真 CLI 可能不符，但阶段 0 测试不覆盖 haiku beta 差异）。
export const getAllModelBetas = memoize((model) => {
    const betaHeaders = [];
    // !isHaiku → push claude-code-20250219（阶段 0 一律 push，TODO isHaiku 判定）
    betaHeaders.push(CLAUDE_CODE_20250219_BETA_HEADER);
    if (has1mContext(model)) {
        betaHeaders.push(CONTEXT_1M_BETA_HEADER);
    }
    return betaHeaders;
});

// clearBetasCache（betas.ts:430-434）：重读 settings 后调。
export function clearBetasCache() {
    getAllModelBetas.cache?.clear?.();
}
