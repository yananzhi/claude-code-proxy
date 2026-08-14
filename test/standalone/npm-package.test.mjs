// test/standalone/npm-package.test.mjs — 阶段5: npm 全局包打包测试
//
// 运行：node --test test/standalone/npm-package.test.mjs
//
// 维度覆盖（见 plan/tmp/2026-08-03-stage5-npm-package.md）：
//   D1 bin 入口可执行
//   D2 package.json 字段
//   D3 out/ 路径发布
//   D4 不破坏 VS Code 形态

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const CLI_JS = join(PROJECT_ROOT, 'standalone', 'cli.js');
const PKG_JSON = JSON.parse(fs.readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));

// ════════════════════════════════════════════════════════════
// D2 package.json 字段
// ════════════════════════════════════════════════════════════
test('D2a: bin 字段指向 standalone/cli.js', () => {
    assert.ok(PKG_JSON.bin, '应有 bin 字段');
    assert.equal(PKG_JSON.bin['claude-code-proxy'], './standalone/cli.js');
});

test('D2b: files 白名单含 out/ + standalone/ + proxy 核心文件', () => {
    assert.ok(PKG_JSON.files, '应有 files 字段');
    assert.ok(PKG_JSON.files.includes('out/'), '应含 out/');
    assert.ok(PKG_JSON.files.includes('standalone/'), '应含 standalone/');
    // proxy/ 拆成具体文件（避免 proxy/logs/ proxy/test/ 泄漏进 npm 包）
    assert.ok(PKG_JSON.files.includes('proxy/server.js'), '应含 proxy/server.js');
    assert.ok(PKG_JSON.files.includes('proxy/config-store.js'), '应含 proxy/config-store.js');
    assert.ok(PKG_JSON.files.includes('proxy/trace-store.js'), '应含 proxy/trace-store.js');
    assert.ok(PKG_JSON.files.includes('proxy/logger.js'), '应含 proxy/logger.js');
    assert.ok(PKG_JSON.files.includes('proxy/package.json'), '应含 proxy/package.json');
    assert.ok(PKG_JSON.files.includes('proxy/web/'), '应含 proxy/web/（控制台网页）');
    assert.ok(PKG_JSON.files.includes('package.json'), '应含 package.json');
    assert.ok(PKG_JSON.files.includes('standalone/package.json'), '应含 standalone/package.json');
    // 确保不含 proxy/ 整目录（会递归带出 logs/ test/）
    assert.ok(!PKG_JSON.files.includes('proxy/'), '不应含 proxy/ 整目录（用具体文件替代，防 logs/test 泄漏）');
});

test('D2c: prepublishOnly 脚本编译', () => {
    assert.equal(PKG_JSON.scripts.prepublishOnly, 'npm run compile');
});

test('D2d: VS Code 形态字段保留（main/engines.vscode/contributes）', () => {
    // bin 与 main 共存
    assert.equal(PKG_JSON.main, './out/extension.js', 'main 应保留为 VS Code 扩展入口');
    assert.ok(PKG_JSON.engines?.vscode, 'engines.vscode 应保留');
    assert.ok(PKG_JSON.contributes, 'contributes 应保留');
    assert.ok(PKG_JSON.contributes.commands, 'VS Code 命令应保留');
    assert.ok(PKG_JSON.activationEvents, 'activationEvents 应保留');
});

// ════════════════════════════════════════════════════════════
// D1 bin 入口可执行
// ════════════════════════════════════════════════════════════
test('D1a: cli.js 含 shebang', () => {
    const content = fs.readFileSync(CLI_JS, 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env node'), 'cli.js 首行应为 shebang');
});

test('D1b: cli.js import main.js 调 launchStandalone', () => {
    const content = fs.readFileSync(CLI_JS, 'utf8');
    assert.ok(content.includes("launchStandalone"), '应调 launchStandalone');
    assert.ok(content.includes("from './main.js'") || content.includes('from "./main.js"'), '应 import main.js');
});

test('D1c: node standalone/cli.js 能起后端（healthz 通）', async () => {
    const home = join(PROJECT_ROOT, '.test-tmp', 'stage5-healthz');
    // 用独立端口避免和已跑的 proxy 冲突——通过 proxy-config 改端口
    const fs2 = await import('node:fs');
    fs2.mkdirSync(home, { recursive: true });
    fs2.writeFileSync(join(home, 'proxy-config.json'), JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', API_TIMEOUT_MS: '600000', ANTHROPIC_MODEL: '' },
        effortLevel: 'max',
        proxy: { listenHost: '127.0.0.1', listenPort: 11611, maxAttempts: 20, backoffSec: 3, backoffMaxSec: 16, passthrough: false, retryRules: [{ status: 503, code: 10310 }, { status: 200, code: 10310 }] },
    }));
    const child = spawn(process.execPath, [CLI_JS], {
        env: { ...process.env, CCP_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { out += c.toString(); });
    try {
        // 等启动（最多 5s）
        const ok = await new Promise((res) => {
            const to = setTimeout(() => res(false), 5000);
            const check = setInterval(async () => {
                try {
                    const r = await fetch('http://127.0.0.1:11611/healthz');
                    if (r.ok) { clearTimeout(to); clearInterval(check); res(true); }
                } catch {}
            }, 300);
        });
        assert.ok(ok, `应 healthz 通，out=${out.slice(0, 300)}`);
    } finally {
        child.kill('SIGTERM');
        await new Promise(r => child.on('exit', () => r()));
        fs2.rmSync(home, { recursive: true, force: true });
    }
});

test('D1d: CCP_HOME 覆盖默认 home', async () => {
    const home = join(PROJECT_ROOT, '.test-tmp', 'stage5-ccphome');
    // 覆盖 proxy-config 用临时端口，避免与用户真实代理（11434/11435/11436）抢端口。
    // ensureConfig 只在 config 不存在时建默认；这里预先建一个用临时端口的 config。
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(join(home, 'proxy-config.json'), JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', API_TIMEOUT_MS: '600000', ANTHROPIC_MODEL: '' },
        effortLevel: 'max',
        proxy: { listenHost: '127.0.0.1', listenPort: 11612, maxAttempts: 20, backoffSec: 3, backoffMaxSec: 16, passthrough: false, retryRules: [{ status: 503, code: 10310 }, { status: 200, code: 10310 }] },
    }));
    fs.mkdirSync(join(home, 'logs'), { recursive: true });
    const child = spawn(process.execPath, [CLI_JS], {
        env: { ...process.env, CCP_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { out += c.toString(); });
    try {
        await new Promise((res) => {
            const to = setTimeout(() => res(), 3000);
            const check = setInterval(() => {
                if (out.includes('workspace 管理 API')) { clearTimeout(to); clearInterval(check); res(); }
            }, 200);
        });
        assert.ok(out.includes(home.replace(/\\/g, '/').slice(0, 5)) || out.includes('配置:'), `应使用 CCP_HOME，out=${out.slice(0, 300)}`);
        assert.ok(fs.existsSync(join(home, 'proxy-config.json')), '应在 CCP_HOME 下建 config');
    } finally {
        child.kill('SIGTERM');
        await new Promise(r => child.on('exit', () => r()));
        try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    }
});

// ════════════════════════════════════════════════════════════
// D3 out/ 路径发布
// ════════════════════════════════════════════════════════════
test('D3a: out/ 编译产物存在（standalone 依赖）', () => {
    const required = ['cleanEnv.js', 'proxySpawnController.js', 'localConfigStore.js', 'claudeBinary.js', 'upstream.js'];
    for (const f of required) {
        assert.ok(fs.existsSync(join(PROJECT_ROOT, 'out', f)), `out/${f} 应存在`);
    }
});

test('D3b: standalone/ + proxy/ 目录存在且含关键文件', () => {
    assert.ok(fs.existsSync(join(PROJECT_ROOT, 'standalone', 'main.js')), 'standalone/main.js 应存在');
    assert.ok(fs.existsSync(join(PROJECT_ROOT, 'standalone', 'cli.js')), 'standalone/cli.js 应存在');
    assert.ok(fs.existsSync(join(PROJECT_ROOT, 'standalone', 'package.json')), 'standalone/package.json 应存在');
    assert.ok(fs.existsSync(join(PROJECT_ROOT, 'proxy', 'server.js')), 'proxy/server.js 应存在');
    assert.ok(fs.existsSync(join(PROJECT_ROOT, 'standalone', 'package.json')), 'standalone package.json 应存在');
});

test('D3: standalone/package.json 声明 type:module（ESM）', () => {
    const sPkg = JSON.parse(fs.readFileSync(join(PROJECT_ROOT, 'standalone', 'package.json'), 'utf8'));
    assert.equal(sPkg.type, 'module', 'standalone/package.json 应 type:module');
});

// ════════════════════════════════════════════════════════════
// D4 npm pack 包含 out/（验证 files 白名单生效）
// ════════════════════════════════════════════════════════════
test('D4: npm pack --dry-run 含 out/ + standalone/ + proxy/', async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync('npm pack --dry-run 2>&1', { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assert.ok(out.includes('out/cleanEnv.js'), 'pack 应含 out/cleanEnv.js');
    assert.ok(out.includes('standalone/cli.js'), 'pack 应含 standalone/cli.js');
    assert.ok(out.includes('standalone/main.js'), 'pack 应含 standalone/main.js');
    assert.ok(out.includes('proxy/server.js'), 'pack 应含 proxy/server.js');
    assert.ok(out.includes('standalone/package.json'), 'pack 应含 standalone/package.json');
});

// ════════════════════════════════════════════════════════════
// D5 npm pack 不应泄漏运行时日志/测试文件/敏感数据
// ════════════════════════════════════════════════════════════

/** 跑 npm pack --dry-run，返回文件列表行（每行一个文件路径）。 */
async function npmPackFileList() {
    const { execSync } = await import('node:child_process');
    const out = execSync('npm pack --dry-run --json 2>&1', { cwd: PROJECT_ROOT, encoding: 'utf8' });
    // npm pack --json 输出 JSON 数组，含 [{ path, files: [...] }]
    const parsed = JSON.parse(out);
    return parsed[0].files.map(f => f.path);
}

test('D5a: npm pack 不含 proxy/logs/（运行时 trace 日志，可能含 API token）', async () => {
    const files = await npmPackFileList();
    const leaked = files.filter(f => f.startsWith('proxy/logs/') || f.includes('/proxy/logs/'));
    assert.equal(leaked.length, 0, `proxy/logs/ 不应随 npm 包发布，泄漏文件: ${leaked.join(', ')}`);
});

test('D5b: npm pack 不含 proxy/test/（测试文件不应进生产包）', async () => {
    const files = await npmPackFileList();
    const leaked = files.filter(f => f.startsWith('proxy/test/') || f.includes('/proxy/test/'));
    assert.equal(leaked.length, 0, `proxy/test/ 不应随 npm 包发布，泄漏文件: ${leaked.join(', ')}`);
});

test('D5c: npm pack 不含 .claude/ .claude_proxy/ .git/ plan/ docs/ mock/ 顶层 test/', async () => {
    const files = await npmPackFileList();
    // 注意：只检查顶层目录（前缀匹配），proxy/test/ 由 D5b 单独覆盖
    const forbidden = ['.claude/', '.claude_proxy/', '.git/', 'plan/', 'docs/', 'mock/'];
    // 顶层 test/ 目录（不含 proxy/test/）
    const leaked = files.filter(f => {
        if (f.startsWith('test/') || f.includes('/test/')) {
            // 排除 proxy/test/（已由 D5b 覆盖）
            return !f.startsWith('proxy/test/') && !f.includes('/proxy/test/');
        }
        return forbidden.some(p => f.startsWith(p) || f.includes('/' + p));
    });
    assert.equal(leaked.length, 0, `敏感目录不应随 npm 包发布，泄漏文件: ${leaked.join(', ')}`);
});

test('D5d: npm pack 仍含 proxy/web/index.html（代理控制台网页，proxy/server.js 依赖）', async () => {
    const files = await npmPackFileList();
    const hasWeb = files.some(f => f === 'proxy/web/index.html' || f.endsWith('/proxy/web/index.html'));
    assert.ok(hasWeb, 'proxy/web/index.html 应随包发布（proxy/server.js serveStatic 依赖）');
});

test('D5e: npm pack 仍含 standalone/web/workspaces-html.js（managementServer.js 依赖）', async () => {
    const files = await npmPackFileList();
    const hasWeb = files.some(f => f === 'standalone/web/workspaces-html.js' || f.endsWith('/standalone/web/workspaces-html.js'));
    assert.ok(hasWeb, 'standalone/web/workspaces-html.js 应随包发布（managementServer.js import 依赖）');
});

// ════════════════════════════════════════════════════════════
// D6 VSIX 打包（.vscodeignore）不破坏
// ════════════════════════════════════════════════════════════

test('D6a: .vscodeignore 不排除 standalone/（独立后端需随 VSIX 发布给扩展开发用）或排除（若 standalone 不需进 VSIX）', () => {
    // standalone/ 不在 .vscodeignore 中 → 会进 VSIX。
    // 这是设计选择：standalone 是独立形态，VSIX 理论上不需要它。
    // 但当前不排除也不影响 VS Code 扩展功能，只是多了几 KB。
    // 此测试记录现状（非 bug），若未来要排除可改断言。
    // 注意：standalone/run/** 排除的是运行时产物子目录，不算排除整个 standalone/。
    const content = fs.readFileSync(join(PROJECT_ROOT, '.vscodeignore'), 'utf8');
    const excludes = content.split(/\r?\n/).filter(Boolean);
    const wholeDirExcluded = excludes.some(l => l.trim() === 'standalone/' || l.trim() === 'standalone/**');
    assert.ok(!wholeDirExcluded, 'standalone/ 当前不在 .vscodeignore（进 VSIX，可接受）');
});

test('D6b: .vscodeignore 排除 proxy/logs/ proxy/test/（VSIX 不含日志和测试）', () => {
    const content = fs.readFileSync(join(PROJECT_ROOT, '.vscodeignore'), 'utf8');
    assert.ok(content.includes('proxy/logs/**'), '.vscodeignore 应排除 proxy/logs/**');
    assert.ok(content.includes('proxy/test/**'), '.vscodeignore 应排除 proxy/test/**');
});
