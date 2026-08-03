# 阶段 4 正交场景设计 — 配置编辑页迁移

> 日期：2026-08-03
> 任务：阶段 4，配置编辑页迁移（webviewEditor → 独立网页）
> 硬约束：VS Code 形态 465 用例不破；不碰 src/ 下 VS Code 形态代码；proxy/ 不动

## 设计决策（先定的点）

### 独立形态不做 "global config" 概念

VS Code 形态有 global config（ConfigStore，存 globalStorage，跨 workspace）+ local config（每 workspace）。**独立形态只有 workspace-local config**——每个 workspace 的 `.claude_proxy/local-configs.json`，没有跨 workspace 的 global config。

理由：
- 独立形态的"公共配置"是 proxy-config（upstream/aliases/retryRules），由 proxy 控制台网页改。
- local config 的 content 含 upstream env（激活时注入 proxy）——但既然 proxy-config 公共一份，local config 的 upstream 和 proxy-config 的 upstream 是什么关系？

**关键澄清**：local config 的 content 是 settings.json 全文，含 `env.ANTHROPIC_BASE_URL/TOKEN/MODEL`。VS Code 形态下，激活 local config 时 launcher 调 `proxyHost.setUpstream()` 把 content 里的 upstream 注入 proxy（proxy-config 的 env 段），CLI 的 BASE_URL 指向代理。所以 **local config 的 upstream = 激活时注入 proxy 的 upstream**。

独立形态要复刻这个：激活 local config → 调 `POST /api/upstream` 把 content upstream 注入 proxy → CLI 会话用代理。但阶段 3 spawn 的是"裸 claude"（不写 settings.json）。**阶段 4 要不要做"激活"这步？**

### 决策：阶段 4 做 local config CRUD + 编辑网页，不做"激活写 settings.json + 注入 upstream"

理由：
- "激活"依赖独立形态的 proxyHost HTTP 客户端（调 `/api/upstream` + 写 `.claude_proxy/settings.json` + `synthesizeProxySettings`），是一块独立工作。
- 阶段 4 的核心是"配置编辑页迁移"（webviewEditor 的 CRUD + 别名编辑），先把编辑能力迁过来。
- "激活"留后续阶段（阶段 4.5 或独立任务）——它需要独立形态的 proxyHost HTTP 客户端 + 复用 claudeLauncher 的 resolveSettingsContent/ensureProjectPermissions/ensureGitignore/writeSettings 纯 fs 逻辑。

所以阶段 4 产出：
- local config CRUD API（management API 加路由，复用 LocalConfigStore）
- 配置编辑网页（name/mode/content textarea + derived 别名编辑）
- derived 节点创建（next-id + 别名初始化，复用 derivedLogic 纯函数 + proxy /api/model-alias/next-id）
- 不做激活（不写 settings.json、不注入 upstream、不 spawn CLI 用该配置）

### derived 节点创建流程

VS Code 形态 `openNewDerived`：
1. `loadGlobalConfigs()` + `localStore.load()` → `aggregateModelCatalog`（模型清单，供 datalist）
2. `snapshotFromParent(parent)` → 提取父 upstream 快照
3. `inheritAliasesFromParent(parent.content)` → 继承父别名
4. `inheritSessionContext1m(parent.content)` → 继承父 1m 档位
5. `newId()` → 派生节点 id
6. `derivedIndex` 由调用方（extension.ts 的 newDerivedConfig 命令）从 `proxyHost.nextAliasId()` 取
7. 保存时 `localStore.upsert(cfg)`

独立形态复刻：`aggregateModelCatalog`/`inheritAliasesFromParent`/`inheritSessionContext1m`/`aliasName` 都是 derivedLogic 纯函数（零 vscode，可复用）。`nextAliasId` 调 proxy `GET /api/model-alias/next-id`。`snapshotFromParent` 用 `extractUpstream`（纯函数）。

### content 编辑器形态

textarea（与 webviewEditor 一致），前端 JSON.parse 校验。derived 的 content 只读。

### 别名编辑即时生效

VS Code 形态 setAlias 调 proxyHost.setModelAlias（HTTP `/api/model-alias`）。独立形态直接 fetch proxy 的 `/api/model-alias`（proxy 端口）。但 management API 在 management 端口（proxy+100），跨端口 fetch——要么 management API 代理转发到 proxy，要么前端直接 fetch proxy 端口。

**决策：management API 加转发路由** `/api/workspaces/:id/configs/:cfgId/alias`（POST），management 内部用 HTTP 调 proxy 的 `/api/model-alias`。这样前端只连 management 端口，不跨端口。但 management 需要知道 proxy 端口——`launchStandalone` 已传 proxyPort 给 management。

或者更简单：**前端直接 fetch proxy 端口**（`http://127.0.0.1:<proxyPort>/api/model-alias`）。proxy 已开 CORS？看 proxy/server.js 有没有 CORS。若没 CORS，前端跨端口 fetch 被拦。

权衡后：**management API 加转发路由**，更干净（前端单端口、不依赖 proxy CORS）。

## 产物

1. `standalone/managementServer.js` 加路由：
   - `GET /api/workspaces/:id/configs` → 列 local configs（阶段 2 已有？确认）
   - `POST /api/workspaces/:id/configs` → 新建 local config
   - `PUT /api/workspaces/:id/configs/:cfgId` → 更新
   - `DELETE /api/workspaces/:id/configs/:cfgId` → 删除
   - `POST /api/workspaces/:id/configs/:cfgId/alias` → 转发到 proxy `/api/model-alias`（即时生效）
   - `GET /api/workspaces/:id/model-catalog` → 聚合模型清单（复用 aggregateModelCatalog）
   - `GET /api/workspaces/:id/next-alias-id` → 转发 proxy `/api/model-alias/next-id`
   - `GET /workspace/:id/configs/:cfgId/edit` → 配置编辑网页 HTML
2. `standalone/web/config-editor-html.js` → buildConfigEditorHtml（name/mode/content textarea + derived 别名四档 + 1m checkbox）
3. 复用 derivedLogic 纯函数（从 out/ 加载）

## 正交维度

### D1 local config CRUD

- D1a：新建 config（name/mode/content）→ 201 + 存入 local-configs.json
- D1b：更新 config（含 derived 字段保留）→ 200
- D1c：删除 config → 200
- D1d：新建 name 缺失 → 400
- D1e：content 非法 JSON（非 derived）→ 400
- D1f：workspace 不存在 → 404
- D1g：config 不存在 → 404

### D2 derived 节点创建

- D2a：创建 derived（含 derivedFrom/derivedIndex/modelAliases/snapshot）→ 201
- D2b：derivedIndex 从 proxy next-id 取
- D2c：modelAliases 继承父
- D2d：snapshot 从父 content 提取
- D2e：父 content 无效 → snapshot=undefined（仍创建，警告）

### D3 别名编辑（即时生效）

- D3a：POST alias → 转发 proxy /api/model-alias → 即时生效
- D3b：删除别名 → 转发 proxy /api/model-alias/delete
- D3c：management 转发失败（proxy 挂）→ 502

### D4 模型清单

- D4a：GET model-catalog → 聚合 local configs 的模型名
- D4b：无 config → 空清单

### D5 配置编辑网页

- D5a：GET 编辑页 → HTML 含 name/mode/content textarea
- D5b：derived 编辑页 → 含别名四档 + 1m checkbox，content 只读
- D5c：前端 JSON 校验（content 非法时禁用 save）

### D6 content 编辑

- D6a：content textarea 编辑 + 保存
- D6b：derived content 只读
- D6c：mode direct/proxy 单选

## 高风险维度对照

| 高险类别 | 适用维度 | 说明 |
|---|---|---|
| 状态转换 | D1, D2 | config 创建/更新/删除 |
| 异常/错误路径 | D1d/e/f/g, D2e, D3c | 校验/不存在/转发失败 |
| 时序/竞态 | D3a | 别名即时生效 + 本地缓存同步 |
| 空/null/初始态 | D1d, D4b | 空 name、空清单 |
| 幂等性 | D1b | 重复 upsert 同 id |
| 边界输入 | D1e, D2e | content JSON、父 content 无效 |

## 用例选取（Step 3 依据）

- D1a-g：local config CRUD 各路径
- D2a-e：derived 创建各情况
- D3a-c：别名转发
- D4a-b：模型清单
- D5a-c：编辑网页
- D6a-c：content 编辑

## 范围说明

阶段 4 不做"激活"（写 settings.json + 注入 upstream + spawn CLI 用该配置）。只做 config CRUD + 编辑网页 + 别名即时生效。激活留后续。
