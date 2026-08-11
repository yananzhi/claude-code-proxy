# 派生/普通 CLI 透传自定义 env（CLAUDE_CODE_AUTO_COMPACT_WINDOW 等）

## Context

派生配置带 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=90000`，启动的 CLI 在某些工程里上下文超 90K 不自动 compact，且 `echo $CLAUDE_CODE_AUTO_COMPACT_WINDOW` 无值。

**根因**：真实 CLI 从 `process.env` 读 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（`test/mock-cli/src/contextWindow.mjs:52`），而 `process.env` 有两个来源：(1) spawn 时注入的 shell env，(2) 启动时 `Object.assign(process.env, settingsEnv)`（`test/mock-cli/src/envApplier.mjs:27`，additive-only）。

当前 4 个启动入口**只透传路由 key**（`ANTHROPIC_BASE_URL`/`TOKEN`/`MODEL`/`SMALL_FAST_MODEL`/`API_TIMEOUT_MS` + 派生四档别名），**把其余自定义 env key 全丢了**（如 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`）。所以该 key 能否进 CLI 纯属意外——取决于共享 `.claude_proxy/settings.json` 是否恰好残留它：
- 本工程 `settings.json` 恰好残留 `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` → CLI 启动时 `Object.assign(process.env, settingsEnv)` 把它带进 process.env → compact 生效。
- 另一工程 settings.json 经事件链后该 key 残留丢失 → process.env 拿不到 → 不 compact。

**因果链（2026-08-11 定位）**：另一工程的 `.claude_proxy/settings.json` 当前是 `{env:{CLAUDE_CODE_AUTO_COMPACT_WINDOW:90000}, skipDangerousModePermissionPrompt:true}`，而 `local-active.json` 激活的是 deepseek 配置（content 里 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=800000` + 路由 key）。值不匹配（90000≠800000）+ 缺路由 key + 有 `skipDangerousModePermissionPrompt`（CLI 自己写的 key，我们 content 从不写）——这三条合起来证明该文件不是我们任何一次 activateConfig 写的（direct activateConfig 写完整 content 含路由 key；stripConflict 保留 90000 但不会凭空加 skipDangerousModePermissionPrompt）。真正重写它的是 **CLI 自己**：CLI 以 `.claude_proxy` 为 config dir 启动时重写 settings.json，只保留自己认识的 key + 残留 env 里非路由 key，丢掉路由 key。同目录 `backups/.claude.json.backup.*`（14:46:39~15:03:02 连续 5 个，比 settings.json 修改时间 14:46:28 晚 11s）印证 CLI 在 settings.json 被写后连续重启 5 次、每次备份全局 state。`markDefaultConfig` 只改 local-active.json 不写 settings.json（弱化激活），故 deepseek 激活标记切换后 settings.json 仍停留在更早的 "52" 配置（90000）写入态，随后 CLI 重写丢失路由 key、保留 90000 残留。

**为何 settings.json 残留不可靠**：`synthesizeProxySettings`（`src/upstream.ts:19`，写完整父 env 到 settings.json）只在普通配置 activateConfig（`standalone/configApi.js:355`，且仅 proxy 模式）/ 插件 doSwitch 调用，派生启动从不调；direct 模式 activateConfig / doSwitch 写**完整 content**（含 env + 路由 key，非"不写 env"——计划早期假设有误，已订正）；且 CLI 自身会重写 settings.json 丢 env。派生启动既不写 settings.json、也不注入 shell env → 自定义 key 永远到不了 CLI。

**预期（用户确认）**：派生/普通 CLI 的自定义 env 应**通过 shell env 注入**，不依赖 settings.json——与 CLAUDE.md「workspace-local 终端路由 key 一律走 shell env」规则一致，把覆盖范围从「路由 key」扩到「所有非冲突自定义 env key」。

## 修复方案

在 4 个启动入口，从 `content.env`（普通）/ 父 `content.env`（派生）提取**非冲突自定义 env key**，注入到 spawn env。冲突 key（路由 key + 特殊处理 key）不透传——它们已由各路径显式构造。

### 共享排除清单（新增到 `src/derivedLogic.ts`）

新增纯函数 `extractCustomEnv(env)`，返回排除下列 key 后的剩余 env（仅字符串非空值）。放 `derivedLogic.ts`（插件 + standalone 共用，纯函数好单测，沿用 `buildAliasEnv`/`resolveDerivedUpstream` 模式）。

排除清单（合并 `CONFLICT_KEYS` + 特殊处理 key）：
```
ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL,
API_TIMEOUT_MS, ANTHROPIC_DEFAULT_HAIKU_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_OPUS_MODEL
```
- 前 5 个 = 路由 key + 特殊处理（各路径已显式构造，透传会重复/冲突）。
- 后 3 个 = 派生四档别名 key（`buildAliasEnv` 已构造，透传会覆盖别名）。

`CONFLICT_KEYS`（`standalone/terminalApi.js:46`，5 个路由 key）是子集——standalone 侧直接复用新函数；terminalApi.js 的 `CONFLICT_KEYS` 常量保留（settings 冲突检测仍用，只检测路由 key 是否覆盖 modelname，不含 AUTH_TOKEN/TIMEOUT/SMALL_FAST_MODEL，语义不变）。

### 4 处修改

**1. 插件普通 `buildWorkspaceEnv`（`src/claudeLauncher.ts:66-132`）**
- `extractUpstream(cfg.content)` 后，调 `extractCustomEnv(parsed.env)` 取自定义 key，在 `return env` 前展开进 env。

**2. 插件派生 `launchDerived`（`src/claudeLauncher.ts:418-428`）**
- 已有 `parentCfg`（line 336）。用 `extractUpstream(parentCfg.content)` 取父 env，再 `extractCustomEnv` 取自定义 key，展开进 terminalOptions.env。
- 父 content 无效时 `extractUpstream` 返回 null → 自定义 env 为空，不阻断（与 `resolveDerivedUpstream` 快照优先逻辑独立，快照能解上游但无自定义 env 时仍透传空，安全）。

**3. standalone 普通 `buildTerminalEnv` normal 分支（`standalone/terminalApi.js:117-159`）**
- `extractUpstream(cfg.content)` 后调 `extractCustomEnv(parsed.env)`，展开进 `env`（line 148-158 构造的 env 后展开）。

**4. standalone 派生 `buildTerminalEnv` derived 分支（`standalone/terminalApi.js:161-195`）**
- `resolveDerivedUpstream` 只解上游不取自定义 env。需额外：从父 `content.env` 取自定义 key。
- `parentCfg` 已是入参。`extractUpstream(parentCfg.content)` → `extractCustomEnv` → 展开进 env（line 187-195 构造的 env 后展开）。
- `parentCfg` 为 null（孤儿靠快照）时自定义 env 为空——可接受（孤儿本就是降级场景，快照无自定义 env）。

### 透传语义保证

- **派生别名不被覆盖**：`extractCustomEnv` 排除四档 `ANTHROPIC_DEFAULT_*_MODEL`，`buildAliasEnv` 构造的别名 env 不受影响。展开顺序：先 `...aliasEnv`，后 `...customEnv`（customEnv 已排除别名 key，顺序无冲突）。
- **路由 key 不被覆盖**：customEnv 排除 `ANTHROPIC_BASE_URL`/`TOKEN`/`MODEL`/`SMALL_FAST_MODEL`/`API_TIMEOUT_MS`，各路径显式构造的路由 key 不受影响。
- **settings.json 冲突检测不变**：`CONFLICT_KEYS`（5 个路由 key）仍只检路由 key，自定义 key（如 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`）不在冲突检测范围——它不会覆盖 modelname，共存安全。

## 测试（TDD：先红后绿）

### 1. standalone 侧证明测试（`test/standalone/terminal-env.test.mjs`）

新增用例，**先写并验证失败**（证明自定义 env 当前被丢）：
- **D1-custom**：`directContent({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000', FOO: 'bar' })` → `buildTerminalEnv` 返回 env 断言含 `CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000'` 和 `FOO: 'bar'`。修复前失败（env 无这两个 key），修复后通过。
- **D3-custom**：`derivedCfg(...)` 的父 `proxyContent({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000' })` → 派生 env 断言含该 key。修复前失败，修复后通过。
- **D1-conflict-excluded**：`directContent({ ANTHROPIC_MODEL: 'x', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '90000' })` → env 的 `ANTHROPIC_MODEL` 仍是显式构造值（不被 customEnv 覆盖），同时含 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`。证明排除清单生效。
- **D3-alias-excluded**：派生 env 含 `ANTHROPIC_DEFAULT_SONNET_MODEL`（来自 buildAliasEnv），且父 env 即便有同名 key 也不覆盖别名。

helpers `directContent(over)`/`proxyContent(over)`/`derivedCfg(over)` 已支持 `over` 注入自定义 key，无需改 helper。

### 2. derivedLogic 纯函数单测（`test/derived-logic/test.mjs`）

新增 `extractCustomEnv` 用例：
- 排除 8 个冲突/特殊 key，保留其余字符串非空 key。
- 非字符串值（数字/对象）不透传（与 `extractUpstream` typeof 守卫一致）。

### 3. mock-cli 证明测试（`test/mock-cli/test/`，用户明确要求）

新增用例证明 CLI 侧行为：构造 settings（仅含 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 在 env）+ shell env（不含该 key），调 `applyConfigEnvironmentVariables()` 后 `process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` 应为 settings 值（证明 settings.json 是当前唯一泄漏路径）；再构造 shell env 含该 key、settings.env 不含，`process.env` 应为 shell 值（证明 shell env 注入能独立生效，不依赖 settings.json）。这证明修复方向正确：shell env 注入后，即便 settings.json 被覆写无 env，CLI 仍能拿到值。

### 4. 回归

- `node --test test/standalone/terminal-env.test.mjs`（standalone 侧全量）
- `node --test test/derived-logic/test.mjs`（纯函数）
- `node --test test/mock-cli/test/`（mock-cli）
- 全量：`node --test --test-concurrency=1 proxy/test/ test/derived-logic/test.mjs test/mock-cli/test/ test/proxyHost/ mock/ test/standalone/`

## 实现顺序

1. 新增 `extractCustomEnv` 到 `src/derivedLogic.ts` + 单测（绿）。
2. 写 standalone 侧 D1-custom/D3-custom/D1-conflict-excluded/D3-alias-excluded（红）。
3. 改 `standalone/terminalApi.js` 两处（绿）。
4. 写 mock-cli 证明测试（绿，验证修复方向）。
5. 改 `src/claudeLauncher.ts` 两处（插件侧，无单测入口——靠 derivedLogic 纯函数 + standalone 等价路径覆盖；插件侧逻辑与 standalone 镜像，standalone 测试即等价证明）。
6. `npm run compile`（derivedLogic.ts → out/derivedLogic.js 供 standalone require）。
7. 跑全量回归。

## 不改的部分

- `synthesizeProxySettings` / activateConfig 写 settings.json 的行为不动（global 链路 + 普通配置激活仍写，CLAUDE.md 约定）。
- `CONFLICT_KEYS` 常量与 settings 冲突检测逻辑不动（语义不变）。
- settings.json 的 `env` 残留不自愈清理（自定义 key 在 settings.json 里与 env 注入共存安全，CLI additive-only 不冲突；用户可手动清理）。
