// test/mock-cli/src/envApplier.mjs — 等价真 CLI applyConfigEnvironmentVariables + additive-only。
// 真 CLI: utils/managedEnv.ts:187-199
//   Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))
//   Object.assign(process.env, filterSettingsEnv(getSettings_DEPRECATED()?.env))
//   后写者赢（Object.assign 语义）。
//
// filterSettingsEnv (managedEnv.ts:85-91)：叠三个 strip 过滤器。
// 阶段 0 这些条件都不触发（无 SSH socket、CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 不置、非 claude-desktop entrypoint），
// 故 filterSettingsEnv 在 mock 里直通 env || {}。
//
// additive-only (state/onChangeAppState.ts:163 注释)：
//   "This is additive-only: new vars are added, existing may be overwritten, nothing is deleted"
//   ——Object.assign 不删 key，故删 settings.env 的 key 不删 process.env。
import { getSettings } from './settingsReader.mjs';

// 阶段 0 直通。TODO 真实场景：withoutSSHTunnelVars / withoutHostManagedProviderVars / withoutCcdSpawnEnvKeys。
function filterSettingsEnv(env) {
    return env || {};
}

// applyConfigEnvironmentVariables：把 settings.env 写进 process.env（覆盖式）。
// 真 CLI 还会先写 getGlobalConfig().env（~/.claude.json 的 env）——阶段 0 不模拟 globalConfig，
// 只写 userSettings 的 env（settings.json 的 env）。
export function applyConfigEnvironmentVariables() {
    const { settings } = getSettings();
    const env = filterSettingsEnv(settings.env);
    Object.assign(process.env, env);
}
