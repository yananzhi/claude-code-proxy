# 正交设计：扩展侧派生虚拟配置节点（derived node）

> 配套 `plan/tmp/next-session-ext-sided.md`（任务起点）与设计文档 §6。
> 本文档只做**正交维度分解**，供 Step 3 选测试用例。实现细节以 §6 为准。

## 0. 测试基建现状与策略（先定调）

- 扩展侧 `src/` 至今**零测试基建**：`tsconfig.json` `rootDir:"src"`、`include:["src/**/*"]`，无 `.test.ts`、无 runner。
- 现有测试只有 `proxy/test/*.mjs`（ESM JS）与 `test/mock-cli/test/*.mjs`（spawn 子进程探针），均不测 `src/` TS 代码。
- VS Code API（tree/webview/terminal）难纯单测。

**策略**：把可测纯逻辑抽到 `src/derivedLogic.ts`（TS，**零 `vscode` 依赖、零 `http` 依赖**，只接 plain data in/out）。测试 `test/derived-logic/test.mjs` import 编译产物 `out/derivedLogic.js`，先 `tsc` 再 `node --test`。VS Code 交互层（treeProvider/extension/webview 的 DOM）靠类型 + 手动验，不进单测。

`derivedLogic.ts` 承载的纯函数（候选，实现时定名）：

1. `buildAliasEnv(derivedIndex, opts) → Record<string,string>` — 构造三档 shell env（`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL = ccp-<档>-N`，支持 `[1m]` 后缀）。**纯函数**。
2. `aliasName(tier, index, with1m) → string` — `ccp-sonnet-1` / `ccp-sonnet-1[1m]`。**纯函数**。
3. `resolveDerivedUpstream(derivedCfg, parentCfg) → {baseUrl, token, timeoutSec, mode} | null` — 快照优先、父 content 兜底的继承合成。**纯函数**。
4. `computeAliasSyncActions(derivedCfg, proxyAliases) → {toSet:[{alias,model}], toRemove:[alias]}` — 启动前比对代理现表与派生节点 modelAliases，算出需补/需清的差集。**纯函数**。
5. `isOrphan(derivedCfg, parentCfg) → boolean` — 父配置是否已不存在。**纯函数**。
6. `summarizeAliases(modelAliases) → string` — 树 description 摘要 `S:.. · H:.. · O:..`。**纯函数**。
7. `aggregateModelCatalog(configs) → string[]` — 从所有配置聚合去重模型清单（webview 下拉候选）。**纯函数**。

> proxyHost 的三个 wrapper（setModelAlias/removeModelAlias/nextAliasId）是 http.request 薄封装，归入"VS Code 交互层"，靠类型 + 代理侧已有 e2e 测试（`server-alias-e2e.test.mjs`）覆盖，扩展侧不单测其 HTTP 细节。

## 1. 正交维度分解

下表每行是一个**独立行为轴**（不会塌缩成同一维度）。维度间组合构成测试空间。

| # | 维度 | 取值/边界 | 关联纯函数 |
|---|---|---|---|
| D1 | 别名格式 | `ccp-<tier>-N`；tier ∈ {haiku,sonnet,opus}；N≥1；`[1m]` 后缀有无 | `aliasName` `buildAliasEnv` |
| D2 | 编号 N 唯一性 | 申请自代理 `nextAliasId`（全局递增不回收）；本地兜底 `nextDerivedIndex`；启动校正 | （代理侧已测，扩展侧测兜底） |
| D3 | 继承来源优先级 | 快照存在→用快照；快照缺→父 content 解；父也缺→失败(null) | `resolveDerivedUpstream` |
| D4 | 孤儿判定 | 父存在(非孤儿)/父删(孤儿) | `isOrphan` |
| D5 | 别名映射同步决策 | 代理表缺→补 set；代理表多余(本节点已不用)→不清（编号不回收，但本节点三档全在则无需动作）；本节点某档未配→不补该档 | `computeAliasSyncActions` |
| D6 | env 传递方式划分 | 三档别名→shell env；BASE_URL/token→settings.env（不进 shell）；别名与 settings.env 不同名 | `buildAliasEnv`（只产 shell env 部分） |
| D7 | 模型清单聚合 | global+local+derived 的 ANTHROPIC_MODEL/ANTHROPIC_DEFAULT_*_MODEL 去重；空集合；重复；手输自定义 | `aggregateModelCatalog` |
| D8 | 摘要展示 | 三档全配/部分配/全空；含 `[1m]` | `summarizeAliases` |

**不进纯函数单测的维度（VS Code 交互层，类型+手动验）**：

| # | 维度 | 落点 |
|---|---|---|
| V1 | tree 展开/折叠 | treeProvider.getChildren 分流 |
| V2 | 终端生命周期 | launchDerived 起终端、deleteDerived 关活终端（按 name/CCP_DERIVED_ID 匹配） |
| V3 | webview setAlias 流程 | onMessage 分支：setModelAlias + upsert + refresh + 不关面板 |
| V4 | 上游一致性警告 | launchDerived 检测代理当前上游≠父上游→弹警告 |
| V5 | 父删级联 | deleteLocalConfig 扫派生节点确认 |

## 2. 高风险维度（Step 3 必须给边界/非法用例）

按 skill 的 6 类高风险，标注本任务命中的：

- **状态转移**：D3（快照→父→null 三态）、D5（同步动作 set/remove/skip）。
- **异常/错误路径**：D3 父缺+快照缺→null；D1 非法 tier；D5 别名为空字符串。
- **时序/竞态**：D5（代理表与本节点缓存不一致的差集计算，顺序无关但需幂等——同一输入两次算同结果）；V2/V3 涉及异步但不进单测。
- **空/null/初始态**：D3 快照字段缺失；D7 空配置列表；D8 modelAliases undefined。
- **幂等**：D5 重复调用 computeAliasSyncActions 结果不变；buildAliasEnv 同输入同输出。
- **边界输入**：D1 N=1（最小）、N 大数；`[1m]` 大小写（CLI 只认 `[1m]`/i，别名侧应原样保留用户给定大小写？——见 §6.9.1，CLI `has1mContext` 用 `/\[1m\]/i`，故 `[1M]` 也识别；但代理 rewriteModel 剥离用 `/\[1m\]/gi`。别名构造应统一输出小写 `[1m]` 避免歧义）；D7 单元素、全重复。

## 3. 维度组合矩阵（选例依据）

关键组合（每个至少 1 例）：

- D1×D6：三档别名 + `[1m]` 全注入 shell env，断言不含 BASE_URL/token。
- D3×D4：快照存在但父删→仍可用快照启动（非孤儿因快照自洽？不——孤儿定义是父删，与快照有无无关；快照让孤儿仍能启动上游但树仍标⚠。需在用例里分开断言）。
- D3 父改：快照存→用旧快照（不继承父新 token），这正是 P1 设计意图。
- D5×D2：代理表已有 ccp-sonnet-1（旧会话残留）+ 本节点 N=2 → 不清 1、只补 2 的缺失档。
- D5 幂等：代理表已与本节点完全一致 → toSet=[] toRemove=[]。
- D7×D8：聚合含 derived 节点的 modelAliases 真实模型名；摘要正确。
- D1 边界：`[1m]` 构造统一小写；N=1。

## 4. 范围声明

- 本轮只做**扩展侧**。代理层 rewriteModel/接口/持久化已在上轮（ae2e62e）完成并测过。
- 扩展侧单测覆盖 D1-D8 纯函数；V1-V5 靠 TS 类型 + 编译通过 + 手动验，不写自动化用例（VS Code API mock 成本远超收益，且计划文件已认可此策略）。
- smoke = baseline（proxy + mock-cli，88 绿）+ 新增 `test/derived-logic/`（先 tsc）。
