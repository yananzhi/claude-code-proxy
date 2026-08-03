// standalone/claudeBinaryStandalone.js — 独立形态 claude 二进制探测（ESM JS）
//
// 在 src/claudeBinary.ts 的 resolveClaudeBinary 之上包一层，补两来源：
//   ③ 系统 PATH 遍历搜 claude/claude.exe/claude.cmd
//   ④ VS Code 扩展目录扫描（~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/，多版本取最新）
//
// 探测顺序（决策 7）：用户覆盖 > 系统 PATH > VS Code 扩展目录 > null
//
// 不改 src/claudeBinary.ts（VS Code 形态冻结）。来源④扫到目录后作为 vscodeExtensionPath
// 传入 resolveClaudeBinary，复用其拼 resources/native-binary/claude[.exe] 的逻辑。

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 从 out/ 加载 resolveClaudeBinary（阶段 0 抽出的纯函数，不 import vscode）
const require = createRequire(import.meta.url);
const { resolveClaudeBinary } = require(path.join(PROJECT_ROOT, 'out', 'claudeBinary.js'));

/** 官方扩展目录前缀。 */
const EXTENSION_PREFIX = 'anthropic.claude-code-';

/**
 * 遍历 PATH 搜 claude 可执行文件。
 * @returns 第一个匹配的完整路径，或 null
 */
export function searchPathForClaude(opts = {}) {
    const platform = opts.platform ?? process.platform;
    const PATH = opts.path ?? process.env.PATH;
    if (!PATH) return null;
    const delimiter = opts.delimiter ?? path.delimiter;
    const dirs = PATH.split(delimiter).filter(Boolean);

    // 候选文件名：Windows 试 .exe/.cmd/.bat；Unix 只试 claude
    const candidates = platform === 'win32'
        ? ['claude.exe', 'claude.cmd', 'claude.bat']
        : ['claude'];

    for (const dir of dirs) {
        for (const name of candidates) {
            const full = path.join(dir, name);
            try {
                // Windows：existsSync 即可（X_OK 在 win 语义不同）
                // Unix：accessSync X_OK 检查可执行权限
                if (platform === 'win32') {
                    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
                        return full;
                    }
                } else {
                    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
                        try {
                            fs.accessSync(full, fs.constants.X_OK);
                            return full;
                        } catch {
                            // 无执行权限，跳过
                        }
                    }
                }
            } catch {
                // statSync 抛错（如权限拒绝），跳过
            }
        }
    }
    return null;
}

/** 简单 semver 比较：[major,minor,patch] 数值比较。非 semver 格式视为 [0,0,0]。 */
function parseSemver(versionStr) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(versionStr);
    if (!m) return [0, 0, 0];
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/**
 * 扫描 VS Code 扩展目录，找最新版 anthropic.claude-code-* 的扩展根目录路径。
 * @returns 扩展根目录绝对路径（如 ~/.vscode/extensions/anthropic.claude-code-1.2.3），或 null
 */
export function scanVscodeExtensionDir(opts = {}) {
    const platform = opts.platform ?? process.platform;
    const extensionsRoot = opts.extensionsRoot
        ?? path.join(os.homedir(), '.vscode', 'extensions');

    let entries;
    try {
        entries = fs.readdirSync(extensionsRoot, { withFileTypes: true });
    } catch {
        return null; // 目录不存在或无权限
    }

    // 找所有 anthropic.claude-code-* 目录，提取版本，取最新
    let bestDir = null;
    let bestVer = [0, 0, 0];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith(EXTENSION_PREFIX)) continue;
        const versionStr = entry.name.slice(EXTENSION_PREFIX.length);
        const ver = parseSemver(versionStr);
        if (compareSemver(ver, bestVer) > 0) {
            // 确认 native-binary 子目录存在（否则跳过该版本）
            const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';
            const candidate = path.join(extensionsRoot, entry.name, 'resources', 'native-binary', binaryName);
            if (fs.existsSync(candidate)) {
                bestDir = path.join(extensionsRoot, entry.name);
                bestVer = ver;
            }
        }
    }
    return bestDir;
}

/**
 * 独立形态 claude 二进制探测（包一层 resolveClaudeBinary）。
 *
 * 探测顺序：用户覆盖 > 系统 PATH > VS Code 扩展目录 > null
 *
 * @param opts.userOverride 用户指定路径（最高优先级）
 * @param opts.platform 平台（默认 process.platform）
 * @param opts.path PATH 值（默认 process.env.PATH，测试可注入）
 * @param opts.extensionsRoot VS Code 扩展目录（默认 ~/.vscode/extensions，测试可注入）
 * @param opts.log 日志回调
 * @returns 二进制完整路径，或 null
 */
export function resolveClaudeBinaryStandalone(opts = {}) {
    const platform = opts.platform ?? process.platform;
    const log = opts.log;

    // ① 用户覆盖 + ④ 扩展目录复用 resolveClaudeBinary
    // 先用 userOverride + 扩展目录扫到的路径调 resolveClaudeBinary（它内部管 ① > ② 顺序）
    // 但我们要 ① > ③(PATH) > ④(扩展)，所以分步：
    //   1. 先试 userOverride（resolveClaudeBinary 单独验存在性）
    //   2. 再试 PATH
    //   3. 再试 扩展目录（resolveClaudeBinary 的 vscodeExtensionPath 分支）

    // 来源①：用户覆盖（交给 resolveClaudeBinary 验，它有 existsSync + 日志）
    if (opts.userOverride && String(opts.userOverride).trim()) {
        const r = resolveClaudeBinary({ userOverride: opts.userOverride, platform, log });
        if (r) return r;
        // 不存在则继续降级
    }

    // 来源③：系统 PATH
    const pathResult = searchPathForClaude({ platform, path: opts.path });
    if (pathResult) {
        return pathResult;
    }
    log?.('[claudeBinaryStandalone] 系统 PATH 未找到 claude');

    // 来源④：VS Code 扩展目录扫描 → 作为 vscodeExtensionPath 传给 resolveClaudeBinary
    const extDir = scanVscodeExtensionDir({ platform, extensionsRoot: opts.extensionsRoot });
    if (extDir) {
        const r = resolveClaudeBinary({ vscodeExtensionPath: extDir, platform, log });
        if (r) return r;
    }

    log?.('[claudeBinaryStandalone] VS Code 扩展目录未找到 claude 二进制');
    return null;
}
