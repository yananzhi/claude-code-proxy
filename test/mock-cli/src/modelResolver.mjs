// test/mock-cli/src/modelResolver.mjs — 等价真 CLI parseUserSpecifiedModel + has1mContext + 保留词避让。
// 真 CLI:
//   utils/model/model.ts:445-506  parseUserSpecifiedModel
//   utils/model/model.ts:105-138  getDefaultOpusModel / getDefaultSonnetModel / getDefaultHaikuModel
//   utils/model/model.ts:616-618  normalizeModelStringForAPI（剥离 [(1|2)m]）
//   utils/context.ts:35-40        has1mContext（/\[1m\]/i）
//   utils/model/aliases.ts:1-14    MODEL_ALIASES

// MODEL_ALIASES（aliases.ts:1-14）：isModelAlias 用。
const MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'best', 'sonnet[1m]', 'opus[1m]', 'opusplan']);

// has1mContext（context.ts:35-40）：先查 is1mContextDisabled，再 /\[1m\]/i 匹配。
function is1mContextDisabled() {
    // 真 CLI: CLAUDE_CODE_DISABLE_1M_CONTEXT truthy → 禁用
    const v = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    return v === '1' || v === 'true' || v === 'TRUE';
}
export function has1mContext(model) {
    if (is1mContextDisabled()) return false;
    return /\[1m\]/i.test(model);
}

// normalizeModelStringForAPI（model.ts:616-618）：剥离 [(1|2)m] 后缀。
export function normalizeModelStringForAPI(model) {
    return model.replace(/\[(1|2)m\]/gi, '');
}

// getBaseModel：探针用，等价 normalizeModelStringForAPI。
export function getBaseModel(model) {
    return normalizeModelStringForAPI(model);
}

// getDefault*Model（model.ts:105-138）：读 process.env.ANTHROPIC_DEFAULT_*_MODEL，无则占位默认。
// 占位默认值不影响测试断言（测试用别名注入，断言别名透传/1m 行为，非内置默认值）。
export function getDefaultSonnetModel() {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-5';
}
export function getDefaultHaikuModel() {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'claude-haiku-4-5';
}
export function getDefaultOpusModel() {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || 'claude-opus-4-6';
}
// getBestModel：真 CLI 走另一套逻辑，阶段 0 占位返回 getDefaultOpusModel（TODO）。
function getBestModel() {
    return getDefaultOpusModel();
}

// isModelAlias（aliases.ts）：modelString（已 toLowerCase + 可能剥 [1m]）是否撞保留词。
function isModelAlias(modelString) {
    return MODEL_ALIASES.has(modelString);
}

// parseUserSpecifiedModel（model.ts:445-506）
// 1. trim + toLowerCase
// 2. has1mTag = has1mContext(normalized)
// 3. modelString = has1mTag ? 剥 [1m] 后的 normalized : normalized
// 4. isModelAlias(modelString) → alias 分支：返回对应 getDefault*Model()，带 [1m] 拼回（best 不拼）
// 5. 非 alias：保留原 case，带 [1m] 拼回
export function parseUserSpecifiedModel(modelInput) {
    const modelInputTrimmed = modelInput.trim();
    const normalizedModel = modelInputTrimmed.toLowerCase();

    const has1mTag = has1mContext(normalizedModel);
    const modelString = has1mTag
        ? normalizedModel.replace(/\[1m\]$/i, '').trim()
        : normalizedModel;

    if (isModelAlias(modelString)) {
        // alias 分支（model.ts:456-470）
        let resolved;
        switch (modelString) {
            case 'sonnet':
            case 'sonnet[1m]':
            case 'opusplan':
                resolved = getDefaultSonnetModel(); break;
            case 'haiku':
                resolved = getDefaultHaikuModel(); break;
            case 'opus':
            case 'opus[1m]':
                resolved = getDefaultOpusModel(); break;
            case 'best':
                resolved = getBestModel(); break;
            default:
                resolved = getDefaultSonnetModel();
        }
        // best 不拼 [1m]；其余 alias 带 [1m] 拼回
        if (has1mTag && modelString !== 'best') {
            return resolved + '[1m]';
        }
        return resolved;
    }

    // 非 alias：保留原 case，带 [1m] 拼回（model.ts:502-505）
    if (has1mTag) {
        return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]';
    }
    return modelInputTrimmed;
}
