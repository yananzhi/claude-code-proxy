/**
 * 净化 process.env 给 spawn 的子进程用：删 VS Code 扩展宿主注入的私货（死锁元凶），
 * 保留系统变量（PATH 等），显式设 ELECTRON_RUN_AS_NODE + CCP_* 路径。
 *
 * ⚠ 死锁根因（V1-f 验证，2026-08-02）：扩展宿主 process.env 含 NODE_OPTIONS（--require
 * bootstrap-fork.js）/ VSCODE_* IPC handle / ELECTRON_* 等，原样透传给子进程会让 Code.exe
 * 在等 IPC 句柄时死锁、stdio 管道还没输出就挂起。净化后死锁解除，Code.exe 能正常以
 * 纯 Node 模式跑 ESM server.js。详见 docs/server独立进程化调研.md「V1-f」。
 *
 * 抽成独立文件便于单测——proxyHost.ts 顶部 import vscode，纯 Node 测试环境加载不了，
 * 把这个不依赖 vscode 的纯函数单独放，测试可直接 require。
 */

export interface CleanEnvOverrides {
    configPath: string;
    logsDir: string;
    logsConfigPath: string;
}

export function cleanEnv(overrides: CleanEnvOverrides): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        // 删 VS Code / Electron 注入（死锁元凶）
        if (/^NODE_OPTIONS$/i.test(k)) continue;
        if (/^VSCODE_/i.test(k)) continue;
        if (/^ELECTRON_/i.test(k)) continue;
        if (/^CHROME_/i.test(k)) continue;
        if (/^PIPE$/i.test(k)) continue;
        env[k] = v;
    }
    env.ELECTRON_RUN_AS_NODE = '1';
    env.CCP_CONFIG_PATH = overrides.configPath;
    env.CCP_LOGS_DIR = overrides.logsDir;
    env.CCP_LOGS_CONFIG_PATH = overrides.logsConfigPath;
    return env;
}
