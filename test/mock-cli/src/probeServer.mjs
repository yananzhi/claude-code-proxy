// test/mock-cli/src/probeServer.mjs — 探针 HTTP 端口（mock 独有测试面，无真 CLI 对应）。
// 监听 127.0.0.1:0（或 MOCK_CLI_PROBE_PORT）动态分配，避开代理 11434-11436。
// 启动后 stdout 输出 {"probePort":N} 供测试读。
import http from 'http';
import { getSettingsStats, getSettingsFilePath } from './settingsReader.mjs';
import { applyConfigEnvironmentVariables } from './envApplier.mjs';
import { clearBetasCache } from './betas.mjs';
import { resetSettingsCache } from './settingsReader.mjs';

// state：index 传入的只读视图函数集合。
export function startProbeServer(state, port = 0) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const path = url.pathname;
        const method = req.method;

        // CORS / 预检（测试用 fetch 可能带）
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const send = (code, body) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        if (method === 'GET' && path === '/probe/model') {
            return send(200, { model: state.getModel() });
        }
        if (method === 'GET' && path === '/probe/base-model') {
            return send(200, { baseModel: state.getBaseModel() });
        }
        if (method === 'GET' && path === '/probe/context-window') {
            return send(200, { contextWindow: state.getContextWindow() });
        }
        if (method === 'GET' && path === '/probe/autocompact-threshold') {
            return send(200, {
                threshold: state.getThreshold(),
                effectiveWindow: state.getEffectiveWindow(),
            });
        }
        if (method === 'GET' && path === '/probe/betas') {
            return send(200, { betas: state.getBetas() });
        }
        if (method === 'GET' && path === '/probe/settings-cache') {
            return send(200, { ...getSettingsStats(), filePath: getSettingsFilePath() });
        }
        if (method === 'GET' && path.startsWith('/probe/env/')) {
            const key = decodeURIComponent(path.slice('/probe/env/'.length));
            return send(200, { key, value: process.env[key] ?? null });
        }
        if (method === 'POST' && path === '/probe/force-reload') {
            // 确定性兜底：同步清缓存 + 重 apply + 清 betas + 重算 model + 通知。
            // 绕过 chokidar 异步，标注为 fallback（默认走真 chokidar）。
            resetSettingsCache();
            applyConfigEnvironmentVariables();
            clearBetasCache();
            state.recompute();
            return send(200, { ok: true, reloaded: true, source: 'force' });
        }
        if (method === 'POST' && path === '/probe/simulate-request') {
            return send(501, { error: 'not implemented in stage 0' });
        }
        return send(404, { error: 'not found' });
    });

    const override = process.env.MOCK_CLI_PROBE_PORT;
    const listenPort = override ? parseInt(override, 10) : port;

    return new Promise((resolve) => {
        server.listen(listenPort, '127.0.0.1', () => {
            const actualPort = server.address().port;
            resolve({ server, port: actualPort });
        });
    });
}
