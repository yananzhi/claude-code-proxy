# Model Aliasing 硬约束

> 本文档记录调研发现的 Claude Code CLI 行为不可逾越的限制。这些是**物理约束**，不是设计选择——以后任何 model aliasing 相关改动都必须在这些边界内。每条约束附调研来源（源码文件:行号或官方文档）。
>
> 调研对象：`D:\work_dir\Claude_Code-_Source_Code` + 官方文档 `code.claude.com/docs/en/model-config`、`env-vars`。
> 主方案文档：`docs/claude code cli运行时model切换方案.md`（§5.3/§5.4/§6.9.1/§6.13/§6.14）。

---

## 1. CLI 模型配置三层分离

Claude Code CLI 的模型配置有三套独立机制，作用域严格分离：

| 机制 | 作用 | 改的对象 | 运行时切换当前 session？ |
|---|---|---|---|
| `ANTHROPIC_MODEL` env | 启动输入源（主模型） | env | ❌ session 内冻结 |
| `/model <name>` 命令 | 运行时 session 级切换 | `Session.model`（内部状态，不改 env、不写 settings） | ✅ 立即生效 |
| `ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL` | alias 解析输入源（控制 `/model sonnet/haiku/opus` 解析到啥） | env | ❌ session 内冻结 |

优先级：`/model`（运行时） > `--model`（启动参数） > `ANTHROPIC_MODEL`（env） > `settings.model`。

**来源**：官方文档 `code.claude.com/docs/en/model-config`；源码 `commands/model/model.tsx:198-203`、`utils/model/model.ts:92-98`。

**约束**：三套机制独立。代理只能动第三层（`DEFAULT_*`）+ 请求层改写；`/model` 不可控、用了就脱离别名体系。`ANTHROPIC_MODEL` env 启动后 session 内冻结（见约束 4）。

---

## 2. CLI 请求层 vs 决策层分离（contextWindow 脱节根因）

CLI 内部有两条分离的链路：

- **请求层**：`body.model = normalizeModelStringForAPI(mainLoopModel)`，发往上游。代理在这里换 model。
- **决策层**（contextWindow / autocompact / token 计数 / StatusLine）：直接用 `toolUseContext.options.mainLoopModel`（CLI 内部状态 = 别名），**完全不读请求 body 的 model 字段**。

代理在请求层换 model → 只影响发往上游的请求，**对 CLI 内部 contextWindow 计算零影响**。CLI 永远拿别名算 contextWindow（`getContextWindowForModel` 无 memoize、每次现算，入参是别名）。

**来源**：源码 `services/compact/autoCompact.ts:267`、`utils/context.ts:51-98`、`query.ts:572-578,639,670`、`services/api/claude.ts:1700`。

**约束**：运行时切模型只能在**同 contextWindow 档位内**安全（200K↔200K、1M↔1M）；跨档位（200K↔1M）切会脱节——CLI 按旧档位算、上游却是新档位模型。跨档位切只能靠通用警告让用户担责（见约束 3）。

---

## 3. `[1m]` 后缀是 CLI 识别 contextWindow 档位的唯一信号

`getContextWindowForModel` 第一道判断就是 `has1mContext(model)`——**看 model 字符串里有没有 `[1m]` 字面量**（`/\[1m\]/i`）：

- 带后缀（如 `ccp-main-1[1m]`）→ CLI 按 1M 算。
- 不带（如 `ccp-main-1`）→ CLI 按 200K 算（默认）。

CLI 发请求时 `normalizeModelStringForAPI` 会**剥掉 `[1m]` 后缀**（`model.replace(/\[(1|2)m\]/gi, '')`）→ 代理收到的别名**不带后缀**。

**来源**：源码 `utils/context.ts:35-40,69-72`、`utils/model/model.ts:616-618`。

**约束**：
- 别名带不带 `[1m]` 由用户在派生节点配置时选（决定 CLI 按 1M 还是 200K 算），默认从父继承。
- 代理映射表 key **一律不带 `[1m]`**（rewriteModel 已剥后缀查表，实现见 `proxy/config-store.js rewriteModel`）。
- 代理侧看不到档位信息（被 CLI 剥了），**没法精确判断跨档位** → 跨档位切只能弹通用警告，让用户自己判断。
- `[500k]`/`[2m]` 等其他后缀 CLI 不识别（只认 `[1m]`），会被当字面量。

---

## 4. settings.env 运行时重读不换当前 session 主模型

CLI 用 chokidar 监听 settings.json，文件变更会清缓存重读。但：

- 主模型 `ANTHROPIC_MODEL` 在 session 初始化时 resolve 后**冻结**，运行中改 settings.env 不会换当前 session 主模型。
- 改了只对**下次新 session** 生效。
- env 字段语义是"启动时注入、每个 session 应用"（官方文档原话 before launching / apply to every session），非运行时热注入。

**来源**：官方文档 `code.claude.com/docs/en/env-vars`；实测确认（场景 3：运行中改 settings.env 的 ANTHROPIC_MODEL → CLI 后续请求 model 不变）；源码 `state/onChangeAppState.ts:163`（additive-only 注释）。

**约束**：别指望改 settings.env 热切主模型；模型切换只能靠代理映射表（请求层改写），不能靠 settings.env 热重载。

---

## 5. 扩展宿主 http 栈对本地响应 body 单向吞没（空 body 真因）

**⚠ 是 http 栈本身在 VS Code 扩展宿主（Electron）里的行为**：`http.get`/`http.request`/`fetch` 对发往 `127.0.0.1` 的响应**不投递 `data` 事件**——直接 `end`，客户端拿 `status 200` + **空 body**（`rawLen=0`）。请求 body 不吞（上行正常），只有响应 body 被吞（单向）。命令行 `node -e`/`curl` 的 http 客户端正常，所以只在扩展宿主复现、极难定位。

**与以下均无关（均已诊断排除，别再往这些方向猜）**：
- ❌ 不是 `@vscode/proxy-agent`（系统 HTTP_PROXY/HTTPS_PROXY 全 unset、NO_PROXY 兜底无效、proxy-agent 无劫持条件）。
- ❌ 不是 `Transfer-Encoding: chunked`（服务端加 `Content-Length` 改发完整 body，扩展宿主 http 栈**仍吞 body**）。
- ❌ 不是服务端没发 body（裸 socket 拿到完整 body）。
- ❌ 不是某个接口特殊（GET / POST 响应都被吞）。

诊断证据（2026-08-01，多轮探针，系统 HTTP_PROXY/HTTPS_PROXY 全 unset）：
- `http.get /api/config` → status=200, rawLen=0（被吞）。
- 裸 `net` socket GET 同路径 → rawBytesLen=516, dechunk 后 decodedLen=508（服务端 body 完整，是客户端吞的）。
- 服务端 `sendJson` 加 `Content-Length` 后（不再 chunked）→ `http.get` 仍 rawLen=0（chunked 不是元凶）。
- `http.request POST` 设映射 → 响应 rawLen=0（被吞），但裸 socket 读回含该映射 → POST 请求 body 没被吞，"假成功"=请求送达但响应读不到。

**来源**：实测（诊断命令 `claude-code-proxy.diagProxyHttp` 多轮探针）；CLAUDE.md 有详细记录。

**约束**：扩展宿主侧调本地代理接口**一律用裸 `net` socket**（`src/proxyHost.ts rawHttp(method, path, body?)` 统一封装：`net.connect` + 手写 HTTP 请求行 + 手动解析响应，含 chunked 解码 `dechunk` 兼容）。绕过扩展宿主 http 栈，稳定拿 body。所有 wrapper（`getModelAliases`/`setModelAlias`/`removeModelAlias`/`setUpstream`/`kill`/`nextAliasId`/`healthz`）全走裸 socket。新增 wrapper 照 `rawHttp` 模式写，不用 `http.get`/`http.request`/`fetch`。代理侧 `res.end` 出口仍配 `Content-Length`（对非扩展宿主如 web UI 浏览器、命令行更规范，对扩展宿主虽无效但无害）。

---

## 6. `/model` 脱离代理/扩展侧感知不到

`/model` 是 CLI 内部命令，改 `Session.model`：

- 无 API 通知扩展侧。
- 用户用了 `/model`，请求 model 字段脱离别名（变成 `/model` 指定的值）→ 代理认不出 → 替换失效。
- 扩展侧编辑页、代理侧都**无法运行时检测**用户何时用了 `/model`。

**来源**：源码 `commands/model/model.tsx:198-203`（改 AppState.mainLoopModel，无外部通知）；官方文档 `/model` 仅当前 session、不写 settings。

**约束**：不能运行时检测 `/model` 脱离并弹警告。只能在编辑页**静态 hover 提示**风险："此映射仅当主对话未用 `/model` 切换时生效。若在 CLI 内用 `/model` 改了模型，请求将脱离本别名，代理替换规则对主对话不再生效（子 agent 三档仍受控）。"

---

## 7. 子 agent 档位别名稳定可追踪

子 agent 走 `ANTHROPIC_DEFAULT_*_MODEL`（档位别名）：

- 子 agent 不认 `/model`（`/model` 只切主对话）。
- 代理能稳定识别 `ccp-haiku-N`/`ccp-sonnet-N`/`ccp-opus-N`，按 N 追踪会话。

**来源**：源码 `utils/model/model.ts:445-506`（`parseUserSpecifiedModel` 的 alias 分支）；官方文档 `ANTHROPIC_DEFAULT_*` 控制 alias 解析。

**约束**：追踪主要靠子 agent 三档别名的 N；主模型别名（`ccp-main-N`）追踪会被 `/model` 破坏（用户一用 `/model` 就脱离）。trace 已记 `model`（原始别名）+ `resolvedModel`（映射后真实模型），按 N 解析可关联会话。

---

## 约束汇总（快速查表）

| 约束 | 后果 | 应对 |
|---|---|---|
| 1 三层分离 | `/model` 不可控 | 只动 `DEFAULT_*` + 请求层；`/model` 用了就脱离 |
| 2 请求/决策层分离 | 代理换 model → CLI contextWindow 不变 | 同档位内切安全；跨档位弹警告 |
| 3 `[1m]` 唯一档位信号 | 代理侧看不到档位（被剥） | 别名带不带 `[1m]` 用户选；代理 key 不带后缀；跨档位通用警告 |
| 4 settings.env 不热切主模型 | 改 env 当前 session 不变 | 切换靠代理映射表，不靠 env 热重载 |
| 5 扩展宿主 http 栈单向吞响应 body | 扩展宿主 http.get 拿空 body（与 proxy-agent/chunked/Content-Length 均无关） | 扩展侧调代理一律用裸 `net` socket（`rawHttp`）；代理侧 `res.end` 仍配 `Content-Length`（为非扩展宿主） |
| 6 `/model` 感知不到 | 运行时检测不到脱离 | 编辑页静态 hover 提示 |
| 7 子 agent 别名稳定 | 可追踪 | 追踪靠三档别名 N |
