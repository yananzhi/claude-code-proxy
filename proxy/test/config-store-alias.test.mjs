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
