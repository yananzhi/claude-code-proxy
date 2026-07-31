# Mock CLI 阶段 0 实现计划

> 状态：实现计划，可照此动手。依据设计文档 `docs/mock-cli-test-harness.md` + 真 Claude Code CLI 源码调研。
> 执行顺序见主方案 `docs/claude code cli运行时model切换方案.md` §6.12，本计划对应**阶段 0**。

---

## 1. 工程现状摸清

### 1.1 模块系统与编译方式
- 根 `tsconfig.json`：`module: commonjs`、`target: ES2020`、`rootDir: src`、`outDir: out`、`include: src/**/*`。VSCode 扩展宿主编译配置，输出 CJS `.js`。
- `proxy/` 是独立 ESM JS 目录（`proxy/package.json` 声明 `type: module`），不进 tsc，纯 `.mjs`/`.js`，由扩展宿主 `dynamic import` 加载。
- 现有测试：`proxy/test/*.test.mjs`，用 `node:test` + `node:assert/strict`，命令 `node --test proxy/test/xxx.test.mjs`。纯文件系统、不起 HTTP。风格：顶部注释说明运行方式 + 测点清单 + `.test-tmp/` 临时目录 + 测完自清。
- 现有 `mock/` 目录：放的是模拟上游故障的 `mock-server.js`（HTTP 控制端点改序列），不是配置加载层 mock，与本 mock-cli 无关。

### 1.2 依赖现状
- `package.json` devDependencies 仅 `@types/node`、`@types/vscode`、`typescript`。package-lock.json 仅 5 个包。
- **chokidar 未安装**，**lodash / lodash-es 未安装**。
- Node v20.19.1。

### 1.3 关键决策：位置 / 语言 / 编译

**mock-cli 放 `test/mock-cli/`，用纯 ESM JavaScript（`.mjs`），不纳入 tsc，不引入 TypeScript。**

理由：
1. **与现有测试基座对齐**：现有测试全是 `proxy/test/*.test.mjs`（纯 ESM JS + node:test）。mock-cli 是测试基础设施非发布产物，同一套语言/运行最省事。
2. **避免 TS ESM 编译坑**：根 tsconfig 是 CJS，纳入 tsc 会输出 CJS 与 `proxy/` 的 ESM 冲突；单独建 ESM tsconfig 要处理 `.mts`/编译输出/sourceMap/watch，对薄层是过度工程。纯 `.mjs` 零编译直接 `node` 跑。
3. **位置选 `test/mock-cli/` 而非 `mock/`**：`mock/` 已被故障模拟 server 占用语义不同。新建 `test/mock-cli/` 与未来测试基础设施并列。
4. **chokidar 必须装**（行为等价要求）；**lodash 不装**，memoize 手写。

### 1.4 探针端口与代理端口冲突
代理端口 `defaultPortForPlatform()`（`proxy/server.js:29-36`）：win32→11434、linux→11435、darwin→11436。探针必须避开 11434-11436。**探针默认 `127.0.0.1:0`（系统分配空闲端口），启动后 stdout 输出 `{"probePort":12345}`，测试读这行拿端口。** 零配置、零冲突、支持并行多实例。保留 `MOCK_CLI_PROBE_PORT` env 覆盖（测试可固定端口便于调试）。

---

## 2. 模块落点（对照真 CLI 文件:行号）

### 2.1 `configHome.mjs` → `getClaudeConfigHomeDir`
- **真 CLI**：`utils/envUtils.ts:7-14`。`process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')`，带 `.normalize('NFC')`。memoize key 是 `process.env.CLAUDE_CONFIG_DIR`（动态 key，env 变了能拿新值）。
- **IO**：无入参；输出配置目录绝对路径。
- **阶段 0**：完整等价。memoize 手写（§6.4），key 函数读 `process.env.CLAUDE_CONFIG_DIR`。
- **依赖**：无（最底层）。

### 2.2 `settingsReader.mjs` → settings.json 读取 + 三层缓存
- **真 CLI**：
  - `utils/settings/settingsCache.ts:1-59`（三层：`sessionSettingsCache` / `perSourceCache` / `parseFileCache`，`resetSettingsCache()` 全清）。
  - `utils/settings/settings.ts:178-199` `parseSettingsFile`（缓存命中返回 clone，miss 时 `readFileSync` + `safeParseJSON`）。
  - `utils/settings/settings.ts:856-868` `getSettingsWithErrors`（session 缓存命中返回，miss 调 `loadSettingsFromDisk` 写缓存）。
  - `utils/settings/settings.ts:274-296` `getSettingsFilePathForSource('userSettings')` → `join(getClaudeConfigHomeDir(), 'settings.json')`。
  - §5.3 结论 D：文件不存在/空文件 → `{ settings: {}, errors: [] }`（`settings.ts:209-211` 的 `content.trim()===''` 分支）。
- **IO**：`getSettings()` 返回 `{ settings: object, errors: [] }`；内部维护三层缓存 + 重读计数（供 `/probe/settings-cache`）。
- **阶段 0**：
  - 完整三层结构，但只实现 `userSettings` 一个 source（不做多源合并——阶段 0 只验证 user settings 重读链路）。
  - `parseSettingsFile`：读文件、`JSON.parse`、空/不存在 → `{}`。不做 zod schema 校验（设计文档 §3「只做依赖的字段」），只取 `env` 字段。
  - 缓存 miss 计数、重读次数供探针查。
- **留 TODO**：多源合并、zod 校验、permission rules 过滤。
- **依赖**：`configHome.mjs`。

### 2.3 `settingsWatcher.mjs` → chokidar 监听 + 清缓存
- **真 CLI**：`utils/settings/changeDetector.ts`。
  - `initialize()`（:84-146）：`chokidar.watch(dirs, { persistent:true, ignoreInitial:true, depth:0, awaitWriteFinish:{stabilityThreshold:1000, pollInterval:500} })`，监听 `change`/`unlink`/`add`。
  - `fanOut(source)`（:437-440）：`resetSettingsCache()` + `emit(source)`。**清缓存在 fanOut 单点**（:421-436 注释强调）。
  - `handleChange`（:268-302）：取消 pending 删除 → `fanOut`。
  - `awaitWriteFinish` 阈值：`FILE_STABILITY_THRESHOLD_MS=1000`、`FILE_STABILITY_POLL_INTERVAL_MS=500`（:31-38）。
  - `handleAdd`（:308-322）：re-add 当 change 处理（吸收 Windows 原子写 unlink+add）。
  - `getSourceForPath`（:362-375）：path → source 映射。Windows 上 chokidar 把路径正斜杠化，需 `path.normalize` 回 native 比对。
- **IO**：`startWatching(settingsFilePath)` 启动；回调触发 `settingsReader.resetCache()` + 重新 `applyConfigEnvironmentVariables()`（重读后要重 apply env，见 §2.4）+ `clearBetasCache()` + 重算 resolved model + 通知探针。`dispose()` 关 watcher。`subscribe(cb)` 让上层感知重读事件。
- **阶段 0**：
  - chokidar watch 单个 settings.json 文件路径（简化：直接 watch 文件而非目录）。`awaitWriteFinish` 同真 CLI 阈值。
  - `change`/`add` → 清缓存 + 重 apply env + 清 betas 缓存 + 重算 model + 通知探针。
  - `unlink`：真 CLI 有 `DELETION_GRACE_MS` 宽限（:62-63）防 delete-and-recreate。阶段 0 简化：删除也触发清缓存（settings 不存在 → `{}`），宽限逻辑 TODO（测试用例不依赖 delete-and-recreate）。
- **留 TODO**：delete 宽限、MDM poll、drop-in 目录、多 source 路径映射。
- **依赖**：`settingsReader.mjs`、`envApplier.mjs`（重读后重 apply）、`betas.mjs`（清缓存）、chokidar。

### 2.4 `envApplier.mjs` → applyConfigEnvironmentVariables + additive-only
- **真 CLI**：
  - `utils/managedEnv.ts:187-199` `applyConfigEnvironmentVariables()`：
    ```
    Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))
    Object.assign(process.env, filterSettingsEnv(getSettings_DEPRECATED()?.env))
    ```
    后写者赢。
  - `filterSettingsEnv`（:85-91）：叠三个 strip 过滤器（`withoutSSHTunnelVars` / `withoutHostManagedProviderVars` / `withoutCcdSpawnEnvKeys`）。**阶段 0 这些条件都不触发**（无 SSH socket、`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 不置、非 claude-desktop entrypoint），`filterSettingsEnv` 在 mock 里是直通 `env || {}`。
  - additive-only：`state/onChangeAppState.ts:163` 注释 + `Object.assign` 语义（删 settings.env 的 key 不删 process.env）。
- **IO**：`applyConfigEnvironmentVariables()` 无入参，从 `settingsReader.getSettings()` 取 `env`，`Object.assign(process.env, env || {})`。
- **阶段 0**：完整等价。`filterSettingsEnv` 直通（带 TODO 注释说明三个 strip 条件何时触发，阶段 0 不模拟）。
- **依赖**：`settingsReader.mjs`。

### 2.5 `modelResolver.mjs` → parseUserSpecifiedModel + has1mContext + 保留词避让
- **真 CLI**：
  - `utils/model/model.ts:445-506` `parseUserSpecifiedModel`：
    - `modelInputTrimmed = modelInput.trim()`，`normalizedModel = trimmed.toLowerCase()`。
    - `has1mTag = has1mContext(normalizedModel)`，`modelString = has1mTag ? normalizedModel.replace(/\[1m]$/i,'').trim() : normalizedModel`。
    - `isModelAlias(modelString)`（`utils/model/aliases.ts:1-14`，`MODEL_ALIASES = ['sonnet','opus','haiku','best','sonnet[1m]','opus[1m]','opusplan']`）→ alias 分支：`sonnet`→`getDefaultSonnetModel()`、`haiku`→`getDefaultHaikuModel()`、`opus`→`getDefaultOpusModel()`、`opusplan`→`getDefaultSonnetModel()`、`best`→`getBestModel()`，都拼回 `[1m]`（除 `best`）。
    - 非 alias：保留原 case，剥离 `[1m]` 后拼回（:502-505）。
  - `getDefaultSonnetModel`（`model.ts:119-128`）：`process.env.ANTHROPIC_DEFAULT_SONNET_MODEL` ?? 内置默认。`getDefaultHaikuModel`（:131-138）、`getDefaultOpusModel`（:105-116）同理。
  - `has1mContext`：`utils/context.ts:35-40`，`/\[1m\]/i.test(model)`（先查 `is1mContextDisabled()`，由 `CLAUDE_CODE_DISABLE_1M_CONTEXT` 控制）。
  - `normalizeModelStringForAPI`（`model.ts:616-618`）：`model.replace(/\[(1|2)m\]/gi, '')`。
- **IO**：
  - `parseUserSpecifiedModel(input)` → resolved model 字符串（含 `[1m]`）。
  - `has1mContext(model)` → bool。
  - `normalizeModelStringForAPI(model)` → 剥离 `[(1|2)m]` 的 base。
  - `getBaseModel(model)` → 供探针 `/probe/base-model`，等价 `normalizeModelStringForAPI`。
- **阶段 0**：
  - 完整等价 `parseUserSpecifiedModel` 的 alias 分支 + 非 alias 透传 + `[1m]` 拼回。
  - `getDefault*Model` 读 `process.env.ANTHROPIC_DEFAULT_*_MODEL`，无则占位默认（如 `'claude-sonnet-4-5'`——具体值不影响测试断言，测试用别名注入，断言别名透传/`[1m]` 行为非内置默认值）。
  - `getBestModel`：真 CLI 走另一套逻辑，阶段 0 占位返回 `getDefaultOpusModel()`（TODO，测试不覆盖 `best`）。
  - `is1mContextDisabled` 读 `CLAUDE_CODE_DISABLE_1M_CONTEXT`。
- **留 TODO**：`getBestModel` 真实逻辑、legacy opus remap（:477-483）、ant 分支（:485-498）。
- **依赖**：无外部（纯函数，读 process.env）。

### 2.6 `contextWindow.mjs` → getContextWindowForModel + getEffectiveContextWindowSize + threshold
- **真 CLI**：
  - `utils/context.ts:51-98` `getContextWindowForModel(model, betas?)`：
    - ant + `CLAUDE_CODE_MAX_CONTEXT_TOKENS` override（:59-67）——阶段 0 不模拟（USER_TYPE !== 'ant'）。
    - `has1mContext(model)` → `1_000_000`（:70-72）。
    - `getModelCapability(model)` 查 max_input_tokens（:74-83）——阶段 0 不模拟 capability 表。
    - betas 含 `CONTEXT_1M_BETA_HEADER` 且 `modelSupports1M` → 1M（:85-87）。
    - `getSonnet1mExpTreatmentEnabled`（:88-90, :100-112）——阶段 0 不模拟（依赖 growthbook）。
    - 默认 `MODEL_CONTEXT_WINDOW_DEFAULT = 200_000`（:9, :97）。
  - `services/compact/autoCompact.ts:33-49` `getEffectiveContextWindowSize(model)`：
    - `reservedTokensForSummary = Math.min(getMaxOutputTokensForModel(model), 20_000)`。
    - `contextWindow = getContextWindowForModel(model, getSdkBetas())`。
    - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 存在且解析为正数 → `contextWindow = Math.min(contextWindow, parsed)`（:40-46）。**min 钳制上限**。
    - 返回 `contextWindow - reservedTokensForSummary`。
  - `autoCompact.ts:72-91` `getAutoCompactThreshold(model)`：
    - `effectiveContextWindow = getEffectiveContextWindowSize(model)`。
    - `threshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS(13_000)`（:62）。
    - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 百分比覆盖（:79-87）——推荐顺手做。
  - `getMaxOutputTokensForModel`（`services/api/claude.ts:3399-3419`）：`getModelMaxOutputTokens(model).default`，带 cap（`CAPPED_DEFAULT_MAX_TOKENS=8_000`）+ `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env override。**关键**：`getModelMaxOutputTokens`（`context.ts:149-210`）按 canonical name 分档，自定义别名走不到已知档位 → else 分支（:198-201）：`defaultTokens=MAX_OUTPUT_TOKENS_DEFAULT(32_000)`、`upperLimit=MAX_OUTPUT_TOKENS_UPPER_LIMIT(64_000)`。再经 cap → `Math.min(32_000, 8_000) = 8_000`。
- **IO**：
  - `getContextWindowForModel(model)` → number。
  - `getEffectiveContextWindowSize(model)` → number。
  - `getAutoCompactThreshold(model)` → number。
- **阶段 0**：
  - `getContextWindowForModel`：只实现 `has1mContext`→1M + 默认 200K 两条（ant override / capability / growthbook 全 TODO）。
  - `getMaxOutputTokensForModel`：简化为"自定义模型名 → 经 cap 后 8_000"。
  - **精算校准**（见 §6.9.1 / 设计文档 §8 修订）：
    - `[1m]` + window=600000：`min(1_000_000, 600_000) - min(8_000, 20_000) - 13_000` = `600_000 - 8_000 - 13_000` = **579,000**。
    - 无 `[1m]` + window=600000：`min(200_000, 600_000) - 8_000 - 13_000` = **179,000**。
- **留 TODO**：ant override、capability 表、growthbook sonnet 1m 实验、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（可顺手做）。
- **依赖**：`modelResolver.mjs`（has1mContext）。

### 2.7 `betas.mjs` → getAllModelBetas memoize + 1M beta header
- **真 CLI**：
  - `utils/betas.ts:234-256` `getAllModelBetas = memoize((model) => ...)`：
    - `!isHaiku` → push `CLAUDE_CODE_20250219_BETA_HEADER`（`'claude-code-20250219'`）。
    - `has1mContext(model)` → push `CONTEXT_1M_BETA_HEADER`（`'context-1m-2025-08-07'`）。
    - 其它 beta（interleaved thinking / redact thinking / ...）依赖 provider、growthbook、ISP 检测——阶段 0 不模拟。
  - `getAllModelBetas.cache?.clear?.()`（`betas.ts:430-434` `clearBetasCaches`）——**重读 settings 后清 betas 缓存**。真 CLI 在 `applySettingsChange` 链路调。
  - memoize 用 `lodash-es/memoize.js`（`betas.ts:2`）。
- **IO**：`getAllModelBetas(model)` → `string[]`；`clearBetasCache()`。
- **阶段 0**：
  - 简化版：自定义模型名（非 haiku）→ `['claude-code-20250219']`；`has1mContext` → 追加 `'context-1m-2025-08-07'`。
  - memoize 手写（按 model 字符串 key），`clearBetasCache()`。**重读链路里调 clearBetasCache()**（在 settingsWatcher 的 fanOut 里）。
- **留 TODO**：isHaiku 判定（canonical name 解析，mock 阶段 0 不实现 → `ccp-haiku-1` 会被当非 haiku 带 `claude-code-20250219`，与真 CLI 可能不符，测试不覆盖 haiku beta 差异，标 TODO）。
- **依赖**：`modelResolver.mjs`（has1mContext）。

### 2.8 `requestSender.mjs` → 预留：发请求到 ANTHROPIC_BASE_URL
- **真 CLI**：阶段 0 不实现，仅占位（设计文档 §6）。
- **IO**：`simulateRequest()` → 返回 `{ status: 'todo' }`。
- **阶段 0**：导出占位函数，探针 `POST /probe/simulate-request` 返回 501 + `{ error: 'not implemented in stage 0' }`。
- **依赖**：无。

### 2.9 `probeServer.mjs` → 探针 HTTP 端口
- **真 CLI**：无对应（mock 独有测试面）。
- **IO**：`startProbeServer(state)` → `{ port, close() }`。state 是 mock 内部状态只读视图。
- **阶段 0**：见 §3 探针契约。
- **依赖**：所有其它模块（读内部状态）。

### 2.10 `index.mjs` → 组装 + 启动
- **职责**：
  1. 启动：`getClaudeConfigHomeDir()` → `settingsReader.getSettings()` → `envApplier.applyConfigEnvironmentVariables()` → `settingsWatcher.startWatching()` → 计算初始 resolved model / contextWindow / threshold / betas → `probeServer.startProbeServer()`。
  2. 重读链路（chokidar 触发）：`settingsReader.resetCache()` → `envApplier.applyConfigEnvironmentVariables()` → `betas.clearBetasCache()` → 更新 resolved model 状态 → 通知探针。
  3. resolved model 来源：mock 启动读 `process.env.ANTHROPIC_MODEL`（真 CLI 的 `/model` 等价物是 `ANTHROPIC_MODEL` env，见主方案 §3.3）；未设用 `getDefaultSonnetModel()`。阶段 0 不实现 `/model` 交互命令，model 来源是启动 env 快照 + settings.env 的 `ANTHROPIC_MODEL`（settings.env 可覆盖）。测试通过 env 注入 model。
- **依赖**：全部模块。

### 模块依赖图（阶段 0）
```
configHome ← settingsReader ← envApplier
              settingsReader ← settingsWatcher → envApplier (重apply) → betas (clearCache)
modelResolver ← contextWindow
modelResolver ← betas
index → (全部) → probeServer
requestSender (占位, 无依赖)
```

---

## 3. 探针 API 契约

所有端点监听 `127.0.0.1`，返回 `Content-Type: application/json`。

| Method | Path | 阶段 0 | 响应 JSON | 查的内部状态 |
|---|---|---|---|---|
| GET | `/probe/model` | 必做 | `{"model":"ccp-sonnet-1[1m]"}` | index 持有的当前 resolved model（含 `[1m]`） |
| GET | `/probe/base-model` | 必做 | `{"baseModel":"ccp-sonnet-1"}` | `normalizeModelStringForAPI(model)` |
| GET | `/probe/context-window` | 必做 | `{"contextWindow":1000000}` | `getContextWindowForModel(model)` |
| GET | `/probe/autocompact-threshold` | 必做 | `{"threshold":579000,"effectiveWindow":592000}` | `getAutoCompactThreshold(model)` + `getEffectiveContextWindowSize(model)` |
| GET | `/probe/env/:key` | 必做 | `{"key":"...","value":"..."}` 或 `{"key":"...","value":null}` | `process.env[key]`（实时读） |
| GET | `/probe/settings-cache` | 必做 | `{"hits":3,"misses":1,"reloads":1,"lastReloadAt":"..."}` | `settingsReader` 缓存统计 |
| GET | `/probe/betas` | 必做 | `{"betas":["claude-code-20250219","context-1m-2025-08-07"]}` | `getAllModelBetas(model)` |
| POST | `/probe/force-reload` | 必做 | `{"ok":true,"reloaded":true,"source":"force"}` | 确定性兜底：同步清缓存 + 重 apply + 重算 model |
| POST | `/probe/simulate-request` | 占位 | `501 {"error":"not implemented in stage 0"}` | 无 |

### `/probe/force-reload` 说明
chokidar 真链路靠测试写文件 + 轮询探针验证（默认）。`/probe/force-reload` 是 CI 不稳定时的确定性兜底（同步清缓存 + 重 apply + 重算 model），绕过 chokidar 异步。标注为 fallback，默认走真 chokidar。

---

## 4. 8 条测试用例落地方案

所有用例结构：每个 `test()` 起独立 `configDir`（`test/mock-cli/.test-tmp/<case>-<pid>/`），写 `settings.json`，spawn mock-cli 子进程（`node test/mock-cli/src/index.mjs`）传 `CLAUDE_CONFIG_DIR` + env，读 stdout 第一行 JSON 拿 `probePort`，调探针断言，测完 kill 子进程 + 清目录。参考 `proxy/test/trace-store.test.mjs` 的 `newTmpDir` 模式。

### 用例 1：shell env 别名冻结（§5.4 TODO-1）
- **构造**：`configDir` 下放空 `settings.json`（`{}`，env 不含别名）。子进程 env 注入 `ANTHROPIC_DEFAULT_SONNET_MODEL=ccp-sonnet-test1` + `ANTHROPIC_MODEL=sonnet`（让 resolved model 走 alias 分支读到别名）。
- **断言**：`GET /probe/env/ANTHROPIC_DEFAULT_SONNET_MODEL` → `ccp-sonnet-test1`；`GET /probe/model` → `ccp-sonnet-test1`（alias `sonnet` 解析到 `getDefaultSonnetModel()` 即 env 值）。多次轮询恒定（冻结）。
- **阶段 0 可跑**：是。

### 用例 2：settings.env 加同名 key 是否覆盖 shell（§5.4 TODO-2）—— 核心
- **精确前提构造**（设计文档 §8 末尾注）：
  1. 启动时：shell env `ANTHROPIC_DEFAULT_SONNET_MODEL=ccp-sonnet-test1`，`settings.json` 的 `env` **不含** `ANTHROPIC_DEFAULT_SONNET_MODEL`。`ANTHROPIC_MODEL=sonnet`。
  2. 启动后断言 `/probe/env/ANTHROPIC_DEFAULT_SONNET_MODEL` = `ccp-sonnet-test1`（别名走 shell，未被覆盖——settings.env 不含同名 key，`Object.assign` no-op）。
  3. **运行中**改 `settings.json`，往 `env` 加 `"ANTHROPIC_DEFAULT_SONNET_MODEL": "from-settings-env"`。
  4. 等 chokidar 重读（轮询 `/probe/settings-cache` 的 reloads +1）。
  5. 断言 `/probe/env/ANTHROPIC_DEFAULT_SONNET_MODEL` = `from-settings-env`（**现在被覆盖了**——settings.env 含同名 key，`Object.assign` 后写者赢）。
- **这条用例毫不含糊地证明**：冻结的前提是"settings.env 不含同名 key"；一旦含则覆盖发生（结论 B）。两条结论分清。
- **阶段 0 可跑**：是。

### 用例 3：additive-only 删不掉（§5.4 TODO-3）
- **构造**：
  1. 启动时 `settings.json` 的 `env` 含 `"FOO_BAR": "initial"`。`ANTHROPIC_MODEL=ccp-sonnet-1`（非 alias，透传）。
  2. 启动后断言 `/probe/env/FOO_BAR` = `initial`。
  3. 运行中改 `settings.json`，从 `env` 删掉 `FOO_BAR`（`env: {}`）。
  4. 等重读。
  5. 断言 `/probe/env/FOO_BAR` 仍 = `initial`（additive-only，`Object.assign` 不删 key）。
- **阶段 0 可跑**：是。

### 用例 4：`[1m]` 解析（§6.9.1）
- **构造**：`ANTHROPIC_MODEL=ccp-sonnet-1[1m]`，空 settings.json。
- **断言**：`/probe/model` = `ccp-sonnet-1[1m]`；`/probe/base-model` = `ccp-sonnet-1`；`/probe/context-window` = `1000000`；`/probe/betas` 含 `context-1m-2025-08-07`。
- **阶段 0 可跑**：是。

### 用例 5：无 `[1m]` 默认 200K（§6.9.1）
- **构造**：`ANTHROPIC_MODEL=ccp-sonnet-1`，空 settings.json。
- **断言**：`/probe/model` = `ccp-sonnet-1`；`/probe/context-window` = `200000`；`/probe/betas` 不含 `context-1m-2025-08-07`（含 `claude-code-20250219`）。
- **阶段 0 可跑**：是。

### 用例 6：AUTO_COMPACT_WINDOW 钳制（§6.9.1）—— 需校准断言值
- **构造**：`ANTHROPIC_MODEL=ccp-sonnet-1[1m]` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000`；另一组 `ANTHROPIC_MODEL=ccp-sonnet-1` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW=600000`。
- **断言（照真 CLI 精算，reservedTokens=min(maxOutputTokens,20000)，自定义模型 maxOutputTokens 经 cap=8000）**：
  - `[1m]` + 600000：effectiveWindow = `min(1000000,600000) - 8000` = `592000`；threshold = `592000 - 13000` = **579000**。
  - 无 `[1m]` + 600000：effectiveWindow = `min(200000,600000) - 8000` = `192000`；threshold = `192000 - 13000` = **179000**。
- **注意**：设计文档 §8 原写 ≈580,000 / ≈187,000 是粗估。mock 照真 CLI，断言用 579,000 / 179,000，注释标注「校准了设计文档估算」。**这是 mock 作为第二道闸的产出**。
- **阶段 0 可跑**：是。

### 用例 7：保留词避让（§6.9.1）
- **构造**：两组：
  1. `ANTHROPIC_MODEL=sonnet`（撞保留词）+ `ANTHROPIC_DEFAULT_SONNET_MODEL=ccp-sonnet-1`。
     - 断言 `/probe/model` = `ccp-sonnet-1`（alias 分支，`getDefaultSonnetModel()` 返回 env 值）。带 `[1m]`：`ANTHROPIC_MODEL=sonnet[1m]` → `/probe/model` = `ccp-sonnet-1[1m]`。
  2. `ANTHROPIC_MODEL=ccp-sonnet-1`（不撞保留词）。
     - 断言 `/probe/model` = `ccp-sonnet-1`（透传，非 alias）。
- **阶段 0 可跑**：是。

### 用例 8：settings 重读生效（§5.3 结论 A）
- **构造**：
  1. 启动 `settings.json` 的 `env` 含 `"SOME_VAR": "v1"`。
  2. 断言 `/probe/env/SOME_VAR` = `v1`。
  3. 改 `settings.json`，`env` 的 `SOME_VAR` 改为 `"v2"`。
  4. 轮询 `/probe/settings-cache` 直到 `reloads` +1。
  5. 断言 `/probe/env/SOME_VAR` = `v2`（重读链路通）。
- **阶段 0 可跑**：是（依赖 chokidar 在 Windows 可靠触发，见 §6.2）。

---

## 5. 实现步骤 todo 清单（按依赖顺序）

| 步骤 | 做什么 | 改/建文件 | 完成标志 | 复杂度 |
|---|---|---|---|---|
| 1 | 装 chokidar | `package.json`、`package-lock.json` | `node -e "require('chokidar')"` 不报错 | 低 |
| 2 | 建目录骨架 + 手写 memoize | `test/mock-cli/src/memoize.mjs` | smoke：缓存命中、clear 后重算 | 低 |
| 3 | configHome + settingsReader | `configHome.mjs`、`settingsReader.mjs` | 临时目录读 settings、resetCache 后重读、空/不存在返 `{}` | 中 |
| 4 | envApplier | `envApplier.mjs` | settings.env `FOO=bar` → `process.env.FOO==='bar'`；删 key → 保留 | 低 |
| 5 | modelResolver | `modelResolver.mjs` | `sonnet`→env 值、`ccp-sonnet-1[1m]`→透传拼回、`ccp-sonnet-1`→透传 | 中 |
| 6 | contextWindow + betas | `contextWindow.mjs`、`betas.mjs` | `[1m]`→1M + betas 含 1M；无→200K；window 钳制算 579000/179000 | 中 |
| 7 | settingsWatcher | `settingsWatcher.mjs` | 改 settings.json → 1-2 秒内探针反映新值 | 中高 |
| 8 | probeServer | `probeServer.mjs` | curl 各端点返回正确 JSON | 中 |
| 9 | index 组装 | `index.mjs` | 起来、stdout 打 probePort、探针可查 | 低 |
| 10 | 8 条测试用例 | `test/mock-cli/test/*.test.mjs` | `node --test test/mock-cli/test/` 全绿 | 中 |
| 11 | package.json test script | `package.json` | `npm run test:mock-cli` 跑全部 | 低 |

---

## 6. 风险与注意

### 6.1 探针端口与代理端口冲突
代理占 11434-11436。**对策**：探针 `127.0.0.1:0` 动态分配，完全不碰固定端口段。stdout 输出实际端口给测试读。零冲突、可并行。

### 6.2 chokidar 在 Windows 上的行为差异（工程是 win32）
- **风险**：Windows 上 chokidar 默认用 native fs events（`usePolling:false`），但 `ReadDirectoryChangesW` 对某些编辑器的"原子写"（写临时文件 + rename）可能触发 `unlink`+`add` 而非 `change`。真 CLI 的 `changeDetector.ts` 有 `DELETION_GRACE_MS` 宽限 + `handleAdd` 把 re-add 当 change 处理（:308-322）吸收这种模式。
- **阶段 0 对策**：
  1. mock watcher 同时监听 `change`/`add`/`unlink`，`add` 当 change 处理（照真 CLI :308-322）。
  2. 测试写文件用 `writeFileSync`（直接覆盖，非 rename），降低触发 unlink+add 概率。
  3. 测试用轮询 + 超时（如 5 秒轮询 `/probe/settings-cache` 的 reloads），不写死 sleep。
  4. `/probe/force-reload` 兜底：chokidar 在 CI 不触发时确定性验证重读逻辑（绕过 chokidar，标注 fallback，默认走真 chokidar）。
- **Windows 路径**：chokidar 在 Windows 把路径正斜杠化，`getSourceForPath` 用 `path.normalize` 比对（真 CLI :362-375 注释）。mock 只 watch 单文件，path 比对简单，但仍需 normalize。

### 6.3 TS ESM 编译 + node:test 跑 .mjs 的搭配
- **决策**：mock-cli 不用 TS，纯 `.mjs`，零编译。彻底规避 `.mts`/编译输出/`moduleResolution` 问题。`node:test` 原生支持 `.mjs`，现有 `proxy/test/*.test.mjs` 已验证可行。
- **代价**：无类型检查。但 mock 是薄层（<500 行），行为对照真 CLI 代码注释，类型损失可接受。若后期想加类型，可单独建 `test/mock-cli/tsconfig.json`（ESM，仅类型检查不编译，`tsc --noEmit`）。

### 6.4 memoize 在 mock 里的实现
- **真 CLI**：`lodash-es/memoize.js`（`envUtils.ts:1`、`betas.ts:2`）。
- **决策**：**手写，不引入 lodash**。20 行可写 `memoize(fn, resolver)` + `.cache.clear()`。
- **实现要点**：`memoize(fn, resolver=(...a)=>a[0])` 返回 `memoized`，`memoized.cache = new Map()`，`memoized.cache.clear = () => memoized.cache.clear()`（与 lodash 接口一致，真 CLI 调 `.cache?.clear?.()`）。configHome 的 resolver 是 `() => process.env.CLAUDE_CONFIG_DIR`（动态 key）。

### 6.5 resolved model 的"会话初始化时算好且 memoize"特性
- §6.9.1 关键坑：`getAllModelBetas` 被 memoize，会话初始化算好后缓存。**mock 必须复刻**：betas 按 model 字符串 memoize，重读 settings 后若 model 变了要 `clearBetasCache()`。**推荐**：重读链路统一 `clearBetasCache()`（保守，与真 CLI `applySettingsChange` 行为一致，重算成本极低）。

### 6.6 process.env 污染隔离
- mock-cli 作为子进程跑，`Object.assign(process.env, ...)` 只影响子进程，不污染测试主进程。**这是 spawn 子进程方案的核心优势**（相对 in-process import）。测试主进程只通过 HTTP 探针观察，env 隔离干净。

### 6.7 `ANTHROPIC_MODEL` 来源
- 阶段 0 mock 不实现 `/model` 交互命令。resolved model 来源：`process.env.ANTHROPIC_MODEL`（启动快照）。未设 fallback `getDefaultSonnetModel()`。`ANTHROPIC_MODEL` 也可能被 settings.env 覆盖（applyConfigEnvironmentVariables 后）——符合真 CLI 行为（settings.env 优先级高于 shell）。测试用例 1/2/3 通过 shell env 注入 `ANTHROPIC_MODEL=sonnet`/`ccp-sonnet-1`，settings.env 不含 `ANTHROPIC_MODEL`，别名冻结前提下 model 不变。

---

## 7. 关键决策汇总

1. **语言/位置**：纯 ESM `.mjs` 放 `test/mock-cli/`，不纳入 tsc。与现有测试基座对齐，零编译，规避 TS-ESM 坑。
2. **chokidar**：必须装（行为等价）。lodash 不装（手写 memoize）。
3. **探针端口**：`127.0.0.1:0` 动态分配，stdout 报端口。零冲突、可并行。
4. **AUTO_COMPACT_WINDOW 断言值**：照真 CLI 精算（579,000 / 179,000），校准设计文档估算（580K/187K），测试注释标注。
5. **settings.env 覆盖测试（用例 2）**：一个用例覆盖两面——不含同名 key 则不覆盖（冻结）+ 含则覆盖。毫不含糊。
6. **`/probe/force-reload`**：确定性兜底，chokidar 真链路靠测试写文件 + 轮询验证。
7. **filterSettingsEnv**：阶段 0 直通（三个 strip 条件不触发），带 TODO 注释。
