# 正交设计：优化 2 主模型别名映射（ccp-main-N）+ 档位选项 + 警告

> 依据：plan/tmp/opt2-main-alias.md（规格）+ docs/model-aliasing-constraints.md（约束）。
> TDD skill Step 2 产物。本文档穷举正交维度，Step 3 据此挑测试用例（覆盖维度，不堆数量）。

## 任务范围回顾

把主模型 `ANTHROPIC_MODEL` 也纳入派生节点的别名代理体系：
- 派生节点启动注入 `ANTHROPIC_MODEL=ccp-main-N[1m]?`（shell env，覆盖父真名）。
- 代理映射表加 `ccp-main-N → 真实模型`（可在线改，复用现有 setModelAlias/rewriteModel）。
- 派生节点配置时选"会话档位"（`[1m]` 或标准），别名按此带后缀；默认从父继承。
- 两类警告：改任一档映射弹通用跨档位警告；main 行 hover 静态提示 `/model` 脱离。

纯逻辑改动（可单测）：`derivedLogic.ts` 的 aliasName/buildAliasEnv/computeAliasSyncActions/summarizeAliases/aggregateModelCatalog + 新增 inheritSessionContext1m。
交互层改动（不进单测，靠手工+编译）：webviewEditor/claudeLauncher/extension/types。

## 既存相关问题（优化 2 范围外但相关，记录待定）

- `proxyHost.getModelAliases()`（http.get）和 `postJson`（http.request，被 setModelAlias/removeModelAlias 用）**仍用 http 栈**，违反约束 5。优化 2 让 main 档也走 setModelAlias，加大依赖面。
- 但 plan 文件未要求改这俩，且它们当前实测可用（POST 可能"假成功"，约束 5 注明）。本次**不动**，记为已知风险，后续单独修。正交设计不纳入。

## 正交维度

### D1: tier 维度（档位种类）
- 三档：haiku / sonnet / opus（走 `ANTHROPIC_DEFAULT_*_MODEL`，现有）。
- **新增 main 档**：走 `ANTHROPIC_MODEL`（区别于三档走 `ANTHROPIC_DEFAULT_*`）。
- main 与三档的别名构造、env 注入 key、映射同步、摘要展示**都不同**（main 走 `ANTHROPIC_MODEL`，三档走 `ANTHROPIC_DEFAULT_*`）。

### D2: `[1m]` 档位后缀维度
- 不带后缀（标准 200K）。
- 带 `[1m]` 后缀（1M contextWindow）。
- 该维度作用于**全部四档**（main + haiku + sonnet + opus）：with1m=true 时四档别名都带 `[1m]`。
- **代理映射表 key 不带后缀**（rewriteModel 剥后缀查表，约束 3）——与 with1m 无关，映射 key 永远是 `ccp-<tier>-N`（无后缀）。

### D3: 档位继承维度（inheritSessionContext1m）
- 父 `ANTHROPIC_MODEL` 带 `[1m]` → 派生默认 with1m=true。
- 父 `ANTHROPIC_MODEL` 不带 → 派生默认 with1m=false。
- 父无 `ANTHROPIC_MODEL` / content 无效 → 默认 false（保守，200K）。
- 父 `ANTHROPIC_MODEL` 带大写 `[1M]` / `[1m]` 混用 → CLI `has1mContext` 用 `/\[1m\]/i` 识别大小写，应判 true。

### D4: 编号 N 维度
- N=1（最小合法）。
- N 大数（不溢出）。
- N=0 / 负数 / 非整数（非法，computeAliasSyncActions 应安全返回空动作，已有 S1/S1b 模式）。
- N 缺失（null/undefined）。

### D5: 映射同步维度（computeAliasSyncActions）
- 代理表缺本节点某档 → toSet 该档。
- 代理表已含且一致 → 无动作。
- 代理表含但值不一致 → toSet（覆盖）。
- 本节点某档未配 → 不补该档（含 main：main 未配不补，启动时别名原样透传不命中映射表 → model not found 风险，但这是用户选择）。
- 别的编号残留 → 不清（编号不回收）。
- **main 档同步**：`ccp-main-N` 走同一套 toSet 逻辑，区别仅在 alias 构造（`ccp-main-N` 无后缀）+ env key（`ANTHROPIC_MODEL`）。

### D6: 安全约束维度（buildAliasEnv 不混入）
- buildAliasEnv 产 main + 三档别名（4 个 key）。
- **绝不含** `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（走 settings.env，不进 shell，防进程列表可见）。
- 现有测试 4 断言 `ANTHROPIC_MODEL === undefined` —— 优化 2 后此断言**作废**，改为断言 `ANTHROPIC_MODEL === 'ccp-main-N[1m]?'`。这是行为变更点，需更新测试。

### D7: 摘要展示维度（summarizeAliases）
- main 档展示（`M:..`）。
- 三档展示（`S:.. · H:.. · O:..`，现有）。
- 全空 → 空串。
- 部分配 → 只显配的。
- 非字符串值 → 跳过不崩（现有 S3 模式，需扩展到 main）。

### D8: 聚合清单维度（aggregateModelCatalog）
- main 档真实模型名应纳入候选清单（现有只聚三档 + content 的 ANTHROPIC_MODEL/SMALL_FAST）。
- derived 节点 modelAliases.main 应被聚进 catalog。

### D9: 警告维度（交互层，不进纯逻辑单测）
- 通用跨档位警告：改任一档（main/haiku/sonnet/opus）映射触发。
- main 行 hover 静态提示：`/model` 脱离风险（约束 6）。
- 这俩是 UI 行为，靠手工验证 + 编译通过，不写纯逻辑单测。

## 维度组合（高风险交叉点）

| 组合 | 风险类别 | 说明 |
|---|---|---|
| D1(main) × D2([1m]) | 边界 | `aliasName('main', 1, true)` = `ccp-main-1[1m]`；映射 key 仍 `ccp-main-1`（无后缀） |
| D1(main) × D5(同步) | 状态转换 | main 档 toSet 走 `ccp-main-N`，与三档并列 |
| D1(main) × D6(安全) | 类型安全 | buildAliasEnv 含 `ANTHROPIC_MODEL` 但不含 BASE_URL/token |
| D2([1m]) × D3(继承) | 边界 | 父带 [1m] → 派生 with1m=true → 四档别名全带后缀 |
| D3(继承) × 异常 | 异常路径 | 父 content 无效/无 ANTHROPIC_MODEL → 默认 false |
| D5(同步) × D4(N非法) | 边界 | main 档 + N=0 → computeAliasSyncActions 安全返回空（与三档一致） |
| D7(摘要) × D1(main) | 一致性 | main 档用 `M:` 前缀，与三档 S/H/O 风格一致 |
| D8(聚合) × D1(main) | 一致性 | main 真实模型名进 catalog |

## 高风险类别自查（6 类，Step 5 子代理会复核）

1. **边界**：N=0/负/非整数（main 档同三档）；with1m true/false；父无 ANTHROPIC_MODEL。
2. **异常路径**：父 content 无效 JSON；modelAliases.main 非字符串；快照损坏（已有，main 不引入新）。
3. **类型安全**：modelAliases.main 为数字/对象 → summarizeAliases/aggregateModelCatalog 不崩。
4. **状态转换**：computeAliasSyncActions main 档缺→补、一致→无动作、不一致→覆盖。
5. **时序竞态**：computeAliasSyncActions 连续调用幂等（main 档同三档）。
6. **一致性**：main 别名构造/映射 key/env key/摘要前缀 与三档风格一致；映射 key 永远无后缀。

## 测试用例选取（Step 3 详见 test.mjs，此处先列维度映射）

- D1+D2：`aliasName('main',1,false)`=`ccp-main-1`；`aliasName('main',1,true)`=`ccp-main-1[1m]`。
- D1+D6：`buildAliasEnv(1,{with1m:true})` 含 `ANTHROPIC_MODEL:'ccp-main-1[1m]'`+三档带后缀，不含 BASE_URL/token。
- D2：`buildAliasEnv(1,{with1m:false})` 四档都不带后缀。
- D1+D5：`computeAliasSyncActions` 含 main 档（配了则补 `ccp-main-N`，未配不补）。
- D5：main 档缺/一致/不一致/未配 四态。
- D3：`inheritSessionContext1m` 父带[1m]=true / 不带=false / 无=默认false / 大写[1M]=true。
- D1+D7：`summarizeAliases` 含 main 档 `M:` 前缀。
- D1+D8：`aggregateModelCatalog` 含 main 真实模型名。
- D4+D5：main 档 + N=0 → 空动作（与三档一致）。
- D7 异常：modelAliases.main 非字符串 → 跳过。
- D8 异常：modelAliases.main 非字符串 → 跳过。
- D6 更新：原测试 4 的 `ANTHROPIC_MODEL===undefined` 断言改为 `===ccp-main-1[1m]`。

## 不做（范围外，约束已定）

- `/model` 脱离运行时检测（约束 6）。
- 跨档位精确判断（约束 3，代理看不到档位）。
- getModelAliases/postJson 改裸 socket（plan 未要求，已知风险另修）。
- 追踪 UI（将来）。
