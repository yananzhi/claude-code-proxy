# Changelog

## 1.3.0

### 派生节点每档独立 1m 上下文（per-tier contextWindow）

派生节点的"会话档位（200K/1M）"从**整个配置一个开关**改成**每个档位独立**——main、haiku、sonnet、opus 各自有自己的 200K/1M 选择，别名后缀按各档独立带 `[1m]`。

- **每档独立 1M checkbox**：派生编辑器的模型映射区，每个档位那一行各有一个"1M"checkbox。勾选的档别名带 `[1m]` 后缀（CLI 按 1M 算 contextWindow），不勾的档标准 200K。原先的全局"会话档位"radio 移除。
- **数据结构**：`sessionContext1m` 从单布尔改成 `{ main?, haiku?, sonnet?, opus? }`（`PerTier1m`）。
- **向后兼容**：老派生节点的 `sessionContext1m: true/false`（布尔）自动迁移成四档同值（`normalizeSessionContext1m`）。
- **默认继承**：新建派生节点时四档默认都从父 `ANTHROPIC_MODEL` 是否带 `[1m]` 继承。
- **代理侧无改动**：别名 key 带不带 `[1m]` 由扩展侧决定，代理 `rewriteModel` 仍剥后缀查表（映射 key 永远不带后缀）。
- 改某档 1m 需重启 CLI 生效（别名后缀变了）；改映射值即时生效。
- **测试**：derived-logic 加 PT 系列 per-tier 单测 + normalizeSessionContext1m 用例；更新 M/R 系列（inherit 返对象）。

## 1.2.1

### 可配置重试规则（HTTP 状态码 + body code 组合）+ 修复 retryOnStatus 失效 bug

把原先写死的"503 + 10310"重试规则提成**用户可配置的组合规则**，并修复一个 latent bug。

- **组合规则模型**：每条规则 = `{ status, code }`。`status` 填 HTTP 状态码或 `*`（任意状态码通配）；`code` 填 body `error.code` 数字或 `all`（任意 body code，响应头一到即决断重试，不等 body）。默认 `503+10310` / `200+10310`（等价原写死行为）。用户可在 Web 控制台自加如 `429+11210`（讯飞网关 authorization failed）或 `503+all`（所有 503 都重试）。
- **修复 retryOnStatus 被流式提前吞掉的 bug**：旧架构 `retryOnStatus`（看状态码）和 `retryOnBodyErrorCode`（看 body code）是两条互不感知的路径，且 body-code 判定在 `writeHead` 之前、status 判定在 `writeHead` 之后——导致带可解析 body 的非 2xx 响应在首段就被流式交付客户端、`retryOnStatus` 永远走不到。用户配了 429 重试但不生效，正是此 bug。新架构统一成 retryRules，状态码判定（含 `all` 通配）在 `writeHead` 之前完成，非 2xx 规则不再被流式吞掉。
- **向后兼容**：老 config.json 的 `retryOnStatus` / `retryOnBodyErrorCode` 自动迁移成 retryRules（`retryOnStatus:[503]` → `{503, 'all'}`；`retryOnBodyErrorCode:[10310]` → `{'*', 10310}`）。
- **Web 控制台**：原"重试状态码"+"body 错误码"两个 chips 区合并成一个规则表（每行 状态码 + body code + 删除），"+ 添加规则"按钮加行。
- **mock 上游**：新增 `429-auth` 模式（429 + code 11210，复刻生产日志形态）。
- **测试**：config-store retryRules 单测（18 条）+ server-retry-rules e2e（15 条，覆盖默认规则 / 自定义规则 / all 通配 / `*` 通配 / 透传模式 / 空规则表 / maxAttempts=1）。

## 1.2.0

### 派生节点 + 运行时模型切换（主模型别名 alias）

新增"派生虚拟配置节点"：从一条 workspace-local 配置派生，给 Claude Code CLI 配固定假模型名（别名），代理在请求层实时把别名替换成真实模型——**不重启 CLI 就能切模型**。

- **四档别名映射**：Main（`ccp-main-N`，走 `ANTHROPIC_MODEL`，主对话）+ Haiku/Sonnet/Opus（`ccp-<tier>-N`，走 `ANTHROPIC_DEFAULT_*_MODEL`，子 agent alias）。
- **会话档位 `[1m]`**：派生节点选 1M 或标准 200K，别名按此带 `[1m]` 后缀，CLI 据此算 contextWindow。默认从父配置继承。
- **在线热改**：编辑页改任一档映射即时同步代理映射表，下个请求生效，无需重启 CLI、无需关闭面板。
- **跨档位警告**：改映射时弹通用警告（代理看不到档位，无法精确判断，让用户担责）。
- **`/model` 脱离提示**：main 档行 hover 静态提示——CLI 内用 `/model` 改的模型会脱离别名体系。
- **强制走代理**：别名只有经代理 `rewriteModel` 才会被重写为真实模型名；直连会 model not found。
- **父上游快照继承**：派生节点存父上游快照，防父删/改断链。

### 代理侧

- `rewriteModel`：剥 `[1m]` 后查映射表替换 `model` 字段，下个请求生效；trace 记 `model`（原始别名）+ `resolvedModel`（映射后真实模型）。
- `sendJson` 等所有 `res.end` 出口显式写 `Content-Length`（规范响应，对非扩展宿主客户端）。
- 配置层热重载 modelAliases 映射表 + nextAliasId 计数器（持久化 + 启动校正）。

### 修复

- **扩展宿主调代理接口全改裸 `net` socket**（`rawHttp` 统一封装）：诊断坐实 VS Code 扩展宿主 http 栈对 `127.0.0.1` 响应 body 单向吞没（`data` 事件不投递，与 proxy-agent/chunked/Content-Length 均无关）。`getModelAliases`/`setModelAlias`/`removeModelAlias`/`setUpstream`/`kill`/`nextAliasId`/`healthz` 全走裸 socket，绕过 http 栈。
- 派生节点重复渲染（local 分组过滤掉派生节点）。
- 派生编辑器连接模式 radio 不可点（派生 scope 强制 proxy，只显文字 + hidden input）。
- `rewriteModel` 误剥 `[2m]`（CLI 只认 `[1m]`，改 `/\[1m\]/gi`）。
- 配置层 init 对数组型 modelAliases 的 fallback。

### 测试

- 派生节点纯逻辑单测（derived-logic）+ 子代理 TDD 回归（37 条）。
- mock-cli 套件（CLI 配置加载层假设验证，source of truth 是 CLI 源码）。
- 代理 config-store-alias e2e（含 main 档回归）。
- 诊断命令 `LLM 代理: 诊断 proxy-agent 劫持`（回归工具，验证裸 socket 全链路 + http 栈对照）。

## 1.1.0

- 配置分两层：global（机器级）+ workspace-local（workspace 级）。
- 本地 LLM 代理（重试 503+10310，流式增量转发）。
- workspace 隔离 Claude CLI 会话（`CLAUDE_CONFIG_DIR`）。
- Web 控制台（重试参数 + trace）。
