# 优化 2：主模型别名映射（ccp-main-N）+ 档位选项 + 警告

> 上轮已做优化 1（连接模式改文字）、优化 3（三档继承父）。本 plan 做优化 2：主模型也走别名代理侧更换 + `[1m]` 档位选项 + 两类警告。
> 约束依据：`docs/model-aliasing-constraints.md`（必读，所有改动在该约束内）。
> 主方案：`docs/claude code cli运行时model切换方案.md` §6。

## 目标

1. **主模型 `ANTHROPIC_MODEL` 也走别名**：派生节点启动注入 `ANTHROPIC_MODEL=ccp-main-N`（可带 `[1m]`），代理映射 `ccp-main-N → 真实模型`，可在线改。
2. **`[1m]` 档位选项**：派生节点配置时选"会话档位"（`[1m]` 或标准），别名按此带后缀。默认从父继承。CLI 按此算 contextWindow。
3. **两类警告**：
   - 改任一档（含主模型）映射时，弹通用警告"若新模型与当前会话档位不同，CLI 决策可能脱节，自行确认"。
   - 主模型映射行 hover 静态提示 `/model` 脱离风险（约束 6：感知不到 `/model`，只能静态提示）。

## 边界（约束文档已定，不逾越）

- 代理映射表 key 一律不带 `[1m]`（rewriteModel 已剥后缀查表，约束 3）。
- 跨档位切不可靠（约束 2），只弹警告不硬拦。
- `/model` 脱离感知不到（约束 6），只能 hover 提示。
- 扩展侧调代理用裸 socket（约束 5）。

## 改动清单

### 1. src/types.ts
- `ModelAliasMapping` 加 `main?: string`（主模型映射，跟 haiku/sonnet/opus 并列）。
- `LLMConfig` 派生字段加 `sessionContext1m?: boolean`（会话档位：true=别名带 `[1m]`、CLI 按 1M 算；false/undefined=标准 200K）。

### 2. src/derivedLogic.ts
- `TIERS` 加 `'main'`（或单独处理，因 main 走 `ANTHROPIC_MODEL` 不是 `ANTHROPIC_DEFAULT_*`）。
- `aliasName('main', idx, with1m)` → `ccp-main-N` 或 `ccp-main-N[1m]`。
- `buildAliasEnv` 加 `ANTHROPIC_MODEL: aliasName('main', idx, with1m)`（主模型走 env `ANTHROPIC_MODEL`，区别于三档走 `ANTHROPIC_DEFAULT_*`）。
- `computeAliasSyncActions` 覆盖 main 档（同步 `ccp-main-N` 到代理映射表）。
- `summarizeAliases` 含 main 档。
- 新增 `inheritSessionContext1m(parentContent)`：从父 content 解析 `ANTHROPIC_MODEL` 是否带 `[1m]`，作为派生节点默认档位。

### 3. src/claudeLauncher.ts（launchDerived）
- `buildAliasEnv(idx, { with1m: derivedCfg.sessionContext1m })` 现在含 `ANTHROPIC_MODEL`。
- 注入 env 时 `ANTHROPIC_MODEL=ccp-main-N[1m]?` 覆盖父的 ANTHROPIC_MODEL（派生节点主模型走别名，不走父真名）。
- 启动前同步代理映射表：含 main 档（`ccp-main-N` → 父真名，可改）。
- 注意：settings.json 的 env 里**不要含 `ANTHROPIC_MODEL`**（让 shell env 的别名生效，约束 4/§5.4）；BASE_URL/token 仍走 settings.env。

### 4. src/webviewEditor.ts
- `openNewDerived`：
  - `sessionContext1m` 默认从父继承（`inheritSessionContext1m`）。
  - `modelAliases.main` 默认从父 content 的 `ANTHROPIC_MODEL`（剥 `[1m]` 后的真名）继承。
- `buildHtml` derived scope：
  - 加"会话档位"选择（`[1m]` / 标准，默认继承），影响别名显示带不带后缀。
  - 四档映射行（main + haiku + sonnet + opus），都可改。
  - main 行 hover 静态提示 `/model` 脱离风险（约束 6 文案）。
  - 改任一档触发 `setAlias` 时，扩展侧弹通用跨档位警告（约束 2/3）。
- `WebviewMessage` 的 `setAlias` 的 `tier` 加 `'main'`。
- `handleSetAlias` 覆盖 main 档。

### 5. src/extension.ts
- `deleteDerivedConfig` 删 `ccp-main-N` 映射（连同三档）。
- 派生节点创建时申请编号 N 后，注入 main 档映射到代理表。

### 6. 代理侧（proxy/）
- `rewriteModel` 已剥 `[1m]` 查表、已实现，无需改（main 档别名也走同一套）。
- 不需要新接口。

## 警告文案

**通用跨档位警告**（改任一档映射时弹）：
> 已更新「{档}」映射：{别名} → {新真实模型}。若新模型与当前会话 contextWindow 档位（{[1m] 或标准}）不同，CLI 的 autocompact/上下文计数可能脱节，自行确认。

**main 行 hover**（静态，约束 6）：
> 主对话模型别名。仅当 CLI 内未用 `/model` 切换时生效——`/model` 改的模型会脱离本别名，代理替换对主对话不再生效（子 agent 三档仍受控）。

## 测试（TDD，照 dev-with-tdd-review skill）

### derived-logic 单测（纯函数）
- `aliasName('main', 1, false)` = `ccp-main-1`；`aliasName('main', 1, true)` = `ccp-main-1[1m]`。
- `buildAliasEnv(1, { with1m: true })` 含 `ANTHROPIC_MODEL: 'ccp-main-1[1m]'` + 三档带后缀。
- `buildAliasEnv(1, { with1m: false })` 含 `ANTHROPIC_MODEL: 'ccp-main-1'` + 三档不带。
- `computeAliasSyncActions` 含 main 档同步。
- `inheritSessionContext1m('{"env":{"ANTHROPIC_MODEL":"x[1m]"}}')` = true；无后缀 = false。
- `summarizeAliases` 含 main 档。

### 代理 e2e
- `ccp-main-1` 命中映射替换；`ccp-main-1[1m]` 剥后缀查表替换（rewriteModel 已实现，回归）。

## 不做（范围外）
- `/model` 脱离运行时检测（约束 6 感知不到，不做）。
- 跨档位精确判断（约束 3 代理看不到档位，只通用警告）。
- 追踪 UI（按 N filter，将来做）。

## TDD 起点
- baseline：`node --test proxy/test/ test/derived-logic/test.mjs test/mock-cli/test/`
- 正交设计：新写 plan/tmp/{date}-main-alias.md
- 约束文档：`docs/model-aliasing-constraints.md`（必读）
