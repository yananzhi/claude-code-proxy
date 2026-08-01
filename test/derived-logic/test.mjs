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
} from '../../out/derivedLogic.js';

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

// ── D1×D6: buildAliasEnv 三档 shell env，不含 BASE_URL/token ──
test('4. buildAliasEnv 三档注入 shell env，不含 BASE_URL/token', () => {
    const env = buildAliasEnv(1, { with1m: true });
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1[1m]');
    // 安全约束：别名走 shell env，BASE_URL/token 走 settings.env，不能混进这里
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_MODEL, undefined); // 主模型走 /model，不纳入
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
