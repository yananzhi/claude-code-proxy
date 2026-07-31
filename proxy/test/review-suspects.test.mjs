// proxy/test/review-suspects.test.mjs — 独立审查：逐条验证怀疑点
//
// 运行：node --test proxy/test/review-suspects.test.mjs
//
// 方法论（TDD 确认）：
//   1. 先写测试断言"bug 存在"（期望错误行为）。
//   2. 跑测试：
//      - 失败 → bug 真实 → 修代码让测试过。
//      - 通过 → 非 bug → 把断言翻转成期望正确行为，留作回归用例。
//   3. 全部跑通。
//
// 维度覆盖（6 类高风险）：
//   C1 边界条件（空值/边界输入）
//   C2 异常/错误路径遗漏
//   C3 类型安全（unsafe cast、null check 缺失）
//   C4 状态转换漏洞（init 校正、persist 一致性）
//   C5 并发/时序（多请求并发改映射表、rewriteModel 与接口并发）
//   C6 与既有代码不一致（命名、错误处理、persist 模式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cs from '../config-store.js';

function newTmpDir(prefix) {
    const d = join(process.cwd(), '.test-tmp', `review-${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(d, { recursive: true });
    return d;
}
function configPath(dir) { return join(dir, 'config.json'); }
function writeConfig(dir, obj) { writeFileSync(configPath(dir), JSON.stringify(obj), 'utf8'); }
function readConfig(dir) { return JSON.parse(readFileSync(configPath(dir), 'utf8')); }
function setup(obj = { env: {}, proxy: {} }) {
    const dir = newTmpDir('suspect');
    writeConfig(dir, obj);
    cs.init(configPath(dir));
    return dir;
}

// ════════════════════════════════════════════════════════════
// C1 边界条件（空值/边界输入）
// ════════════════════════════════════════════════════════════

// C1-1 🔴 rewriteModel 的 [1m] 剥离正则原为 /\[(1|2)m\]/gi —— [2m] 被剥离，与 CLI 不一致
// 设计文档 §6.9.1 明确："唯一合法长度标记是 [1m]"，"[2m] 不被识别，会被当模型名字面量原样传递"
// 原 bug：代理剥 [2m]，CLI 不剥。若别名带 [2m] 会被误命中；若真实模型名含 [2m] 会被误剥。
// 已修：正则改为 /\[1m\]/gi，只剥 [1m]。回归用例确认 [2m] 不再被剥离。
test('C1-1: rewriteModel 不剥离 [2m]（已修：只剥 [1m]，与 CLI 一致）[已修-回归]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'claude-sonnet-5' } });
    // 请求 model 带 [2m]：CLI 不剥（字面量），代理也不剥 → base='ccp-sonnet-1[2m]' → 不命中表
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1[2m]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false, '[2m] 不被剥离，base 含 [2m] 不命中别名表');
    assert.equal(r.resolvedModel, 'ccp-sonnet-1[2m]', '原样透传含 [2m]');
    assert.equal(r.body, body);
    rmSync(dir, { recursive: true, force: true });
});

// C1-1b 补充：[1m] 仍正常剥离（修 [2m] 不能误伤 [1m]）
test('C1-1b: rewriteModel 仍剥离 [1m]（修 [2m] 未误伤 [1m]）[回归]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'claude-sonnet-5' } });
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1[1m]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, true, '[1m] 正常剥离并命中');
    assert.equal(r.resolvedModel, 'claude-sonnet-5');
    rmSync(dir, { recursive: true, force: true });
});

// C1-2 🟡 rewriteModel 不命中时返回 resolvedModel: rawModel（含 [1m] 后缀）——trace 落这个值
// 怀疑：不命中时 resolvedModel 是 rawModel（含 [1m]），而命中时是真实模型（不含 [1m]）。
// trace 落 resolvedModel 时，不命中场景会记一个带 [1m] 的"未解析别名"，这在 trace 统计/过滤里
// 可能造成混乱（§6.10 的 session filter 用 ccp-(haiku|sonnet|opus)-N 正则提取 N，若 rawModel
// 是别的模型名带 [1m] 会匹配不上，但这不是 bug）。真正的问题：不命中时 resolvedModel 记 rawModel
// 而非真实模型，语义上"resolvedModel"应是"最终发给上游的 model"，不命中时上游收到的就是 rawModel，
// 所以记 rawModel 是对的。断言"非 bug"，回归用例。
test('C1-2: 不命中时 resolvedModel=rawModel（含后缀）——语义正确（上游收到的就是 rawModel）[非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: {} });
    const body = Buffer.from(JSON.stringify({ model: 'some-model[1m]' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false);
    assert.equal(r.resolvedModel, 'some-model[1m]', '不命中时 resolvedModel 记 rawModel，语义正确');
    rmSync(dir, { recursive: true, force: true });
});

// C1-3 🟡 init 启动校正正则 /-(\d+)$/ —— 别名 ccp-sonnet-foo-1 也拿 1，会误抬
// 怀疑：正则只看结尾的 -N，不约束前缀格式。若用户手动加了个 ccp-sonnet-foo-1（非标准别名），
// init 也会拿 1 去 max。但这是"防重号"的防御逻辑，误抬 nextAliasId 只会让下个编号跳号，不会重号，
// 方向上是安全的（宁可跳号不可重号）。断言"非 bug"（防御性抬号安全方向），但记录格式约束不足。
test('C1-3: init 校正正则不约束前缀 —— ccp-sonnet-foo-1 也被抬，但方向安全（跳号不重号）[非BUG]', () => {
    const dir = newTmpDir('c1-3');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-foo-1': 'a', 'ccp-haiku-3': 'b' },
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    // maxN=3（从 ccp-haiku-3），nextAliasId 校正到 3
    assert.equal(cs.getView().nextAliasId, 3, '取 max 编号，方向安全');
    rmSync(dir, { recursive: true, force: true });
});

// C1-4 🟢 rewriteModel 对 null prototype 的 JSON.parse 对象的处理
// JSON.parse('{"model":"x"}') 返回的是普通对象，但若上游 body 是 {"__proto__":...} 边界情况
// 'in' 操作符在 null prototype 对象上行为正常，这里不是问题。留一个回归用例。
test('C1-4: parsed.model 为数字 0 时不命中（类型守卫）[非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { '0': 'real' } });
    const body = Buffer.from(JSON.stringify({ model: 0 }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false, 'typeof 0 !== "string"，不命中');
    rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// C2 异常/错误路径遗漏
// ════════════════════════════════════════════════════════════

// C2-1 🟡 updateModelAlias 不校验 alias 里的特殊字符 / 原型污染键
// 怀疑：alias="__proto__" 会污染 Object.prototype。
// 实测：{ ...(config.modelAliases ?? {}), [alias]: model } 用计算属性语法 [alias]: model，
// 计算属性赋值 __proto__ 时设的是普通自有属性，不触发原型 setter（与 obj.__proto__ = x 不同）。
// JSON.parse 落盘/读盘也不触发原型设置。故无原型污染。但 __proto__ 作为别名 key 是脏数据，
// 不校验特殊字符是代码味道。断言"非 bug"（无污染），回归用例。
test('C2-1: updateModelAlias(alias="__proto__") 不污染原型（计算属性语法安全）[非BUG]', () => {
    const dir = setup();
    cs.updateModelAlias('__proto__', 'polluted');
    // 未污染 Object.prototype
    assert.equal(({}).polluted, undefined, '未污染原型');
    // 但 __proto__ 作为自有属性存在于映射表（脏数据，但不崩溃）
    const aliases = cs.getModelAliases();
    assert.equal(Object.hasOwn(aliases, '__proto__'), true, '__proto__ 作为自有属性存在');
    assert.equal(aliases['__proto__'], 'polluted');
    rmSync(dir, { recursive: true, force: true });
});

// C2-2 🟡 updateModelAlias 用 trim() 校验但写入原始值（含空格）
// updateModelAlias('  ccp-sonnet-1  ', 'x') 通过校验（trim 后非空），但写入的 key 是 '  ccp-sonnet-1  '
// 怀疑：CLI 发来的 model 不会带首尾空格，所以查表时 base 也不会带空格，这条映射永远命中不了。
// 这不是严重 bug（用户不会故意输空格），但写入值与校验逻辑不一致是代码味道。
test('C2-2: updateModelAlias 写入含空格的 alias（trim 只校验不清洗）[味道]', () => {
    const dir = setup();
    const r = cs.updateModelAlias('  ccp-sonnet-1  ', 'real');
    assert.equal(r.alias, '  ccp-sonnet-1  ', '写入原始值含空格');
    // 查表时 model='ccp-sonnet-1'（不带空格）→ base='ccp-sonnet-1' → 不命中（key 是带空格的）
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1' }), 'utf8');
    const rr = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(rr.rewritten, false, '带空格的 key 查表不命中（CLI 不会带空格）');
    rmSync(dir, { recursive: true, force: true });
});

// C2-3 🟡 rewriteModel: contentType 为 undefined 时的行为
// server.js 调用时传 req.headers['content-type']，若请求无 content-type 头则为 undefined
// rewriteModel 里 String(contentType || '').toLowerCase() → '' → 不 includes 'json' → 原样返回
// 这是对的（非 JSON 不改）。但 Claude Code 总会带 content-type: application/json。
// 断言"非 bug"，回归用例。
test('C2-3: contentType=undefined → 原样返回（非JSON处理）[非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'real' } });
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', undefined);
    assert.equal(r.rewritten, false);
    assert.equal(r.body, body);
    rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// C3 类型安全（unsafe cast、null check 缺失）
// ════════════════════════════════════════════════════════════

// C3-1 🟡 init 中 nextAliasId 兜底：typeof !== 'number' || !Number.isFinite
// 怀疑：若 nextAliasId 是字符串 "5"（手动编辑配置文件常见），typeof !== 'number' → 兜底 0
// 这会丢掉手动设的 5，但启动校正会从已存别名 maxN 重新抬起来。若别名表空但 nextAliasId="5"，
// 会丢成 0，下个 id 返回 1（跳过 1..5 的"已用"语义，但既然别名表空，1..5 没被占用，返 1 也对）。
// 断言"非 bug"（兜底逻辑自洽），但字符串数字被丢弃值得回归。
test('C3-1: nextAliasId 是字符串 "5" → 兜底 0（启动校正兜底）[非BUG]', () => {
    const dir = newTmpDir('c3-1');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-3': 'a' },
        nextAliasId: "5",  // 字符串
    });
    cs.init(configPath(dir));
    // typeof "5" !== 'number' → 兜底 0；启动校正 maxN=3 → 抬到 3
    assert.equal(cs.getView().nextAliasId, 3, '字符串被兜底为0，校正从别名表恢复');
    rmSync(dir, { recursive: true, force: true });
});

// C3-2 🔴 init 兜底条件原为 !config.modelAliases || typeof config.modelAliases !== 'object'
// 漏了数组：typeof [] === 'object' 且 [] 是 truthy，两个条件都不触发 → 数组不被兜底成 {}
// 后果：数组 ['a','b'] 被 getModelAliases 的 {..spread} 转成 {"0":"a","1":"b"}，
// 被当成"别名'0'→a, 别名'1'→b"的错误映射。已修：加 Array.isArray 排除数组。
// 回归用例确认数组被兜底为 {}。
test('C3-2: modelAliases 是数组 → init 兜底为 {}（已修：加 Array.isArray）[已修-回归]', () => {
    const dir = newTmpDir('c3-2');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: ['a', 'b'],  // 数组，非法格式
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    const aliases = cs.getModelAliases();
    assert.deepEqual(aliases, {}, '数组被兜底为空对象 {}');
    rmSync(dir, { recursive: true, force: true });
});

// C3-3 🟢 rewriteModel: parsed 是数组时 typeof === 'object' 但无 model 字段
// JSON.parse('[]') 返回数组，typeof === 'object'，通过类型守卫，但 [].model === undefined
// 走到 typeof rawModel !== 'string' → 原样返回。安全。回归用例。
test('C3-3: body 是 JSON 数组 → 原样返回（无 model 字段）[非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'real' } });
    const body = Buffer.from('[1,2,3]', 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false);
    assert.equal(r.body, body);
    rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// C4 状态转换漏洞（init 校正、persist 一致性）
// ════════════════════════════════════════════════════════════

// C4-1 🔴 nextAliasId 语义：返回 n+1，init 校正是 if (maxN > nextAliasId) nextAliasId = maxN
// 怀疑：nextAliasId 语义是"已发出的最大编号"，nextAliasId() 返回 ++n（下一个新编号）。
// 但 init 校正用 `if (maxN > nextAliasId) nextAliasId = maxN`，不是 maxN+1。
// 场景：已存 ccp-sonnet-1（maxN=1）+ nextAliasId=0 → 校正到 1 → nextAliasId() 返回 2。
// 这是对的：1 号已占用，下个该发 2 号。但文档 §6.2 写的是"若 max ≥ nextAliasId 则抬 nextAliasId = max+1"。
// 代码用的是严格大于 + 抬到 max（不是 max+1），靠 nextAliasId() 的 ++n 补偿。
// 验证：已存 ccp-sonnet-1（maxN=1）+ nextAliasId=0 → 校正后 nextAliasId=1 → nextAliasId() 返回 2（正确，1 已占）
// 断言"非 bug"，回归用例。
test('C4-1: 已存 ccp-sonnet-1 + nextAliasId=0 → 校正到1，下个id=2（1已占）[非BUG]', () => {
    const dir = newTmpDir('c4-1');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-1': 'a' },
        nextAliasId: 0,
    });
    cs.init(configPath(dir));
    assert.equal(cs.getView().nextAliasId, 1, '校正到 maxN=1');
    assert.equal(cs.nextAliasId(), 2, '下个 id=2（1 号已占用）');
    rmSync(dir, { recursive: true, force: true });
});

// C4-2 🟡 persist 一致性：nextAliasId 是否被 persist 写回？
// 怀疑：persist() 函数只写 config.proxy 段 + config 整体 JSON.stringify。
// nextAliasId 存在 config 顶层，JSON.stringify(config) 会包含它。所以会被写回。
// 但要确认 persist 没有遗漏 nextAliasId 字段。回归用例。
test('C4-2: nextAliasId 递增后 persist 写回 config.json [非BUG]', () => {
    const dir = setup();
    cs.nextAliasId();
    cs.nextAliasId();
    const disk = readConfig(dir);
    assert.equal(disk.nextAliasId, 2, 'persist 写回 nextAliasId');
    rmSync(dir, { recursive: true, force: true });
});

// C4-3 🟡 removeModelAlias 后 persist 一致性：删除后 config.json 里该 key 没了
test('C4-3: removeModelAlias 后 persist 落盘（key 确实删除）[非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'a', 'ccp-sonnet-2': 'b' } });
    cs.removeModelAlias('ccp-sonnet-1');
    const disk = readConfig(dir);
    assert.ok(!('ccp-sonnet-1' in (disk.modelAliases ?? {})));
    assert.equal(disk.modelAliases['ccp-sonnet-2'], 'b');
    rmSync(dir, { recursive: true, force: true });
});

// C4-4 🟡 init 校正：nextAliasId 已 > maxN 时不压回（严格大于才抬，不向下校正）
// 怀疑：若 nextAliasId=10 但别名表只有 ccp-sonnet-1（maxN=1），校正不触发（1 不 > 10），
// nextAliasId 保持 10，下个 id=11。这是对的（10 之前的号可能被已删会话用过，不回收）。
// 但若 nextAliasId=10 是手动编辑的错误值（实际从没发过 10 个号），会跳号 2..10。
// 这是"宁可跳号不可重号"的安全方向。回归用例。
test('C4-4: nextAliasId=10 + maxN=1 → 不压回（安全方向：跳号不重号）[非BUG]', () => {
    const dir = newTmpDir('c4-4');
    writeConfig(dir, {
        env: {}, proxy: {},
        modelAliases: { 'ccp-sonnet-1': 'a' },
        nextAliasId: 10,
    });
    cs.init(configPath(dir));
    assert.equal(cs.getView().nextAliasId, 10, '不向下校正');
    assert.equal(cs.nextAliasId(), 11, '下个 id=11');
    rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// C5 并发/时序（多请求并发改映射表、rewriteModel 与接口并发）
// ════════════════════════════════════════════════════════════

// C5-1 🟢 并发：多个 nextAliasId() 并发调用不会重号（Node 单线程 + 同步 ++）
// Node 是单线程，config.nextAliasId = n+1 是同步操作，不会有竞态。回归用例。
test('C5-1: 连续 nextAliasId() 不重号 [非BUG]', () => {
    const dir = setup();
    const ids = [];
    for (let i = 0; i < 100; i++) ids.push(cs.nextAliasId());
    const unique = new Set(ids);
    assert.equal(unique.size, 100, '100 个 id 全唯一');
    assert.equal(Math.max(...ids), 100);
    rmSync(dir, { recursive: true, force: true });
});

// C5-2 🟢 rewriteModel 读 config.modelAliases 不拷贝，与 updateModelAlias 写并发
// updateModelAlias 每次创建新对象 { ...(config.modelAliases ?? {}), [alias]: model } 再赋值
// rewriteModel 读 const aliases = config.modelAliases ?? {} —— 读的是引用
// 若 rewriteModel 正在遍历 'base in aliases' 时 updateModelAlias 把 config.modelAliases 换成新对象，
// rewriteModel 持有的还是旧引用，结果一致（旧表）。这是安全的（下个请求读新表）。
// Node 单线程下两者不会真正并发（无 await 在中间），所以无竞态。回归用例。
test('C5-2: rewriteModel 与 updateModelAlias 无竞态（单线程 + 引用替换）[非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'a' } });
    const body = Buffer.from(JSON.stringify({ model: 'ccp-sonnet-1' }), 'utf8');
    const r1 = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r1.resolvedModel, 'a');
    cs.updateModelAlias('ccp-sonnet-1', 'b');
    const r2 = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r2.resolvedModel, 'b', '更新后读到新值');
    rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// C6 与既有代码不一致（命名、错误处理、persist 模式）
// ════════════════════════════════════════════════════════════

// C6-1 🟡 server.js 接口入参校验：POST /api/model-alias 的 alias/model 是空串
// server.js: `if (typeof alias !== 'string' || !alias || typeof model !== 'string' || !model)`
// 空串 '' 被 !'' 拦截（truthy 检查）。但 config-store.js 的 updateModelAlias 用 !alias.trim()
// 两层校验不一致：server 层 !alias 拦截空串，store 层 !alias.trim() 拦截纯空格。
// 若 server 层放过 '  '（纯空格，!''  是 false，!'  ' 也是 false... 等等）
// 实际：!'  ' === false（非空字符串是 truthy），所以 server 层不拦截纯空格，会进 store 层被 trim 拦截
// 这不是 bug（双层防御），但两层校验逻辑不一致是代码味道。回归用例确认纯空格被拦。
test('C6-1: POST /api/model-alias 纯空格 alias → store 层 trim 拦截抛错 [非BUG]', () => {
    const dir = setup();
    // server 层 !'  ' === false（放行），store 层 !'  '.trim() === true（拦截）
    assert.throws(() => cs.updateModelAlias('   ', 'real'), /alias 不能为空/);
    assert.throws(() => cs.updateModelAlias('ccp-sonnet-1', '   '), /model 不能为空/);
    rmSync(dir, { recursive: true, force: true });
});

// C6-2 🟡 rewriteModel 与 rewriteEffort 命名/返回结构不一致
// rewriteEffort 返回 Buffer（body 或改写后的 body）
// rewriteModel 返回 { body, rewritten, resolvedModel }
// 串联时 server.js: outBody = rewriteEffort(...) 返 Buffer → rewriteModel(outBody) 接 Buffer
// 命名风格不一致但功能正确。回归用例确认串联。
test('C6-2: rewriteEffort 返 Buffer，rewriteModel 接 Buffer，串联正确 [非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'real' } });
    // 模拟 rewriteEffort 改了 effort 后的 body（已是 Buffer）
    const body = Buffer.from(JSON.stringify({
        model: 'ccp-sonnet-1', output_config: { effort: 'high' },
    }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, true);
    assert.equal(r.resolvedModel, 'real');
    assert.equal(JSON.parse(r.body.toString()).model, 'real');
    assert.equal(JSON.parse(r.body.toString()).output_config.effort, 'high', 'effort 字段保留');
    rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════
// C-extra: resolvedModel 在 trace 链路的边界
// ════════════════════════════════════════════════════════════

// C-7 🟡 rewriteModel 请求本来没 model 字段：resolvedModel 返回啥？
// rawModel = parsed.model → undefined → typeof !== 'string' → 返回 {resolvedModel: rawModel ?? undefined}
// 即 resolvedModel: undefined。server.js: const resolvedModel = modelResult.resolvedModel;
// trace: resolvedModel: resolvedModel ?? '' → ''
// trace-store.append: typeof trace.resolvedModel !== 'string' → '' （兜底）
// 链路安全。回归用例。
test('C-7: 请求无 model 字段 → resolvedModel=undefined → trace 落 "" [非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'real' } });
    const body = Buffer.from(JSON.stringify({ messages: [] }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false);
    assert.equal(r.resolvedModel, undefined, '无 model 字段 → undefined');
    // server.js 会做 resolvedModel ?? '' → ''
    const traceResolved = r.resolvedModel ?? '';
    assert.equal(traceResolved, '', 'trace 落空串');
    rmSync(dir, { recursive: true, force: true });
});

// C-8 🟡 rewriteModel: body 是空 Buffer（length=0）
// JSON.parse('') 抛错 → catch → 原样返回 {resolvedModel: undefined}
// 但 server.js 里 body.length > 0 才 parse 提取 reqModel，rewriteModel 无此守卫
// 空 body 进 rewriteModel → parse 失败 → 原样返回。安全。回归用例。
test('C-8: 空 body → JSON.parse 失败 → 原样返回 [非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'ccp-sonnet-1': 'real' } });
    const body = Buffer.alloc(0);
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false);
    assert.equal(r.body, body);
    assert.equal(r.resolvedModel, undefined);
    rmSync(dir, { recursive: true, force: true });
});

// C-9 🟡 rewriteModel: rawModel === realModel 时不改写（短路）
// 已有 D2附加 测试覆盖，但确认 resolvedModel 返回 realModel（不是 rawModel）
test('C-9: rawModel 已等于真实模型 → 不改写，resolvedModel=realModel [非BUG]', () => {
    const dir = setup({ env: {}, proxy: {}, modelAliases: { 'claude-sonnet-5': 'claude-sonnet-5' } });
    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5' }), 'utf8');
    const r = cs.rewriteModel(body, 'rid', 'application/json');
    assert.equal(r.rewritten, false);
    assert.equal(r.resolvedModel, 'claude-sonnet-5', '短路返回 realModel');
    rmSync(dir, { recursive: true, force: true });
});
