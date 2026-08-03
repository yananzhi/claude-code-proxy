import * as fs from 'fs';
import * as path from 'path';

/**
 * claude 二进制解析（纯函数，host-agnostic）。
 *
 * 从 claudeLauncher.ts 抽出，不依赖 vscode，便于独立后端形态复用 + 纯 Node 环境单测。
 */

/** 扩展安装目录下二进制的相对子路径（各平台一致）。 */
const NATIVE_BINARY_SUBDIR = path.join('resources', 'native-binary');

/**
 * 解析 claude 二进制完整路径（纯函数，host-agnostic）。
 *
 * 探测顺序：
 * 1. 用户指定的绝对路径（userOverride，存在则用，最高优先级）
 * 2. VS Code 扩展安装目录下的 native-binary（vscodeExtensionPath 提供）
 *    - win32 → `claude.exe`，其他平台 → `claude`
 * 3. 都找不到 → 返回 null
 *
 * 抽成纯函数便于独立后端形态复用（独立形态传系统 PATH 探测 + 扩展目录扫描结果）。
 * VS Code 形态在 claudeLauncher.resolveBinaryPath() 里传 vscode 设置 +
 * vscode.extensions.getExtension 的结果。
 *
 * @param opts.userOverride 用户指定路径（空串/纯空白/undefined 视为未设置）
 * @param opts.vscodeExtensionPath VS Code 扩展安装目录（undefined 则跳过来源②）
 * @param opts.platform 平台（默认 process.platform，决定二进制名后缀）
 * @param opts.log 日志回调（可选，不传则静默）
 * @returns 二进制完整路径，或 null
 */
export function resolveClaudeBinary(opts: {
    userOverride?: string;
    vscodeExtensionPath?: string;
    platform?: NodeJS.Platform;
    log?: (msg: string) => void;
}): string | null {
    const { userOverride, vscodeExtensionPath, log } = opts;
    const platform = opts.platform ?? process.platform;

    // 1) 用户设置覆盖
    if (userOverride && userOverride.trim()) {
        if (fs.existsSync(userOverride)) {
            return userOverride;
        }
        log?.(`[launcher] 设置的 claudeBinaryPath 不存在: ${userOverride}`);
    }

    // 2) VS Code 扩展自动探测
    if (vscodeExtensionPath) {
        const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';
        const candidate = path.join(vscodeExtensionPath, NATIVE_BINARY_SUBDIR, binaryName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        log?.(`[launcher] 官方扩展已装但二进制缺失: ${candidate}`);
    } else {
        log?.('[launcher] 未找到官方 anthropic.claude-code 扩展');
    }

    return null;
}
