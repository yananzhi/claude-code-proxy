// test/derived-logic/review-per-tier.mjs
// 第三轮 per-tier 审查 TDD 验证（独立于 test.mjs，专注本次 per-tier 改动的 6 类风险）。
// Run:  npx tsc -p ./ && node --test test/derived-logic/review-per-tier.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAliasEnv,
    normalizeSessionContext1m,
    inheritSessionContext1m,
} from '../../out/derivedLogic.js';

const TIER_1M_ALL = { main: true, haiku: true, sonnet: true, opus: true };
const TIER_200K_ALL = { main: false, haiku: false, sonnet: false, opus: false };

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P1（类别6 一致性 / 类别2 异常路径）：
// claudeLauncher 直接传 buildAliasEnv(idx, { sessionContext1m: derivedCfg.sessionContext1m })，
// 若 derivedCfg.sessionContext1m 是老布尔 true（未迁移），buildAliasEnv 不把它当对象 → 落到 with1m
// 分支 → with1m undefined → 四档全 false（200K）。老派生节点的 1M 设置静默丢失！
// 期望：buildAliasEnv 收布尔 sessionContext1m 时应等价于 with1m（向后兼容）。
// ═══════════════════════════════════════════════════════════════════
test('P1. buildAliasEnv sessionContext1m=布尔 true → 应四档 1M（兼容老数据，不丢失）', () => {
    // 模拟 claudeLauncher.ts:419 的调用：buildAliasEnv(idx, { sessionContext1m: derivedCfg.sessionContext1m })
    // derivedCfg.sessionContext1m 是老布尔 true（未迁移）
    const env = buildAliasEnv(1, { sessionContext1m: true });
    // 当前实现：true 不是对象 → 落 with1m 分支 → with1m undefined → 四档 false（200K）
    // 期望：布尔 true 应等价 with1m=true → 四档带 [1m]
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1[1m]', '布尔 true 的老数据 main 应带 [1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1[1m]');
});

test('P1b. buildAliasEnv sessionContext1m=布尔 false → 应四档 200K（兼容老数据）', () => {
    const env = buildAliasEnv(1, { sessionContext1m: false });
    // 当前实现：false 是 falsy → 落 with1m 分支 → 四档 false（200K）——巧合正确
    // 但语义应一致：布尔 false 也应四档 200K
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1');
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P2（类别4 状态转换 holes）：
// handleSetCtx1m 改某档时，先 normalizeSessionContext1m(cfg.sessionContext1m) 再改单档。
// 若 cfg.sessionContext1m 是老布尔 true，normalize 成四档 true，再改 haiku=false →
// {main:true, haiku:false, sonnet:true, opus:true}。其他档保留 true（不破坏）。
// 这是关键状态转换：老布尔数据迁移后改一档，其他档不应被波及。
// 此处测纯逻辑 normalize 的行为（webview 交互层 handleSetCtx1m 的等价纯逻辑）。
// ═══════════════════════════════════════════════════════════════════
test('P2. 老布尔 true 迁移后改单档 haiku=false，其他档保留 true', () => {
    // 模拟 handleSetCtx1m 的纯逻辑：
    // 1) cfg.sessionContext1m = true（老布尔）
    // 2) perTier = normalizeSessionContext1m(true) ?? {...200K}
    // 3) perTier['haiku'] = false
    const oldBool = true;
    const perTier = normalizeSessionContext1m(oldBool) ?? { ...TIER_200K_ALL };
    perTier.haiku = false;
    // 期望：只有 haiku 变 false，main/sonnet/opus 保留 true
    assert.equal(perTier.main, true, 'main 应保留 true（不被 haiku 改动波及）');
    assert.equal(perTier.haiku, false, 'haiku 改 false');
    assert.equal(perTier.sonnet, true, 'sonnet 应保留 true');
    assert.equal(perTier.opus, true, 'opus 应保留 true');
});

test('P2b. 老布尔 false 迁移后改单档 sonnet=true，其他档保留 false', () => {
    const oldBool = false;
    const perTier = normalizeSessionContext1m(oldBool) ?? { ...TIER_200K_ALL };
    perTier.sonnet = true;
    assert.equal(perTier.main, false, 'main 保留 false');
    assert.equal(perTier.haiku, false, 'haiku 保留 false');
    assert.equal(perTier.sonnet, true, 'sonnet 改 true');
    assert.equal(perTier.opus, false, 'opus 保留 false');
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P3（类别1 边界 / 类别3 类型安全）：
// buildAliasEnv 同时传 with1m:true 与 sessionContext1m:undefined（claudeLauncher 可能
// 在 sessionContext1m 未设时只传 with1m 的场景）。对象优先分支判 undefined → 落 with1m。
// 期望：sessionContext1m 为 undefined 时回退 with1m（不丢失 with1m=true）。
// ═══════════════════════════════════════════════════════════════════
test('P3. buildAliasEnv with1m=true + sessionContext1m=undefined → 四档 1M（with1m 不丢）', () => {
    const env = buildAliasEnv(2, { with1m: true, sessionContext1m: undefined });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-2[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-2[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-2[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-2[1m]');
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P4（类别1 边界）：
// normalizeSessionContext1m 空对象 {} → 四档 false（缺档补 false）。
// 这是 per-tier 改动后最常见的初始态（用户清空所有档）。
// ═══════════════════════════════════════════════════════════════════
test('P4. normalizeSessionContext1m 空对象 {} → 四档 false', () => {
    assert.deepEqual(normalizeSessionContext1m({}), TIER_200K_ALL);
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P5（类别1 边界 / 类别3 类型安全）：
// normalizeSessionContext1m 对象只有部分档有值、其余 undefined → 缺的补 false。
// 单档有值、四档混合场景。
// ═══════════════════════════════════════════════════════════════════
test('P5. normalizeSessionContext1m 单档 true 其余缺 → {main:true, haiku:false, sonnet:false, opus:false}', () => {
    assert.deepEqual(
        normalizeSessionContext1m({ main: true }),
        { main: true, haiku: false, sonnet: false, opus: false },
    );
});

test('P5b. normalizeSessionContext1m 四档混合 → 各档独立保留', () => {
    assert.deepEqual(
        normalizeSessionContext1m({ main: true, haiku: false, sonnet: true, opus: false }),
        { main: true, haiku: false, sonnet: true, opus: false },
    );
    assert.deepEqual(
        normalizeSessionContext1m({ main: false, haiku: true, sonnet: false, opus: true }),
        { main: false, haiku: true, sonnet: false, opus: true },
    );
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P6（类别2 异常路径 / 类别3 类型安全）：
// normalizeSessionContext1m 收数组 [true, false] → 非对象非布尔脏数据 → 四档 false。
// buildAliasEnv 收 sessionContext1m 为数组 → 应不崩、四档 200K。
// ═══════════════════════════════════════════════════════════════════
test('P6. normalizeSessionContext1m 数组 → 四档 false（脏数据兜底）', () => {
    assert.deepEqual(normalizeSessionContext1m([true, false]), TIER_200K_ALL);
    assert.deepEqual(normalizeSessionContext1m([]), TIER_200K_ALL);
});

test('P6b. buildAliasEnv sessionContext1m 为数组 → 四档 200K（不崩）', () => {
    const env = buildAliasEnv(1, { sessionContext1m: [true, true] });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1');
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P7（类别3 类型安全 / 类别6 一致性）：
// normalizeSessionContext1m 收脏数据 string "true" / number 1 / null → 四档 false。
// 这些是手改 local-configs.json 可能带入的脏值。
// ═══════════════════════════════════════════════════════════════════
test('P7. normalizeSessionContext1m 脏数据 string/number/null → 四档 false', () => {
    assert.deepEqual(normalizeSessionContext1m('true'), TIER_200K_ALL);
    assert.deepEqual(normalizeSessionContext1m(1), TIER_200K_ALL);
    assert.deepEqual(normalizeSessionContext1m(0), TIER_200K_ALL);
    assert.deepEqual(normalizeSessionContext1m(null), TIER_200K_ALL);
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P8（类别3 类型安全）：
// normalizeSessionContext1m 对象 value 为非布尔（string/number/null/undefined/object）→ 该档 false。
// 即 strict-true 校验：只有 === true 才是 true。
// ═══════════════════════════════════════════════════════════════════
test('P8. normalizeSessionContext1m 对象 value 非布尔 → 该档 false（strict-true）', () => {
    assert.deepEqual(
        normalizeSessionContext1m({ main: 'true', haiku: 1, sonnet: null, opus: undefined }),
        { main: false, haiku: false, sonnet: false, opus: false },
    );
    assert.deepEqual(
        normalizeSessionContext1m({ main: {}, haiku: [], sonnet: 'yes', opus: 0 }),
        { main: false, haiku: false, sonnet: false, opus: false },
    );
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P9（类别3 类型安全 / 类别1 边界）：
// normalizeSessionContext1m 返回 undefined（输入 undefined）后，调用方 buildAliasEnv 怎么处理？
// buildAliasEnv 的三元：opts.sessionContext1m（undefined）→ falsy → 落 with1m 分支。
// 即 normalize 返回 undefined 不会进 buildAliasEnv 的 normalize 分支（因为 buildAliasEnv 自己
// 先判 opts.sessionContext1m truthy）。这是安全的——undefined sessionContext1m + 无 with1m → 200K。
// ═══════════════════════════════════════════════════════════════════
test('P9. buildAliasEnv 无 opts（sessionContext1m 与 with1m 都缺）→ 四档 200K', () => {
    const env = buildAliasEnv(3);
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-3');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-3');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-3');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-3');
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P10（类别5 时序 / 并发）：
// buildAliasEnv 连续调用（模拟连续改多档后启动）：每次改档更新 cfg.sessionContext1m 内存，
// 最后 launchDerived 读 cfg.sessionContext1m 一次构造 env。验证多档混合后 buildAliasEnv 正确。
// ═══════════════════════════════════════════════════════════════════
test('P10. 连续改多档后 buildAliasEnv 反映最终态', () => {
    // 模拟：初始继承父带 [1m] → 四档 true
    let ctx = inheritSessionContext1m(JSON.stringify({ env: { ANTHROPIC_MODEL: 'glm[1m]' } }));
    // 用户改 main=false（模拟 handleSetCtx1m 纯逻辑）
    ctx = normalizeSessionContext1m(ctx) ?? { ...TIER_200K_ALL };
    ctx.main = false;
    // 用户改 sonnet=false
    ctx.sonnet = false;
    // 最终 buildAliasEnv
    const env = buildAliasEnv(1, { sessionContext1m: ctx });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1', 'main 改 false → 不带 [1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1[1m]', 'haiku 保留 true → 带');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1', 'sonnet 改 false → 不带');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1[1m]', 'opus 保留 true → 带');
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P11（类别6 一致性）：
// buildAliasEnv 两套 opts 兼容（with1m vs sessionContext1m）是否真的一致？
// with1m=true 应等价于 sessionContext1m={main:true,haiku:true,sonnet:true,opus:true}。
// with1m=false 应等价于 sessionContext1m={四档:false}。
// ═══════════════════════════════════════════════════════════════════
test('P11. buildAliasEnv with1m=true 等价于 sessionContext1m={四档:true}', () => {
    const envWith = buildAliasEnv(1, { with1m: true });
    const envObj = buildAliasEnv(1, { sessionContext1m: { main: true, haiku: true, sonnet: true, opus: true } });
    assert.deepEqual(envWith, envObj);
});

test('P11b. buildAliasEnv with1m=false 等价于 sessionContext1m={四档:false}', () => {
    const envWith = buildAliasEnv(1, { with1m: false });
    const envObj = buildAliasEnv(1, { sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false } });
    assert.deepEqual(envWith, envObj);
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P12（类别6 一致性）：
// with1m=true + sessionContext1m={四档:false}（对象优先）→ 应四档 false（对象优先于 with1m）。
// PT5 已测 main 单档，此处补全四档断言。
// ═══════════════════════════════════════════════════════════════════
test('P12. buildAliasEnv with1m=true + sessionContext1m={四档:false} → 对象优先，四档 200K', () => {
    const env = buildAliasEnv(1, {
        with1m: true,
        sessionContext1m: { main: false, haiku: false, sonnet: false, opus: false },
    });
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1');
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P13（类别6 一致性 / 类别4 状态转换）：
// buildAliasEnv sessionContext1m=布尔 false + with1m=true（矛盾输入）→ sessionContext1m 权威。
// 修复后 sessionContext1m 始终优先（即使是布尔 false），with1m 不再覆盖。
// 旧实现：false && ... 短路 → 落 with1m → 四档 1M（矛盾，sessionContext1m=false 被无视）。
// 修复后：normalize(false)={四档:false} → 200K（sessionContext1m 权威）。
// 这是修复 P1 引入的刻意行为变化：sessionContext1m（含布尔 false）始终优先于 with1m。
// ═══════════════════════════════════════════════════════════════════
test('P13. buildAliasEnv sessionContext1m=false + with1m=true → sessionContext1m 权威（200K）', () => {
    const env = buildAliasEnv(1, { with1m: true, sessionContext1m: false });
    // 修复后：sessionContext1m=false → 四档 200K（sessionContext1m 优先，with1m 被忽略）
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1', 'sessionContext1m=false 权威 → main 200K');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1');
});

// ═══════════════════════════════════════════════════════════════════
// 怀疑点 P14（类别2 异常路径 / 类别6 一致性）：
// buildAliasEnv sessionContext1m 脏数据（string 'true'）+ with1m=true → 修复后 sessionContext1m 优先
// （normalize 兜底四档 false），with1m 被忽略。
// 旧实现：'true' && typeof 'true'==='object' false → 落 with1m → 四档 1M。
// 修复后：normalize('true')=四档 false → 200K。脏数据 sessionContext1m 不应被 with1m 救回。
// ═══════════════════════════════════════════════════════════════════
test('P14. buildAliasEnv sessionContext1m=脏数据 "true" + with1m=true → normalize 兜底 200K', () => {
    const env = buildAliasEnv(1, { with1m: true, sessionContext1m: 'true' });
    // 修复后：sessionContext1m='true'（脏）→ normalize 四档 false → 200K
    assert.equal(env.ANTHROPIC_MODEL, 'ccp-main-1');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'ccp-haiku-1');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'ccp-sonnet-1');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'ccp-opus-1');
});
