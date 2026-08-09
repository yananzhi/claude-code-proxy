# CLAUDE.md — claude-code-proxy

VS Code 扩展：管理 Claude Code 配置切换 + 本地 LLM 代理（可配置组合重试规则：HTTP 状态码 + body code）+ workspace 隔离 CLI 会话 + 运行时模型切换（派生节点 alias）。

## 关键陷阱（必读，避免重复踩坑）

### 扩展宿主调本地 HTTP 服务的空 body 坑（曾耗时数小时定位）

**⚠ 最关键认知（别再绕弯）**：**VS Code 扩展宿主（Electron）的 Node http 客户端，对发往 `127.0.0.1` 的响应 body 一律不投递 `data` 事件**——直接 `end`，客户端拿到 `status 200` + **空 body**（`rawLen=0`）。这是 **http 栈本身在扩展宿主里的行为**，与以下因素**均无关**（都已诊断排除，别再往这些方向猜）：
- ❌ 不是 `@vscode/proxy-agent` 劫持（系统 HTTP_PROXY/HTTPS_PROXY 全 unset、NO_PROXY 兜底无效、proxy-agent 无劫持条件）。
- ❌ 不是 `Transfer-Encoding: chunked`（服务端加 `Content-Length` 改发完整 body，扩展宿主 http 栈**仍吞 body**）。
- ❌ 不是服务端没发 body（裸 socket 拿到完整 body）。
- ❌ 不是某个接口特殊（GET / POST 响应都被吞）。

**是 http 栈本身在扩展宿主里的行为**——`http.get`/`http.request`/`fetch` 的响应 `data` 事件在扩展宿主内不投递。命令行 `node -e` / `curl` 的 http 客户端正常，所以只在扩展宿主内复现、极难定位。

**现象**：扩展侧 `http.get`/`http.request` 调本地代理（`127.0.0.1:<port>`），拿 `status 200` 但 body 为空（`rawLen=0`），`JSON.parse('')` 报 `Unexpected end of JSON input`。同样的 URL 用 `curl` 或命令行 `node -e` 拿到正常 body。

**诊断证据（2026-08-01，系统 HTTP_PROXY/HTTPS_PROXY 全 unset，多轮探针）**：
- `http.get GET /api/config` → status=200, rawLen=0（被吞）。
- 裸 `net` socket GET 同路径 → rawBytesLen=516, **dechunk 后 decodedLen=508**（服务端 body 完整，是客户端吞的）。
- 服务端 `sendJson` 加 `Content-Length` 后（不再 chunked）→ `http.get` 仍 rawLen=0（**chunked 不是元凶**，http 栈连 Content-Length 响应都吞）。
- `http.request POST` 设映射 → 响应 rawLen=0（被吞），但裸 socket 读回 `/api/config` 含该映射 → **POST 请求 body 没被吞，映射真写入了**（"假成功"=请求送达但响应读不到；只看 status 的 wrapper 功能上对，但容错为零）。
- `http.request POST` 响应也 rawLen=0 → **GET/POST 响应都被吞，请求 body 不吞（单向）**。

**结论**：扩展宿主 http 栈对本地响应 body 是单向吞没（请求上行正常、响应下行被吞）。proxy-agent 无关、chunked 无关、Content-Length 无关。

**修复方案（本工程已采用，治本）**：
1. **扩展侧调代理的 wrapper 一律用裸 `net` socket**（`src/proxyHost.ts` 的 `rawHttp(method, path, body?)` 统一封装：`net.connect` + 手写 HTTP 请求行 + 手动解析响应，含 chunked 解码 `dechunk` 兼容）。绕过扩展宿主 http 栈，稳定拿 body。`getModelAliases`/`setModelAlias`/`removeModelAlias`/`setUpstream`/`kill`/`nextAliasId`/`healthz` 全走 `rawHttp` 或裸 socket。
2. **`src/extension.ts` activate 最早注入 `NO_PROXY=127.0.0.1,localhost`**（双保险，防系统真开代理时 proxy-agent 干预请求行）。
3. **`proxy/server.js handleRequest` 用 `new URL(req.url, ...)` 规范化 urlPath**（防系统开代理时 proxy-agent 发绝对路径请求行致路由失配）。
4. **代理侧 `sendJson`/静态文件/502 响应仍显式写 `Content-Length`**——对扩展宿主无效（已证 http 栈连 Content-Length 都吞），但对**非扩展宿主**（web UI 浏览器 fetch、命令行）更规范，留着不亏。

**复现/定位手法**：
- 在扩展侧 `res.on('end')` 打印 `res.headers` + rawLen。`rawLen=0` 即 body 被吞。
- 裸 `net` socket GET 同路径 + `dechunk`：若 decodedLen>0 而扩展侧 http.get rawLen=0 → 确证服务端 body 完整、是扩展宿主 http 栈吞了。
- 一键诊断命令 `claude-code-proxy.diagProxyHttp`（命令面板搜"诊断 proxy-agent"）已内置此对照，直接跑看 output 面板。

**规则**：扩展宿主侧调本地代理接口**一律用裸 `net` socket**（`proxyHost.rawHttp`），不用 `http.get`/`http.request`/`fetch`。新增 wrapper 照 `rawHttp` 模式写。服务端 `res.end` 出口仍配 `Content-Length`（为非扩展宿主客户端）。

### workspace-local 终端走纯 env 注入（global 链路才走 settings.json）

**约束**：Claude Code 有两条独立的路由链路，注入方式不同——

1. **global 链路**（`extension.ts` 的 `doSwitch` + 官方 Claude Code 插件聊天框）：切换 global config 时 `doSwitch` 仍写**全局** `~/.claude/settings.json` 的 `env` 字段。**原因**：官方聊天框不在本扩展进程树里、拿不到本扩展注入的 shell env，只能读 `CLAUDE_CONFIG_DIR`（默认 `~/.claude/`）下的 settings.json。这条链路**保持写 settings.json，不动**。

2. **workspace-local 链路**（`claudeLauncher.ts` 的 `launch()`/`launchDerived()` + standalone 的 `terminalApi.js`）：**纯 shell env 注入**，**不写** `.claude_proxy/settings.json` 的路由 key（`ANTHROPIC_BASE_URL`/token/model 等）。**原因**：这些终端都由本扩展（或 standalone 后端）spawn，能拿 shell env，无需文件做路由；且不写路由 key 后，**插件终端与 standalone 终端可无缝共用同一 workspace 文件夹**——standalone 的冲突检测不再被插件遗留的路由 key 触发。`launch()` 用 `buildWorkspaceEnv(cfg)` 镜像 standalone `buildTerminalEnv` 的 normal 分支；`launchDerived()` 镜像 standalone derived 分支（四档别名 + BASE_URL/token 全走 env）。

派生节点的"冻结前提"（settings.env 不能含别名 key）自动满足——根本不写 settings.env。

**与 standalone 混用同一 workspace 的坑**：standalone 启动终端前检测 `.claude_proxy/settings.json` 的 `env` 是否含路由 key（`ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL`），**有则拒绝启动**（`standalone/terminalApi.js:85-106`，因 standalone 走 env 注入、认为 settings 同名 key 会覆盖 env 致路由错乱）。改后插件不再写路由 key，正常不触发；残留来源只剩"旧 activateConfig 残留 / 用户手动改过"，错误信息已提示哪个 key，让用户手动删。

**规则**：workspace-local 终端（插件 + standalone）路由 key **一律走 shell env**，不要写 `.claude_proxy/settings.json`。global 链路（`doSwitch` + 官方聊天框）保持写 `~/.claude/settings.json` 不动。standalone 的冲突检测也别放宽（放宽=容忍 settings 路由 key，会让 env 注入被 settings 覆盖、路由错乱）。

### 反引号模板字符串拼 JS：`\r`/`\n`/`\x..` 必须双反斜杠（终端页卡"正在连接"的元凶，已复发一次）

**⚠ 最关键认知（别再绕弯）**：`standalone/web/workspaces-html.js` 的 `buildTerminalHtml` 用**反引号模板字符串**拼整页 HTML，内含 `<script>` 块的 JS 代码。在这段模板里写 JS 字符串字面量或注释时，**任何 `\` 开头的转义序列（`\n` `\r` `\x16` `\t` 等）都会被 Node 在解析模板字符串时解释成真实控制字节**——`\n` 变成真实换行符、`\r` 变成真实 CR(0x0d)。这不是"传给浏览器的字面量"，是模板层的转义。

**坑（已踩 2 次，均耗时定位）**：
- **第 1 次**：代码 `term.paste('\n')` → 浏览器收到 `term.paste('` + 真实换行 + `')` → 单引号字符串内换行 → `SyntaxError: Invalid or unexpected token`。
- **第 2 次（修 Shift+Enter 时引入回归）**：注释 `// 转成 '\r' 经 onData 泄漏` → `\r` 被 Node 转成真实 CR(0x0d) 塞进注释行 → **CR 把 `//` 注释从中间断开**，断点后文字变裸代码 → 同样 SyntaxError。**用户当场指出"这不就是刚修过的 bug 吗"**——memory 已记 `\r` 在注释里也危险，写注释提到字节序列时仍要警惕。

**现象**：整个 `<script>` 块因语法错误中止 → 后续 `connectWs()` 不执行 → **网页终端卡在"正在连接终端..."**。表面现象像 WebSocket 连不上，**实际是前端 JS 根本没跑起来**（`connectWs()` 没被调用，WS 压根没尝试连）。别往 WS / 后端 PTY / 路由方向猜。

**为什么难定位**：浏览器控制台 `Uncaught SyntaxError: Invalid or unexpected token (at <page>:<line>)` 是典型症状，行号指向断行处——但若没开 DevTools、只看"卡连接"现象，极易误判为 WS/网络问题。且 **Chromium 对内联 `<script>` 的 SyntaxError 不稳定触发 `pageerror` 事件**（实测本场景不发），不能靠 Playwright `page.on('pageerror')` 看护。

**修复方案（治本）**：
1. **模板里所有 `\r`/`\n`/`\x..` 写双反斜杠**：`'\\r'`/`'\\n'`（Node 输出字面量 `'\r'`/`'\n'` 文本给浏览器，浏览器 JS 才正确解析为换行符字符串）。`buildTerminalHtml` 内的 JS 字符串字面量 + 注释一律如此。
2. **注释里提到字节序列时**：优先用 `CR`/`LF`/`0x0d`/`0x0a` 等不含反斜杠的字样，或写 `\\r`/`\\n`，**绝不裸写 `\r`/`\n`**（注释里的也会被 Node 转义，这是第 2 次复发的盲点）。
3. **验证手法**：把生成的 HTML 里 `<script>` 块 dump 出来 `node --check` 或 `new Function(code)`——能立刻定位 SyntaxError 行号（比猜快得多）：
   ```js
   const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g; let m;
   while ((m = re.exec(html)) !== null) { try { new Function(m[1]); } catch(e){ console.error(e); } }
   ```
4. **回归测试**：`test/e2e/terminal-connect.spec.ts` 已看护——打开真实 `/terminal/:tid` 页面断言 `#msg` 离开"正在连接终端..."（内联 JS 炸了→`connectWs()` 不跑→`#msg` 永远停在"正在连接..."→超时失败），+ 静态抽检内联 `<script>` 用 `new Function(code)` 体检。已验证两条用例在裸写 `\r` 时都失败、修复后都通过。

**规则**：在 `buildTerminalHtml`（及任何反引号模板拼 JS 的地方）写 JS 字符串字面量里的换行/控制符一律 `'\\n'`/`'\\r'`（双反斜杠）；注释里别裸写 `\n`/`\r`/`\x16`，改用 `LF`/`CR`/`0x16` 文字。改完用 `test/e2e/terminal-connect.spec.ts` 验证。相关 memory：`[[template-literal-escape-in-htmlgen]]`、`[[claude-cli-newline-keybinding]]`。

## 架构速览

- `src/`：VS Code 扩展 TS（编译到 `out/`，CommonJS）。
  - `proxyHost.ts`：代理宿主/控制器（spawn 独立子进程跑 proxy/server.js，用 `process.execPath` + 净化 env + `ELECTRON_RUN_AS_NODE`，详见下方「Server 独立进程化」）+ 调代理接口的 wrapper（裸 socket）+ 心跳/多窗口协调（端口 bind 单例 + 2s healthz 探测 + child.on('exit') 主动 re-spawn）。
  - `cleanEnv.ts`：净化 `process.env` 给 spawn 子进程用（删 `NODE_OPTIONS`/`VSCODE_*`/`ELECTRON_*`/`CHROME_*`/`PIPE` 注入变量，设 `ELECTRON_RUN_AS_NODE=1` + `CCP_*` 路径）。纯函数，抽出来好单测。
  - `claudeLauncher.ts`：启动 workspace 隔离 CLI（`CLAUDE_CONFIG_DIR` + 路由 key/别名全走 shell env；不写 `.claude_proxy/settings.json` 路由）。
  - `derivedLogic.ts`：派生节点纯逻辑（继承快照、别名 env 构造、映射表同步、per-档 1m 上下文 `sessionContext1m`/`normalizeSessionContext1m`/`inheritSessionContext1m`），抽出来好单测。
  - `treeProvider.ts` / `webviewEditor.ts` / `localConfigStore.ts`：配置树 / 编辑器 / 存储。
- `proxy/`：本地 LLM 代理（ESM JS，不进 tsc）。
  - `server.js`：转发主路径 + `rewriteModel`（别名替换）+ `rewriteEffort` + `inspectFirstBody`/`describeHitRule`（retryRules 命中判定，status+code 组合，`all`/`*` 通配）+ API 接口。`isMainModule` 入口认 `CCP_*` env（扩展子进程用，优先）/ `CONFIG_PATH`（向后兼容，mock 测试用）/ 默认 `./config.json`（CLI 模式）；`exitOnKill` 选项让子进程模式下 `/api/kill` 与 `/api/port POST` 触发 `process.exit(0)` 让宿主 re-spawn。
  - `config-store.js`：配置读写 + 热重载 + modelAliases 映射表 + nextAliasId 计数器 + retryRules（含老 retryOnStatus/retryOnBodyErrorCode 向后兼容迁移）。
  - `trace-store.js`：trace 写时分流（model=原始别名、resolvedModel=映射后真实模型）。
- `test/mock-cli/`：Claude Code CLI 配置加载层等价重实现（探针 + 假设验证）。
- `test/derived-logic/`：派生节点纯逻辑单测。
- `test/proxyHost/`：ProxyHost 辅助函数单测（`cleanEnv`/`spawn-helpers`/`stdio-forward`）。

## Server 独立进程化

`proxy/server.js` 作为**独立 Node 子进程**运行（不再 in-proc import 进 Extension Host）。设计/验证记录见 `docs/server独立进程化调研.md`。

- **spawn 方式**：`spawn(process.execPath, [serverPath], { env: cleanEnv(...), stdio:['ignore','pipe','pipe'], windowsHide:true })`。`process.execPath` = `Code.exe`（VS Code 自带 Node Runtime），加 `ELECTRON_RUN_AS_NODE=1` 当纯 Node 跑 ESM。
- **⚠ 净化 env 是关键**（V1-f 验证，曾耗时定位）：扩展宿主 `process.env` 注入了 `NODE_OPTIONS`（含 `--require bootstrap-fork.js`）/ `VSCODE_*` IPC handle / `ELECTRON_*` / `CHROME_*` 等私货，原样透传给子进程会让 `Code.exe` 在等 IPC 句柄时**死锁**（子进程不 listen 不 exit 零输出）。必须用 `cleanEnv()` 删这些注入变量，死锁才解除。**新增 spawn 调用一律走 `cleanEnv`，不要 `...process.env` 原样透传。**
- **就绪检测**：spawn 后轮询 `/healthz`（裸 socket，`waitForPortReady`），最多 5s，通=宿主成功；超时=kill 子进程下次心跳重试。
- **生命周期**：`child.on('exit')` 主动清 handle + 下次心跳 re-spawn；`spawning` 守卫防重入 spawn 多子进程；`disposed` 守卫防 deactivate 后心跳继续 spawn（泄漏）。
- **`/api/kill` 与 `/api/port POST`**：子进程模式（`exitOnKill=true`）触发 `process.exit(0)` 让宿主 re-spawn，而非 in-proc 的 `server.close()` 空转。in-proc 测试模式不退出进程。
- **通信通道不变**：扩展↔子进程仍走裸 socket HTTP（`rawHttp`/`healthz`），扩展宿主 http 栈吞 body 坑依然存在（见上节），裸 socket 仍必须。

## 测试与开发

- **全量**（一条命令跑完所有 `node --test` 套件，约 65s）：
  ```
  node --test --test-concurrency=1 proxy/test/ test/derived-logic/test.mjs test/mock-cli/test/ test/proxyHost/ mock/ test/standalone/
  ```
  ⚠ `--test-concurrency=1` 必须加：`mock/` + `test/standalone/` 套件起真代理子进程 + mock 上游，默认并发会端口抢占/资源竞争卡死。串行才稳定。
  现状 633 tests / 631 pass / 0 fail / 2 skip（POSIX 专属在 Windows 跳过）+ e2e 13 pass（`npm run test:e2e`）。
  - `npm run test:e2e`：Playwright e2e（chromium only，worker 串行，起 standalone 子进程 + 临时端口），测管理界面 DOM/用户可见行为，不进 `node --test` 全量命令。配置 `playwright.config.ts`，套件 `test/e2e/`（`package.json` 声明 `type:module` 让 .ts 走 ESM）。不起真终端（PTY 留手动）。含 `terminal-connect.spec.ts`（终端页卡"正在连接"回归守卫，见上方「反引号模板字符串拼 JS」陷阱）+ `xterm-shift-enter.spec.ts`（Shift+Enter 换行回归守卫）。

- **按目录跑**（改某块时针对性）：
  - `node --test proxy/test/` — server/config/trace 配置层 + e2e（9 文件，153 用例）
  - `node --test test/derived-logic/test.mjs` — 派生节点纯逻辑（153 用例）
  - `node --test test/mock-cli/test/` — Claude CLI 配置加载层等价重实现（11 用例）
  - `node --test test/proxyHost/` — `cleanEnv` / `spawnProxyChild` / `healthz` / `killChild` / `forwardStdio` / `resolveClaudeBinary` 控制器（5 文件）
  - `node --test test/standalone/` — 独立后端入口骨架 + workspace 管理 + CLI 会话 + 配置编辑 + npm 打包 + 激活(弱化为默认标记) + 树状管理页 + 终端路由双通道 + 别名终端顶栏实时映射（config 初始化 / spawn 守护 / 心跳 re-spawn / 生命周期 / workspace CRUD / management API / 二进制探测 / PTY 会话 keyed by terminalId / WebSocket / local config CRUD / 别名配置创建 + alias 回写本地 / 配置编辑网页 / bin 入口 / files 白名单 / markDefaultConfig 只写标记不写 settings.json / 树状管理页 HTML / buildTerminalEnv 三种 config 类型统一走 env + configDir 共享（避免重复引导）+ settings.json 检测（env 注入与 settings.json 不共存） / syncDerivedAliases / alias-resolve 顶栏，280+ 用例，起真 server.js 子进程；真实 PTY/conpty 集成手动验证不进套件；激活/派生终端测试用临时代理子进程或 proxyPort 19998，**绝不用真实代理 11434**——派生/proxy 路径会 POST /api/upstream 污染全局 upstream）
  - `node --test mock/` — 端到端（起真代理 + mock 上游，effort/日志/model/端口/stats/SSE，6 文件 + test.mjs）

- **单文件跑**：`node --test proxy/test/server-entry-kill.test.mjs`（任意 `.test.mjs` 文件路径）。

- `npm run test:mock-cli`：等价于 `node --test test/mock-cli/test/`（package.json 留的快捷方式）。

- 代理测试用 mock 上游（`mock/mock-server.js`，认 `MOCK_PORT`/`MOCK_SEQUENCE` env），不依赖真实 LLM。注意 mock 端口避开 Windows 保留端口（如 8795 EACCES，用 8791-8794/8796）。

- 设计文档：`docs/claude code cli运行时model切换方案.md`（运行时 model 切换方案）、`docs/server独立进程化调研.md`（独立进程化方案 + V1 验证记录 + 最终架构）。

## 工作流规则

### plan 文件副本归档

**规则**：每次 plan mode 产出的 plan 文件，**除了写到 `.claude_proxy/plans/<随机名>.md` 外，必须再抄一份到 `docs/plan/tmp/`**（文件名可沿用原随机名或改为语义化名）。`docs/plan/tmp/` 已建出，作为所有 plan 的归档副本目录，便于回溯和版本控制（plan 原文件在 `.claude_proxy/plans/` 下是 session 级、易被清理）。

**执行时机**：plan 定稿（写完 plan 文件）后立即抄一份；若 plan 后续在实现过程中有重大修订，同步更新 `docs/plan/tmp/` 里的副本。

**抄送方式**：读原 plan 文件全文 → Write 到 `docs/plan/tmp/<同名>.md`。

