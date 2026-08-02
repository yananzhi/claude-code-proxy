# 下轮 TDD 起点：扩展侧 model aliasing

> 上轮已完成代理层（commit ae2e62e），下轮做扩展侧。新会话直接读此文件 + 设计文档 §6 接着干。
> 设计文档：`docs/claude code cli运行时model切换方案.md`（§6.2 数据模型 / §6.3 tree / §6.4 后台通知 / §6.5 继承 / §6.6 启动参数 / §6.7 webview / §6.8 命令 / §6.9 边界）。
> TDD skill：`.claude_proxy/skills/dev-with-tdd-review/SKILL.md`（七步）。

## 上轮成果（代理层，已提交 ae2e62e）

- `proxy/config-store.js`：getModelAliases / updateModelAlias / removeModelAlias / nextAliasId / rewriteModel（剥离 [1m] 查表替换，不受 isMessagesMain 守卫）/ init 兜底+启动校正 / getView 加 modelAliases+nextAliasId
- `proxy/server.js`：outBody 链串联 rewriteModel、trace 加 resolvedModel、三接口（POST /api/model-alias、/api/model-alias/delete、GET /api/model-alias/next-id）
- `proxy/trace-store.js`：append 规范化 + summarize 加 resolvedModel
- 测试 88 全绿（proxy/test/ + test/mock-cli/test/）
- 子 agent 审查修了 2 个真 bug：rewriteModel 剥 [2m]→改 /\[1m\]/gi、init 兜底漏数组→加 Array.isArray

## 扩展侧待办（三块）

### 块 1：src/proxyHost.ts — 代理接口 wrapper
照 setUpstream（L211-238）模板，手写 http.request POST：
- `setModelAlias(alias, model)` → POST /api/model-alias
- `removeModelAlias(alias)` → POST /api/model-alias/delete
- `nextAliasId()` → GET /api/model-alias/next-id

### 块 2：派生节点 store + tree + launcher
- `src/types.ts`：LLMConfig 加 derivedFrom / derivedIndex / modelAliases / derivedSnapshot（DerivedSnapshot: {baseUrl, token, timeoutSec, mode}）
- `src/localConfigStore.ts`：加 getDerivedByParent(parentId)；load/save/upsert/remove/get 无需改（新字段自然序列化）
- `src/treeProvider.ts`：加 CV_DERIVED_CONFIG='derived-config'；父 local 节点 collapsibleState 可展开；getChildren 展开时返回派生节点；buildDerivedNode（description 显示映射摘要 S:.. H:.. O:..，孤儿打 ⚠ 前缀禁用启动）；单击绑 launchDerivedClaude
- `src/claudeLauncher.ts`：加 launchDerived(derivedCfg)——继承父上游（优先 derivedSnapshot，无则父 content extractUpstream）+ 三档别名走 shell env（ANTHROPIC_DEFAULT_*_MODEL=ccp-<档>-N）+ BASE_URL/token 走 settings.env（沿用 synthesizeProxySettings，不降级安全）+ 启动前同步代理映射表（缺则 setModelAlias 补）+ 上游一致性警告（P5）
- `src/extension.ts`：加命令 newDerivedConfig / editDerivedConfig / launchDerivedClaude / deleteDerivedConfig（删时关联活终端 P6）；deleteLocalConfig 父删时级联派生节点（P1）
- `package.json`：加命令 + viewItem==derived-config 行内按钮 + local-config 加 +派生

### 块 3：src/webviewEditor.ts — 配置页
- scope 新增 'derived'；openNewDerived(parentCfg) / openEditDerived(cfg)
- buildHtml derived scope 加"模型别名映射"区域（三档各一行：左固定别名只读 ccp-<档>-N，右下拉选真实模型）
- WebviewMessage 加 { type:'setAlias'; tier:'haiku'|'sonnet'|'opus'; model:string }
- onMessage setAlias 分支：调 proxyHost.setModelAlias + localStore.upsert 同步缓存 + refresh() 刷树（P7）+ 不关面板
- derived scope content textarea 只读（P11）
- 全局模型清单来源（P9）：从所有已存配置 model 字段聚合去重 + 手输历史

## 关键约束（上轮已验/已定，别踩）

- 别名走 shell env（启动快照、session 内冻结）——§5.4 + 官方文档"env 启动时注入"确认
- token/BASE_URL 走 settings.env（不进 shell，防进程列表可见）——§6.6 P4
- 派生节点存 derivedSnapshot 防父删/改断链——§6.5 P1
- 别名格式 ccp-<档>-N，支持 1M 带 [1m] 后缀（ccp-sonnet-1[1m]）——§6.9.1
- 编号全局递增不回收——§6.9
- 主模型 ANTHROPIC_MODEL 不纳入 alias、走 /model——§3.3/§6.13
- rewriteModel 在代理层已实现，扩展侧只调接口

## TDD 起点

- Step 1 baseline：`node --test proxy/test/` + `node --test test/mock-cli/test/`（88 绿）
- Step 2 正交设计：新写 plan/tmp/{date}-ext-derived-node.md，维度至少含：继承（父删/改/快照优先）、孤儿节点、编号申请（nextAliasId）、别名注入（shell env 三档）、终端生命周期（launchDerived 起终端、deleteDerived 关活终端）、webview setAlias（同步缓存+刷树+不关面板）、上游一致性警告
- 扩展侧测试难点：VS Code API（tree/webview/terminal）难纯单测。策略——把可抽逻辑（继承合成、别名 env 构造、映射表同步、快照优先级）抽成纯函数单测；VS Code 交互层靠类型 + 手动验。
- PROJECT_OVERRIDE：baseline=`node --test proxy/test/ test/mock-cli/test/`，planning dir=plan/tmp/
