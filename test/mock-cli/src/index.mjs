// test/mock-cli/src/index.mjs — 组装 + 启动。
// 启动序列：configHome → settingsReader → envApplier → modelResolver(contextWindow/betas) → settingsWatcher → probeServer。
// 重读链路（chokidar 触发）：resetSettingsCache → applyConfigEnvironmentVariables → clearBetasCache → 重算 model → 通知探针。
//
// resolved model 来源：process.env.ANTHROPIC_MODEL（启动快照）。未设 fallback getDefaultSonnetModel()。
// 阶段 0 不实现 /model 交互命令。
import { getSettings } from './settingsReader.mjs';
import { applyConfigEnvironmentVariables } from './envApplier.mjs';
import { parseUserSpecifiedModel, getBaseModel } from './modelResolver.mjs';
import { getContextWindowForModel, getEffectiveContextWindowSize, getAutoCompactThreshold } from './contextWindow.mjs';
import { getAllModelBetas } from './betas.mjs';
import { startWatching, subscribe, dispose } from './settingsWatcher.mjs';
import { startProbeServer } from './probeServer.mjs';

// ── 当前 resolved model 状态（会话初始化算好，重读时重算）──
let currentModelInput = '';  // ANTHROPIC_MODEL 的原始值（alias 或自定义名）
let currentResolvedModel = '';

function computeModel() {
    // ANTHROPIC_MODEL 来自 shell env 启动快照，但 applyConfigEnvironmentVariables 后可能被 settings.env 覆盖
    // （真 CLI 行为：settings.env 优先级高于 shell）。这里读当前 process.env。
    currentModelInput = process.env.ANTHROPIC_MODEL || '';
    currentResolvedModel = parseUserSpecifiedModel(currentModelInput || 'sonnet');
}

// 探针 state 视图（probeServer 调用）
const state = {
    getModel: () => currentResolvedModel,
    getBaseModel: () => getBaseModel(currentResolvedModel),
    getContextWindow: () => getContextWindowForModel(currentResolvedModel),
    getThreshold: () => getAutoCompactThreshold(currentResolvedModel),
    getEffectiveWindow: () => getEffectiveContextWindowSize(currentResolvedModel),
    getBetas: () => getAllModelBetas(currentResolvedModel),
    recompute: () => {
        computeModel();
    },
};

async function main() {
    // 1. 读 settings + apply env
    getSettings();
    applyConfigEnvironmentVariables();
    // 2. 计算初始 resolved model
    computeModel();
    // 3. 订阅 settings 重读事件 → 重算 model
    subscribe(() => {
        computeModel();
    });
    // 4. 启 chokidar 监听
    startWatching();
    // 5. 起探针
    const { server, port } = await startProbeServer(state);
    // stdout 输出 probePort 供测试读（第一行 JSON）
    process.stdout.write(JSON.stringify({ probePort: port }) + '\n');

    // 优雅退出
    const shutdown = async () => {
        try { await dispose(); } catch {}
        server.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    process.stderr.write(`mock-cli failed: ${err?.stack || err}\n`);
    process.exit(1);
});
