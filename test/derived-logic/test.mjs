// test/derived-logic/test.mjs — 扩展侧派生节点纯逻辑单测。
// Run:  npx tsc -p ./ && node --test test/derived-logic/test.mjs
//
// 被测：out/derivedLogic.js（src/derivedLogic.ts 编译产物，零 vscode 依赖）。
// 维度覆盖见 plan/tmp/2026-07-31-ext-derived-node.md（D1-D8 + 6 类高风险）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    aliasName,
    buildAliasEnv,
    resolveDerivedUpstream,
    isOrphan,
    computeAliasSyncActions,
    aggregateModelCatalog,
    summarizeAliases,
    nextDerivedIndex,
    filterParentConfigs,
    inheritSessionContext1m,
    normalizeSessionContext1m,
    inheritAliasesFromParent,
    extractCustomEnv,
} from '../../out/derivedLogic.js';

// per-tier 1m 期望对象常量（inheritSessionContext1m 现返回 per-tier 对象，非布尔）
const TIER_1M_ALL = { main: true, haiku: true, sonnet: true, opus: true };
const TIER_200K_ALL = { main: false, haiku: false, sonnet: false, opus: false };

// ── D1: aliasName 基本格式 ──
test('1. aliasName 三档 × N=1 基本格式', () => {
    assert.equal(aliasName('haiku', 1), 'ccp-haiku-1');
    assert.equal(aliasName('sonnet', 1), 'ccp-sonnet-1');
    assert.equal(aliasName('opus', 1), 'ccp-opus-1');
});

// ── D1 边界: [1m] 后缀，统一小写 ──
test('2. aliasName [1m] 后缀统一小写', () => {
    assert.equal(aliasName('sonnet', 1, true), 'ccp-sonnet-1[1m]');
    // 即使传入大写也归一为小写 [1m]（CLI has1mContext 用 /\[1m\]/i 识别，但统一输出避免歧义）
    assert.equal(aliasName('sonnet', 2, true), 'ccp-sonnet-2[1m]');
    assert.equal(aliasName('sonnet', 2, false), 'ccp-sonnet-2');
});

// ── D1 异常路径: 非法 tier 抛错 ──
test('3. aliasName 非法 tier 抛错', () => {
    assert.throws(() => aliasName('best', 1), /tier/);
    assert.throws(() => aliasName('sonnet', 0), /index/); // N>=1
    assert.throws(() => aliasName('sonnet', -1), /index/);
});

// ── D1×D6: buildAliasEnv 四档 shell env，不含 BASE_URL/token ──
// 优化 2：主模型也走别名（ccp-main-N[1m]?），buildAliasEnv 现含 ANTHROPIC_MODEL。
test('4. buildAliasEnv 四档注入 shell env（含 ANTHROPIC_MODEL），不含 BASE_URL/token', () => {
    const env = buildAliasEnv(1, { with1m: true });
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1[1m]');
    // 优化 2：主模型走 ANTHROPIC_MODEL 别名（覆盖父真名），带 [1m] 后缀
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1[1m]');
    // 安全约束：别名走 shell env，BASE_URL/token 走 settings.env，不能混进这里
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

// ── D6 幂等: buildAliasEnv 同输入同输出 ──
test('5. buildAliasEnv 幂等', () => {
    assert.deepEqual(buildAliasEnv(3, { with1m: false }), buildAliasEnv(3, { with1m: false }));
    assert.deepEqual(buildAliasEnv(3, { with1m: true }), buildAliasEnv(3, { with1m: true }));
});

// ── D3: resolveDerivedUpstream 快照优先（P1 设计意图）──
test('6. resolveDerivedUpstream 快照优先，忽略父 content 新值', () => {
    const derived = {
        derivedFrom: 'parent-1',
        derivedSnapshot: { baseUrl: 'http://snap.example', token: 'snap-token', timeoutSec: 300, mode: 'direct' },
    };
    const parent = { content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://new.example', ANTHROPIC_AUTH_TOKEN: 'new-token', API_TIMEOUT_MS: '120000' } }) };
    const r = resolveDerivedUpstream(derived, parent);
    assert.equal(r.baseUrl, 'http://snap.example');
    assert.equal(r.token, 'snap-token');
    assert.equal(r.timeoutSec, 300);
    assert.equal(r.mode, 'direct');
});

// ── D3: 快照缺 → 父 content 兜底 ──
test('7. resolveDerivedUpstream 快照缺 → 父 content 解出', () => {
    const derived = { derivedFrom: 'parent-1' }; // 无快照
    const parent = { content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://p.example', ANTHROPIC_AUTH_TOKEN: 'p-token', API_TIMEOUT_MS: '240000' } }), mode: 'proxy' };
    const r = resolveDerivedUpstream(derived, parent);
    assert.equal(r.baseUrl, 'http://p.example');
    assert.equal(r.token, 'p-token');
    assert.equal(r.timeoutSec, 240);
    assert.equal(r.mode, 'proxy');
});

// ── D3 异常: 父缺 + 快照缺 → null ──
test('8. resolveDerivedUpstream 父缺 + 快照缺 → null', () => {
    const derived = { derivedFrom: 'parent-1' }; // 无快照
    assert.equal(resolveDerivedUpstream(derived, undefined), null);
    assert.equal(resolveDerivedUpstream(derived, null), null);
});

// ── D3 异常: 快照缺 + 父 content 无效 JSON → null ──
test('9. resolveDerivedUpstream 快照缺 + 父 content 无效 JSON → null', () => {
    const derived = { derivedFrom: 'parent-1' };
    const parent = { content: 'not-json' };
    assert.equal(resolveDerivedUpstream(derived, parent), null);
});

// ── D4: isOrphan ──
test('10. isOrphan 父存在/缺失', () => {
    const derived = { derivedFrom: 'parent-1' };
    assert.equal(isOrphan(derived, { id: 'parent-1' }), false);
    assert.equal(isOrphan(derived, undefined), true);
    assert.equal(isOrphan(derived, null), true);
});

// ── D5: 代理表缺本节点三档 → toSet 三条 ──
test('11. computeAliasSyncActions 代理表缺 → 补三档', () => {
    const derived = { derivedIndex: 2, modelAliases: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' } };
    const proxyAliases = {}; // 空表
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toSet.length, 3);
    assert.ok(r.toSet.find(a => a.alias === 'ccp-haiku-2' && a.model === 'claude-haiku-4-5'));
    assert.ok(r.toSet.find(a => a.alias === 'ccp-sonnet-2' && a.model === 'claude-sonnet-5'));
    assert.ok(r.toSet.find(a => a.alias === 'ccp-opus-2' && a.model === 'claude-opus-5'));
    assert.equal(r.toRemove.length, 0);
});

// ── D5: 代理表已含部分 → 只补缺的 ──
test('12. computeAliasSyncActions 代理表含部分 → 只补缺的', () => {
    const derived = { derivedIndex: 2, modelAliases: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' } };
    const proxyAliases = { 'ccp-haiku-2': 'claude-haiku-4-5', 'ccp-sonnet-2': 'claude-sonnet-5' }; // opus 缺
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toSet.length, 1);
    assert.equal(r.toSet[0].alias, 'ccp-opus-2');
    assert.equal(r.toRemove.length, 0);
});

// ── D5 幂等/边界: 完全一致 → 无动作 ──
test('13. computeAliasSyncActions 完全一致 → 无动作', () => {
    const derived = { derivedIndex: 2, modelAliases: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' } };
    const proxyAliases = {
        'ccp-haiku-2': 'claude-haiku-4-5',
        'ccp-sonnet-2': 'claude-sonnet-5',
        'ccp-opus-2': 'claude-opus-5',
    };
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toSet.length, 0);
    assert.equal(r.toRemove.length, 0);
});

// ── D5×D2: 别的编号残留不属于本节点 → 不清 ──
test('14. computeAliasSyncActions 别的编号残留不清（编号不回收）', () => {
    const derived = { derivedIndex: 2, modelAliases: { sonnet: 'claude-sonnet-5' } };
    const proxyAliases = {
        'ccp-sonnet-1': 'old-model', // 旧会话残留 N=1，本节点 N=2
        'ccp-haiku-2': 'claude-haiku-4-5',
        'ccp-sonnet-2': 'claude-sonnet-5',
    };
    const r = computeAliasSyncActions(derived, proxyAliases);
    // 只补本节点缺的 opus（haiku/sonnet 已在）；ccp-sonnet-1 不在 toRemove
    assert.equal(r.toSet.length, 0); // haiku 已在、sonnet 已在、opus 未配故不补
    assert.equal(r.toRemove.length, 0);
    assert.ok(!r.toRemove.includes('ccp-sonnet-1'));
});

// ── D5 边界: 本节点某档未配 → 不补该档 ──
test('15. computeAliasSyncActions 某档未配 → 不补该档', () => {
    const derived = { derivedIndex: 3, modelAliases: { sonnet: 'claude-sonnet-5' } }; // 只配 sonnet
    const proxyAliases = {};
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toSet.length, 1);
    assert.equal(r.toSet[0].alias, 'ccp-sonnet-3');
    // haiku/opus 未配，不补
    assert.ok(!r.toSet.find(a => a.alias === 'ccp-haiku-3'));
    assert.ok(!r.toSet.find(a => a.alias === 'ccp-opus-3'));
});

// ── D5 幂等 ──
test('16. computeAliasSyncActions 幂等', () => {
    const derived = { derivedIndex: 2, modelAliases: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' } };
    const proxyAliases = { 'ccp-sonnet-2': 'claude-sonnet-5' };
    const r1 = computeAliasSyncActions(derived, proxyAliases);
    const r2 = computeAliasSyncActions(derived, proxyAliases);
    assert.deepEqual(r1, r2);
});

// ── D7 空: aggregateModelCatalog 空 ──
test('17. aggregateModelCatalog 空 configs → []', () => {
    assert.deepEqual(aggregateModelCatalog([]), []);
});

// ── D7: 多源聚合去重 ──
test('18. aggregateModelCatalog global+local 多源去重', () => {
    const configs = [
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2' } }) },
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2', ANTHROPIC_SMALL_FAST_MODEL: 'glm-flash' } }) },
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'qwen-max' } }) },
    ];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('glm-5.2'));
    assert.ok(catalog.includes('glm-flash'));
    assert.ok(catalog.includes('qwen-max'));
    // 去重：glm-5.2 出现两次只留一个
    assert.equal(catalog.filter(m => m === 'glm-5.2').length, 1);
});

// ── D7: 含 derived 节点的 modelAliases 真实模型名 ──
test('19. aggregateModelCatalog 含 derived modelAliases 真实模型名', () => {
    const configs = [
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2' } }) },
        { modelAliases: { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' } },
    ];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('glm-5.2'));
    assert.ok(catalog.includes('claude-haiku-4-5'));
    assert.ok(catalog.includes('claude-sonnet-5'));
    assert.ok(catalog.includes('claude-opus-5'));
});

// ── D8: summarizeAliases 三档全配 ──
test('20. summarizeAliases 三档全配', () => {
    const s = summarizeAliases({ haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' });
    assert.ok(s.includes('S:claude-sonnet-5'), s);
    assert.ok(s.includes('H:claude-haiku-4-5'), s);
    assert.ok(s.includes('O:claude-opus-5'), s);
});

// ── D8 空态: modelAliases undefined ──
test('21. summarizeAliases undefined → 空串', () => {
    assert.equal(summarizeAliases(undefined), '');
    assert.equal(summarizeAliases({}), '');
});

// ── D8 边界: 只配 sonnet ──
test('22. summarizeAliases 只配 sonnet → 只显 S', () => {
    const s = summarizeAliases({ sonnet: 'claude-sonnet-5' });
    assert.ok(s.includes('S:claude-sonnet-5'), s);
    assert.ok(!s.includes('H:'), s);
    assert.ok(!s.includes('O:'), s);
});

// ── D2 兜底: nextDerivedIndex 本地兜底 ──
test('23. nextDerivedIndex 本地兜底 max+1 / 空→1', () => {
    assert.equal(nextDerivedIndex([]), 1);
    assert.equal(nextDerivedIndex([{ derivedIndex: 1 }]), 2);
    assert.equal(nextDerivedIndex([{ derivedIndex: 1 }, { derivedIndex: 5 }, { derivedIndex: 3 }]), 6);
    // 非派生节点（无 derivedIndex）不影响
    assert.equal(nextDerivedIndex([{ id: 'a' }, { derivedIndex: 2 }]), 3);
});

// ═══════════════════════════════════════════════════════════════════
// 审查怀疑点 TDD 用例（每点独立断言，失败→真 bug 修复，通过→翻转为回归用例）
// ═══════════════════════════════════════════════════════════════════

// ── S1 (类别3 类型安全/类别1 边界): computeAliasSyncActions derivedIndex=0 → aliasName 抛错 ──
// 怀疑：derivedIndex=0 能通过 `idx == null || !Number.isFinite(idx)` 守卫（0 非 null、是 finite），
// 但 aliasName(tier, 0) 会抛 "index 必须 >=1"。即 computeAliasSyncActions 对非法编号未拦截，内部抛错。
// 期望：computeAliasSyncActions 对 derivedIndex=0 应安全返回空动作（与缺编号一致），不抛错。
test('S1. computeAliasSyncActions derivedIndex=0 不应抛错（应返回空动作）', () => {
    const derived = { derivedIndex: 0, modelAliases: { sonnet: 'claude-sonnet-5' } };
    // 当前实现：idx=0 通过守卫 → aliasName('sonnet', 0) 抛错
    // 期望修复后：0 是非法编号，应同 null 一样返回空动作
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 0);
    assert.equal(r.toRemove.length, 0);
});

// ── S1b: computeAliasSyncActions derivedIndex=负数 → 同样应安全返回空 ──
test('S1b. computeAliasSyncActions derivedIndex=-1 不应抛错', () => {
    const derived = { derivedIndex: -1, modelAliases: { sonnet: 'claude-sonnet-5' } };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 0);
    assert.equal(r.toRemove.length, 0);
});

// ── S2 (类别3 类型安全/类别2 异常路径): aggregateModelCatalog 非字符串 env 值崩溃 ──
// 怀疑：extractUpstream 把 obj.env 强转为 Record<string,string>（不安全转型），
// 实际 env 值可能是数字/布尔/对象。aggregateModelCatalog 对其调 .trim() 会抛 "m.trim is not a function"。
// 期望：非字符串值应被跳过（不崩溃）。
test('S2. aggregateModelCatalog 非字符串 env 值不崩溃（数字/布尔/对象跳过）', () => {
    const configs = [
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: 123 } }) },          // 数字
        { content: JSON.stringify({ env: { ANTHROPIC_SMALL_FAST_MODEL: true } }) }, // 布尔
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: { a: 1 } } }) },     // 对象
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2' } }) },    // 正常字符串
    ];
    // 当前实现：遇到 123 会抛 m.trim is not a function
    // 期望修复后：跳过非字符串，返回 ['glm-5.2']
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('glm-5.2'));
    assert.ok(!catalog.includes('123'));  // 数字不应作为模型名
});

// ── S3 (类别3 类型安全): summarizeAliases 非字符串值崩溃 ──
// 怀疑：modelAliases 的某档值若为数字/对象，summarizeAliases 调 .trim() 会崩。
// 期望：非字符串值应被跳过。
test('S3. summarizeAliases 非字符串值不崩溃（跳过）', () => {
    // 数字值
    const s1 = summarizeAliases({ sonnet: 123 });
    assert.equal(s1, '');
    // 对象值
    const s2 = summarizeAliases({ haiku: { x: 1 }, sonnet: 'claude-sonnet-5' });
    assert.ok(s2.includes('S:claude-sonnet-5'));
    assert.ok(!s2.includes('H:'));
});

// ── S4 (类别3 类型安全): aggregateModelCatalog modelAliases 非字符串值 ──
test('S4. aggregateModelCatalog modelAliases 非字符串值不崩溃', () => {
    const configs = [
        { modelAliases: { sonnet: 999, haiku: 'claude-haiku-4-5' } },
    ];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('claude-haiku-4-5'));
    assert.ok(!catalog.includes('999'));
});

// ── S5 (类别1 边界): resolveDerivedUpstream 快照部分缺（baseUrl 有 token 无）→ 应回退父 ──
test('S5. resolveDerivedUpstream 快照 baseUrl 有 token 缺 → 回退父 content', () => {
    const derived = {
        derivedFrom: 'parent-1',
        derivedSnapshot: { baseUrl: 'http://snap.example', token: '', mode: 'direct' }, // token 空
    };
    const parent = { content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://p.example', ANTHROPIC_AUTH_TOKEN: 'p-token' } }), mode: 'direct' };
    const r = resolveDerivedUpstream(derived, parent);
    // 快照 token 空 → 不用快照 → 回退父 content
    assert.equal(r.baseUrl, 'http://p.example');
    assert.equal(r.token, 'p-token');
});

// ── S6 (类别1 边界): resolveDerivedUpstream 快照 baseUrl 缺 token 有 → 回退父 ──
test('S6. resolveDerivedUpstream 快照 baseUrl 缺 → 回退父 content', () => {
    const derived = {
        derivedFrom: 'parent-1',
        derivedSnapshot: { baseUrl: '', token: 'snap-token', mode: 'direct' }, // baseUrl 空
    };
    const parent = { content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://p.example', ANTHROPIC_AUTH_TOKEN: 'p-token' } }), mode: 'direct' };
    const r = resolveDerivedUpstream(derived, parent);
    assert.equal(r.baseUrl, 'http://p.example');
    assert.equal(r.token, 'p-token');
});

// ── S7 (类别1 边界): resolveDerivedUpstream 快照部分缺 + 父也缺 → null ──
test('S7. resolveDerivedUpstream 快照部分缺 + 父缺 → null', () => {
    const derived = {
        derivedFrom: 'parent-1',
        derivedSnapshot: { baseUrl: 'http://snap.example', token: '', mode: 'direct' }, // token 空
    };
    assert.equal(resolveDerivedUpstream(derived, undefined), null);
    assert.equal(resolveDerivedUpstream(derived, null), null);
});

// ── S8 (类别3 类型安全): resolveDerivedUpstream 父 content env 值非字符串 ──
// 怀疑：父 content 的 ANTHROPIC_BASE_URL 若是数字，extractUpstream 不检查类型，
// resolveDerivedUpstream 把数字当 baseUrl 返回（类型不安全）。后续合成 settings 时写数字进 env。
// 期望：非字符串的 baseUrl/token 应视为缺失 → null（或回退）。
test('S8. resolveDerivedUpstream 父 content env 值为数字 → 视为缺失返回 null', () => {
    const derived = { derivedFrom: 'parent-1' }; // 无快照
    const parent = { content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 123, ANTHROPIC_AUTH_TOKEN: 'p-token' } }), mode: 'direct' };
    // 当前实现：baseUrl=123（数字）是 truthy → 通过 `!baseUrl` 检查 → 返回 { baseUrl: 123, ... }
    // 期望：数字非合法 URL，应视为缺失 → null
    const r = resolveDerivedUpstream(derived, parent);
    assert.equal(r, null);
});

// ── S9 (类别1 边界): computeAliasSyncActions model 带尾空格 → 应 trim 后比较/设置 ──
// 怀疑：model = 'claude-sonnet-5 '（尾空格）会被原样 push 进 toSet（比较用 !== 不 trim）。
// 代理表若已有 'claude-sonnet-5'（无空格），会判定不一致 → 多余的 set 动作。
// 期望：model 应 trim 后再比较与设置（与"未配判定用 .trim()"一致）。
test('S9. computeAliasSyncActions model 带尾空格 → trim 后比较', () => {
    const derived = { derivedIndex: 2, modelAliases: { sonnet: 'claude-sonnet-5 ' } }; // 尾空格
    const proxyAliases = { 'ccp-sonnet-2': 'claude-sonnet-5' }; // 无空格
    const r = computeAliasSyncActions(derived, proxyAliases);
    // 当前实现：'claude-sonnet-5 ' !== 'claude-sonnet-5' → toSet 一条（多余动作）
    // 期望：trim 后一致 → 无动作
    assert.equal(r.toSet.length, 0);
});

// ── S10 (类别1 边界): aliasName N 大数（不溢出/不丢精度）──
test('S10. aliasName N 大数正常构造', () => {
    // N 是合理大数（非 Number.MAX_SAFE_INTEGER 边界，实际编号不会那么大，但验证不崩）
    assert.equal(aliasName('sonnet', 1000000), 'ccp-sonnet-1000000');
});

// ── S11 (类别1 边界): aliasName N 非整数（浮点）→ 抛错 ──
test('S11. aliasName N 浮点（非整数）→ 抛错', () => {
    assert.throws(() => aliasName('sonnet', 1.5), /index/);
});

// S11 修正：2.0 是整数（Number.isInteger(2.0)===true），不抛。翻转断言为回归用例。
test('S11b. aliasName N=2.0（浮点但整数）→ 正常', () => {
    assert.equal(aliasName('sonnet', 2.0), 'ccp-sonnet-2');
});

// ── S12 (类别3 类型安全): aliasName tier 大小写敏感 ──
test('S12. aliasName tier 大写 → 抛错（大小写敏感）', () => {
    assert.throws(() => aliasName('Sonnet', 1), /tier/);
    assert.throws(() => aliasName('HAIKU', 1), /tier/);
});

// ── S13 (类别1 边界): buildAliasEnv derivedIndex=0 → 抛错（与 aliasName 一致）──
test('S13. buildAliasEnv derivedIndex=0 → 抛错（编号必须 >=1）', () => {
    assert.throws(() => buildAliasEnv(0), /index/);
    assert.throws(() => buildAliasEnv(-1), /index/);
});

// ── S14 (类别1 边界): nextDerivedIndex 含 NaN/Infinity/负数 ──
test('S14. nextDerivedIndex 含 NaN/Infinity/负数 → 忽略', () => {
    assert.equal(nextDerivedIndex([{ derivedIndex: NaN }]), 1);
    assert.equal(nextDerivedIndex([{ derivedIndex: Infinity }]), 1);
    assert.equal(nextDerivedIndex([{ derivedIndex: -5 }]), 1);
    assert.equal(nextDerivedIndex([{ derivedIndex: 3 }, { derivedIndex: NaN }, { derivedIndex: 5 }]), 6);
});

// ── S15 (类别3 类型安全): nextDerivedIndex derivedIndex 为字符串数字 ──
// 怀疑：derivedIndex: '3'（字符串）typeof !== 'number' → 忽略。这是正确的（类型守卫）。
// 翻转为回归用例。
test('S15. nextDerivedIndex derivedIndex 为字符串 → 忽略（类型守卫正确）', () => {
    assert.equal(nextDerivedIndex([{ derivedIndex: '3' }]), 1);
    assert.equal(nextDerivedIndex([{ derivedIndex: 3 }, { derivedIndex: '5' }]), 4);
});

// ── S16 (类别5 时序竞态): computeAliasSyncActions 连续调用幂等（同输入同输出）──
// 已有 test 16 覆盖，此处补"代理表中途变化"场景：第一次补后第二次应无动作。
test('S16. computeAliasSyncActions 第一次补后第二次（代理表已含）→ 无动作', () => {
    const derived = { derivedIndex: 2, modelAliases: { sonnet: 'claude-sonnet-5' } };
    const r1 = computeAliasSyncActions(derived, {});
    assert.equal(r1.toSet.length, 1);
    // 模拟第一次 set 后代理表更新
    const updatedProxy = { 'ccp-sonnet-2': 'claude-sonnet-5' };
    const r2 = computeAliasSyncActions(derived, updatedProxy);
    assert.equal(r2.toSet.length, 0);
});

// ── S17 (类别6 一致性): computeAliasSyncActions toRemove 始终空（编号不回收，接口预留）──
test('S17. computeAliasSyncActions toRemove 始终为空（编号不回收）', () => {
    const derived = { derivedIndex: 2, modelAliases: { haiku: 'h', sonnet: 's', opus: 'o' } };
    const proxyAliases = { 'ccp-haiku-1': 'old', 'ccp-sonnet-99': 'stale' }; // 别的编号残留
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toRemove.length, 0);
});

// ── S18 (类别1 边界): aggregateModelCatalog content 为空串/非 JSON ──
test('S18. aggregateModelCatalog content 空串/非 JSON → 跳过不崩', () => {
    const configs = [
        { content: '' },
        { content: 'not-json' },
        { content: JSON.stringify({ env: {} }) },  // 空 env
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2' } }) },
    ];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('glm-5.2'));
    assert.equal(catalog.length, 1);
});

// ── S19 (类别3 类型安全): aggregateModelCatalog content 为 undefined ──
test('S19. aggregateModelCatalog content undefined → 跳过不崩', () => {
    const configs = [
        { },  // 无 content
        { content: undefined },
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2' } }) },
    ];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('glm-5.2'));
    assert.equal(catalog.length, 1);
});

// ── S20 (类别1 边界): summarizeAliases 空字符串值 ──
test('S20. summarizeAliases 空字符串值 → 跳过（不显示空档）', () => {
    assert.equal(summarizeAliases({ sonnet: '', haiku: '  ', opus: 'claude-opus-5' }), 'O:claude-opus-5');
});

// ── S21 (类别1 边界): isOrphan derivedFrom 缺失 ──
// 怀疑：derived 无 derivedFrom（非派生节点）但传给 isOrphan，parent=null → 返回 true（孤儿）。
// 语义上非派生节点不该判孤儿，但 isOrphan 不检查 derivedFrom。
// 这是调用方约束（buildDerivedNode 只对派生节点调），isOrphan 本身行为可接受。
// 翻转为回归用例：isOrphan 只看 parent 有无，不看 derivedFrom。
test('S21. isOrphan 只看 parent 有无（不看 derivedFrom）', () => {
    const notDerived = {};  // 无 derivedFrom
    assert.equal(isOrphan(notDerived, { id: 'x' }), false);
    assert.equal(isOrphan(notDerived, null), true);
});

// ── S22 (类别5 时序/类别1 边界): 终端 name 匹配 #N 不应误匹配 #N0/#N1 ──
// 怀疑：deleteDerivedAndAliases 用 t.name.includes(`#${idx}`) 匹配活终端，
// #2 会误匹配 `Claude Code #20 (xxx)` / `Claude Code #21 (xxx)`。
// 修复：用 `#${idx}(?![0-9])` 正则断言 #N 后非数字。
// 此处测纯逻辑（正则匹配），extension.ts 侧已改为正则。
test('S22. 终端 name 匹配 #2 不误匹配 #20/#21/#200', () => {
    const names = [
        'Claude Code #2 (session-a)',   // 应匹配
        'Claude Code #20 (session-b)',  // 不应匹配
        'Claude Code #21 (session-c)',  // 不应匹配
        'Claude Code #200 (session-d)', // 不应匹配
        'Claude Code #1 (session-e)',   // 不应匹配
    ];
    // 旧逻辑（子串匹配）的缺陷演示
    const oldMatch = names.filter(n => n.includes('#2'));
    assert.ok(oldMatch.length >= 4, '旧子串匹配会误匹配 #20/#21/#200');  // 确认缺陷存在

    // 新逻辑（正则断言）
    const idx = 2;
    const idxRe = new RegExp(`#${idx}(?![0-9])`);
    const newMatch = names.filter(n => idxRe.test(n));
    assert.equal(newMatch.length, 1);
    assert.equal(newMatch[0], 'Claude Code #2 (session-a)');
});

// ── S22b: 终端 name 匹配 #12 不误匹配 #1/#2 ──
test('S22b. 终端 name 匹配 #12 只匹配 #12', () => {
    const names = [
        'Claude Code #1 (a)',
        'Claude Code #12 (b)',
        'Claude Code #2 (c)',
        'Claude Code #120 (d)',
    ];
    const idx = 12;
    const idxRe = new RegExp(`#${idx}(?![0-9])`);
    const matched = names.filter(n => idxRe.test(n));
    assert.equal(matched.length, 1);
    assert.equal(matched[0], 'Claude Code #12 (b)');
});

// ── S23 (类别3 类型安全): resolveDerivedUpstream 快照 baseUrl/token 非字符串 → 回退父 ──
// 怀疑：快照数据损坏（baseUrl 是数字），snap.baseUrl 是 truthy → 通过检查 → 返回数字 baseUrl。
// 期望：非字符串快照值应视为无效，回退父 content（或 null）。
test('S23. resolveDerivedUpstream 快照 baseUrl 为数字 → 回退父 content', () => {
    const derived = {
        derivedFrom: 'parent-1',
        derivedSnapshot: { baseUrl: 123, token: 'snap-token', mode: 'direct' }, // baseUrl 数字（损坏）
    };
    const parent = { content: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://p.example', ANTHROPIC_AUTH_TOKEN: 'p-token' } }), mode: 'direct' };
    const r = resolveDerivedUpstream(derived, parent);
    // 当前实现（修复前）：baseUrl=123 是 truthy → 返回 { baseUrl: 123, ... }（数字）
    // 期望修复后：数字 baseUrl 无效 → 回退父 content
    assert.equal(r.baseUrl, 'http://p.example');
    assert.equal(r.token, 'p-token');
});

// ── S24 (类别3 类型安全): resolveDerivedUpstream 快照 token 非字符串 + 父缺 → null ──
test('S24. resolveDerivedUpstream 快照 token 为数字 + 父缺 → null', () => {
    const derived = {
        derivedFrom: 'parent-1',
        derivedSnapshot: { baseUrl: 'http://snap.example', token: 999, mode: 'direct' }, // token 数字
    };
    assert.equal(resolveDerivedUpstream(derived, undefined), null);
    assert.equal(resolveDerivedUpstream(derived, null), null);
});

// ── filterParentConfigs: 派生节点不在 local 分组重复渲染（回归 bug 防护）──
// bug 现象：local 分组遍历全部 configs（含派生）调 buildConfigNode，派生节点既在父下、
//          又作为普通 local 项出现（如 "52-52 #14" 多出一项）。修：过滤掉 derivedFrom 非空者。
test('filterParentConfigs: 排除派生节点，只留父 local 配置', () => {
    const configs = [
        { id: 'p1', name: 'parent1' },                              // 父
        { id: 'd1', name: 'derived1', derivedFrom: 'p1' },          // 派生（该被排除）
        { id: 'p2', name: 'parent2' },                              // 父
        { id: 'd2', name: 'orphan', derivedFrom: 'gone' },          // 孤儿派生（也排除）
    ];
    const parents = filterParentConfigs(configs);
    assert.equal(parents.length, 2);
    assert.deepEqual(parents.map(c => c.id), ['p1', 'p2']);
});

test('filterParentConfigs: derivedFrom 为空串/undefined 都算父', () => {
    const configs = [
        { id: 'a', derivedFrom: undefined },
        { id: 'b', derivedFrom: '' },
        { id: 'c', derivedFrom: 'parent-x' },
    ];
    const parents = filterParentConfigs(configs);
    assert.equal(parents.length, 2);
    assert.deepEqual(parents.map(c => c.id), ['a', 'b']);
});

test('filterParentConfigs: 空数组返空', () => {
    assert.deepEqual(filterParentConfigs([]), []);
});

test('filterParentConfigs: 全是派生节点返空（孤儿由 treeProvider 另挂）', () => {
    const configs = [
        { id: 'd1', derivedFrom: 'p1' },
        { id: 'd2', derivedFrom: 'p2' },
    ];
    assert.deepEqual(filterParentConfigs(configs), []);
});

// ═══════════════════════════════════════════════════════════════════
// 优化 2：主模型别名（ccp-main-N）+ 档位选项（[1m]）+ 继承
// 维度见 plan/tmp/2026-08-01-main-alias.md（D1 main / D2 [1m] / D3 继承）
// ═══════════════════════════════════════════════════════════════════

// ── D1+D2: aliasName main 档 × [1m] 后缀 ──
test('M1. aliasName main 档基本格式 + [1m] 后缀', () => {
    assert.equal(aliasName('main', 1, false), 'ccp-main-1');
    assert.equal(aliasName('main', 1, true), 'ccp-main-1[1m]');
    assert.equal(aliasName('main', 7, true), 'ccp-main-7[1m]');
    assert.equal(aliasName('main', 7, false), 'ccp-main-7');
});

// ── D1: aliasName main 档非法 N 抛错（与三档一致）──
test('M2. aliasName main 档 N=0/负数/浮点 → 抛错', () => {
    assert.throws(() => aliasName('main', 0), /index/);
    assert.throws(() => aliasName('main', -1), /index/);
    assert.throws(() => aliasName('main', 1.5), /index/);
});

// ── D2: buildAliasEnv with1m=false → 四档都不带后缀 ──
test('M3. buildAliasEnv with1m=false → 四档别名都不带 [1m]', () => {
    const env = buildAliasEnv(3, { with1m: false });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-3');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-3');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-3');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-3');
    // 确认无一档带 [1m]
    assert.ok(!Object.values(env).some(v => v.includes('[1m]')));
});

// ── D2: buildAliasEnv 默认 with1m=false（不传 opts）──
test('M4. buildAliasEnv 不传 opts → 默认不带 [1m]', () => {
    const env = buildAliasEnv(2);
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-2');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-2');
});

// ── D1+D5: computeAliasSyncActions 含 main 档（配了则补 ccp-main-N）──
test('M5. computeAliasSyncActions main 档配了 → 补 ccp-main-N', () => {
    const derived = {
        derivedIndex: 2,
        modelAliases: { main: 'glm-5.2', haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5' },
    };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 4);
    assert.ok(r.toSet.find(a => a.alias === 'ccp-main-2' && a.model === 'glm-5.2'));
    assert.ok(r.toSet.find(a => a.alias === 'ccp-haiku-2' && a.model === 'claude-haiku-4-5'));
    assert.ok(r.toSet.find(a => a.alias === 'ccp-sonnet-2' && a.model === 'claude-sonnet-5'));
    assert.ok(r.toSet.find(a => a.alias === 'ccp-opus-2' && a.model === 'claude-opus-5'));
    // 映射 key 不带 [1m]（约束 3）
    assert.ok(!r.toSet.some(a => a.alias.includes('[1m]')));
});

// ── D5: main 档未配 → 不补 main（其余三档照常）──
test('M6. computeAliasSyncActions main 档未配 → 不补 main', () => {
    const derived = {
        derivedIndex: 2,
        modelAliases: { sonnet: 'claude-sonnet-5' }, // 只配 sonnet，main/haiku/opus 未配
    };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 1);
    assert.equal(r.toSet[0].alias, 'ccp-sonnet-2');
    assert.ok(!r.toSet.find(a => a.alias === 'ccp-main-2'));
});

// ── D5: main 档代理表已含且一致 → 无动作 ──
test('M7. computeAliasSyncActions main 档一致 → 无动作', () => {
    const derived = {
        derivedIndex: 2,
        modelAliases: { main: 'glm-5.2' },
    };
    const proxyAliases = { 'ccp-main-2': 'glm-5.2' };
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toSet.length, 0);
});

// ── D5: main 档代理表含但值不一致 → 覆盖 ──
test('M8. computeAliasSyncActions main 档不一致 → 覆盖', () => {
    const derived = {
        derivedIndex: 2,
        modelAliases: { main: 'glm-5.2' },
    };
    const proxyAliases = { 'ccp-main-2': 'old-model' };
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toSet.length, 1);
    assert.equal(r.toSet[0].alias, 'ccp-main-2');
    assert.equal(r.toSet[0].model, 'glm-5.2');
});

// ── D4+D5: main 档 + N=0 → 空动作（与三档一致，防 aliasName 抛错）──
test('M9. computeAliasSyncActions main 档 + N=0 → 空动作不抛错', () => {
    const derived = {
        derivedIndex: 0,
        modelAliases: { main: 'glm-5.2', sonnet: 'claude-sonnet-5' },
    };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 0);
    assert.equal(r.toRemove.length, 0);
});

// ── D5: main 档 model 带尾空格 → trim 后比较（与 S9 一致）──
test('M10. computeAliasSyncActions main 档 model 带尾空格 → trim', () => {
    const derived = { derivedIndex: 2, modelAliases: { main: 'glm-5.2 ' } };
    const proxyAliases = { 'ccp-main-2': 'glm-5.2' };
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toSet.length, 0);
});

// ── D1+D7: summarizeAliases 含 main 档（M: 前缀）──
test('M11. summarizeAliases 含 main 档 → M: 前缀', () => {
    const s = summarizeAliases({ main: 'glm-5.2', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5', opus: 'claude-opus-5' });
    assert.ok(s.includes('M:glm-5.2'), s);
    assert.ok(s.includes('S:claude-sonnet-5'), s);
    assert.ok(s.includes('H:claude-haiku-4-5'), s);
    assert.ok(s.includes('O:claude-opus-5'), s);
});

// ── D7: summarizeAliases 只配 main ──
test('M12. summarizeAliases 只配 main → 只显 M', () => {
    const s = summarizeAliases({ main: 'glm-5.2' });
    assert.ok(s.includes('M:glm-5.2'), s);
    assert.ok(!s.includes('S:'), s);
    assert.ok(!s.includes('H:'), s);
    assert.ok(!s.includes('O:'), s);
});

// ── D7 异常: summarizeAliases main 非字符串值 → 跳过不崩 ──
test('M13. summarizeAliases main 非字符串值 → 跳过', () => {
    const s = summarizeAliases({ main: 123, sonnet: 'claude-sonnet-5' });
    assert.ok(s.includes('S:claude-sonnet-5'));
    assert.ok(!s.includes('M:'));
    assert.equal(summarizeAliases({ main: { x: 1 } }), '');
});

// ── D7 边界: summarizeAliases main 空串/纯空白 → 跳过 ──
test('M14. summarizeAliases main 空串/纯空白 → 跳过', () => {
    assert.equal(summarizeAliases({ main: '' }), '');
    assert.equal(summarizeAliases({ main: '   ' }), '');
});

// ── D1+D8: aggregateModelCatalog 含 main 档真实模型名 ──
test('M15. aggregateModelCatalog 含 derived modelAliases.main 真实模型名', () => {
    const configs = [
        { content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2' } }) },
        { modelAliases: { main: 'qwen-max', haiku: 'claude-haiku-4-5' } },
    ];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('glm-5.2'));
    assert.ok(catalog.includes('qwen-max'));
    assert.ok(catalog.includes('claude-haiku-4-5'));
});

// ── D8 异常: aggregateModelCatalog main 非字符串值 → 跳过 ──
test('M16. aggregateModelCatalog main 非字符串值 → 跳过', () => {
    const configs = [{ modelAliases: { main: 999, sonnet: 'claude-sonnet-5' } }];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('claude-sonnet-5'));
    assert.ok(!catalog.includes('999'));
});

// ── D3: inheritSessionContext1m 父 ANTHROPIC_MODEL 带 [1m] → 四档 true（per-tier，对象）──
test('M17. inheritSessionContext1m 父带 [1m] → 四档 true', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2[1m]' } });
    assert.deepEqual(inheritSessionContext1m(content), { main: true, haiku: true, sonnet: true, opus: true });
});

// ── D3: inheritSessionContext1m 父不带 [1m] → 四档 false ──
test('M18. inheritSessionContext1m 父不带 [1m] → 四档 false', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2' } });
    assert.deepEqual(inheritSessionContext1m(content), { main: false, haiku: false, sonnet: false, opus: false });
});

// ── D3: inheritSessionContext1m 父无 ANTHROPIC_MODEL → 四档 false（保守 200K）──
test('M19. inheritSessionContext1m 父无 ANTHROPIC_MODEL → 四档 false', () => {
    assert.deepEqual(inheritSessionContext1m(JSON.stringify({ env: {} })), { main: false, haiku: false, sonnet: false, opus: false });
    assert.deepEqual(inheritSessionContext1m(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x' } })), { main: false, haiku: false, sonnet: false, opus: false });
});

// ── D3: inheritSessionContext1m 父 content 无效 JSON → 四档 false ──
test('M20. inheritSessionContext1m 父 content 无效 JSON → 四档 false', () => {
    assert.deepEqual(inheritSessionContext1m('not-json'), { main: false, haiku: false, sonnet: false, opus: false });
    assert.deepEqual(inheritSessionContext1m(''), { main: false, haiku: false, sonnet: false, opus: false });
});

// ── D3 边界: inheritSessionContext1m 父 ANTHROPIC_MODEL 大写 [1M] → 四档 true（CLI /\[1m\]/i 识别）──
test('M21. inheritSessionContext1m 父带大写 [1M] → 四档 true（大小写不敏感）', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2[1M]' } });
    assert.deepEqual(inheritSessionContext1m(content), { main: true, haiku: true, sonnet: true, opus: true });
});

// ── D3 边界: inheritSessionContext1m 父 ANTHROPIC_MODEL 非字符串 → 四档 false ──
test('M22. inheritSessionContext1m 父 ANTHROPIC_MODEL 非字符串 → 四档 false', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 123 } });
    assert.deepEqual(inheritSessionContext1m(content), { main: false, haiku: false, sonnet: false, opus: false });
});

// ── D3 边界: inheritSessionContext1m 父 ANTHROPIC_MODEL 带 [2m]（CLI 不识别）→ false ──
test('M23. inheritSessionContext1m 父带 [2m]（CLI 不识别）→ false', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2[2m]' } });
    assert.deepEqual(inheritSessionContext1m(content), TIER_200K_ALL);
});

// ═══════════════════════════════════════════════════════════════════
// 优化 2 代码审查 TDD 用例（R1..Rn，每点独立断言）
// ═══════════════════════════════════════════════════════════════════

// ── R1 (类别1 边界): inheritSessionContext1m 父 ANTHROPIC_MODEL 空串 → false ──
test('R1. inheritSessionContext1m 父 ANTHROPIC_MODEL 空串 → false', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: '' } });
    assert.deepEqual(inheritSessionContext1m(content), TIER_200K_ALL);
});

// ── R2 (类别1 边界): inheritSessionContext1m 父 ANTHROPIC_MODEL 纯空白串 → false ──
// 怀疑：纯空白串 '   ' 是 truthy？不，空串才是 falsy。'   ' 是 truthy → 通过 !m 检查，
// 但 /\[1m\]/i.test('   ') = false → 返回 false。应安全。
test('R2. inheritSessionContext1m 父 ANTHROPIC_MODEL 纯空白串 → false', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: '   ' } });
    assert.deepEqual(inheritSessionContext1m(content), TIER_200K_ALL);
});

// ── R3 (类别3 类型安全): inheritSessionContext1m 父 ANTHROPIC_MODEL 为 null ──
// 怀疑：JSON 里 ANTHROPIC_MODEL: null，extractUpstream 把 env 强转 Record<string,string>，
// 但 null 实际值是 null（typeof null === 'object'）。typeof m !== 'string' 守卫应捕获。
test('R3. inheritSessionContext1m 父 ANTHROPIC_MODEL 为 null → false', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: null } });
    assert.deepEqual(inheritSessionContext1m(content), TIER_200K_ALL);
});

// ── R4 (类别3 类型安全): inheritSessionContext1m 父 ANTHROPIC_MODEL 为布尔 ──
test('R4. inheritSessionContext1m 父 ANTHROPIC_MODEL 为布尔 → false', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: true } });
    assert.deepEqual(inheritSessionContext1m(content), TIER_200K_ALL);
});

// ── R5 (类别1 边界): inheritSessionContext1m 父 ANTHROPIC_MODEL 带 [1m] 但中间穿插空格 ──
// 怀疑：'glm-5.2 [1m]'（空格在 [1m] 前）→ /\[1m\]/i 仍匹配 → true。
// CLI has1mContext 也是 /\[1m\]/i 子串匹配，行为一致。非 bug，回归保护。
test('R5. inheritSessionContext1m 父 [1m] 前有空格 → true（子串匹配，与 CLI 一致）', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2 [1m]' } });
    assert.deepEqual(inheritSessionContext1m(content), TIER_1M_ALL);
});

// ── R6 (类别1 边界): inheritSessionContext1m 父 ANTHROPIC_MODEL 带 [1m] 多次出现 → true ──
test('R6. inheritSessionContext1m 父 [1m] 多次出现 → true', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm[1m]-5.2[1m]' } });
    assert.deepEqual(inheritSessionContext1m(content), TIER_1M_ALL);
});

// ── R7 (类别3 类型安全): computeAliasSyncActions modelAliases.main 为数字 → 跳过 ──
test('R7. computeAliasSyncActions modelAliases.main 为数字 → 跳过不崩', () => {
    const derived = { derivedIndex: 2, modelAliases: { main: 123, sonnet: 'claude-sonnet-5' } };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 1);
    assert.equal(r.toSet[0].alias, 'ccp-sonnet-2');
    assert.ok(!r.toSet.some(a => a.alias === 'ccp-main-2'));
});

// ── R8 (类别3 类型安全): computeAliasSyncActions modelAliases.main 为 null → 跳过 ──
test('R8. computeAliasSyncActions modelAliases.main 为 null → 跳过', () => {
    const derived = { derivedIndex: 2, modelAliases: { main: null, sonnet: 'claude-sonnet-5' } };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 1);
    assert.ok(!r.toSet.some(a => a.alias === 'ccp-main-2'));
});

// ── R9 (类别3 类型安全): computeAliasSyncActions modelAliases.main 为对象 → 跳过 ──
test('R9. computeAliasSyncActions modelAliases.main 为对象 → 跳过不崩', () => {
    const derived = { derivedIndex: 2, modelAliases: { main: { x: 1 }, haiku: 'claude-haiku-4-5' } };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 1);
    assert.equal(r.toSet[0].alias, 'ccp-haiku-2');
});

// ── R10 (类别3 类型安全): aggregateModelCatalog modelAliases.main 为数字 → 跳过 ──
test('R10. aggregateModelCatalog modelAliases.main 为数字 → 跳过', () => {
    const configs = [{ modelAliases: { main: 123, sonnet: 'claude-sonnet-5' } }];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('claude-sonnet-5'));
    assert.ok(!catalog.includes('123'));
});

// ── R11 (类别3 类型安全): aggregateModelCatalog modelAliases.main 为 null → 跳过 ──
test('R11. aggregateModelCatalog modelAliases.main 为 null → 跳过', () => {
    const configs = [{ modelAliases: { main: null, haiku: 'claude-haiku-4-5' } }];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('claude-haiku-4-5'));
    assert.equal(catalog.length, 1);
});

// ── R12 (类别1 边界): computeAliasSyncActions derivedIndex 为字符串数字 '2' → 空动作 ──
// 怀疑：idx='2'（字符串），idx==null 为 false，Number.isFinite('2') 为 false（字符串非数字）
// → 返回空动作。应安全。
test('R12. computeAliasSyncActions derivedIndex 为字符串 "2" → 空动作', () => {
    const derived = { derivedIndex: '2', modelAliases: { sonnet: 'claude-sonnet-5' } };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 0);
    assert.equal(r.toRemove.length, 0);
});

// ── R13 (类别1 边界): computeAliasSyncActions derivedIndex 为 NaN → 空动作 ──
test('R13. computeAliasSyncActions derivedIndex 为 NaN → 空动作', () => {
    const derived = { derivedIndex: NaN, modelAliases: { sonnet: 'claude-sonnet-5' } };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 0);
});

// ── R14 (类别1 边界): computeAliasSyncActions derivedIndex 为 Infinity → 空动作 ──
test('R14. computeAliasSyncActions derivedIndex 为 Infinity → 空动作', () => {
    const derived = { derivedIndex: Infinity, modelAliases: { sonnet: 'claude-sonnet-5' } };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 0);
});

// ── R15 (类别1 边界): buildAliasEnv derivedIndex 为浮点 1.5 → 抛错（与 aliasName 一致）──
test('R15. buildAliasEnv derivedIndex=1.5 → 抛错', () => {
    assert.throws(() => buildAliasEnv(1.5), /index/);
});

// ── R16 (类别1 边界): summarizeAliases 四档全配顺序 M·S·H·O ──
test('R16. summarizeAliases 四档全配 → 顺序 M · S · H · O', () => {
    const s = summarizeAliases({ main: 'glm-5.2', sonnet: 's', haiku: 'h', opus: 'o' });
    assert.equal(s, 'M:glm-5.2 · S:s · H:h · O:o');
});

// ── R17 (类别1 边界): inheritSessionContext1m 父 content 为 null（JSON null）──
test('R17. inheritSessionContext1m 父 content 为 JSON null → false', () => {
    assert.deepEqual(inheritSessionContext1m('null'), TIER_200K_ALL);
});

// ── R18 (类别1 边界): inheritSessionContext1m 父 content 为 JSON 数组 ──
// 怀疑：JSON.parse('[1,2]') 成功，obj.env 是 undefined → (obj.env ?? {}) = {} → parsed 非 null
// 但 parsed.env 是 {}，无 ANTHROPIC_MODEL → false。应安全。
test('R18. inheritSessionContext1m 父 content 为 JSON 数组 → false', () => {
    assert.deepEqual(inheritSessionContext1m('[1,2,3]'), TIER_200K_ALL);
});

// ── R19 (类别1 边界): inheritSessionContext1m 父 env 里 ANTHROPIC_MODEL 带混合大小写 [1M]/[1m] ──
test('R19. inheritSessionContext1m 父带 [1M] 大写 → true（大小写不敏感）', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2[1M]' } });
    assert.deepEqual(inheritSessionContext1m(content), TIER_1M_ALL);
});

// ── R20 (类别1 边界): inheritSessionContext1m 父 ANTHROPIC_MODEL 带 [1m] 但值是别名 ccp-main-1[1m] ──
// 场景：父本身就是派生节点（content 含别名）。extractUpstream 解出别名串，[1m] 匹配 → true。
test('R20. inheritSessionContext1m 父 ANTHROPIC_MODEL 是别名 ccp-main-1[1m] → true', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'ccp-main-1[1m]' } });
    assert.deepEqual(inheritSessionContext1m(content), TIER_1M_ALL);
});

// ── R21 (类别4 状态转换): computeAliasSyncActions main 档 model 带尾空格 + 代理表不一致 ──
// 怀疑：main: 'glm-5.2 '（尾空格），代理表 { 'ccp-main-2': 'old' }。
// trim 后 model='glm-5.2'，与 'old' 不一致 → toSet 一条 ccp-main-2: glm-5.2（trim 后）。
test('R21. computeAliasSyncActions main 档 model 带尾空格 + 代理表不一致 → trim 后 set', () => {
    const derived = { derivedIndex: 2, modelAliases: { main: 'glm-5.2 ' } };
    const proxyAliases = { 'ccp-main-2': 'old' };
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toSet.length, 1);
    assert.equal(r.toSet[0].alias, 'ccp-main-2');
    assert.equal(r.toSet[0].model, 'glm-5.2');  // trim 后
});

// ── R22 (类别4 状态转换): computeAliasSyncActions 四档部分配部分一致 → 只补缺的 ──
test('R22. computeAliasSyncActions 四档部分配部分一致 → 只补缺的', () => {
    const derived = {
        derivedIndex: 3,
        modelAliases: { main: 'glm-5.2', sonnet: 'claude-sonnet-5' },
    };
    const proxyAliases = { 'ccp-main-3': 'glm-5.2' };  // main 一致，sonnet 缺
    const r = computeAliasSyncActions(derived, proxyAliases);
    assert.equal(r.toSet.length, 1);
    assert.equal(r.toSet[0].alias, 'ccp-sonnet-3');
});

// ── R23 (类别5 时序): computeAliasSyncActions 四档全配 + 代理表全空 → 补四条 ──
test('R23. computeAliasSyncActions 四档全配 + 代理表空 → 补四条', () => {
    const derived = {
        derivedIndex: 1,
        modelAliases: { main: 'glm-5.2', haiku: 'h', sonnet: 's', opus: 'o' },
    };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 4);
    assert.ok(r.toSet.find(a => a.alias === 'ccp-main-1'));
    assert.ok(r.toSet.find(a => a.alias === 'ccp-haiku-1'));
    assert.ok(r.toSet.find(a => a.alias === 'ccp-sonnet-1'));
    assert.ok(r.toSet.find(a => a.alias === 'ccp-opus-1'));
});

// ── R24 (类别6 一致性): computeAliasSyncActions 映射 key 不带 [1m]（约束 3）──
// 怀疑：即使 derivedIndex 配了 sessionContext1m（但 computeAliasSyncActions 不读此字段），
// alias 应不带 [1m]。computeAliasSyncActions 调 aliasName(tier, idx) 无第三参 → 默认 false。
test('R24. computeAliasSyncActions 映射 key 永不带 [1m]（不读 sessionContext1m）', () => {
    const derived = {
        derivedIndex: 1,
        modelAliases: { main: 'glm-5.2', sonnet: 's' },
        sessionContext1m: true,  // 即使 true，映射 key 不带后缀
    };
    const r = computeAliasSyncActions(derived, {});
    assert.ok(r.toSet.every(a => !a.alias.includes('[1m]')));
});

// ── R25 (类别1 边界): buildAliasEnv with1m=true → 四档都带 [1m]（含 main）──
test('R25. buildAliasEnv with1m=true → 四档都带 [1m]', () => {
    const env = buildAliasEnv(1, { with1m: true });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1[1m]');
});

// ── R26 (类别1 边界): inheritSessionContext1m 父 env 为非对象（数字）──
// 怀疑：JSON { "env": 123 }，extractUpstream 解析 obj.env=123，强转 Record<string,string>。
// parsed.env 是 123（数字），但被 as 成 Record<string,string>。访问 parsed.env.ANTHROPIC_MODEL
// → 123['ANTHROPIC_MODEL'] = undefined。typeof undefined !== 'string' → false。应安全。
test('R26. inheritSessionContext1m 父 env 为数字 → false', () => {
    const content = JSON.stringify({ env: 123 });
    assert.deepEqual(inheritSessionContext1m(content), TIER_200K_ALL);
});

// ── R27 (类别1 边界): inheritSessionContext1m 父 env 为数组 ──
test('R27. inheritSessionContext1m 父 env 为数组 → false', () => {
    const content = JSON.stringify({ env: [1, 2] });
    assert.deepEqual(inheritSessionContext1m(content), TIER_200K_ALL);
});

// ── R28 (类别1 边界): inheritSessionContext1m 父 env 为 null ──
// 怀疑：JSON { "env": null }，obj.env = null，extractUpstream (obj.env ?? {}) = {}。
// parsed.env.ANTHROPIC_MODEL = undefined → false。应安全。
test('R28. inheritSessionContext1m 父 env 为 null → false', () => {
    const content = JSON.stringify({ env: null });
    assert.deepEqual(inheritSessionContext1m(content), TIER_200K_ALL);
});

// ── R29 (类别2 异常路径): inheritSessionContext1m 传入 undefined（JS 运行时）──
// 怀疑：extractUpstream(undefined) → JSON.parse(undefined) → 抛 → catch → null → false。
// 虽 TS 签名是 string，但运行时可能传 undefined（父 content 缺失）。应不崩。
test('R29. inheritSessionContext1m 传入 undefined → false（不崩）', () => {
    assert.deepEqual(inheritSessionContext1m(undefined), TIER_200K_ALL);
});

// ── R30 (类别2 异常路径): inheritSessionContext1m 传入 null ──
test('R30. inheritSessionContext1m 传入 null → false（不崩）', () => {
    assert.deepEqual(inheritSessionContext1m(null), TIER_200K_ALL);
});

// ── R31 (类别2 异常路径): inheritSessionContext1m 传入数字 ──
test('R31. inheritSessionContext1m 传入数字 → false（不崩）', () => {
    assert.deepEqual(inheritSessionContext1m(123), TIER_200K_ALL);
});

// ── R32 (类别2 异常路径): inheritSessionContext1m 传入对象 ──
// 怀疑：JSON.parse(object) → JSON.parse("[object Object]") → 抛 → null → false。
test('R32. inheritSessionContext1m 传入对象 → false（不崩）', () => {
    assert.deepEqual(inheritSessionContext1m({ env: { ANTHROPIC_MODEL: 'x[1m]' } }), TIER_200K_ALL);
});

// ── R33 (类别1 边界): computeAliasSyncActions modelAliases 为 null ──
// 怀疑：derived.modelAliases = null，mapping = null ?? {} = {}。遍历四档 raw=undefined → 跳过。
test('R33. computeAliasSyncActions modelAliases=null → 空动作', () => {
    const derived = { derivedIndex: 2, modelAliases: null };
    const r = computeAliasSyncActions(derived, {});
    assert.equal(r.toSet.length, 0);
});

// ── R34 (类别1 边界): aggregateModelCatalog modelAliases 为 null ──
test('R34. aggregateModelCatalog modelAliases=null → 跳过不崩', () => {
    const configs = [{ modelAliases: null, content: JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm-5.2' } }) }];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('glm-5.2'));
    assert.equal(catalog.length, 1);
});

// ── R35 (类别1 边界): summarizeAliases main 带尾空格 → trim 前显示？──
// 怀疑：summarizeAliases 对 main 调 .trim() 判定是否显示，但显示用 modelAliases.main（未 trim）。
// 即 'glm-5.2 '（尾空格）→ trim() truthy → 显示 'M:glm-5.2 '（带尾空格）。
// 这是显示层小瑕疵（尾空格进树 description），非功能 bug。回归保护。
test('R35. summarizeAliases main 带尾空格 → 显示带空格（trim 只用于判定）', () => {
    const s = summarizeAliases({ main: 'glm-5.2 ' });
    assert.ok(s.includes('M:glm-5.2'));
    // 注意：显示值未 trim，带尾空格——这是已知小瑕疵
});

// ── R36 (类别6 一致性): aliasName main 档错误消息含 main ──
test('R36. aliasName 非法 tier 错误消息含全部四档', () => {
    try {
        aliasName('best', 1);
        assert.fail('应抛错');
    } catch (e) {
        assert.ok(/main/.test(e.message), `错误消息应含 main: ${e.message}`);
        assert.ok(/haiku/.test(e.message), `错误消息应含 haiku: ${e.message}`);
    }
});

// ── R37 (类别1 边界): buildAliasEnv 四档 key 名称正确（ANTHROPIC_MODEL 非 DEFAULT）──
// 怀疑：main 走 ANTHROPIC_MODEL（不带 DEFAULT_ 前缀），三档走 ANTHROPIC_DEFAULT_*_MODEL。
// 验证 key 命名不串。
test('R37. buildAliasEnv key 命名：main→ANTHROPIC_MODEL，三档→ANTHROPIC_DEFAULT_*_MODEL', () => {
    const env = buildAliasEnv(1, { with1m: false });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1');
    // 不应有 ANTHROPIC_DEFAULT_MAIN_MODEL
    assert.equal(env.ANTHROPIC_DEFAULT_MAIN_MODEL, undefined);
});

// ═══════════════════════════════════════════════════════════════════
// RV (Review Verification) — 第二轮审查怀疑点 TDD 验证
// ═══════════════════════════════════════════════════════════════════

// ── RV1 (类别2 异常路径): resolveDerivedUpstream 父 content API_TIMEOUT_MS 非数字 → timeoutSec=NaN ──
// 怀疑：API_TIMEOUT_MS: "abc"（非数字字符串），Number("abc")=NaN，Math.round(NaN/1000)=NaN。
// resolveDerivedUpstream 返回 timeoutSec: NaN（而非 undefined）。
// 后续 synthesizeDerivedSettings 用 NaN != null（true）→ env.API_TIMEOUT_MS = "NaN"（脏值写进 settings.json）。
// 期望：非数字的 API_TIMEOUT_MS 应视为缺失 → timeoutSec: undefined（不应产生 NaN）。
test('RV1. resolveDerivedUpstream 父 API_TIMEOUT_MS 非数字 → timeoutSec 应为 undefined（非 NaN）', () => {
    const derived = { derivedFrom: 'p1' }; // 无快照
    const parent = {
        content: JSON.stringify({ env: {
            ANTHROPIC_BASE_URL: 'http://p.example',
            ANTHROPIC_AUTH_TOKEN: 'p-token',
            API_TIMEOUT_MS: 'abc',  // 非数字
        } }),
        mode: 'direct',
    };
    const r = resolveDerivedUpstream(derived, parent);
    assert.notEqual(r, null);
    // 当前实现：timeoutSec = Math.round(Number('abc')/1000) = NaN
    // 期望：NaN 应视为缺失 → undefined
    assert.equal(r.timeoutSec, undefined, `timeoutSec 应为 undefined，实际=${r.timeoutSec}（NaN 会污染 settings.json）`);
});

// ── RV1b: API_TIMEOUT_MS 为空串 → Number('')=0 → timeoutSec=0（应 undefined）──
// 怀疑：API_TIMEOUT_MS: ""（空串），Number("")=0，Math.round(0/1000)=0。
// 0 是 falsy 但 !=null，synthesizeDerivedSettings 会写 API_TIMEOUT_MS="0"（0ms 超时 = 立即超时！）。
// 期望：空串/0 应视为缺失 → undefined。
test('RV1b. resolveDerivedUpstream 父 API_TIMEOUT_MS 空串 → timeoutSec 应为 undefined（非 0）', () => {
    const derived = { derivedFrom: 'p1' };
    const parent = {
        content: JSON.stringify({ env: {
            ANTHROPIC_BASE_URL: 'http://p.example',
            ANTHROPIC_AUTH_TOKEN: 'p-token',
            API_TIMEOUT_MS: '',  // 空串
        } }),
        mode: 'direct',
    };
    const r = resolveDerivedUpstream(derived, parent);
    assert.notEqual(r, null);
    // 当前实现：Number('')=0 → timeoutSec=0（0 秒超时会立即超时）
    // 期望：空串应视为缺失 → undefined
    assert.equal(r.timeoutSec, undefined, `timeoutSec 应为 undefined，实际=${r.timeoutSec}（0 会立即超时）`);
});

// ── RV2 (类别1 边界): resolveDerivedUpstream 快照 timeoutSec=NaN 透传 ──
// 怀疑：快照里 timeoutSec=NaN（snapshotFromParent 对非数字 API_TIMEOUT_MS 算出 NaN 存入），
// resolveDerivedUpstream 快照路径不检查 timeoutSec 类型，直接透传 NaN。
// 期望：快照 timeoutSec 非 finite 数字应视为 undefined。
test('RV2. resolveDerivedUpstream 快照 timeoutSec=NaN → 应视为 undefined（非透传 NaN）', () => {
    const derived = {
        derivedFrom: 'p1',
        derivedSnapshot: { baseUrl: 'http://snap', token: 'tok', timeoutSec: NaN, mode: 'direct' },
    };
    const r = resolveDerivedUpstream(derived, null);
    assert.notEqual(r, null);
    // 当前实现：timeoutSec: snap.timeoutSec = NaN（透传）
    // 期望：NaN 应归一为 undefined
    assert.equal(r.timeoutSec, undefined, `timeoutSec 应为 undefined，实际=${r.timeoutSec}`);
});

// ── RV3 (类别1 边界): resolveDerivedUpstream 快照 timeoutSec 为字符串 ──
// 怀疑：快照数据损坏（timeoutSec 是字符串 "300"），resolveDerivedUpstream 透传字符串。
// synthesizeDerivedSettings 用 String(Math.round("300"*1000)) = "300000"（巧合正确），
// 但若 timeoutSec 是 "abc" 字符串则 Math.round(NaN)="NaN"。
// 期望：非数字 timeoutSec 应归一为 undefined 或数字。
test('RV3. resolveDerivedUpstream 快照 timeoutSec 为字符串 "abc" → 应归一为 undefined', () => {
    const derived = {
        derivedFrom: 'p1',
        derivedSnapshot: { baseUrl: 'http://snap', token: 'tok', timeoutSec: 'abc', mode: 'direct' },
    };
    const r = resolveDerivedUpstream(derived, null);
    assert.notEqual(r, null);
    // 当前实现：透传字符串 'abc'
    // 期望：非 finite 数字归一为 undefined
    assert.equal(r.timeoutSec, undefined, `timeoutSec 应为 undefined，实际=${r.timeoutSec}`);
});

// ── RV4 (类别1 边界): aggregateModelCatalog 父 ANTHROPIC_SMALL_FAST_MODEL 带尾空格 ──
// 怀疑：aggregateModelCatalog 对 content 解出的模型名用 .trim() 判定+加入 set，
// 但 ANTHROPIC_SMALL_FAST_MODEL 路径也应有 trim（现有代码已有）。验证不崩。
test('RV4. aggregateModelCatalog ANTHROPIC_SMALL_FAST_MODEL 带尾空格 → trim', () => {
    const configs = [
        { content: JSON.stringify({ env: { ANTHROPIC_SMALL_FAST_MODEL: 'glm-flash  ' } }) },
    ];
    const catalog = aggregateModelCatalog(configs);
    assert.ok(catalog.includes('glm-flash'));
    assert.ok(!catalog.some(m => m !== m.trim()));
});

// ── RV5 (类别6 一致性): computeAliasSyncActions 代理表值带尾空格 → 视为不一致 ──
// 怀疑：代理表 { 'ccp-sonnet-2': 'claude-sonnet-5 ' }（尾空格），派生节点配 'claude-sonnet-5'。
// trim 后 model='claude-sonnet-5'，proxyAliases['ccp-sonnet-2']='claude-sonnet-5 '（未 trim）。
// 'claude-sonnet-5' !== 'claude-sonnet-5 ' → toSet 一条（多余动作）。
// 代理表值是否也应 trim 比较？当前不 trim 代理表值，只 trim 派生节点值。
// 这是设计选择（代理表权威，不归一化），但会导致每次启动都多余 set。
test('RV5. computeAliasSyncActions 代理表值带尾空格 → 多余 set（代理表值未 trim）', () => {
    const derived = { derivedIndex: 2, modelAliases: { sonnet: 'claude-sonnet-5' } };
    const proxyAliases = { 'ccp-sonnet-2': 'claude-sonnet-5 ' }; // 代理表值带尾空格
    const r = computeAliasSyncActions(derived, proxyAliases);
    // 当前实现：代理表值不 trim → 'claude-sonnet-5' !== 'claude-sonnet-5 ' → toSet 一条
    // 这是已知行为（代理表权威不归一化），记录为"每次启动多余 set"的轻微低效
    // 翻转为回归用例：确认代理表值不 trim 比较（设计选择）
    assert.ok(r.toSet.length >= 1, '代理表值带尾空格时，派生节点 trim 后值不一致 → toSet 至少一条（设计选择：代理表权威不归一化）');
});

// ══════════════════════════════════════════════════════════════════
// PT 系列：per-tier 1m（每档独立选 200K/1M，sessionContext1m 从布尔改对象）
// ══════════════════════════════════════════════════════════════════
// 背景：会话档位从"整配置一个布尔"改成"每档一个布尔"。
// sessionContext1m: { main?: boolean; haiku?: boolean; sonnet?: boolean; opus?: boolean }
// 每档独立决定别名是否带 [1m]。选 200K 的档别名不带后缀。

// ── D2 per-档别名后缀：aliasName 已支持 per-call with1m ──
test('PT1. aliasName 各档独立 with1m 后缀', () => {
    assert.equal(aliasName('main', 1, true), 'ccp-main-1[1m]');
    assert.equal(aliasName('haiku', 1, false), 'ccp-haiku-1');
    assert.equal(aliasName('sonnet', 2, true), 'ccp-sonnet-2[1m]');
    assert.equal(aliasName('opus', 3, false), 'ccp-opus-3');
});

// ── D5 buildAliasEnv 接 per-tier 对象：各档按自身 1m 决定后缀 ──
test('PT2. buildAliasEnv opts.sessionContext1m 对象 → 各档独立后缀', () => {
    const env = buildAliasEnv(1, { sessionContext1m: { main: true, haiku: false, sonnet: true, opus: false } });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1[1m]', 'main 1M → 带 [1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1', 'haiku 200K → 不带');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1[1m]', 'sonnet 1M → 带');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1', 'opus 200K → 不带');
});

// ── D5 buildAliasEnv per-tier 部分档 undefined → 该档默认 200K ──
test('PT3. buildAliasEnv sessionContext1m 部分档缺 → 缺的档默认 200K（不带后缀）', () => {
    const env = buildAliasEnv(2, { sessionContext1m: { main: true } });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-2[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-2', 'haiku 缺 → 200K');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-2', 'sonnet 缺 → 200K');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-2', 'opus 缺 → 200K');
});

// ── D5 向后兼容：buildAliasEnv 仍接 { with1m: boolean }（四档同值）──
test('PT4. buildAliasEnv opts.with1m 布尔（兼容）→ 四档同值', () => {
    const env = buildAliasEnv(1, { with1m: true });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1[1m]');
});

// ── D5 sessionContext1m 对象优先于 with1m（同时传时）──
test('PT5. buildAliasEnv sessionContext1m 对象优先于 with1m', () => {
    // 两者同传，对象优先
    const env = buildAliasEnv(1, { with1m: true, sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false } });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1', '对象优先 → main 200K');
});

// ── D5 类型安全：sessionContext1m 对象 value 非布尔（脏数据）→ 视为 false ──
test('PT6. buildAliasEnv sessionContext1m value 非布尔 → 视为 false（200K）', () => {
    const env = buildAliasEnv(1, { sessionContext1m: { main: 'yes', haiku: 1, sonnet: null, opus: undefined } });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1', '"yes" 非 strict true → 200K');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1', '1 非 strict true → 200K');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1', 'null → 200K');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1', 'undefined → 200K');
});

// ── D5 sessionContext1m 不是对象（脏数据 string/null/number）→ 四档全 200K ──
test('PT7. buildAliasEnv sessionContext1m 非对象脏数据 → 四档 200K', () => {
    for (const bad of ['true', null, 123, [true]]) {
        const env = buildAliasEnv(1, { sessionContext1m: bad });
        assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1', `${JSON.stringify(bad)} → main 200K`);
        assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1');
    }
});

// ── D4 inheritSessionContext1m 父带 [1m] → 四档都 true（对象）──
test('PT8. inheritSessionContext1m 父带 [1m] → {四档:true}', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-sonnet-5[1m]' } });
    const r = inheritSessionContext1m(content);
    assert.deepEqual(r, { main: true, haiku: true, sonnet: true, opus: true });
});

// ── D4 父不带 [1m] → 四档都 false ──
test('PT9. inheritSessionContext1m 父不带 [1m] → {四档:false}', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-sonnet-5' } });
    const r = inheritSessionContext1m(content);
    assert.deepEqual(r, { main: false, haiku: false, sonnet: false, opus: false });
});

// ── D4 父无 model / content 无效 → 四档都 false ──
test('PT10. inheritSessionContext1m 父无 model / 无效 → {四档:false}', () => {
    assert.deepEqual(inheritSessionContext1m(JSON.stringify({ env: {} })), { main: false, haiku: false, sonnet: false, opus: false });
    assert.deepEqual(inheritSessionContext1m(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x' } })), { main: false, haiku: false, sonnet: false, opus: false });
    assert.deepEqual(inheritSessionContext1m('not json'), { main: false, haiku: false, sonnet: false, opus: false });
    assert.deepEqual(inheritSessionContext1m(''), { main: false, haiku: false, sonnet: false, opus: false });
});

// ── D4 父带 [2m]（CLI 不认）→ 四档 false ──
test('PT11. inheritSessionContext1m 父带 [2m] → 四档 false（CLI 只认 [1m]）', () => {
    const content = JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-sonnet-5[2m]' } });
    const r = inheritSessionContext1m(content);
    assert.deepEqual(r, { main: false, haiku: false, sonnet: false, opus: false });
});

// ── D3 向后兼容：读取老派生节点 sessionContext1m 布尔 → 迁移成对象 ──
// normalizeSessionContext1m：布尔 true → 四档 true；false → 四档 false；undefined → undefined；对象 → 原样
test('PT12. normalizeSessionContext1m 布尔 true → 四档 true', () => {
    assert.deepEqual(normalizeSessionContext1m(true), { main: true, haiku: true, sonnet: true, opus: true });
});
test('PT13. normalizeSessionContext1m 布尔 false → 四档 false', () => {
    assert.deepEqual(normalizeSessionContext1m(false), { main: false, haiku: false, sonnet: false, opus: false });
});
test('PT14. normalizeSessionContext1m undefined → undefined（保持未填）', () => {
    assert.equal(normalizeSessionContext1m(undefined), undefined);
});
test('PT15. normalizeSessionContext1m 对象 → 归一（非布尔 value 转 false）', () => {
    assert.deepEqual(
        normalizeSessionContext1m({ main: true, haiku: 'yes', sonnet: undefined, opus: false }),
        { main: true, haiku: false, sonnet: false, opus: false },
    );
});
test('PT16. normalizeSessionContext1m 非对象非布尔脏数据 → 四档 false', () => {
    assert.deepEqual(normalizeSessionContext1m('true'), { main: false, haiku: false, sonnet: false, opus: false });
    assert.deepEqual(normalizeSessionContext1m(null), { main: false, haiku: false, sonnet: false, opus: false });
    assert.deepEqual(normalizeSessionContext1m(123), { main: false, haiku: false, sonnet: false, opus: false });
});

// ════════════════════════════════════════════════════════════════════════
// inheritAliasesFromParent：派生节点新建时从父 content 继承四档映射，剥 [1m] 后缀。
// Bug：原实现只剥 main 档，三档（haiku/sonnet/opus）漏剥 → value 带 [1m] → OCR 现象。
// 维度覆盖见 plan/tmp/2026-08-02-derived-inherit-strip-1m.md（D1-D8）。
// ════════════════════════════════════════════════════════════════════════

// ── D1×D2: 四档都剥 [1m]（核心 bug 修复点：三档原本漏剥） ──
test('IA1. inheritAliasesFromParent 四档都剥 [1m] 小写后缀', () => {
    const content = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: 'xopglm52[1m]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'xopglm52[1m]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'xopglm52[1m]',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'xopglm52[1m]',
        },
    });
    const r = inheritAliasesFromParent(content);
    assert.equal(r.main, 'xopglm52');
    assert.equal(r.haiku, 'xopglm52');   // bug 前：'xopglm52[1m]'
    assert.equal(r.sonnet, 'xopglm52');  // bug 前：'xopglm52[1m]'
    assert.equal(r.opus, 'xopglm52');    // bug 前：'xopglm52[1m]'
});

// ── D2 大小写不敏感：[1M] 大写也要剥（与 CLI has1mContext /\[1m\]/i 一致） ──
test('IA2. inheritAliasesFromParent [1M] 大写后缀也剥（大小写不敏感）', () => {
    const content = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: 'GLM[1M]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'GLM[1M]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM[1M]',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'GLM[1M]',
        },
    });
    const r = inheritAliasesFromParent(content);
    assert.equal(r.main, 'GLM');
    assert.equal(r.haiku, 'GLM');
    assert.equal(r.sonnet, 'GLM');
    assert.equal(r.opus, 'GLM');
});

// ── D2×D3 多次出现 + 任意位置：全局剥，不限末尾 ──
test('IA3. inheritAliasesFromParent [1m] 多次出现/任意位置全剥', () => {
    const content = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: 'a[1m]b[1m]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: '[1m]haiku',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet[1m]tail',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'op[1m]us',
        },
    });
    const r = inheritAliasesFromParent(content);
    assert.equal(r.main, 'ab');
    assert.equal(r.haiku, 'haiku');
    assert.equal(r.sonnet, 'sonnettail');
    assert.equal(r.opus, 'opus');
});

// ── D8 只剥 [1m]：[2m]/[500k] 等 CLI 不认的后缀原样保留（与 main 档一致） ──
test('IA4. inheritAliasesFromParent [2m]/[500k] 等非 [1m] 后缀不剥', () => {
    const content = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: 'glm[2m]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm[500k]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-sonnet',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm[1m][2m]', // 只剥 [1m]，留 [2m]
        },
    });
    const r = inheritAliasesFromParent(content);
    assert.equal(r.main, 'glm[2m]');
    assert.equal(r.haiku, 'glm[500k]');
    assert.equal(r.sonnet, 'glm-sonnet');
    assert.equal(r.opus, 'glm[2m]'); // [1m] 剥掉，[2m] 留
});

// ── D4 父 content 非法 JSON → 返回 {}（与现状一致） ──
test('IA5. inheritAliasesFromParent 非法 JSON content → {}', () => {
    assert.deepEqual(inheritAliasesFromParent('not json'), {});
    assert.deepEqual(inheritAliasesFromParent(''), {});
});

// ── D5 各档缺失：缺的档不进结果 ──
test('IA6. inheritAliasesFromParent 部分档缺失 → 缺档不进结果', () => {
    const content = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: 'glm[1m]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet[1m]',
            // haiku / opus 缺
        },
    });
    const r = inheritAliasesFromParent(content);
    assert.equal(r.main, 'glm');
    assert.equal(r.sonnet, 'sonnet');
    assert.equal(r.haiku, undefined);
    assert.equal(r.opus, undefined);
});

// ── D6 值类型守卫：非字符串值不崩、视为缺失 ──
test('IA7. inheritAliasesFromParent 非字符串 env 值不崩、视为缺失', () => {
    const content = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: 12345,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: { foo: 'bar' },
            ANTHROPIC_DEFAULT_SONNET_MODEL: null,
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus[1m]',
        },
    });
    const r = inheritAliasesFromParent(content);
    assert.equal(r.main, undefined);
    assert.equal(r.haiku, undefined);
    assert.equal(r.sonnet, undefined);
    assert.equal(r.opus, 'opus');
});

// ── D7 空白：剥后缀后 trim；纯空白视为未配 ──
test('IA8. inheritAliasesFromParent 剥后缀后 trim，纯空白视为未配', () => {
    const content = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: '  glm[1m]  ',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: '[1m]   ',   // 剥后纯空白 → 不进结果
            ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',       // 纯空白 → 不进结果
            ANTHROPIC_DEFAULT_OPUS_MODEL: ' opus [1m] ',
        },
    });
    const r = inheritAliasesFromParent(content);
    assert.equal(r.main, 'glm');
    assert.equal(r.haiku, undefined);
    assert.equal(r.sonnet, undefined);
    assert.equal(r.opus, 'opus');
});

// ── D4 空 env → {} ──
test('IA9. inheritAliasesFromParent content 无 env → {}', () => {
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify({ foo: 'bar' })), {});
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify({ env: {} })), {});
});

// ════════════════════════════════════════════════════════════════════════
// 代码评审 TDD：6 类高风险怀疑点（每类 ≥1 个），逐个 TDD 确认。
// ════════════════════════════════════════════════════════════════════════

// ── S1 边界条件：env 是数组/数字/字符串等非对象类型 ──
// 怀疑：extractUpstream 的 `obj.env ?? {}` 只兜底 null/undefined，
// 若 env 是数组/数字/字符串，env.ANTHROPIC_MODEL 取属性可能拿到意外值或崩。
test('S1. inheritAliasesFromParent env 是数组/数字/字符串不崩', () => {
    // env 是数组：数组无 ANTHROPIC_MODEL 属性 → 视为缺档 → {}
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify({ env: [] })), {});
    // env 是数字
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify({ env: 123 })), {});
    // env 是字符串
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify({ env: 'str' })), {});
    // env 是 null（?? 兜底）
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify({ env: null })), {});
});

// ── S2 边界条件：模型名只含 [1m]（剥后空串）应视为未配 ──
test('S2. inheritAliasesFromParent 值只含 [1m] 剥后空 → 视为未配', () => {
    const content = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: '[1m]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: '[1M]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: ' [1m] ',
            ANTHROPIC_DEFAULT_OPUS_MODEL: '[1m][1m]',
        },
    });
    const r = inheritAliasesFromParent(content);
    assert.equal(r.main, undefined);
    assert.equal(r.haiku, undefined);
    assert.equal(r.sonnet, undefined);
    assert.equal(r.opus, undefined);
});

// ── S3 边界条件：[1m] 大小写混合如 [1m]/[1M]/[1m] 已覆盖，但 [1m] 中含全角字符不剥（与 CLI 一致） ──
test('S3. inheritAliasesFromParent 全角 [１ｍ] 不剥（与 CLI has1mContext 一致）', () => {
    const content = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: 'glm［１ｍ］',  // 全角中括号+全角数字——不是 [1m]
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm[1ｍ]',  // 半角括号+全角 m
        },
    });
    const r = inheritAliasesFromParent(content);
    // 全角不是 ASCII [1m]，不剥（与 CLI /\[1m\]/i 一致，只匹配 ASCII）
    assert.equal(r.main, 'glm［１ｍ］');
    assert.equal(r.haiku, 'glm[1ｍ]');
});

// ── S4 异常路径：content 是 JSON 但顶层是数组/原始值（JSON.parse 不抛但非对象） ──
test('S4. inheritAliasesFromParent content 是 JSON 数组/原始值 → {}', () => {
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify([1, 2, 3])), {});
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify('just a string')), {});
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify(42)), {});
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify(true)), {});
    assert.deepEqual(inheritAliasesFromParent(JSON.stringify(null)), {});
});

// ── S5 状态转换/一致性：aggregateModelCatalog 父 content 带 [1m] + 派生 modelAliases 剥后 → 目录重复 ──
// 怀疑：aggregateModelCatalog 从父 content 读 ANTHROPIC_MODEL 不剥 [1m]（得 'glm[1m]'），
// 又从派生 modelAliases 读剥后的 'glm'，Set 里两个都进 → 下拉候选出现重复（一个带 [1m] 一个不带）。
test('S5. aggregateModelCatalog 父 content 带 [1m] 与派生剥后值产生重复候选', () => {
    const parentContent = JSON.stringify({
        env: { ANTHROPIC_MODEL: 'glm[1m]', ANTHROPIC_SMALL_FAST_MODEL: 'fast[1m]' },
    });
    // 派生节点继承后 modelAliases 是剥后的 'glm'/'fast'
    const derivedAliases = inheritAliasesFromParent(parentContent);
    // 父配置 + 派生节点都在 configs 里
    const configs = [
        { content: parentContent, modelAliases: undefined },
        { content: parentContent, modelAliases: derivedAliases },
    ];
    const catalog = aggregateModelCatalog(configs);
    // 期望：目录应只有 'glm' 和 'fast'（剥后），不应同时出现 'glm[1m]' 和 'glm'
    const hasStripped = catalog.includes('glm');
    const hasWithSuffix = catalog.includes('glm[1m]');
    // 若两者都在 → 重复候选 bug 存在
    if (hasStripped && hasWithSuffix) {
        assert.fail(`目录重复：同时含 'glm' 和 'glm[1m]'。catalog=${JSON.stringify(catalog)}`);
    }
});

// ── S6 一致性：inheritSessionContext1m 与 inheritAliasesFromParent 协同 ──
// 怀疑：父 ANTHROPIC_MODEL 带 [1m] → inheritSessionContext1m 四档 true（别名带 [1m]），
// 同时 inheritAliasesFromParent 剥掉 value 的 [1m]。启动时 buildAliasEnv 生成带 [1m] 的别名，
// 代理 rewriteModel 剥别名 [1m] 查表命中剥后的 value → 正确。验证这条链路一致。
test('S6. inheritSessionContext1m + inheritAliasesFromParent + buildAliasEnv 链路一致', () => {
    const parentContent = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: 'glm[1m]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm[1m]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm[1m]',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm[1m]',
        },
    });
    const ctx1m = inheritSessionContext1m(parentContent);
    const aliases = inheritAliasesFromParent(parentContent);
    // 四档都应是 true（父 main 带 [1m]）
    assert.deepEqual(ctx1m, { main: true, haiku: true, sonnet: true, opus: true });
    // 四档 value 都剥了
    assert.equal(aliases.main, 'glm');
    assert.equal(aliases.haiku, 'glm');
    assert.equal(aliases.sonnet, 'glm');
    assert.equal(aliases.opus, 'glm');
    // buildAliasEnv 生成的别名带 [1m]（因 perTier 全 true）
    const aliasEnv = buildAliasEnv(3, { sessionContext1m: ctx1m });
    assert.equal(aliasEnv.ANTHROPIC_MODEL, 'ccp-main-3[1m]');
    assert.equal(aliasEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-3[1m]');
    // 代理 rewriteModel 会剥别名 [1m] 查表：ccp-main-3 → 'glm'（剥后 value），链路自洽
});

// ── S7 一致性：父三档带 [1m] 但 main 不带 → inheritSessionContext1m 全 false（只看 main），value 剥后缀 ──
// 怀疑：父 main='glm'(无[1m]) 但 haiku='glm[1m]'，inheritSessionContext1m 看 main → 全 false（200K），
// 但 inheritAliasesFromParent 剥掉 haiku 的 [1m]。结果：haiku 别名不带 [1m]（200K），
// 但父 haiku 实际是 1M 模型。这是 inheritSessionContext1m 的设计限制（只看 main），不是本 PR bug。
// 记录此行为作回归。
test('S7. 父 main 无[1m] 但三档有[1m]：ctx1m 全 false（设计限制，非 bug）', () => {
    const parentContent = JSON.stringify({
        env: {
            ANTHROPIC_MODEL: 'glm',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm[1m]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm[1m]',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm[1m]',
        },
    });
    const ctx1m = inheritSessionContext1m(parentContent);
    const aliases = inheritAliasesFromParent(parentContent);
    // inheritSessionContext1m 只看 main，main 无 [1m] → 全 false
    assert.deepEqual(ctx1m, { main: false, haiku: false, sonnet: false, opus: false });
    // 但 value 仍剥 [1m]（四档统一剥）
    assert.equal(aliases.main, 'glm');
    assert.equal(aliases.haiku, 'glm');
    assert.equal(aliases.sonnet, 'glm');
    assert.equal(aliases.opus, 'glm');
    // 别名不带 [1m]（perTier 全 false）——haiku 实际是 1M 但按 200K 算，设计限制
    const aliasEnv = buildAliasEnv(1, { sessionContext1m: ctx1m });
    assert.equal(aliasEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1');  // 不带 [1m]
});

// ── S8 一致性：computeAliasSyncActions 不剥 [1m]（raw.trim() 原样） ──
// 怀疑：若 modelAliases value 带 [1m]（如用户 setAlias 手输 'glm[1m]'，或老数据未剥），
// computeAliasSyncActions 用 raw.trim() 原样设进代理表 → 代理 rewriteModel 剥别名 [1m] 查表命中
// 'glm[1m]' value → 发 'glm[1m]' 给上游 → model not found。
// 这是 setAlias 路径与 inheritAliasesFromParent 路径的剥后缀不一致。
// 记录此行为：computeAliasSyncActions 不剥（设计如此——剥后缀责任在写入方 inheritAliasesFromParent），
// 故 setAlias 路径若不剥会产生带后缀的脏值。本测试确认 computeAliasSyncActions 的原样透传行为。
test('S8. computeAliasSyncActions 不剥 [1m]（raw.trim() 原样透传，剥后缀责任在写入方）', () => {
    // modelAliases value 带 [1m]（模拟 setAlias 手输未剥的脏值）
    const derived = { derivedIndex: 2, modelAliases: { haiku: 'glm[1m]' } };
    const proxyAliases = {};
    const actions = computeAliasSyncActions(derived, proxyAliases);
    // computeAliasSyncActions 不剥 → toSet 的 model 带 [1m]
    assert.equal(actions.toSet.length, 1);
    assert.equal(actions.toSet[0].alias, 'ccp-haiku-2');
    assert.equal(actions.toSet[0].model, 'glm[1m]');  // 原样，未剥
    // 这意味着 setAlias 路径若不剥，脏值会进代理表 → 上游 model not found
    // （inheritAliasesFromParent 出口已剥，故继承路径安全；setAlias 路径是独立风险点）
});

// ── extractCustomEnv：自定义 env 透传（CLAUDE_CODE_AUTO_COMPACT_WINDOW 等） ──
// 派生/普通 CLI 启动时，从 content.env 提取非冲突自定义 key 注入 shell env。
// 排除 8 个冲突/特殊 key（5 路由 + 3 派生别名），保留其余字符串非空值。
// 详见 plan/tmp/twinkling-forging-sunset.md。
test('extractCustomEnv：排除 8 个冲突/特殊 key，保留其余字符串非空 key', () => {
    const env = {
        // 路由 key（应排除——各路径显式构造）
        ANTHROPIC_BASE_URL: 'http://x',
        ANTHROPIC_AUTH_TOKEN: 'tok',
        ANTHROPIC_MODEL: 'glm[1m]',
        ANTHROPIC_SMALL_FAST_MODEL: 'haiku',
        API_TIMEOUT_MS: '300000',
        // 派生别名 key（应排除——buildAliasEnv 显式构造）
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'ccp-haiku-1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'ccp-sonnet-1',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'ccp-opus-1',
        // 自定义 key（应保留）
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000',
        FOO: 'bar',
        ANOTHER_CUSTOM: 'value',
    };
    const out = extractCustomEnv(env);
    assert.equal(out.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000');
    assert.equal(out.FOO, 'bar');
    assert.equal(out.ANOTHER_CUSTOM, 'value');
    // 8 个冲突/特殊 key 全部排除
    assert.equal(out.ANTHROPIC_BASE_URL, undefined);
    assert.equal(out.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(out.ANTHROPIC_MODEL, undefined);
    assert.equal(out.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    assert.equal(out.API_TIMEOUT_MS, undefined);
    assert.equal(out.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
    assert.equal(out.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined);
    assert.equal(out.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
});

test('extractCustomEnv：非字符串值（数字/对象/布尔）不透传', () => {
    const env = {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000',  // 字符串，保留
        NUMERIC_ENV: 12345,                         // 数字，丢弃
        OBJECT_ENV: { a: 1 },                        // 对象，丢弃
        BOOL_ENV: true,                              // 布尔，丢弃
        EMPTY_STRING: '',                            // 空串，丢弃
        VALID_STRING: 'ok',                          // 字符串，保留
    };
    const out = extractCustomEnv(env);
    assert.equal(out.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000');
    assert.equal(out.VALID_STRING, 'ok');
    assert.equal(out.NUMERIC_ENV, undefined);
    assert.equal(out.OBJECT_ENV, undefined);
    assert.equal(out.BOOL_ENV, undefined);
    assert.equal(out.EMPTY_STRING, undefined);
});

test('extractCustomEnv：null/undefined/非对象入参返回空对象', () => {
    assert.deepEqual(extractCustomEnv(null), {});
    assert.deepEqual(extractCustomEnv(undefined), {});
    assert.deepEqual(extractCustomEnv('not-an-object'), {});
    assert.deepEqual(extractCustomEnv({}), {});
});

test('extractCustomEnv：不修改入参（纯函数，返回副本）', () => {
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000', ANTHROPIC_MODEL: 'glm' };
    const snapshot = { ...env };
    const out = extractCustomEnv(env);
    assert.equal(out.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000');
    // 入参未被修改
    assert.deepEqual(env, snapshot);
});

// ── TDD 审查：边界条件 ──
// 怀疑：extractCustomEnv 的入参 guard 是 `if (!env || typeof env !== 'object')`，
// 但 JS 里 typeof array === 'object'。若 extractUpstream 返回的 env 实际是个数组
// （JSON "env": [...] ），数组会穿透 guard，Object.keys 返回数字索引字符串 '0','1'…，
// 数组元素若是字符串会被当作 env 透传——产生名为 '0'/'1' 的脏 env key。
// 断言"bug 存在"：数组入参应产出含数字 key 的对象。
test('TDD-S1: extractCustomEnv 传入数组 → 数组元素若为字符串会被透传为数字 key（bug）', () => {
    const arr = ['value0', 'value1'];
    const out = extractCustomEnv(arr);
    // 若 bug 存在：out = { '0': 'value0', '1': 'value1' }
    // 若已修复（数组应返回 {}）：out = {}
    assert.deepEqual(out, {}, '数组不应被当作 env 对象透传，应返回空对象');
});

// TDD-S3 (Cat 2 异常路径): extractUpstream 对 JSON null/数字/字符串 等非对象顶层不崩溃
// 怀疑：extractUpstream(content) 里 `const obj = JSON.parse(content); const env = (obj.env ?? {})`，
// 若 content="null" → JSON.parse 返回 null → null.env 抛 TypeError。虽有 try/catch 兜底返回 null，
// 但下游 extractCustomEnv(extractUpstream(...)?.env ?? {}) 链路是否真的安全？
// 验证：extractCustomEnv 对各种 extractUpstream 可能返回的 env 值（含异常兜底的空对象）不抛。
test('TDD-S3: extractCustomEnv 对 extractUpstream 异常路径的返回值不抛（null/空对象安全）', () => {
    // extractUpstream("null") → catch → null → ?.env ?? {} → {} → extractCustomEnv({}) = {}
    assert.deepEqual(extractCustomEnv({}), {});
    // extractUpstream("42") → obj=42, 42.env=undefined, undefined??{}={} → extractCustomEnv({})={}
    // 模拟：extractUpstream 对非对象 JSON 的 env 是 {}（因 obj.env=undefined ?? {}）
    assert.deepEqual(extractCustomEnv(null), {});
    assert.deepEqual(extractCustomEnv(undefined), {});
});

// TDD-S4 (Cat 3 类型安全): __proto__ 原型污染
// 怀疑：若 content.env 含 "__proto__" key（JSON.parse 把它当 own property），
// extractCustomEnv 用 Object.keys 遍历会拿到 '__proto__'，然后 out['__proto__'] = v 赋值。
// 虽然 out['__proto__'] = 'string' 不污染原型（直接属性赋值），但返回的对象 .__proto__ 会被覆盖。
// 更危险的是 constructor/prototype 等。验证：__proto__ key 是否被透传到返回对象。
test('TDD-S4: extractCustomEnv 含 __proto__ key → 不应透传原型污染 key', () => {
    // JSON.parse('{"__proto__":"polluted","FOO":"bar"}') 含 __proto__ 作为 own property
    const env = JSON.parse('{"__proto__":"polluted","FOO":"bar"}');
    const out = extractCustomEnv(env);
    // 若 bug：out.__proto__ === 'polluted'（own property），out.FOO === 'bar'
    // 若安全：out 不含 __proto__ 作为 own property
    assert.equal(out.FOO, 'bar', '正常自定义 key 应透传');
    // Object.prototype 不应被污染
    assert.equal(({}).polluted, undefined, 'Object.prototype 不应被污染');
    // out 不应有 __proto__ 作为 own property（即使有也不应污染原型）
    assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), false,
        '__proto__ 不应作为 own property 透传（防原型污染）');
});

// TDD-S6 (Cat 5 并发/时序): extractCustomEnv 纯函数 + 跨 await 确定性
// 怀疑：extractCustomEnv 是否依赖外部可变状态？若依赖，buildTerminalEnv 在 await fwd/upstream
// 前后调用 extractCustomEnv 可能拿到不同结果（时序竞态）。验证：同一入参在 async 边界前后
// 调用 extractCustomEnv 结果相同（纯函数，无外部状态依赖）。
test('TDD-S6: extractCustomEnv 跨 await 边界结果一致（纯函数，无时序竞态）', async () => {
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000', FOO: 'bar', ANTHROPIC_MODEL: 'glm' };
    const before = extractCustomEnv(env);
    // 模拟 buildTerminalEnv 的 async gap（upstream 注入 + 别名同步）
    await new Promise(r => setTimeout(r, 10));
    const after = extractCustomEnv(env);
    assert.deepEqual(before, after, '跨 await 调用结果应一致（纯函数无外部状态依赖）');
    assert.equal(after.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '90000');
    assert.equal(after.FOO, 'bar');
    assert.equal(after.ANTHROPIC_MODEL, undefined, '路由 key 仍被排除');
});
