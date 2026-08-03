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

## 架构速览

- `src/`：VS Code 扩展 TS（编译到 `out/`，CommonJS）。
  - `proxyHost.ts`：代理宿主/控制器（spawn 独立子进程跑 proxy/server.js，用 `process.execPath` + 净化 env + `ELECTRON_RUN_AS_NODE`，详见下方「Server 独立进程化」）+ 调代理接口的 wrapper（裸 socket）+ 心跳/多窗口协调（端口 bind 单例 + 2s healthz 探测 + child.on('exit') 主动 re-spawn）。
  - `cleanEnv.ts`：净化 `process.env` 给 spawn 子进程用（删 `NODE_OPTIONS`/`VSCODE_*`/`ELECTRON_*`/`CHROME_*`/`PIPE` 注入变量，设 `ELECTRON_RUN_AS_NODE=1` + `CCP_*` 路径）。纯函数，抽出来好单测。
  - `claudeLauncher.ts`：启动 workspace 隔离 CLI（`CLAUDE_CONFIG_DIR` + 别名走 shell env + token 走 settings.env）。
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

- **全量**（一条命令跑完所有 `node --test` 套件，约 60s）：
  ```
  node --test --test-concurrency=1 proxy/test/ test/derived-logic/test.mjs test/mock-cli/test/ test/proxyHost/ mock/
  ```
  ⚠ `--test-concurrency=1` 必须加：`mock/` 套件起真代理子进程 + mock 上游，默认并发会端口抢占/资源竞争卡死。串行才稳定。
  现状 ~352 tests / 348 pass / 2 fail（原有失败，见下）/ 2 skip（POSIX 专属在 Windows 跳过）。

- **已知失败（原有，非改造引入）**：`mock/test-stats-e2e.mjs`（3 个 web UI HTML 断言与 `proxy/web/index.html` 不符）、`mock/test-stream-incremental.mjs`（代理在本环境缓冲了整个 SSE 响应而非增量转发）。两者在改造前就是失败/被 `exit 0` 掩盖，改造后变成显式 test failure。

- **按目录跑**（改某块时针对性）：
  - `node --test proxy/test/` — server/config/trace 配置层 + e2e（9 文件，~157 用例）
  - `node --test test/derived-logic/test.mjs` — 派生节点纯逻辑（~153 用例）
  - `node --test test/mock-cli/test/` — Claude CLI 配置加载层等价重实现（~10 用例）
  - `node --test test/proxyHost/` — `cleanEnv` / `spawnProxyChild` / `healthz` / `killChild` / `forwardStdio` 控制器（4 文件，~28 用例）
  - `node --test mock/` — 端到端（起真代理+mock上游，effort/日志/model/端口/stats/SSE，6 文件）

- **单文件跑**：`node --test proxy/test/server-entry-kill.test.mjs`（任意 `.test.mjs` 文件路径）。

- `npm run test:mock-cli`：等价于 `node --test test/mock-cli/test/`（package.json 留的快捷方式）。

- 代理测试用 mock 上游（`mock/mock-server.js`，认 `MOCK_PORT`/`MOCK_SEQUENCE` env），不依赖真实 LLM。

- 设计文档：`docs/claude code cli运行时model切换方案.md`（运行时 model 切换方案）、`docs/server独立进程化调研.md`（独立进程化方案 + V1 验证记录 + 最终架构）。

