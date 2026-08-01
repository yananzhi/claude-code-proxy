# Changelog

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
