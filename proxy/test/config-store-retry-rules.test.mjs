// proxy/test/config-store-retry-rules.test.mjs — retryRules 配置层单测
//
// 运行：node --test proxy/test/config-store-retry-rules.test.mjs
// 纯文件系统，不起 HTTP。测 config-store 的 retryRules 模型：默认值、迁移、校验、持久化、getView。
//
// 维度覆盖：
//   D1 规则 status 维度（具体 / '*' 通配 / 不命中）
//   D2 规则 code 维度（具体数字 / 'all' 通配）
//   D7 配置层（默认 / 热更新 / 校验 / 向后兼容迁移 / 持久化 / getView）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cs from '../config-store.js';

function newTmpDir(prefix) {
    const d = join(process.cwd(), '.test-tmp', `cs-rr-${prefix}-${process.pid}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
function configPath(dir) { return join(dir, 'config.json'); }
function writeConfig(dir, obj) { writeFileSync(configPath(dir), JSON.stringify(obj), 'utf8'); }
function readConfig(dir) { return JSON.parse(readFileSync(configPath(dir), 'utf8')); }

// ── D7a 默认规则：老配置无 proxy 段 → fallback 默认 retryRules ──
test('D7a: 老配置无 proxy 段 → getView 返默认 retryRules（503+10310, 200+10310）', () => {
    const dir = newTmpDir('d7a-default');
    writeConfig(dir, { env: {} });
    cs.init(configPath(dir));
    const rules = cs.getView().proxy.retryRules;
    assert.ok(Array.isArray(rules));
    assert.deepEqual(rules, [
        { status: 503, code: 10310 },
        { status: 200, code: 10310 },
    ], '默认规则等价原写死行为');
    rmSync(dir, { recursive: true, force: true });
});

// ── D7b 热更新 retryRules → 下次 getProxy 即生效 + persist 落盘 ──
test('D7b: updateProxy 改 retryRules → getProxy 生效 + 落盘', () => {
    const dir = newTmpDir('d7b-update');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    const updated = cs.updateProxy({ retryRules: [{ status: 429, code: 11210 }, { status: 503, code: 'all' }] });
    assert.deepEqual(updated.retryRules, [{ status: 429, code: 11210 }, { status: 503, code: 'all' }]);
    // getProxy 即生效
    assert.deepEqual(cs.getProxy().retryRules, [{ status: 429, code: 11210 }, { status: 503, code: 'all' }]);
    // 落盘
    const disk = readConfig(dir);
    assert.deepEqual(disk.proxy.retryRules, [{ status: 429, code: 11210 }, { status: 503, code: 'all' }]);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7c 校验：非法 status（非数字 / 越界）→ 抛错 ──
test('D7c1: retryRules status 非数字 → 抛错', () => {
    const dir = newTmpDir('d7c1-badstatus');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.throws(() => cs.updateProxy({ retryRules: [{ status: 'abc', code: 1 }] }), /status/);
    rmSync(dir, { recursive: true, force: true });
});

test('D7c2: retryRules status 越界（99）→ 抛错', () => {
    const dir = newTmpDir('d7c2-status99');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.throws(() => cs.updateProxy({ retryRules: [{ status: 99, code: 1 }] }), /status/);
    rmSync(dir, { recursive: true, force: true });
});

test('D7c3: retryRules status 越界（600）→ 抛错', () => {
    const dir = newTmpDir('d7c3-status600');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.throws(() => cs.updateProxy({ retryRules: [{ status: 600, code: 1 }] }), /status/);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7c 校验：非法 code（既非数字也非 'all'）→ 抛错 ──
test('D7c4: retryRules code 非法字符串 → 抛错', () => {
    const dir = newTmpDir('d7c4-badcode');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.throws(() => cs.updateProxy({ retryRules: [{ status: 503, code: 'whatever' }] }), /code/);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7c 校验：retryRules 非数组 / 元素非对象 → 抛错 ──
test('D7c5: retryRules 非数组 → 抛错', () => {
    const dir = newTmpDir('d7c5-notarray');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.throws(() => cs.updateProxy({ retryRules: 'nope' }), /retryRules/);
    rmSync(dir, { recursive: true, force: true });
});

test('D7c6: retryRules 元素缺 status → 抛错', () => {
    const dir = newTmpDir('d7c6-nostatus');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    assert.throws(() => cs.updateProxy({ retryRules: [{ code: 1 }] }), /status/);
    rmSync(dir, { recursive: true, force: true });
});

// ── D1b status '*' 通配合法 ──
test('D1b: retryRules status="*" 通配 → 合法接受', () => {
    const dir = newTmpDir('d1b-starstatus');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    const updated = cs.updateProxy({ retryRules: [{ status: '*', code: 10310 }] });
    assert.deepEqual(updated.retryRules, [{ status: '*', code: 10310 }]);
    rmSync(dir, { recursive: true, force: true });
});

// ── D2b code 'all' 通配合法 ──
test('D2b: retryRules code="all" 通配 → 合法接受', () => {
    const dir = newTmpDir('d2b-allcode');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    const updated = cs.updateProxy({ retryRules: [{ status: 503, code: 'all' }] });
    assert.deepEqual(updated.retryRules, [{ status: 503, code: 'all' }]);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7d 向后兼容：老 config.json 含 retryOnStatus → 迁移成 {status, code:'all'} ──
test('D7d1: 老配置 retryOnStatus:[503] → 迁移成 {status:503, code:"all"}', () => {
    const dir = newTmpDir('d7d1-migrate-status');
    writeConfig(dir, { env: {}, proxy: { retryOnStatus: [503, 502] } });
    cs.init(configPath(dir));
    const rules = cs.getProxy().retryRules;
    assert.ok(rules.some(r => r.status === 503 && r.code === 'all'), '含 503+all');
    assert.ok(rules.some(r => r.status === 502 && r.code === 'all'), '含 502+all');
    rmSync(dir, { recursive: true, force: true });
});

// ── D7d 向后兼容：老 config.json 含 retryOnBodyErrorCode → 迁移成 {status:'*', code} ──
test('D7d2: 老配置 retryOnBodyErrorCode:[10310] → 迁移成 {status:"*", code:10310}', () => {
    const dir = newTmpDir('d7d2-migrate-bodycode');
    writeConfig(dir, { env: {}, proxy: { retryOnBodyErrorCode: [10310, 11210] } });
    cs.init(configPath(dir));
    const rules = cs.getProxy().retryRules;
    assert.ok(rules.some(r => r.status === '*' && r.code === 10310), '含 *+10310');
    assert.ok(rules.some(r => r.status === '*' && r.code === 11210), '含 *+11210');
    rmSync(dir, { recursive: true, force: true });
});

// ── D7d 向后兼容：老配置同时含两字段 → 两边都迁移 ──
test('D7d3: 老配置同时含 retryOnStatus + retryOnBodyErrorCode → 都迁移', () => {
    const dir = newTmpDir('d7d3-migrate-both');
    writeConfig(dir, { env: {}, proxy: { retryOnStatus: [503], retryOnBodyErrorCode: [10310] } });
    cs.init(configPath(dir));
    const rules = cs.getProxy().retryRules;
    assert.ok(rules.some(r => r.status === 503 && r.code === 'all'), '含 503+all（来自 retryOnStatus）');
    assert.ok(rules.some(r => r.status === '*' && r.code === 10310), '含 *+10310（来自 retryOnBodyErrorCode）');
    rmSync(dir, { recursive: true, force: true });
});

// ── D7e 持久化：迁移后 persist 不再写旧字段 ──
test('D7e: 迁移后 persist 落盘只写 retryRules，不写旧字段', () => {
    const dir = newTmpDir('d7e-persist-no-old');
    writeConfig(dir, { env: {}, proxy: { retryOnStatus: [503], retryOnBodyErrorCode: [10310] } });
    cs.init(configPath(dir));
    // 触发一次 persist（updateProxy 会 persist）
    cs.updateProxy({ maxAttempts: 5 });
    const disk = readConfig(dir);
    assert.equal(disk.proxy.retryOnStatus, undefined, '旧字段 retryOnStatus 不再落盘');
    assert.equal(disk.proxy.retryOnBodyErrorCode, undefined, '旧字段 retryOnBodyErrorCode 不再落盘');
    assert.ok(Array.isArray(disk.proxy.retryRules), '新字段 retryRules 落盘');
    rmSync(dir, { recursive: true, force: true });
});

// ── D7f getView 返回 retryRules 给前端 ──
test('D7f: getView().proxy.retryRules 返回当前规则', () => {
    const dir = newTmpDir('d7f-getview');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    cs.updateProxy({ retryRules: [{ status: 429, code: 11210 }] });
    const view = cs.getView();
    assert.deepEqual(view.proxy.retryRules, [{ status: 429, code: 11210 }]);
    // 旧字段不应出现在 view.proxy
    assert.equal(view.proxy.retryOnStatus, undefined);
    assert.equal(view.proxy.retryOnBodyErrorCode, undefined);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7 边界：空 retryRules（不重试任何）合法 ──
test('D7g: 空 retryRules → 合法（不重试任何）', () => {
    const dir = newTmpDir('d7g-empty');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    const updated = cs.updateProxy({ retryRules: [] });
    assert.deepEqual(updated.retryRules, []);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7 边界：updateProxy 不传 retryRules → 保留现有规则（部分更新）──
test('D7h: updateProxy 不传 retryRules → 保留现有规则', () => {
    const dir = newTmpDir('d7h-partial');
    writeConfig(dir, { env: {}, proxy: {} });
    cs.init(configPath(dir));
    cs.updateProxy({ retryRules: [{ status: 429, code: 11210 }] });
    // 只改 maxAttempts，不动 retryRules
    cs.updateProxy({ maxAttempts: 3 });
    assert.deepEqual(cs.getProxy().retryRules, [{ status: 429, code: 11210 }], 'retryRules 保留');
    assert.equal(cs.getProxy().maxAttempts, 3);
    rmSync(dir, { recursive: true, force: true });
});

// ── D7 边界：迁移时若新 retryRules 已存在 → 不重复迁移（新字段优先）──
test('D7i: 配置已有 retryRules + 残留旧字段 → 新字段优先，旧字段忽略', () => {
    const dir = newTmpDir('d7i-newpriority');
    writeConfig(dir, {
        env: {},
        proxy: {
            retryRules: [{ status: 429, code: 11210 }],
            retryOnStatus: [503],  // 残留旧字段
        },
    });
    cs.init(configPath(dir));
    const rules = cs.getProxy().retryRules;
    // 新字段优先，不混入 503+all
    assert.deepEqual(rules, [{ status: 429, code: 11210 }]);
    rmSync(dir, { recursive: true, force: true });
});
