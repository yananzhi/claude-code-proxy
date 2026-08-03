// standalone/ports.js — 端口策略（ESM JS）
//
// proxy（转发）监听 platformPort；management API 监听 platformPort+100。
// win32→11434/11534, linux→11435/11535, darwin→11436/11536。

/** 平台默认 proxy 端口（与 proxyHost DEFAULT_PORT 一致，避免同机 WSL 冲突）。 */
export function platformPort(platform = process.platform) {
    if (platform === 'win32') return 11434;
    if (platform === 'linux') return 11435;
    if (platform === 'darwin') return 11436;
    return 11435; // 未知平台兜底 linux 端口（与 proxyHost defaultPortForPlatform 一致）
}

/** 平台默认 management API 端口（proxy 端口 + 100）。 */
export function managementPort(platform = process.platform) {
    return platformPort(platform) + 100;
}
