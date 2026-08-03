// test/proxyHost/cleanEnv.test.mjs — M2: cleanEnv() 净化 env 单测
//
// 运行：node --test test/proxyHost/cleanEnv.test.mjs
//
// 维度覆盖（见 plan/tmp/2026-08-02-proxyhost-spawn-controller.md 维度3 env 净化）：
//   D10 cleanEnv 删 NODE_OPTIONS（死锁元凶）
//   D11 cleanEnv 删 VSCODE_*/ELECTRON_*/CHROME_*/PIPE
//   D12 cleanEnv 保留系统变量（PATH 等）
//   D13 cleanEnv 设 ELECTRON_RUN_AS_NODE=1
//   D14 cleanEnv 设 CCP_* 路径
//   边界：脏 env 含大小写混合、空值、已有 ELECTRON_RUN_AS_NODE（应被覆盖）
//
// 注：cleanEnv 是 proxyHost.ts（TS）导出的函数，编译到 out/proxyHost.js（CJS）。
// 这里 require out/proxyHost.js 取 cleanEnv。需先 npm run compile。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const OUT = join(process.cwd(), 'out', 'cleanEnv.js');
if (!existsSync(OUT)) {
    console.error('out/cleanEnv.js 不存在，请先 npm run compile');
    process.exit(1);
}
// cleanEnv.js 是 CJS（编译自 TS），用 createRequire 加载
const require = createRequire(import.meta.url);
const { cleanEnv } = require(OUT);

/** 造一个脏 env（模拟扩展宿主注入），临时替换 process.env 跑 cleanEnv 再恢复。 */
function withDirtyEnv(dirty, fn) {
    const saved = { ...process.env };
    // 清空再设脏值
    for (const k of Object.keys(process.env)) delete process.env[k];
    for (const [k, v] of Object.entries(dirty)) process.env[k] = v;
    try {
        return fn();
    } finally {
        for (const k of Object.keys(process.env)) delete process.env[k];
        for (const [k, v] of Object.entries(saved)) process.env[v === undefined ? k : k] = v;
        // 恢复（上面解构丢了 undefined 信息，逐个恢复 saved）
        for (const k of Object.keys(saved)) process.env[k] = saved[k];
    }
}

const PATHS = { configPath: 'C:\\cfg.json', logsDir: 'C:\\logs', logsConfigPath: 'C:\\logs-cfg.json' };

test('D10: cleanEnv 删 NODE_OPTIONS（死锁元凶）', () => {
    withDirtyEnv({ PATH: '/usr/bin', NODE_OPTIONS: '--require bootstrap-fork.js' }, () => {
        const env = cleanEnv(PATHS);
        assert.equal(env.NODE_OPTIONS, undefined, 'NODE_OPTIONS 必须被删');
        assert.equal(env.PATH, '/usr/bin', 'PATH 保留');
    });
});

test('D11: cleanEnv 删 VSCODE_*/ELECTRON_*/CHROME_*/PIPE', () => {
    withDirtyEnv({
        PATH: '/usr/bin',
        VSCODE_IPC_HOOK_EXTHOST: '\\\\.\\pipe\\x',
        VSCODE_NLS_CONFIG: '{}',
        ELECTRON_NO_ATTACH: '1',
        CHROME_CRASHPAD_PIPE_NAME: '\\\\.\\pipe\\crash',
        PIPE: '\\\\.\\pipe\\something',
        KEEP_ME: 'yes',
    }, () => {
        const env = cleanEnv(PATHS);
        assert.equal(env.VSCODE_IPC_HOOK_EXTHOST, undefined);
        assert.equal(env.VSCODE_NLS_CONFIG, undefined);
        assert.equal(env.ELECTRON_NO_ATTACH, undefined);
        assert.equal(env.CHROME_CRASHPAD_PIPE_NAME, undefined);
        assert.equal(env.PIPE, undefined);
        assert.equal(env.KEEP_ME, 'yes', '非注入变量保留');
    });
});

test('D12: cleanEnv 保留系统变量（PATH/HOME/USERPROFILE 等）', () => {
    withDirtyEnv({
        PATH: '/usr/bin', HOME: '/home/u', USERPROFILE: 'C:\\Users\\u',
        NODE_OPTIONS: 'x', VSCODE_X: 'y',
    }, () => {
        const env = cleanEnv(PATHS);
        assert.equal(env.PATH, '/usr/bin');
        assert.equal(env.HOME, '/home/u');
        assert.equal(env.USERPROFILE, 'C:\\Users\\u');
    });
});

test('D13: cleanEnv 设 ELECTRON_RUN_AS_NODE=1', () => {
    withDirtyEnv({ PATH: '/usr/bin' }, () => {
        const env = cleanEnv(PATHS);
        assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
    });
});

test('D13b: 已有 ELECTRON_RUN_AS_NODE 被覆盖为 1（不残留旧值）', () => {
    withDirtyEnv({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '0' }, () => {
        const env = cleanEnv(PATHS);
        assert.equal(env.ELECTRON_RUN_AS_NODE, '1', '被覆盖为 1，不残留 0');
    });
});

test('D14: cleanEnv 设 CCP_* 路径', () => {
    withDirtyEnv({ PATH: '/usr/bin' }, () => {
        const env = cleanEnv(PATHS);
        assert.equal(env.CCP_CONFIG_PATH, 'C:\\cfg.json');
        assert.equal(env.CCP_LOGS_DIR, 'C:\\logs');
        assert.equal(env.CCP_LOGS_CONFIG_PATH, 'C:\\logs-cfg.json');
    });
});

test('D11b: 大小写混合的注入变量都被删', () => {
    withDirtyEnv({
        PATH: '/usr/bin',
        vscode_mixed: '1',   // VSCODE_ 正则 i 大小写不敏感
        Vscode_X: '2',
    }, () => {
        const env = cleanEnv(PATHS);
        // /^VSCODE_/i 匹配 vscode_ 和 Vscode_
        assert.equal(env.vscode_mixed, undefined);
        assert.equal(env.Vscode_X, undefined);
    });
});

test('边界：env 里空字符串值保留（非注入变量名）', () => {
    // process.env 不存真 undefined（设 undefined 会变成字符串 'undefined' 或被删），
    // 真实边界是空字符串 ''——cleanEnv 应保留它（非注入变量名）。
    withDirtyEnv({ PATH: '/usr/bin', EMPTY_VAL: '' }, () => {
        const env = cleanEnv(PATHS);
        assert.equal(env.EMPTY_VAL, '', '空字符串值保留');
        assert.equal(env.PATH, '/usr/bin');
    });
});
