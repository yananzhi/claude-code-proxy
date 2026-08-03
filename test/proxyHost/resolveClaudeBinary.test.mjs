// test/proxyHost/resolveClaudeBinary.test.mjs — 阶段0: resolveClaudeBinary 纯函数单测
//
// 运行：node --test test/proxyHost/resolveClaudeBinary.test.mjs
//
// 维度覆盖（见 plan/tmp/2026-08-03-stage0-core-extraction.md 块B）：
//   B1 探测来源优先级：用户覆盖 > VS Code 扩展 > null
//   B2 平台二进制名：win32 → claude.exe，其他 → claude
//   B3 路径不存在降级：用户覆盖不存在 → 降级到扩展；扩展二进制不存在 → null
//   B4 空覆盖：空串/纯空白/undefined → 跳过来源①
//   B5 undefined 扩展路径：跳过来源② → null
//   B6 无 log 回调：不崩
//
// 注：resolveClaudeBinary 是 claudeBinary.ts（TS）导出的纯函数，编译到 out/claudeBinary.js（CJS）。
// 从 claudeLauncher.ts 抽出到独立文件，避免加载时 require('vscode')（测试环境无 vscode 运行时）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const OUT = join(process.cwd(), 'out', 'claudeBinary.js');
if (!existsSync(OUT)) {
    console.error('out/claudeBinary.js 不存在，请先 npm run compile');
    process.exit(1);
}
const require = createRequire(import.meta.url);
const { resolveClaudeBinary } = require(OUT);

/** 造一个临时 VS Code 扩展目录结构，含 native-binary/claude[.exe]。返回扩展根目录。 */
function makeFakeExtension(root, platform) {
    const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';
    const binDir = join(root, 'resources', 'native-binary');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, binaryName), 'fake binary');
    return root;
}

/** 造一个临时用户覆盖路径文件。返回文件路径。 */
function makeFakeUserBinary(root, platform) {
    const binaryName = platform === 'win32' ? 'claude-user.exe' : 'claude-user';
    const p = join(root, binaryName);
    writeFileSync(p, 'fake user binary');
    return p;
}

test('B1-优先级：用户覆盖存在 → 返回用户覆盖（即使扩展也有）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rcb-'));
    try {
        const extPath = makeFakeExtension(join(tmp, 'ext'), 'linux');
        const userPath = makeFakeUserBinary(tmp, 'linux');
        const result = resolveClaudeBinary({
            userOverride: userPath,
            vscodeExtensionPath: extPath,
            platform: 'linux',
        });
        assert.equal(result, userPath, '用户覆盖优先级最高');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('B1-优先级：用户覆盖不存在 + 扩展存在 → 返回扩展二进制', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rcb-'));
    try {
        const extPath = makeFakeExtension(join(tmp, 'ext'), 'linux');
        const result = resolveClaudeBinary({
            userOverride: '/nonexistent/path/claude',
            vscodeExtensionPath: extPath,
            platform: 'linux',
        });
        assert.equal(result, join(extPath, 'resources', 'native-binary', 'claude'));
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('B1-优先级：都不存在 → null', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rcb-'));
    try {
        const result = resolveClaudeBinary({
            userOverride: '/nonexistent/path/claude',
            vscodeExtensionPath: join(tmp, 'no-such-ext'),
            platform: 'linux',
        });
        assert.equal(result, null);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('B2-平台：win32 → 拼 claude.exe', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rcb-'));
    try {
        const extPath = makeFakeExtension(join(tmp, 'ext'), 'win32');
        const result = resolveClaudeBinary({
            vscodeExtensionPath: extPath,
            platform: 'win32',
        });
        assert.equal(result, join(extPath, 'resources', 'native-binary', 'claude.exe'));
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('B2-平台：linux → 拼 claude（无 .exe）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rcb-'));
    try {
        const extPath = makeFakeExtension(join(tmp, 'ext'), 'linux');
        const result = resolveClaudeBinary({
            vscodeExtensionPath: extPath,
            platform: 'linux',
        });
        assert.equal(result, join(extPath, 'resources', 'native-binary', 'claude'));
        assert.ok(!result.endsWith('.exe'), 'linux 不应有 .exe 后缀');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('B3-降级：用户覆盖不存在 → 记日志 + 降级到扩展', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rcb-'));
    try {
        const extPath = makeFakeExtension(join(tmp, 'ext'), 'linux');
        const logs = [];
        const result = resolveClaudeBinary({
            userOverride: '/nonexistent/claude',
            vscodeExtensionPath: extPath,
            platform: 'linux',
            log: (m) => logs.push(m),
        });
        assert.equal(result, join(extPath, 'resources', 'native-binary', 'claude'), '降级到扩展');
        assert.ok(logs.some(l => l.includes('claudeBinaryPath 不存在')), '应记降级日志');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('B3-降级：扩展二进制缺失 → null + 记日志', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rcb-'));
    try {
        // 扩展目录存在但 native-binary 下没有二进制
        const extPath = join(tmp, 'ext');
        mkdirSync(join(extPath, 'resources', 'native-binary'), { recursive: true });
        const logs = [];
        const result = resolveClaudeBinary({
            vscodeExtensionPath: extPath,
            platform: 'linux',
            log: (m) => logs.push(m),
        });
        assert.equal(result, null);
        assert.ok(logs.some(l => l.includes('二进制缺失')), '应记缺失日志');
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('B4-空覆盖：空串/纯空白/undefined 都跳过来源①', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rcb-'));
    try {
        const extPath = makeFakeExtension(join(tmp, 'ext'), 'linux');
        const expected = join(extPath, 'resources', 'native-binary', 'claude');
        for (const empty of ['', '   ', '\t', undefined]) {
            const result = resolveClaudeBinary({
                userOverride: empty,
                vscodeExtensionPath: extPath,
                platform: 'linux',
            });
            assert.equal(result, expected, `空覆盖值 ${JSON.stringify(empty)} 应跳过来源①用扩展`);
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test('B5+6：undefined 扩展路径 + 无 log 回调 → 不崩返回 null', () => {
    const result = resolveClaudeBinary({
        userOverride: undefined,
        vscodeExtensionPath: undefined,
        platform: 'linux',
        // 不传 log
    });
    assert.equal(result, null, '无任何来源应返回 null');
});

// ─── 行为一致性回归（与原 claudeLauncher.resolveBinaryPath 对齐）──────────────────
// 原代码：`if (!ext)` 判断 ext 对象是否存在；ext 存在但 extensionPath 为空串时，
//   仍进入二进制检查分支，记 "官方扩展已装但二进制缺失" 日志。
// 新代码：`if (vscodeExtensionPath)` 判断字符串真值；空串 → 走 else 记 "未找到扩展"。
// 这是一个潜在行为差异。此用例固化当前实现的行为（空串等同未安装扩展）。
test('回归-空串 extensionPath：视为未安装扩展（记"未找到"日志，不记"二进制缺失"）', () => {
    const logs = [];
    const result = resolveClaudeBinary({
        userOverride: undefined,
        vscodeExtensionPath: '',
        platform: 'linux',
        log: (m) => logs.push(m),
    });
    assert.equal(result, null, '空串扩展路径应返回 null');
    // 当前实现：空串是 falsy → 走 else → 记 "未找到官方 anthropic.claude-code 扩展"
    assert.ok(
        logs.some(l => l.includes('未找到官方 anthropic.claude-code 扩展')),
        `空串 extensionPath 应记 "未找到扩展" 日志，实际 logs=${JSON.stringify(logs)}`,
    );
    // 不应记 "二进制缺失"（那是 ext 存在但二进制不存在的分支）
    assert.ok(
        !logs.some(l => l.includes('二进制缺失')),
        '空串 extensionPath 不应记 "二进制缺失" 日志',
    );
});
