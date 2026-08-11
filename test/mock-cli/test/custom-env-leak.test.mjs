// test/mock-cli/test/custom-env-leak.test.mjs — 证明自定义 env key 的两条到达路径。
// Run: node --test test/mock-cli/test/custom-env-leak.test.mjs
//
// 背景（plan twinkling-forging-sunset §3）：派生/普通 CLI 的自定义 env key
// （如 CLAUDE_CODE_AUTO_COMPACT_WINDOW）能否到达 process.env 有两条路径：
//   (1) spawn 时注入的 shell env（4 个启动入口的 spawn env）
//   (2) CLI 启动时 applyConfigEnvironmentVariables() 把 settings.env 累加进 process.env
//       （Object.assign 语义，additive-only——只加/覆盖，不删）。
//
// 本文件用**进程内直调**（不 spawn 子进程）证明：
//   A. settings.json 是当前唯一"非显式"泄漏路径——settings.env 含 key、shell env 不含 →
//      applyConfigEnvironmentVariables() 后 process.env 拿到 settings 值。
//   B. shell env 注入能独立生效——shell env（process.env）含 key、settings.env 不含 →
//      applyConfigEnvironmentVariables() 不覆盖（settings 无该 key）→ process.env 保留 shell 值。
//   C. settings.env 含同名 key 会覆盖 shell env（后写者赢，Object.assign 语义）——
//      证明若依赖 settings.json 残留，值会被 settings 覆盖，不可控。
//
// 结论：修复方向正确——shell env 注入后，即便 settings.json 被 CLI 覆写丢掉 env，
// CLI 仍能从 process.env 拿到值（路径 B）。反之若只靠 settings.json（路径 A/C），
// 值随 settings.json 被覆写而丢失/被覆盖，不可靠。
//
// 进程内测试要点：
//   - getClaudeConfigHomeDir 以 process.env.CLAUDE_CONFIG_DIR 为 memoize 动态 key，
//     切换 configDir 之间必须 .cache.clear()，否则拿到旧 configDir 的缓存值。
//   - getSettings 有三层 sessionCache；切换 configDir 后必须 resetSettingsCache()。
//   - applyConfigEnvironmentVariables 是 additive-only（Object.assign 不删 key），
//     故每条用例前后必须清理 process.env 的目标 key，防跨用例污染。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { applyConfigEnvironmentVariables } from '../src/envApplier.mjs';
import { resetSettingsCache } from '../src/settingsReader.mjs';
import { getClaudeConfigHomeDir } from '../src/configHome.mjs';

const KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

function newTmpDir(prefix) {
    return mkdtempSync(join(tmpdir(), `mock-cli-${prefix}-`));
}

function writeSettings(configDir, settingsObj) {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settingsObj, null, 2));
}

// 切到新 configDir：清 memoize 缓存（动态 key 变了）+ 清 settings 三层缓存。
// additive-only 下还须清 process.env 目标 key，防上一条用例残留污染。
function switchConfigDir(configDir) {
    if (process.env.CLAUDE_CONFIG_DIR !== undefined) delete process.env.CLAUDE_CONFIG_DIR;
    getClaudeConfigHomeDir.cache.clear();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    getClaudeConfigHomeDir.cache.clear();
    resetSettingsCache();
    if (process.env[KEY] !== undefined) delete process.env[KEY];
}

// ── A. settings.json 是当前泄漏路径（shell env 不含、settings.env 含）──
test('A. settings.env 含 KEY + shell env 不含 → applyConfigEnvironmentVariables 后 process.env 拿到 settings 值', () => {
    const configDir = newTmpDir('leakA');
    switchConfigDir(configDir);
    try {
        writeSettings(configDir, { env: { [KEY]: '90000' } });
        // 前置：shell env 不含该 key
        assert.equal(process.env[KEY], undefined, '前置：shell env 不应含 KEY');

        applyConfigEnvironmentVariables();

        // settings.env 的值被 Object.assign 进 process.env —— 证明 settings.json 是泄漏路径
        assert.equal(process.env[KEY], '90000', 'settings.env 的 KEY 应被累加进 process.env');
    } finally {
        if (process.env[KEY] !== undefined) delete process.env[KEY];
        rmSync(configDir, { recursive: true, force: true });
    }
});

// ── B. shell env 注入独立生效（shell env 含、settings.env 不含）──
test('B. shell env 含 KEY + settings.env 不含 → applyConfigEnvironmentVariables 不覆盖，process.env 保留 shell 值', () => {
    const configDir = newTmpDir('leakB');
    switchConfigDir(configDir);
    try {
        // shell env 已注入（模拟 4 个启动入口的 spawn env）
        process.env[KEY] = '70000';
        // settings 无 env 字段（模拟 CLI 重写 settings.json 丢掉 env 后的状态）
        writeSettings(configDir, {});

        applyConfigEnvironmentVariables();

        // settings.env 无该 key → Object.assign 不覆盖 → process.env 保留 shell 值
        // 这正是修复方向：shell env 注入后即便 settings.json 被覆写无 env，CLI 仍能拿到值
        assert.equal(process.env[KEY], '70000', 'shell env 注入的 KEY 应独立存活，不被 settings 覆盖');
    } finally {
        if (process.env[KEY] !== undefined) delete process.env[KEY];
        rmSync(configDir, { recursive: true, force: true });
    }
});

// ── C. settings.env 含同名 key 会覆盖 shell env（后写者赢）──
// 证明若依赖 settings.json 残留，值会被 settings 覆盖，不可控（反衬路径 B 的可靠性）。
test('C. shell env 含 KEY + settings.env 含同名 KEY → settings 覆盖 shell（后写者赢）', () => {
    const configDir = newTmpDir('leakC');
    switchConfigDir(configDir);
    try {
        process.env[KEY] = '70000';       // shell env 注入值
        writeSettings(configDir, { env: { [KEY]: '90000' } });  // settings 残留值

        applyConfigEnvironmentVariables();

        // Object.assign 后写者赢 → settings 值覆盖 shell 值
        // 这说明若 settings.json 残留 KEY，shell env 注入的值会被盖掉——不可靠
        assert.equal(process.env[KEY], '90000', 'settings.env 同名 key 应覆盖 shell env（Object.assign 后写者赢）');
    } finally {
        if (process.env[KEY] !== undefined) delete process.env[KEY];
        rmSync(configDir, { recursive: true, force: true });
    }
});

// ── D. settings.json 不存在 → applyConfigEnvironmentVariables 无副作用，shell env 独活 ──
// 模拟全新 workspace（.claude_proxy 目录还没 settings.json）—— shell env 是唯一来源。
test('D. settings.json 不存在 + shell env 含 KEY → applyConfigEnvironmentVariables 无副作用，shell 值存活', () => {
    const configDir = newTmpDir('leakD');
    switchConfigDir(configDir);
    try {
        process.env[KEY] = '60000';
        // 不写 settings.json（ENOENT → getSettings 返回 { settings: {} }）

        applyConfigEnvironmentVariables();

        assert.equal(process.env[KEY], '60000', 'settings.json 不存在时 shell env 应原样存活');
    } finally {
        if (process.env[KEY] !== undefined) delete process.env[KEY];
        rmSync(configDir, { recursive: true, force: true });
    }
});
