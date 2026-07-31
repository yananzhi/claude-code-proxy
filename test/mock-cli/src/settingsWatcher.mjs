// test/mock-cli/src/settingsWatcher.mjs — 等价真 CLI chokidar 监听 + fanOut 清缓存。
// 真 CLI: utils/settings/changeDetector.ts
//   initialize() :84-146  chokidar.watch({ persistent:true, ignoreInitial:true, depth:0,
//                       awaitWriteFinish:{ stabilityThreshold:1000, pollInterval:500 } })
//   fanOut(source) :437-440  resetSettingsCache() + emit(source)
//   handleChange :268-302    取消 pending 删除 → fanOut
//   handleAdd :308-322       re-add 当 change 处理（吸收 Windows 原子写 unlink+add）
//   getSourceForPath :362-375  Windows 路径 normalize 比对
//
// 重读链路（fanOut）：resetSettingsCache → applyConfigEnvironmentVariables → clearBetasCache
// → 上层重算 resolved model → 通知探针。
import chokidar from 'chokidar';
import { normalize } from 'path';
import { getSettingsFilePath, resetSettingsCache } from './settingsReader.mjs';
import { applyConfigEnvironmentVariables } from './envApplier.mjs';
import { clearBetasCache } from './betas.mjs';

const FILE_STABILITY_THRESHOLD_MS = 1000;
const FILE_STABILITY_POLL_INTERVAL_MS = 500;

let watcher = null;
let subscribers = [];
let lastReloadSource = null;

// fanOut（changeDetector.ts:437-440）：清缓存 + 重新 apply env + 清 betas + 通知。
function fanOut(source) {
    resetSettingsCache();
    applyConfigEnvironmentVariables();
    clearBetasCache();
    lastReloadSource = source;
    for (const cb of subscribers) {
        try { cb(source); } catch { /* 单个订阅者异常不影响其它 */ }
    }
}

// startWatching：监听单个 settings.json 文件路径。
// change/add → fanOut。unlink → fanOut（阶段 0 简化，TODO delete 宽限）。
export function startWatching(filePath = getSettingsFilePath()) {
    const normalized = normalize(filePath);
    watcher = chokidar.watch(normalized, {
        persistent: true,
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: {
            stabilityThreshold: FILE_STABILITY_THRESHOLD_MS,
            pollInterval: FILE_STABILITY_POLL_INTERVAL_MS,
        },
    });
    // change / add / unlink 都触发 fanOut（add 当 change，照真 CLI handleAdd:308-322）
    watcher.on('change', (p) => fanOut(`change:${p}`));
    watcher.on('add', (p) => fanOut(`add:${p}`));
    watcher.on('unlink', (p) => fanOut(`unlink:${p}`));
    return watcher;
}

// subscribe(cb)：上层（index）订阅重读事件，重算 resolved model。
export function subscribe(cb) {
    subscribers.push(cb);
    return () => {
        subscribers = subscribers.filter((fn) => fn !== cb);
    };
}

export function getLastReloadSource() {
    return lastReloadSource;
}

export async function dispose() {
    if (watcher) {
        await watcher.close();
        watcher = null;
    }
    subscribers = [];
}
