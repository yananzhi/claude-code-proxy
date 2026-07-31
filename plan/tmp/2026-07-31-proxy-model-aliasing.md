# 代理层 model aliasing 正交设计

> 任务：给代理加 model 别名映射表 + rewriteModel 请求体改写 + 热更新接口 + nextAliasId 计数器。
> 落点：`proxy/config-store.js`（映射表存储 + 热更新）、`proxy/server.js`（rewriteModel + 接口）、`proxy/trace-store.js`（resolvedModel 字段）。
> 主方案依据：`docs/claude code cli运行时model切换方案.md` §6.4 / §6.9.1 / §6.10。

## 落点对照（已核实）

| 改什么 | 文件:位置 | 照抄模板 |
|---|---|---|
| `config.modelAliases` 字段 + `config.nextAliasId` | `config-store.js`（DEFAULTS/DEFAULT_PROXY_CONFIG 旁） | 新增字段 |
| `getModelAliases()` / `updateModelAlias` / `removeModelAlias` / `nextAliasId()` | `config-store.js` L87 后（紧跟 updateEffort） | updateEffort |
| init 读取 + 启动校正 | `config-store.js:36-45` init | 新增 init 时读 + 校正 |
| getView 加 modelAliases | `config-store.js:110-133` getView | 扩展返回 |
| `rewriteModel(body, aliases, reqId, contentType)` | `server.js` L99 后（紧跟 rewriteEffort） | rewriteEffort |
| 调用 rewriteModel | `server.js` L568-570 outBody 链 | 紧跟 rewriteEffort |
| `POST /api/model-alias` | `server.js` L397 后（紧跟 /api/effort） | /api/effort |
| `POST /api/model-alias/delete` | 同上 | 同上 |
| `GET /api/model-alias/next-id` | 同上 | 同上 |

## 正交维度

### D1：映射表 CRUD
- D1a 初始空表（无配置文件 / 老配置无 modelAliases 字段）→ `getModelAliases()` 返 `{}`
- D1b `updateModelAlias(alias, model)` 加一条 → 表里多一项 + persist 落盘
- D1c `updateModelAlias` 改已存在别名（同 alias 不同 model）→ 覆盖旧值
- D1d `removeModelAlias(alias)` 删一条 → 表里少该项 + persist
- D1e `removeModelAlias` 删不存在的 alias → 无害（幂等）

### D2：rewriteModel 命中行为
- D2a model 命中别名 → 替换为真实模型名
- D2b model 不命中别名（白名单外）→ 原样透传不改
- D2c model 带 `[1m]` 后缀（如 `ccp-sonnet-1[1m]`）→ 剥离 `[1m]` 后查表、命中则替换 base，不带后缀发上游
- D2d model 带 `[1m]` 但 base 不命中 → 原样透传（保留 `[1m]`？还是剥离？——照 §6.9.1 "rewriteModel 需先剥离 [1m] 再查表"，不命中则原样透传含后缀，让上游处理）
- D2e 空 model（`""`）→ 不改
- D2f model 字段缺失（undefined）→ 不改
- D2g 非 JSON body / 非 object → 原样返回

### D3：rewriteModel 与 rewriteEffort 串联
- D3a 同一请求 effort 命中 + model 命中 → 两次改写都生效（最终 body 含改 effort + 改 model）
- D3b effort 不命中（无 output_config.effort）+ model 命中 → 只改 model
- D3c effort 命中 + model 不命中 → 只改 effort
- D3d 两者都不命中 → body 不变（`rewritten` 标志反映）

### D4：rewriteModel 不受 isMessagesMain 守卫
- D4a `/v1/messages` 主路径请求 model 命中 → 替换
- D4b `/v1/messages/count_tokens` 子路径请求 model 命中 → **也替换**（rewriteModel 不加 isMessagesMain 守卫，区别于 rewriteEffort）
- D4c 其它路径（非 /v1/messages）model 命中 → 也替换（白名单式，只要 JSON body 含 model 命中就换）

### D5：trace 记录
- D5a `reqModel`（trace 现有字段）保留**原始别名**（改写前）
- D5b 新增 `resolvedModel` 字段记替换后真实模型（改写后）
- D5c model 不命中时 `resolvedModel` = `reqModel`（原样）

### D6：热更新接口
- D6a `POST /api/model-alias` body `{alias, model}` → 200 + `{ok, alias, model}`，下个请求生效
- D6b `POST /api/model-alias/delete` body `{alias}` → 200 + `{ok}`，下个请求生效
- D6c `GET /api/model-alias/next-id` → 200 + `{id: N}`，N 递增
- D6d `POST /api/model-alias` 缺字段 → 400
- D6e `GET /api/config`（现有）→ 视图含 `modelAliases` 字段

### D7：nextAliasId 计数器持久化 + 启动校正
- D7a 老配置无 `nextAliasId` → init 兜底 0
- D7b `nextAliasId()` → `++` + persist，返回新值
- D7c 启动校正：init 后扫 `modelAliases` key 的 max 别名号，若 ≥ nextAliasId 抬到 max+1
- D7d 空表 → 校正后 nextAliasId=0（或 1，取决于起点）

### D8：persist 持久化
- D8a updateModelAlias 后 persist → proxy-config.json 含 modelAliases
- D8b removeModelAlias 后 persist → 表少一项
- D8c nextAliasId 后 persist → 计数器落盘
- D8d 写盘失败 → 不阻断内存（照现有 persist 容错）

## 高风险维度（必须覆盖边界）

- **state transitions**：D1c 覆盖、D1e 删不存在（幂等边界）
- **exception/error paths**：D2g 非 JSON、D6d 缺字段、D8d 写盘失败
- **empty/null/initial**：D1a 空表、D2e 空 model、D2f model 缺失、D7a 老配置无字段
- **idempotency**：D1e 删不存在的 alias、D6c 连续 next-id（不幂等，每次 +1，验证递增）
- **boundary inputs**：D2c/d 带 `[1m]` 后缀的边界、D4b count_tokens 子路径

## 维度 × 用例覆盖矩阵

| 维度 | 用例 |
|---|---|
| D1a | 空表getModelAliases返{} |
| D1b | updateModelAlias 加一条 |
| D1c | updateModelAlias 覆盖旧值 |
| D1d | removeModelAlias 删一条 |
| D1e | removeModelAlias 删不存在（幂等） |
| D2a | rewriteModel 命中替换 |
| D2b | rewriteModel 不命中原样透传 |
| D2c | 带[1m]命中：剥离后查表替换base |
| D2d | 带[1m]不命中：原样透传含[1m] |
| D2e | 空model不改 |
| D2f | model缺失不改 |
| D2g | 非JSON body原样返回 |
| D3a | effort+model都命中串联 |
| D3b | effort不命中+model命中 |
| D3c | effort命中+model不命中 |
| D3d | 都不命中body不变 |
| D4a | /v1/messages主路径替换 |
| D4b | count_tokens子路径也替换 |
| D5a | reqModel保留原始别名 |
| D5b | resolvedModel记真实模型 |
| D5c | 不命中resolvedModel=reqModel |
| D6a | POST /api/model-alias 200 |
| D6b | POST /api/model-alias/delete 200 |
| D6c | GET /api/model-alias/next-id 递增 |
| D6d | POST缺字段400 |
| D6e | GET /api/config含modelAliases |
| D7a | 老配置无nextAliasId兜底0 |
| D7b | nextAliasId递增 |
| D7c | 启动校正抬到max+1 |
| D8a | updateModelAlias后persist落盘 |

约 30 条用例，覆盖 8 维度 + 5 高风险类。
