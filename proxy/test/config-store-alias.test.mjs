// proxy/test/config-store-alias.test.mjs — model aliasing 配置层单测
//
// 运行：node --test proxy/test/config-store-alias.test.mjs
// 纯文件系统，不起 HTTP。测 config-store 的 modelAliases / nextAliasId / rewriteModel / init 校正。
//
// 维度覆盖：
//   D1 映射表 CRUD（a-e）
//   D2 rewriteModel 命中行为（a-g）
//   D7 nextAliasId 计数器持久化 + 启动校正（a-c）
//   D8 persist 持久化（a/c/d）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cs from '../config-store.js';

function newTmpDir(prefix) {
    const d = join(process.cwd(), '.test-tmp', `cs-alias-${prefix}-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
function configPath(dir) { return join(dir, 'config.json'); }
function writeConfig(dir, obj) { writeFileSync(configPath(dir), JSON.stringify(obj), 'utf8'); }
function readConfig(dir) { return JSON.parse(readFileSync(configPath(dir), 'utf8')); }

// ── D1a 初始空表（老配置无 modelAliases）──
test('D1a: 老配置无 modelAliases → getModelAliases 返 {}', () => {
    const dir = newTmpDir('d1a');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.deepEqual(cs.getModelAliases(), {});
    rmSync(dir, { recursive: true, force: true });
});

// ── D1b updateModelAlias 加一条 ──
test('D1b: updateModelAlias 加一条 → 表里多一项 + persist 落盘', () => {
    const dir = newTmpDir('d1b');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    const r = cs.updateModelAlias('ccp-sonnet-1', 'claude-sonnet-5');
    assert.equal(r.alias, 'ccp-sonnet-1');
    assert.equal(r.model, 'claude-sonnet-5');
    assert.equal(cs.getModelAliases()['ccp-sonnet-1'], 'claude-sonnet-5');
    // D8a persist 落盘
    const disk = readConfig(dir);
    assert.equal(disk.modelAliases['ccp-sonnet-1'], 'claude-sonnet-5');
    rmSync(dir, { recursive: true, force: true });
});

// ── D1c updateModelAlias 覆盖旧值 ──
test('D1c: updateModelAlias 同 alias 不同 model → 覆盖', () => {
    const dir = newTmpDir('d1c');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    cs.updateModelAlias('ccp-sonnet-1', 'claude-sonnet-5');
    cs.updateModelAlias('ccp-sonnet-1', 'claude-sonnet-6');
    assert.equal(cs.getModelAliases()['ccp-sonnet-1'], 'claude-sonnet-6');
    rmSync(dir, { recursive: true, force: true });
});

// ── D1d removeModelAlias 删一条 ──
test('D1d: removeModelAlias 删一条 → 表少一项 + persist', () => {
    const dir = newTmpDir('d1d');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'a', 'ccp-haiku-1': 'b' } });
    cs.init(configPath(dir));
    cs.removeModelAlias('ccp-sonnet-1');
    assert.ok(!('ccp-sonnet-1' in cs.getModelAliases()));
    assert.equal(cs.getModelAliases()['ccp-haiku-1'], 'b');
    const disk = readConfig(dir);
    assert.ok(!('ccp-sonnet-1' in (disk.modelAliases ?? {})));
    rmSync(dir, { recursive: true, force: true });
});

// ── D1e removeModelAlias 删不存在（幂等）──
test('D1e: removeModelAlias 删不存在 → 无害幂等', () => {
    const dir = newTmpDir('d1e');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.doesNotThrow(() => cs.removeModelAlias('ccp-sonnet-99'));
    assert.deepEqual(cs.getModelAliases(), {});
    rmSync(dir, { recursive: true, force: true });
});

// ── D2a rewriteModel 命中替换 ──
test('D2a: model 命中别名 → 替换为真实模型', () => {
    const dir = newTmpDir('d2a');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'claude-sonnet-5' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1', messages: [] }), 'utf8');
    const r = cs.rewriteModel(body, 'rid1', 'application/json');
    assert.equal(r.rewritten, true);
    assert.equal(r.resolvedModel, 'claude-sonnet-5');
    assert.equal(JSON.parse(r.body.toString()).model, 'claude-sonnet-5');
    rmSync(dir, { recursive: true, force: true });
});

// ── D2b rewriteModel 不命中原样透传 ──
test('D2b: model 不命中别名 → 原样透传', () => {
    const dir = newTmpDir('d2b');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'x' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'other-model' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid2', 'application/json');
    assert.equal(r.rewritten, false);
    assert.equal(r.resolvedModel, 'other-model');
    assert.equal(r.body, body);
    rmSync(dir, { recursive: true, force: true });
});

// ── D2c 带 [1m] 命中：剥离后查表替换 base ──
test('D2c: model 带 [1m] 命中 → 剥离后查表替换 base（不带后缀）', () => {
    const dir = newTmpDir('d2c');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'claude-sonnet-5' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1[1m]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid3', 'application/json');
    assert.equal(r.rewritten, true);
    assert.equal(r.resolvedModel, 'claude-sonnet-5');
    assert.equal(JSON.parse(r.body.toString()).model, 'claude-sonnet-5');
    rmSync(dir, { recursive: true, force: true });
});

// ── D2d 带 [1m] 不命中：原样透传含 [1m] ──
test('D2d: model 带 [1m] 但 base 不命中 → 原样透传含 [1m]', () => {
    const dir = newTmpDir('d2d');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: {} });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1[1m]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid4', 'application/json');
    assert.equal(r.rewritten, false);
    assert.equal(r.resolvedModel, 'ccp-sonnet-1[1m]');
    assert.equal(r.body, body);
    rmSync(dir, { recursive: true, force: true });
});

// ── D2e 空 model 不改 ──
test('D2e: 空 model → 不改', () => {
    const dir = newTmpDir('d2e');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'x' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: '' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid5', 'application/json');
    assert.equal(r.rewritten, false);
    rmSync(dir, { recursive: true, force: true });
});

// ── D2f model 缺失不改 ──
test('D2f: model 字段缺失 → 不改', () => {
    const dir = newTmpDir('d2f');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'x' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ messages: [] }), 'utf8');
    const r = cs.rewriteModel(body, 'rid6', 'application/json');
    assert.equal(r.rewritten, false);
    rmSync(dir, { recursive: true, force: true });
});

// ── D2g 非 JSON body / 非 object 原样返回 ──
test('D2g: 非 JSON body → 原样返回', () => {
    const dir = newTmpDir('d2g');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'x' } });
    cs.init(configPath(dir));
    const body = Buffer.from('not-json', 'utf8');
    const r = cs.rewriteModel(body, 'rid7', 'application/json');
    assert.equal(r.rewritten, false);
    assert.equal(r.body, body);
    // 非 json content-type
    const r2 = cs.rewriteModel(body, 'rid7b', 'text/event-stream');
    assert.equal(r2.rewritten, false);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7a 老配置无 nextAliasId → 兜底 0 ──
test('D7a: 老配置无 nextAliasId → init 兜底 0', () => {
    const dir = newTmpDir('d7a');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.equal(cs.getView().nextAliasId, 0);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7b nextAliasId 递增 + 持久化 ──
test('D7b: nextAliasId 递增 + persist', () => {
    const dir = newTmpDir('d7b');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    const a = cs.nextAliasId();
    const b = cs.nextAliasId();
    assert.equal(a, 1);
    assert.equal(b, 2);
    assert.equal(readConfig(dir).nextAliasId, 2);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7c 启动校正：已存别名编号 > nextAliasId → 抬到 max ──
test('D7c: 启动校正 — 已存 ccp-sonnet-5 但 nextAliasId=0 → 抬到 5，下个 id=6', () => {
    const dir = newTmpDir('d7c');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-3': 'a', 'ccp-sonnet-5': 'b' },
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    // 语义：nextAliasId = 已发出最大编号。校正后 = 5
    assert.equal(cs.getView().nextAliasId, 5);
    // 下一个 id 是 6（++5）
    assert.equal(cs.nextAliasId(), 6);
    rmSync(dir, { recursive: true, force: true });
});

// ── D2 附加：rewriteModel 与 rawModel 等于真实模型时不重复 stringify ──
test('D2附加: rawModel 已等于真实模型 → 不改写（rewritten=false）', () => {
    const dir = newTmpDir('d2extra');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'claude-sonnet-5' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5' }), 'utf8');
    // base 剥离后 'claude-sonnet-5' 不在表（key 是 ccp-sonnet-1）→ 不命中
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false);
    rmSync(dir, { recursive: true, force: true });
});

// ── 优化 2 回归：main 档别名 ccp-main-N 命中替换（代理侧无需改，验证同构）──
test('优化2: ccp-main-1 命中 → 替换为真实模型', () => {
    const dir = newTmpDir('opt2-main');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-main-1': 'glm-5.2' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-main-1', messages: [] }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, true);
    assert.equal(r.resolvedModel, 'glm-5.2');
    assert.equal(JSON.parse(r.body.toString()).model, 'glm-5.2');
    rmSync(dir, { recursive: true, force: true });
});

// ── 优化 2 回归：ccp-main-N[1m] 剥后缀查表命中 ──
test('优化2: ccp-main-1[1m] 剥后缀查表命中 → 替换 base', () => {
    const dir = newTmpDir('opt2-main-1m');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-main-1': 'glm-5.2' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-main-1[1m]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, true);
    assert.equal(r.resolvedModel, 'glm-5.2');
    assert.equal(JSON.parse(r.body.toString()).model, 'glm-5.2');
    rmSync(dir, { recursive: true, force: true });
});

// ── 优化 2 回归：main 档别名参与 nextAliasId 启动校正（/-(\d+)$/ 正则兼容 ccp-main-N）──
test('优化2: ccp-main-7 残留 + nextAliasId=0 → 启动校正抬到 7', () => {
    const dir = newTmpDir('opt2-main-corr');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-main-7': 'glm-5.2', 'ccp-sonnet-3': 'a' },
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    // main 档 N=7 是最大，校正应抬到 7
    assert.equal(cs.getView().nextAliasId, 7);
    assert.equal(cs.nextAliasId(), 8);
    rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// RV 系列（独立审查第二轮 — 陌生人视角，找前轮未覆盖的缺陷）
// ════════════════════════════════════════════════════════════

// RV1 翻转回归：nextAliasId=-5（负数）→ init 校正逻辑意外兜底（maxN=0 > -5 → 抬到 0）。
// 原怀疑：typeof/Number.isFinite 放过负数，nextAliasId() 返回 -4。
// 实测：init 校正 if (maxN > config.nextAliasId) 中 maxN=0（空表）> -5 → true → 抬到 0。
// 故负数被校正逻辑兜住（0 > 任何负数恒真）。非 bug，翻转回归确认。
test('RV1: nextAliasId=-5 → 校正逻辑兜底为 0（0 > -5 恒真）[翻转回归]', () => {
    const dir = newTmpDir('rv1-neg');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: {},
        nextAliasId: -5,
    });
    cs.init(configPath(dir));
    // 校正逻辑：maxN=0（空表）> -5 → true → 抬到 0
    assert.equal(cs.getView().nextAliasId, 0, '负数被校正逻辑兜底为 0');
    assert.equal(cs.nextAliasId(), 1, '下个 id=1');
    rmSync(dir, { recursive: true, force: true });
});

// RV2 真bug：nextAliasId=0.5（小数）→ typeof==='number' && Number.isFinite(0.5)===true → 保留。
// 空表 maxN=0，0 > 0.5 → false → 校正不抬。nextAliasId() 返回 1.5，config.nextAliasId 变 1.5。
// 持久化落盘 nextAliasId: 1.5，后续产出 1.5/2.5/3.5... 小数编号别名。
// 触发条件：手动编辑 config.json 把 nextAliasId 写成小数（0 < x < 1 时校正救不了）。
// 后果：小数编号别名，正则 /-(\d+)$/ 对 ccp-sonnet-1.5 提取 N=5（误），编号体系混乱。
// 断言正确行为（应为 0）：FAIL → 真 bug。
test('RV2: nextAliasId=0.5 → 应兜底为 0，实际保留 0.5 [真bug，待人工修复]', () => {
    const dir = newTmpDir('rv2-float');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: {},
        nextAliasId: 0.5,
    });
    cs.init(configPath(dir));
    // 期望（正确行为）：非整数应被兜底为 0
    assert.equal(cs.getView().nextAliasId, 0, '小数 nextAliasId 应被兜底为 0（真bug：实际保留 0.5）');
    rmSync(dir, { recursive: true, force: true });
});

// RV3 真bug：updateModelAlias 不校验 model 值的类型外的内容，但更严重的是 rewriteModel 把
// 映射表中非字符串值直接塞进 parsed.model。若手动编辑 config.json 让 modelAliases 值为数字：
//   {"ccp-sonnet-1": 5}
// rewriteModel: realModel = aliases[base] = 5（number），rawModel='ccp-sonnet-1'（string），
// rawModel === realModel → false，parsed.model = 5（number），JSON.stringify → "model":5。
// 上游收到 model: 5（数字）而非字符串 → 上游 API 报错或行为未定义。
// 触发条件：手动编辑 config.json 把映射值写成非字符串（数字/布尔/null/对象）。
// 后果：发往上游的 model 字段变成非字符串，上游 API 可能 400。
// 注：init 的兜底只检查 modelAliases 整体是 object，不检查每个 value 类型。
// 断言正确行为（应跳过非字符串值，rewritten=false）：FAIL → 真 bug。
test('RV3: modelAliases 值为数字 5 → 应跳过非字符串值，实际替换为数字 [真bug，待人工修复]', () => {
    const dir = newTmpDir('rv3-numval');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-1': 5 },  // 数字值（手动编辑脏数据）
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1', messages: [] }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    // 期望（正确行为）：非字符串映射值应被视为无效，不替换
    assert.equal(r.rewritten, false, '非字符串映射值应跳过不替换（真bug：实际替换了）');
    assert.equal(typeof JSON.parse(r.body.toString()).model, 'string', 'model 应保持字符串（真bug：变成数字）');
    rmSync(dir, { recursive: true, force: true });
});

// RV3b 真bug：modelAliases 值为 null → rewriteModel 行为
// realModel = null，rawModel='ccp-sonnet-1'，rawModel === null → false，parsed.model = null。
// 发往上游 model: null。同样是非字符串污染。
// 断言正确行为（应跳过 null 值）：FAIL → 真 bug。
test('RV3b: modelAliases 值为 null → 应跳过 null 值，实际替换为 null [真bug，待人工修复]', () => {
    const dir = newTmpDir('rv3b-nullval');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-1': null },
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1', messages: [] }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false, 'null 映射值应跳过不替换（真bug：实际替换了）');
    rmSync(dir, { recursive: true, force: true });
});

// RV4 真bug：modelAliases 值为布尔 false → rawModel === false 不成立（string !== boolean），
// parsed.model = false，发往上游 model: false。
// 断言正确行为（应跳过布尔值）：FAIL → 真 bug。
test('RV4: modelAliases 值为布尔 false → 应跳过布尔值，实际替换为 false [真bug，待人工修复]', () => {
    const dir = newTmpDir('rv4-boolval');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-1': false },
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1', messages: [] }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false, '布尔映射值应跳过不替换（真bug：实际替换了）');
    rmSync(dir, { recursive: true, force: true });
});

// RV5 静态推理/翻转回归：rewriteModel 的 [1m] 剥离正则 /\[1m\]/gi 是否正确处理 [1M]（大写）。
// 约束 3：CLI 的 has1mContext 用 /\[1m\]/i（不区分大小写），CLI 的 normalizeModelStringForAPI
// 用 /\[(1|2)m\]/gi（不区分大小写）剥离。故 CLI 会剥 [1M]/[1m]/[2M]/[2m]。
// 代理收到的是 CLI 剥后的别名（不带后缀），所以代理理论上收不到 [1M]。
// 但若有人直接调代理（绕过 CLI）发 [1M]，代理应剥吗？代理正则 /\[1m\]/gi 因 i 标志会剥 [1M]。
// 这与 CLI 一致（CLI 也剥 [1M]）。断言：代理剥 [1M]，与 CLI 行为一致。翻转回归用例。
test('RV5: rewriteModel 剥离 [1M]（大写）与 CLI /\[1m\]/i 一致 [翻转回归]', () => {
    const dir = newTmpDir('rv5-1M');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'claude-sonnet-5' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1[1M]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    // i 标志使 [1M] 被剥离 → base='ccp-sonnet-1' → 命中
    assert.equal(r.rewritten, true, '[1M] 被剥离（i 标志），命中别名');
    assert.equal(r.resolvedModel, 'claude-sonnet-5');
    rmSync(dir, { recursive: true, force: true });
});

// RV6 真bug：config.json 文件本身损坏（非法 JSON）→ init 里 JSON.parse(readFileSync(...)) 直接抛，
// 无 try/catch，代理启动失败，无任何兜底/降级。startServer 调 init 会 reject，扩展侧 tryBecomeHost 失败。
// 触发条件：用户手动编辑 config.json 写错（少括号/尾逗号），或磁盘损坏/部分写入。
// 后果：代理完全起不来，用户无明确错误提示（只能看 stderr 的 SyntaxError 堆栈）。
// 注：这是设计选择还是 bug？对比 persist() 写失败有 try/catch（只 log 不崩），
//     读失败无任何容错。但读失败时没有"已知好状态"可回退（配置是用户数据），抛错让上层处理是合理的。
//     这里测"init 对损坏文件抛 SyntaxError"，断言当前行为（抛错），标注为"防护缺失"而非功能 bug。
test('RV6: config.json 损坏（非法 JSON）→ init 抛 SyntaxError（无容错）[防护缺失，待人工评估]', () => {
    const dir = newTmpDir('rv6-corrupt');
    writeFileSync(configPath(dir), '{env: , proxy: invalid}', 'utf8');  // 非法 JSON
    // 当前行为：直接抛 SyntaxError（无 try/catch 兜底）
    assert.throws(() => cs.init(configPath(dir)), SyntaxError, 'init 对损坏配置抛 SyntaxError');
    rmSync(dir, { recursive: true, force: true });
});

// RV7 真bug：modelAliases 值为对象（非字符串/数字/布尔/null）→ rewriteModel 行为
// realModel = {x:1}（对象），rawModel='ccp-sonnet-1'，rawModel === realModel → false，
// parsed.model = {x:1}，JSON.stringify → "model":{"x":1}。发往上游 model 是对象，上游必 400。
// 断言正确行为（应跳过对象值）：FAIL → 真 bug。
test('RV7: modelAliases 值为对象 → 应跳过对象值，实际替换为对象 [真bug，待人工修复]', () => {
    const dir = newTmpDir('rv7-objval');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-1': { real: 'glm-5' } },
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1', messages: [] }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false, '对象映射值应跳过不替换（真bug：实际替换了）');
    rmSync(dir, { recursive: true, force: true });
});

// RV8 静态推理/翻转回归：nextAliasId = NaN → typeof NaN === 'number' 但 Number.isFinite(NaN)===false
// → 兜底为 0。这是对的。回归用例确认 NaN 被兜底。
test('RV8: nextAliasId=NaN → 兜底为 0（Number.isFinite 守卫生效）[翻转回归]', () => {
    const dir = newTmpDir('rv8-nan');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: {},
        nextAliasId: NaN,
    });
    cs.init(configPath(dir));
    assert.equal(cs.getView().nextAliasId, 0, 'NaN 被 Number.isFinite 守卫兜底为 0');
    assert.equal(cs.nextAliasId(), 1);
    rmSync(dir, { recursive: true, force: true });
});

// RV9 静态推理/翻转回归：nextAliasId = Infinity → Number.isFinite(Infinity)===false → 兜底 0。
test('RV9: nextAliasId=Infinity → 兜底为 0 [翻转回归]', () => {
    const dir = newTmpDir('rv9-inf');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: {},
        nextAliasId: Infinity,
    });
    cs.init(configPath(dir));
    assert.equal(cs.getView().nextAliasId, 0, 'Infinity 被兜底为 0');
    rmSync(dir, { recursive: true, force: true });
});

// RV10 真bug（边界）：rewriteModel 当 rawModel 带多个 [1m] 后缀（如 ccp-sonnet-1[1m][1m]）。
// CLI 的 normalizeModelStringForAPI 用 /\[(1|2)m\]/gi（global）会剥所有匹配，但 CLI 永远只加一个 [1m]。
// 代理正则 /\[1m\]/gi（global）也会剥所有 → base='ccp-sonnet-1'。命中替换为 realModel。
// 但 rawModel='ccp-sonnet-1[1m][1m]'，realModel='claude-sonnet-5'，rawModel !== realModel → rewritten=true。
// 这与 CLI 一致（CLI 也 global 剥）。不是 bug。翻转回归确认多 [1m] 被全剥。
test('RV10: rawModel 带 [1m][1m] 双后缀 → 全剥后命中 [翻转回归]', () => {
    const dir = newTmpDir('rv10-multi1m');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'claude-sonnet-5' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1[1m][1m]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, true, 'global 正则剥所有 [1m]');
    assert.equal(r.resolvedModel, 'claude-sonnet-5');
    assert.equal(JSON.parse(r.body.toString()).model, 'claude-sonnet-5');
    rmSync(dir, { recursive: true, force: true });
});

// RV11 约束违反检查：[2m] 不被剥离（约束 3）—— 已在 review-suspects C1-1 覆盖。
// 这里补充 [2M]（大写）也不被剥离，确认 i 标志没误伤 [2m]。
test('RV11: [2M] 大写也不被剥离（只剥 [1m]，约束 3）[翻转回归]', () => {
    const dir = newTmpDir('rv11-2M');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'claude-sonnet-5' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1[2M]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false, '[2M] 不被剥离，base 含 [2M] 不命中');
    assert.equal(r.resolvedModel, 'ccp-sonnet-1[2M]');
    rmSync(dir, { recursive: true, force: true });
});

// RV12 真bug（边界）：removeModelAlias 删不存在的别名返回 {removed: true}。
// 语义误导：删除一个从未存在的别名，返回 removed:true 让调用方以为删了东西。
// 但 D1e 已断言为"非 bug（幂等）"。这里翻转确认当前行为，标注语义不一致。
test('RV12: removeModelAlias 删不存在 → 返回 removed:true（语义不一致但幂等）[翻转回归]', () => {
    const dir = newTmpDir('rv12-delnoexist');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'a' } });
    cs.init(configPath(dir));
    const r = cs.removeModelAlias('ccp-sonnet-99');  // 不存在
    assert.equal(r.removed, true, '删不存在也返回 removed:true（语义不一致，但幂等无害）');
    rmSync(dir, { recursive: true, force: true });
});

// RV13 真bug（类型安全）：updateModelAlias 不校验 alias 含换行符/控制字符。
// alias='ccp-sonnet-1\nX-Inject: bad' 会被写入 config.json 作为 key。
// JSON 里换行在 key 中是合法的（转义为 \n），不会破坏 JSON，但若该 key 被用于
// 任何非 JSON 上下文（如日志、文件名、正则）可能注入。当前仅作 JSON key，风险低。
// 标注为"防护缺失"而非真 bug。
test('RV13: updateModelAlias alias 含换行符 → 不校验（防护缺失，低风险）[翻转回归]', () => {
    const dir = newTmpDir('rv13-newline');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    // 不抛错，写入含换行的 alias
    assert.doesNotThrow(() => cs.updateModelAlias('ccp-sonnet-1\nbad', 'real'));
    const aliases = cs.getModelAliases();
    assert.ok(Object.hasOwn(aliases, 'ccp-sonnet-1\nbad'), '含换行的 alias 被写入');
    rmSync(dir, { recursive: true, force: true });
});

// RV14 真bug（状态转换）：init 校正正则 /-(\d+)$/ 对超大数字（如 ccp-sonnet-99999999999999999999）
// Number(m[1]) 会精度丢失（超过 Number.MAX_SAFE_INTEGER）。maxN 变成不精确值，
// nextAliasId 被抬到不精确值，后续编号跳号或精度异常。
// 触发条件：手动编辑 config.json 写超长数字别名。
// 后果：nextAliasId 精度丢失，编号体系异常（但概率极低，标注防护缺失）。
test('RV14: 超大数字别名 → Number() 精度丢失 [防护缺失，极低概率]', () => {
    const dir = newTmpDir('rv14-bignum');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-99999999999999999999': 'a' },
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    // Number('99999999999999999999') = 1e+20（精度丢失，超出 MAX_SAFE_INTEGER）
    const v = cs.getView().nextAliasId;
    assert.ok(v > 0, '校正抬到某大数');
    assert.ok(!Number.isSafeInteger(v), '精度丢失（非安全整数）');
    rmSync(dir, { recursive: true, force: true });
});

// RV15 静态推理（一致性）：rewriteModel 当 rawModel === realModel 短路时 resolvedModel 返回 realModel。
// 但若 rawModel 带 [1m] 而 realModel 也恰好等于带 [1m] 的 rawModel（自引用带后缀）：
// alias 'ccp-sonnet-1[1m]' → model 'ccp-sonnet-1[1m]'，rawModel='ccp-sonnet-1[1m]'，
// base='ccp-sonnet-1'（剥了 [1m]），realModel='ccp-sonnet-1[1m]'（表里的值，含 [1m]）。
// rawModel === realModel → true → 短路不替换，resolvedModel=realModel='ccp-sonnet-1[1m]'。
// 此时 body 没改（model 仍是 ccp-sonnet-1[1m]），发往上游带 [1m] 后缀。
// 这是否 bug？若用户故意把别名映射到带 [1m] 的自身，是自引用，不替换合理。但 [1m] 后缀发往上游
// 可能被上游当字面量（上游不认 [1m]）。标注为"边界行为"，非 bug（用户自引用配置）。
test('RV15: 自引用带 [1m] 映射 → 短路不替换，body 保留 [1m] [翻转回归，边界行为]', () => {
    const dir = newTmpDir('rv15-selfref');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'ccp-sonnet-1[1m]' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1[1m]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    // rawModel='ccp-sonnet-1[1m]', base='ccp-sonnet-1', realModel='ccp-sonnet-1[1m]'
    // rawModel === realModel → 短路
    assert.equal(r.rewritten, false, '自引用短路不替换');
    assert.equal(r.resolvedModel, 'ccp-sonnet-1[1m]');
    assert.equal(r.body, body, 'body 原样');
    rmSync(dir, { recursive: true, force: true });
});

// RV16 真bug（类型安全）：updateModelAlias 用 alias.trim() 校验但写入原始 alias（含首尾空格）。
// 已在 review-suspects C2-2 覆盖为"味道"。这里确认 server.js 层的校验与 store 层不一致：
// server.js POST /api/model-alias 用 !alias（truthy 检查，不 trim）→ 纯空格 '  ' 是 truthy → 放行；
// store 层用 !alias.trim() → 拦截纯空格。两层不一致但双层防御，最终纯空格被 store 层拦。
// 但若直接调 store（如其他代码路径或测试），server 层校验不生效。
// 这里测 store 层单独调用：纯空格 alias 抛错（已覆盖 C6-1），补充 model 纯空格也抛错。
test('RV16: updateModelAlias model 纯空格 → store 层 trim 拦截 [翻转回归]', () => {
    const dir = newTmpDir('rv16-spacemodel');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.throws(() => cs.updateModelAlias('ccp-sonnet-1', '   '), /model 不能为空/);
    rmSync(dir, { recursive: true, force: true });
});

// RV17 真bug（时序/一致性）：rewriteModel 读 config.modelAliases 不拷贝（const aliases = config.modelAliases ?? {}），
// 而 updateModelAlias 每次创建新对象赋值。但 rewriteModel 在 'base in aliases' 检查后到
// aliases[base] 读取之间，若 config.modelAliases 被并发替换，rewriteModel 持有的 aliases 引用还是旧的。
// Node 单线程无真正并发（无 await 在 rewriteModel 中间），故无竞态。但 rewriteModel 是同步函数，
// 中间无 await，不会被 updateModelAlias 打断。安全。翻转回归确认。
test('RV17: rewriteModel 同步无 await → 无并发竞态 [翻转回归]', () => {
    const dir = newTmpDir('rv17-noawait');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'a' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1' }), 'utf8');
    // 同步调用，中间无 await，不会被 updateModelAlias 打断
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.resolvedModel, 'a');
    rmSync(dir, { recursive: true, force: true });
});

// RV18 约束符合性：约束 5 要求所有 res.end 出口显式 Content-Length。
// server.js 502 错误响应（passthrough 网络错误，行 677-678）显式写了 content-length。
// reply() 函数（行 307-314）删了 content-length 但用 res.end(Buffer) 一次性写，
// Node 会自动算 Content-Length（Buffer 一次性 end 不分块）。这是否满足约束 5？
// 约束 5 原文："所有 res.end 出口显式写 Content-Length"。reply() 没显式写，依赖 Node 自动算。
// 但 reply 用于非扩展宿主客户端（CLI/curl），Node 自动算 Content-Length 对这些客户端 OK。
// 扩展宿主走裸 socket 不经 reply。故 reply 不显式写 Content-Length 是"规范但不严格满足约束 5 字面"。
// 标注为"一致性"问题，非功能 bug（reply 的客户端不受空 body 坑影响）。
// 此项为静态推理，无独立测试（需起 HTTP 验 reply 路径，已在 e2e 覆盖）。

// RV19 真bug（边界）：rewriteModel 当 body 是合法 JSON 但 parsed.model 是空字符串 ''。
// typeof '' === 'string' 但 !rawModel（!''===true）→ 返回 rewritten:false, resolvedModel: rawModel ?? undefined = ''。
// 但 server.js 提取 reqModel 时 reqModel = parsed.model || '' → ''（空串）。
// modelTag: resolvedModel('') && resolvedModel !== reqModel('') → '' && false → ''（falsy）→ 无 tag。
// 一致。翻转回归确认空 model 不改写。
test('RV19: model 是空字符串 → 不改写，resolvedModel="" [翻转回归]', () => {
    const dir = newTmpDir('rv19-emptymodel');
    writeConfig(dir, { env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'x' } });
    cs.init(configPath(dir));
    const body = Buffer.from(JSON.stringify({ model: '' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false);
    assert.equal(r.resolvedModel, '');
    rmSync(dir, { recursive: true, force: true });
});

// RV20 真bug（边界）：init 校正当别名 key 是 '__proto__' 或 'constructor' 等原型属性名。
// Object.keys(config.modelAliases) 不返回原型属性（只返回自有可枚举），故 __proto__ 作为 key
// 不会被 Object.keys 遍历到（除非它是自有属性，计算属性赋值时是自有属性）。
// 实测：JSON.parse('{"__proto__":1}') 的 __proto__ 是自有属性，Object.keys 会返回它。
// /-(\d+)$/.exec('__proto__') → null（不匹配）。故不影响 maxN。安全。翻转回归确认。
test('RV20: 别名 key="__proto__-5" → init 校正正则匹配 N=5 [翻转回归，边界]', () => {
    const dir = newTmpDir('rv20-protokey');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { '__proto__-5': 'a' },
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    // /-(\d+)$/.exec('__proto__-5') → 匹配 N=5 → maxN=5 → 校正到 5
    assert.equal(cs.getView().nextAliasId, 5, '校正从 __proto__-5 取 N=5');
    rmSync(dir, { recursive: true, force: true });
});
