// test/mock-cli/src/settingsReader.mjs — 等价真 CLI settings 读取 + 三层缓存。
// 真 CLI:
//   utils/settings/settingsCache.ts:1-59  三层：sessionSettingsCache / perSourceCache / parseFileCache
//   utils/settings/settings.ts:178-199   parseSettingsFile（缓存命中返回 clone，miss 时 readFileSync + parse）
//   utils/settings/settings.ts:856-868   getSettingsWithErrors（session 命中返回，miss 调 loadSettingsFromDisk）
//   utils/settings/settings.ts:274-296   getSettingsFilePathForSource('userSettings') → join(configHome, 'settings.json')
//   §5.3 结论 D：文件不存在/空文件 → { settings: {}, errors: [] }
//
// 阶段 0 简化：
// - 只实现 userSettings 一个 source（不做多源合并）
// - 不做 zod schema 校验，只取 env 字段
// - 缓存统计（hits/misses/reloads）供 /probe/settings-cache 查
import { readFileSync } from 'fs';
import { join } from 'path';
import { getClaudeConfigHomeDir } from './configHome.mjs';

// ── 三层缓存（等价真 CLI settingsCache.ts 的三个模块级变量）──
// 阶段 0 简化：单 source（userSettings），parseFileCache 按 path 存。
let sessionCache = null;              // sessionSettingsCache 等价
const perSourceCache = new Map();     // perSourceCache 等价（key = source 名）
const parseFileCache = new Map();     // parseFileCache 等价（key = 文件路径）

// ── 缓存统计（mock 独有，供探针）──
const stats = { hits: 0, misses: 0, reloads: 0, lastReloadAt: null };

export function getSettingsStats() {
    return { ...stats };
}

export function getSettingsFilePath() {
    // getSettingsFilePathForSource('userSettings')
    return join(getClaudeConfigHomeDir(), 'settings.json');
}

// parseSettingsFile：缓存命中返回 clone，miss 时读文件 + parse
// 真 CLI settings.ts:178-199。空文件/不存在 → { settings: null, errors: [] }
function parseSettingsFile(filePath) {
    if (parseFileCache.has(filePath)) {
        return parseFileCache.get(filePath);
    }
    let result = { settings: null, errors: [] };
    try {
        const content = readFileSync(filePath, 'utf8');
        if (content.trim() === '') {
            // 空文件 → {} （settings.ts:209-211 的 content.trim()==='' 分支）
            result = { settings: {}, errors: [] };
        } else {
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                result = { settings: parsed, errors: [] };
            } else {
                result = { settings: {}, errors: ['not an object'] };
            }
        }
    } catch (err) {
        // ENOENT → { settings: null, errors: [] }（§5.3 结论 D，不报错）
        // 其它 parse 错误同样返回空
        result = { settings: null, errors: [] };
    }
    parseFileCache.set(filePath, result);
    return result;
}

// getSettings：session 缓存命中返回，miss 调 loadSettingsFromDisk 写缓存
// 真 CLI getSettingsWithErrors:856-868
export function getSettings() {
    if (sessionCache !== null) {
        stats.hits++;
        return sessionCache;
    }
    stats.misses++;
    const filePath = getSettingsFilePath();
    const { settings, errors } = parseSettingsFile(filePath);
    // settings 为 null（文件不存在）→ 退化为 {}
    const resolved = settings ?? {};
    sessionCache = { settings: resolved, errors };
    perSourceCache.set('userSettings', resolved);
    return sessionCache;
}

// resetSettingsCache：三层全清（等价真 CLI resetSettingsCache:settingsCache.ts:55-59）
// 由 settingsWatcher 的 fanOut 调用。
export function resetSettingsCache() {
    sessionCache = null;
    perSourceCache.clear();
    parseFileCache.clear();
    stats.reloads++;
    stats.lastReloadAt = new Date().toISOString();
}
