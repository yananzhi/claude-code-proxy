// test/mock-cli/test/mock-cli.test.mjs — Mock CLI 阶段 0 测试。
// Run: node --test test/mock-cli/test/mock-cli.test.mjs
//
// 8 条用例，对应主方案 §5.4 TODO + §6.9.1 假设：
//   1. shell env 别名冻结（§5.4 TODO-1）
//   2. settings.env 加同名 key 覆盖 shell（§5.4 TODO-2）—— 核心，覆盖两面
//   3. additive-only 删不掉（§5.4 TODO-3）
//   4. [1m] 解析（§6.9.1）
//   5. 无 [1m] 默认 200K（§6.9.1）
//   6. AUTO_COMPACT_WINDOW 钳制（§6.9.1）—— 精算 579000/179000
//   7. 保留词避让（§6.9.1）
//   8. settings 重读生效（§5.3 结论 A）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnMockCli, probeGet, probePost, waitForReload, newTmpDir, writeSettings } from './helpers.mjs';

// ── 用例 1：shell env 别名冻结（§5.4 TODO-1）──
test('1. shell env 别名运行中冻结', async () => {
    const configDir = newTmpDir('t1');
    writeSettings(configDir, {});  // settings.env 不含别名
    const mock = await spawnMockCli({
        configDir,
        env: {
            ANTHROPIC_MODEL: 'sonnet',  // alias → getDefaultSonnetModel() → env 值
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'ccp-sonnet-test1',
        },
    });
    try {
        const envProbe = await probeGet(mock.probePort, '/probe/env/ANTHROPIC_DEFAULT_SONNET_MODEL');
        assert.equal(envProbe.value, 'ccp-sonnet-test1', 'shell env 别名应被读到');
        const modelProbe = await probeGet(mock.probePort, '/probe/model');
        assert.equal(modelProbe.model, 'ccp-sonnet-test1', 'alias sonnet 应解析到 env 值');
        // 多次轮询恒定（冻结）
        for (let i = 0; i < 3; i++) {
            const again = await probeGet(mock.probePort, '/probe/env/ANTHROPIC_DEFAULT_SONNET_MODEL');
            assert.equal(again.value, 'ccp-sonnet-test1');
        }
    } finally {
        mock.cleanup();
    }
});

// ── 用例 2：settings.env 加同名 key 覆盖 shell（§5.4 TODO-2）—— 核心两面 ──
test('2. settings.env 不含别名同名 key 则不覆盖；含则覆盖', async () => {
    const configDir = newTmpDir('t2');
    // 初始 settings.env 不含 ANTHROPIC_DEFAULT_SONNET_MODEL
    writeSettings(configDir, { env: { ANTHROPIC_MODEL: 'sonnet' } });
    const mock = await spawnMockCli({
        configDir,
        env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'ccp-sonnet-test1' },
    });
    try {
        // 步骤 2：不含同名 key → 不覆盖，shell 值保留
        const before = await probeGet(mock.probePort, '/probe/env/ANTHROPIC_DEFAULT_SONNET_MODEL');
        assert.equal(before.value, 'ccp-sonnet-test1', 'settings.env 不含同名 key 时 shell 别名应冻结');

        // 步骤 3：运行中往 settings.env 加同名 key
        const stats0 = await probeGet(mock.probePort, '/probe/settings-cache');
        writeSettings(configDir, {
            env: {
                ANTHROPIC_MODEL: 'sonnet',
                ANTHROPIC_DEFAULT_SONNET_MODEL: 'from-settings-env',
            },
        });
        // 步骤 4：等 chokidar 重读
        await waitForReload(mock.probePort, stats0.reloads + 1);

        // 步骤 5：含同名 key → 覆盖（Object.assign 后写者赢，结论 B）
        const after = await probeGet(mock.probePort, '/probe/env/ANTHROPIC_DEFAULT_SONNET_MODEL');
        assert.equal(after.value, 'from-settings-env', 'settings.env 含同名 key 时应覆盖 shell');
    } finally {
        mock.cleanup();
    }
});

// ── 用例 3：additive-only 删不掉（§5.4 TODO-3）──
test('3. settings.env 删 key 不删 process.env（additive-only）', async () => {
    const configDir = newTmpDir('t3');
    writeSettings(configDir, { env: { FOO_BAR: 'initial', ANTHROPIC_MODEL: 'ccp-sonnet-1' } });
    const mock = await spawnMockCli({ configDir });
    try {
        const before = await probeGet(mock.probePort, '/probe/env/FOO_BAR');
        assert.equal(before.value, 'initial');

        const stats0 = await probeGet(mock.probePort, '/probe/settings-cache');
        // 运行中删 FOO_BAR
        writeSettings(configDir, { env: { ANTHROPIC_MODEL: 'ccp-sonnet-1' } });
        await waitForReload(mock.probePort, stats0.reloads + 1);

        const after = await probeGet(mock.probePort, '/probe/env/FOO_BAR');
        assert.equal(after.value, 'initial', 'additive-only：删 settings.env 的 key 不删 process.env');
    } finally {
        mock.cleanup();
    }
});

// ── 用例 4：[1m] 解析（§6.9.1）──
test('4. [1m] 后缀 → contextWindow=1M + beta header + 透传拼回', async () => {
    const configDir = newTmpDir('t4');
    writeSettings(configDir, {});
    const mock = await spawnMockCli({ configDir, env: { ANTHROPIC_MODEL: 'ccp-sonnet-1[1m]' } });
    try {
        const model = await probeGet(mock.probePort, '/probe/model');
        assert.equal(model.model, 'ccp-sonnet-1[1m]', '非 alias 透传 + [1m] 拼回');
        const base = await probeGet(mock.probePort, '/probe/base-model');
        assert.equal(base.baseModel, 'ccp-sonnet-1', '剥离 [1m]');
        const cw = await probeGet(mock.probePort, '/probe/context-window');
        assert.equal(cw.contextWindow, 1_000_000, '[1m] → 1M');
        const betas = await probeGet(mock.probePort, '/probe/betas');
        assert.ok(betas.betas.includes('context-1m-2025-08-07'), 'betas 含 1M header');
    } finally {
        mock.cleanup();
    }
});

// ── 用例 5：无 [1m] 默认 200K（§6.9.1）──
test('5. 无 [1m] → contextWindow=200K + 不含 1M beta', async () => {
    const configDir = newTmpDir('t5');
    writeSettings(configDir, {});
    const mock = await spawnMockCli({ configDir, env: { ANTHROPIC_MODEL: 'ccp-sonnet-1' } });
    try {
        const model = await probeGet(mock.probePort, '/probe/model');
        assert.equal(model.model, 'ccp-sonnet-1');
        const cw = await probeGet(mock.probePort, '/probe/context-window');
        assert.equal(cw.contextWindow, 200_000);
        const betas = await probeGet(mock.probePort, '/probe/betas');
        assert.ok(!betas.betas.includes('context-1m-2025-08-07'), '无 [1m] 不含 1M header');
        assert.ok(betas.betas.includes('claude-code-20250219'));
    } finally {
        mock.cleanup();
    }
});

// ── 用例 6：AUTO_COMPACT_WINDOW 钳制（§6.9.1）—— 精算 579000/179000 ──
test('6. AUTO_COMPACT_WINDOW min 钳制 + reservedTokens', async () => {
    // [1m] + window=600000 → 579000
    {
        const configDir = newTmpDir('t6a');
        writeSettings(configDir, {});
        const mock = await spawnMockCli({
            configDir,
            env: {
                ANTHROPIC_MODEL: 'ccp-sonnet-1[1m]',
                CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
            },
        });
        try {
            const t = await probeGet(mock.probePort, '/probe/autocompact-threshold');
            // 精算：min(1_000_000, 600_000) - 8_000 - 13_000 = 579_000
            // 注：设计文档 §8 原写 ≈580K 是 reserved=0 粗估，照真 CLI reservedTokens=8000 实为 579000
            assert.equal(t.threshold, 579_000, '[1m]+600000 → 579000');
            assert.equal(t.effectiveWindow, 592_000);
        } finally {
            mock.cleanup();
        }
    }
    // 无 [1m] + window=600000 → 179000
    {
        const configDir = newTmpDir('t6b');
        writeSettings(configDir, {});
        const mock = await spawnMockCli({
            configDir,
            env: {
                ANTHROPIC_MODEL: 'ccp-sonnet-1',
                CLAUDE_CODE_AUTO_COMPACT_WINDOW: '600000',
            },
        });
        try {
            const t = await probeGet(mock.probePort, '/probe/autocompact-threshold');
            // 精算：min(200_000, 600_000) - 8_000 - 13_000 = 179_000
            // 注：设计文档 §8 原写 ≈187K 是 reserved=0 粗估，实为 179000
            assert.equal(t.threshold, 179_000, '无[1m]+600000 → 179000');
            assert.equal(t.effectiveWindow, 192_000);
        } finally {
            mock.cleanup();
        }
    }
});

// ── 用例 7：保留词避让（§6.9.1）──
test('7. alias 保留词 vs 自定义别名', async () => {
    // alias sonnet → getDefaultSonnetModel() = env 值
    {
        const configDir = newTmpDir('t7a');
        writeSettings(configDir, {});
        const mock = await spawnMockCli({
            configDir,
            env: {
                ANTHROPIC_MODEL: 'sonnet',
                ANTHROPIC_DEFAULT_SONNET_MODEL: 'ccp-sonnet-1',
            },
        });
        try {
            const m = await probeGet(mock.probePort, '/probe/model');
            assert.equal(m.model, 'ccp-sonnet-1', 'alias sonnet 解析到 env 值');
        } finally {
            mock.cleanup();
        }
    }
    // alias sonnet[1m] → env 值 + [1m] 拼回
    {
        const configDir = newTmpDir('t7b');
        writeSettings(configDir, {});
        const mock = await spawnMockCli({
            configDir,
            env: {
                ANTHROPIC_MODEL: 'sonnet[1m]',
                ANTHROPIC_DEFAULT_SONNET_MODEL: 'ccp-sonnet-1',
            },
        });
        try {
            const m = await probeGet(mock.probePort, '/probe/model');
            assert.equal(m.model, 'ccp-sonnet-1[1m]', 'alias sonnet[1m] 解析到 env 值 + [1m] 拼回');
        } finally {
            mock.cleanup();
        }
    }
    // 自定义别名 → 透传（非 alias）
    {
        const configDir = newTmpDir('t7c');
        writeSettings(configDir, {});
        const mock = await spawnMockCli({ configDir, env: { ANTHROPIC_MODEL: 'ccp-sonnet-1' } });
        try {
            const m = await probeGet(mock.probePort, '/probe/model');
            assert.equal(m.model, 'ccp-sonnet-1', '自定义别名透传');
        } finally {
            mock.cleanup();
        }
    }
});

// ── 用例 8：settings 重读生效（§5.3 结论 A）──
test('8. 运行中改 settings.env → chokidar 重读后探针反映新值', async () => {
    const configDir = newTmpDir('t8');
    writeSettings(configDir, { env: { SOME_VAR: 'v1', ANTHROPIC_MODEL: 'ccp-sonnet-1' } });
    const mock = await spawnMockCli({ configDir });
    try {
        const before = await probeGet(mock.probePort, '/probe/env/SOME_VAR');
        assert.equal(before.value, 'v1');

        const stats0 = await probeGet(mock.probePort, '/probe/settings-cache');
        writeSettings(configDir, { env: { SOME_VAR: 'v2', ANTHROPIC_MODEL: 'ccp-sonnet-1' } });
        await waitForReload(mock.probePort, stats0.reloads + 1);

        const after = await probeGet(mock.probePort, '/probe/env/SOME_VAR');
        assert.equal(after.value, 'v2', '重读链路通：新值生效');
    } finally {
        mock.cleanup();
    }
});

// ── 附加：force-reload 确定性兜底（绕过 chokidar）──
test('附加. /probe/force-reload 确定性兜底', async () => {
    const configDir = newTmpDir('t9');
    writeSettings(configDir, { env: { ANTHROPIC_MODEL: 'ccp-sonnet-1' } });
    const mock = await spawnMockCli({ configDir });
    try {
        const stats0 = await probeGet(mock.probePort, '/probe/settings-cache');
        // 改文件后不靠 chokidar，直接 force-reload
        writeSettings(configDir, { env: { ANTHROPIC_MODEL: 'ccp-sonnet-1[1m]' } });
        const r = await probePost(mock.probePort, '/probe/force-reload');
        assert.equal(r.reloaded, true);
        const stats1 = await probeGet(mock.probePort, '/probe/settings-cache');
        assert.ok(stats1.reloads > stats0.reloads, 'force-reload 应增 reloads');
        const m = await probeGet(mock.probePort, '/probe/model');
        assert.equal(m.model, 'ccp-sonnet-1[1m]', 'force-reload 后 model 重算');
    } finally {
        mock.cleanup();
    }
});

// ── 用例 9：纯 shell env 启动，无 settings.json（§5.3 结论 D）──
// 验证：完全不提供 settings.json，只靠 shell env 传 model，CLI 正常 + model 来自 shell env。
// 这是主方案"派生节点别名走 shell env、不写 settings.env"的根基之一。
test('9. 无 settings.json，纯 shell env 传 model → CLI 正常 + model 来自 env', async () => {
    const configDir = newTmpDir('t9-nojson');
    // 故意不 writeSettings —— configDir 下无 settings.json
    const mock = await spawnMockCli({
        configDir,
        env: {
            ANTHROPIC_MODEL: 'ccp-sonnet-1[1m]',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'ccp-sonnet-1',
        },
    });
    try {
        // settings.json 不存在 → getSettings 返回 {}（§5.3 结论 D），不报错
        const stats = await probeGet(mock.probePort, '/probe/settings-cache');
        assert.equal(stats.reloads, 0);
        // model 来自 shell env 的 ANTHROPIC_MODEL（[1m] 透传拼回）
        const model = await probeGet(mock.probePort, '/probe/model');
        assert.equal(model.model, 'ccp-sonnet-1[1m]', '无 settings.json 时 model 纯来自 shell env');
        const base = await probeGet(mock.probePort, '/probe/base-model');
        assert.equal(base.baseModel, 'ccp-sonnet-1');
        const cw = await probeGet(mock.probePort, '/probe/context-window');
        assert.equal(cw.contextWindow, 1_000_000, '[1m] 在纯 env 下仍生效');
        // shell env 注入的别名也在（settings.env 不含 → 不覆盖，冻结）
        const envProbe = await probeGet(mock.probePort, '/probe/env/ANTHROPIC_DEFAULT_SONNET_MODEL');
        assert.equal(envProbe.value, 'ccp-sonnet-1', 'shell env 别名在无 settings 时保留');
    } finally {
        mock.cleanup();
    }
});
