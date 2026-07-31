// test/mock-cli/test/helpers.mjs — 测试共用 helper。
// spawnMockCli({ configDir, env }) → { probePort, proc, cleanup }
// probeGet(port, path) / probePost(port, path)
// waitForReload(port, expectedReloads) —— 轮询 /probe/settings-cache
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setTimeout as sleep } from 'timers/promises';

const MOCK_CLI_BIN = join(process.cwd(), 'test/mock-cli/src/index.mjs');

export function newTmpDir(prefix) {
    return mkdtempSync(join(tmpdir(), `mock-cli-${prefix}-`));
}

export function writeSettings(configDir, settingsObj) {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settingsObj, null, 2));
}

export async function spawnMockCli({ configDir, env = {} }) {
    const proc = spawn(process.execPath, [MOCK_CLI_BIN], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    // 读 stdout 第一行 JSON 拿 probePort
    const port = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('mock-cli 启动超时，stdout: ' + buf)), 10000);
        proc.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            const nl = buf.indexOf('\n');
            if (nl >= 0) {
                clearTimeout(timer);
                try {
                    const line = JSON.parse(buf.slice(0, nl));
                    if (line.probePort) resolve(line.probePort);
                    else reject(new Error('stdout 第一行无 probePort: ' + buf));
                } catch (e) {
                    reject(new Error('解析 probePort 失败: ' + e.message + ' buf: ' + buf));
                }
            }
        });
        proc.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`mock-cli 提前退出 code=${code}`));
        });
    });
    return {
        probePort: port,
        proc,
        cleanup: () => {
            try { proc.kill('SIGTERM'); } catch {}
        },
    };
}

export async function probeGet(port, path) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return res.json();
}

export async function probePost(port, path, body) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
}

// waitForReload：轮询 /probe/settings-cache 直到 reloads 达到期望值（或超时）。
// Windows chokidar 有 awaitWriteFinish 1 秒延迟 + 文件事件，需轮询。
export async function waitForReload(port, expectedReloads, timeoutMs = 8000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
        const stats = await probeGet(port, '/probe/settings-cache');
        last = stats;
        if (stats.reloads >= expectedReloads) return stats;
        await sleep(150);
    }
    throw new Error(`waitForReload 超时：期望 reloads>=${expectedReloads}，实际 ${last?.reloads}`);
}
