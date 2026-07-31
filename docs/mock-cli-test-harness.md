# Mock CLI 测试套件设计

> 状态：设计草案。本套件为本工程测试框架的基础组件，不单独建工程。

---

## 1. 定位

Mock CLI 是 **Claude Code CLI 配置加载层的等价重实现**——把真 CLI（`D:\work_dir\Claude_Code-_Source_Code`）中"读 settings.json / 读 env / 重读 / 优先级 / model 解析 / contextWindow / autocompact"这块行为的**等价实现**，用我们能跑自动化测试的方式重写。

**source of truth 是真 CLI 的代码，不是我们的主方案设计文档**。mock 里固化的行为规则直接照搬真 CLI 源码调研结论；当两者冲突时，改主方案文档的假设，mock 不动（除非真 CLI 代码本身变了）。mock 是"真 CLI 行为的可执行镜像"，不是"我们愿望的可执行镜像"。

## 2. 解决的痛点

真 CLI 是黑盒：怎么读 settings、何时重读、env 优先级、`[1m]` 解析——这些是主方案赖以成立的前提（§5.3-5.4、§6.9.1），但只能人肉启会话验证，没法进自动化测试。每改一个假设都要人跑一遍，成本高、易回归。

Mock CLI 把这些前提**固化成可执行代码**，让依赖它们的逻辑（launcher 派生节点、代理 rewriteModel、别名格式）能跑自动化用例。同时是"我们对 CLI 行为理解"的可执行文档——一旦真 CLI 行为跟 mock 跑出的不符，说明假设错了。

## 3. 边界

### 做到的行为（照搬真 CLI）

| 行为 | 真 CLI 来源 | mock 等价实现 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` 解析配置目录 | `utils/envUtils.ts:7-14` `getClaudeConfigHomeDir` | 同：`process.env.CLAUDE_CONFIG_DIR ?? ~/.claude` |
| settings.json 读取 + 三层缓存 | `utils/settings/settingsCache.ts` + `settings.ts:getSettingsWithErrors` | 同：缓存 + 缓存 miss 从磁盘读 |
| chokidar 文件监听 + 清缓存 | `utils/settings/changeDetector.ts` | 同：监听 settings 文件变更 → 清缓存 → 重读 |
| `applyConfigEnvironmentVariables` | `utils/managedEnv.ts:187-199` | 同：`Object.assign(process.env, filterSettingsEnv(settings.env))` 覆盖式 |
| env additive-only（可加/可覆盖/不可删） | `onChangeAppState.ts:163` 注释 | 同：Object.assign 语义，删 settings.env 不删 process.env |
| `parseUserSpecifiedModel` | `utils/model/model.ts:445-506` | 同：alias 分支 + `[1m]` 剥离/拼回 + 保留词避让 |
| `has1mContext` | `utils/context.ts:35-40` | 同：`/\[1m\]/i` 检测 |
| `getContextWindowForModel` | `utils/context.ts:51-98` | 同：`[1m]`→1,000,000，否则 200,000 |
| `getEffectiveContextWindowSize` | `services/compact/autoCompact.ts:33-49` | 同：`min(contextWindow, AUTO_COMPACT_WINDOW) - maxOutputTokens` |
| `getAutoCompactThreshold` | `autoCompact.ts:72-91` | 同：有效窗口 - 13000 |
| `normalizeModelStringForAPI` | `utils/model/model.ts:616-618` | 同：剥离 `[(1|2)m]` |
| getAllModelBetas memoize | `utils/betas.ts:234,371` | 同：按 model 字符串 memoize |

### 不做的

- CLI 的 TUI / 交互式对话 / 工具调用 / 推理。
- 完整的 settings schema 校验（只做我们依赖的字段）。
- 真实 LLM 通信（当前阶段；预留接口，见 §6）。

## 4. 双面设计

Mock CLI 一身两职：

### 4.1 像 CLI 的那一面

- 读 `CLAUDE_CONFIG_DIR` 下的 settings.json。
- 读 process.env（启动快照）。
- 监听 settings 文件变更、重读、apply env。
- resolve model（含 `[1m]` 解析、alias 保留词）。
- 算 contextWindow、autocompact 阈值。
- **能发请求**（预留，见 §6）：把 resolved model + beta header 发到指定 `ANTHROPIC_BASE_URL`。

### 4.2 测试探针的那一面

**后台开个 HTTP 端口**，暴露内部状态供测试断言。这是关键——测试不只看 stdout，能从外部查 mock 内部状态：

| 探针 API | 用途 |
|---|---|
| `GET /probe/model` | 当前 resolved model（含/不含 `[1m]`） |
| `GET /probe/base-model` | 剥离 `[1m]` 后的 base |
| `GET /probe/context-window` | 当前 contextWindow（1M / 200K） |
| `GET /probe/autocompact-threshold` | 当前 autocompact 触发阈值 |
| `GET /probe/env/:key` | process.env 某 key 当前值（验证 env 注入/冻结/覆盖） |
| `GET /probe/settings-cache` | settings 缓存状态（命中/已清/重读次数） |
| `GET /probe/betas` | 当前 model 的 beta headers（验证 1M beta 是否带） |
| `POST /probe/simulate-file-change` | 模拟 settings.json 被外部改写（触发 chokidar 重读链路） |
| `POST /probe/simulate-request` | 触发一次"发请求"（resolved model → ANTHROPIC_BASE_URL，预留端到端） |

探针端口监听 `127.0.0.1:<随机/配置端口>`，避免抢代理端口。

## 5. 技术栈

- **Node + TypeScript（ESM）**：跟本工程 `src/`（TS）+ `proxy/`（ESM JS）风格对齐。
- **测试框架**：`node:test` + `node:assert`，跟现有 `proxy/test/*.test.mjs` 一致。
- **文件监听**：`chokidar`（跟真 CLI 同库，行为等价）。
- **HTTP**：Node 内置 `http`（探针端口 + 预留发请求）。

## 6. 与代理交互的预留

当前阶段只做"配置解析 + 探针"。但架构上预留端到端：

- `POST /probe/simulate-request` 触发时，mock 把 resolved model（`normalizeModelStringForAPI` 处理后）、beta headers、`ANTHROPIC_BASE_URL` 组装成 Anthropic API 请求，发到 `ANTHROPIC_BASE_URL` 指向的地址。
- 若该地址指向本工程代理（`127.0.0.1:<proxyPort>`），则形成 **mock CLI → 代理 → 上游** 的端到端测试链路，能验证代理的 `rewriteModel`（别名替换）、`rewriteEffort` 串联、trace 记录等。
- 这一层当前只占位（接口在、实现 TODO），不阻塞主套件落地。

## 7. 模块划分

```
test/mock-cli/
  src/
    configHome.ts        # getClaudeConfigHomeDir 等价
    settingsReader.ts    # settings.json 读取 + 三层缓存
    settingsWatcher.ts   # chokidar 监听 + 清缓存
    envApplier.ts        # applyConfigEnvironmentVariables + additive-only
    modelResolver.ts     # parseUserSpecifiedModel + has1mContext + 保留词避让
    contextWindow.ts     # getContextWindowForModel + getEffectiveContextWindowSize + threshold
    betas.ts             # getAllModelBetas memoize + 1M beta header
    requestSender.ts    # 预留：发请求到 ANTHROPIC_BASE_URL
    probeServer.ts       # 探针 HTTP 端口
    index.ts             # 组装 + 启动
  test/
    *.test.mjs           # node:test 用例
```

## 8. 测试用例骨架（对应主方案假设）

每个用例 = 启 mock CLI（指定 configDir/env）+ 探针断言。这些用例**直接验证主方案前提**：

| 用例 | 验证的主方案假设 | 探针断言 |
|---|---|---|
| shell env 别名冻结 | §5.4 TODO-1 | 注入 `ANTHROPIC_DEFAULT_SONNET_MODEL=ccp-sonnet-test1`（settings.env 不含）→ `/probe/env` 恒为 `ccp-sonnet-test1` |
| settings.env 不覆盖 shell 别名 | §5.4 TODO-2 | 运行中往 settings.env 加同名 key → `/probe/env` 仍是 shell 值（settings.env 覆盖了？应被覆盖——等等，见下） |
| additive-only 删不掉 | §5.4 TODO-3 | settings.env 删某 key → `/probe/env` 保留旧值 |
| `[1m]` 解析 | §6.9.1 | model=`ccp-sonnet-1[1m]` → `/probe/base-model`=`ccp-sonnet-1`、`/probe/context-window`=1,000,000、`/probe/betas` 含 1M |
| 无 `[1m]` 默认 200K | §6.9.1 | model=`ccp-sonnet-1` → context-window=200,000、betas 不含 1M |
| `AUTO_COMPACT_WINDOW` 钳制 | §6.9.1 | `[1m]` + window=600000 → threshold≈580,000；无 `[1m]` + window=600000 → threshold≈187,000 |
| 保留词避让 | §6.9.1 | alias=`sonnet`（撞保留词）→ 解析走 alias 分支，`[1m]` 拼到 default；`ccp-sonnet-1` 不撞 → 透传 |
| settings 重读生效 | §5.3 结论A | `/probe/simulate-file-change` 改 settings.env → `/probe/env` 变（重读链路通） |

> 注：§5.4 TODO-2 的"settings.env 加同名 key 是否覆盖 shell"——调研结论 B 说是覆盖（Object.assign 后写者赢）。但 §5.4 的别名冻结前提是"settings.env **不含同名 key**"才不覆盖。这两条要分清：别名走 shell env、settings.env 不含别名同名 key 时，别名不被覆盖。用例要精确构造这个前提，不能笼统说"settings.env 不覆盖 shell"。mock 能帮我们把这条测得毫不含糊。

## 9. 与主方案文档的关系

- mock 实现依据 = 主方案 §5.3/§5.4/§6.9.1 的调研结论（来源是真 CLI 代码）。
- mock 测试用例 = 主方案 §5.4 TODO 的人工验证项的**自动化版**——TODO-1/2/3 改由 mock 跑，不再全靠人肉。
- 若 mock 跑出与主方案假设不符 → 改主方案假设，mock 不动（除非真 CLI 代码变了需同步 mock）。
- mock 是主方案进入实现前的**第二道闸**（第一道是 §5.4 人工验证；mock 把人工验证固化成可回归自动化）。
