# CLAUDE.md — claude-code-proxy

VS Code 扩展：管理 Claude Code 配置切换 + 本地 LLM 代理（重试 503/10310）+ workspace 隔离 CLI 会话 + 运行时模型切换（派生节点 alias）。

## 关键陷阱（必读，避免重复踩坑）

### 扩展宿主调本地 HTTP 服务的空 body 坑（曾耗时数小时定位）

**现象**：扩展侧用 `http.get`/`http.request` 调本地代理（`127.0.0.1:<port>`），拿到 `status 200` 但 **body 为空**（`rawLen=0`），`JSON.parse('')` 报 `Unexpected end of JSON input`。同样的 URL 用 `curl` 或命令行 `node -e` 却能拿到正常 body。

**真因（2026-08-01 诊断坐实，推翻了早期 proxy-agent 假设）**：

代理侧 `sendJson` 用 `res.end(JSON.stringify(obj))` 一次性写完，但 **`writeHead` 没写 `Content-Length`**。Node http server 对没 Content-Length 的 `res.end(string)` 会**自动改用 `Transfer-Encoding: chunked` 分块发送**（HTTP/1.1 规范：无 Content-Length 必须分块，否则客户端不知何时结束）。

- **命令行 node / curl 的 http 客户端透明解码 chunked** → `data` 事件拿到明文 → 正常。
- **VS Code 扩展宿主（Electron）的 http 客户端不解码 chunked** → `data` 事件不投递 → `end` 直接触发 → `rawLen=0`。这是扩展宿主 http 栈的特定行为。

诊断证据（第二轮 5 探针，系统 HTTP_PROXY/HTTPS_PROXY 全 unset、NO_PROXY 生效）：
- `http.get GET /api/config` → status=200, `transfer-encoding: chunked`, rawLen=0。
- 裸 `net` socket GET 同一路径 → status=200, isChunked=true, rawBytesLen=516, **dechunk 后 decodedLen=508**（服务端 body 完整）。
- `http.request POST` 设映射 → 响应 rawLen=0（被吞），但裸 socket 读回 `/api/config` 含该映射 → **POST 请求 body 没被吞，映射真写入了**（"假成功"=请求送达但响应读不到）。

**这证明**：proxy-agent 不是元凶（系统没开代理、NO_PROXY 兜底无效、proxy-agent 无劫持条件）；真因是 **chunked 响应被扩展宿主 http 客户端吞 body**。

**修复方案（本工程已采用，治本）**：
1. **代理侧 `sendJson`（及所有 `res.end` 出口）显式写 `Content-Length`**（`proxy/server.js`）。这样服务端发完整 body 不分块，扩展宿主 http 客户端正常收 `data` 事件。**所有 http wrapper（含 `getModelAliases`/`setModelAlias`/`removeModelAlias`）恢复可用**。
2. **`src/extension.ts` activate 最早注入 `NO_PROXY=127.0.0.1,localhost`**（双保险，防系统真开代理时 proxy-agent 干预）。
3. **`proxy/server.js handleRequest` 用 `new URL(req.url, ...)` 规范化 urlPath**（防系统开代理时 proxy-agent 发绝对路径请求行致路由失配）。
4. **`src/proxyHost.ts nextAliasId` 仍用裸 `net` socket + `dechunk`**（历史方案，先于方案 1 落地；方案 1 后裸 socket 仍兼容——非 chunked 走 `else` 原样返回）。**新增 wrapper 不强制裸 socket**，http.get/request 配合服务端 Content-Length 即可。

**复现/定位手法**：
- 在扩展侧 `res.on('end')` 打印 `res.headers` + rawLen。看到 `transfer-encoding: chunked` + rawLen=0 = chunked 被吞。
- 裸 `net` socket GET 同路径 + `dechunk`：若 decodedLen>0 而扩展侧 http.get rawLen=0 → 确证服务端 body 完整、是客户端吞了（临时诊断命令 `claude-code-proxy.diagProxyHttp` 已验证）。

**规则**：代理侧任何 `res.end(string)` 出口**必须配 `Content-Length`**，否则扩展宿主拿空 body。这是治本。裸 socket 是 nextAliasId 的历史实现，新 wrapper 用 http 栈 + 服务端 Content-Length 即可。

## 架构速览

- `src/`：VS Code 扩展 TS（编译到 `out/`，CommonJS）。
  - `proxyHost.ts`：代理宿主（ESM import proxy/server.js 进扩展进程，非子进程）+ 调代理接口的 wrapper（裸 socket）。
  - `claudeLauncher.ts`：启动 workspace 隔离 CLI（`CLAUDE_CONFIG_DIR` + 别名走 shell env + token 走 settings.env）。
  - `derivedLogic.ts`：派生节点纯逻辑（继承快照、别名 env 构造、映射表同步），抽出来好单测。
  - `treeProvider.ts` / `webviewEditor.ts` / `localConfigStore.ts`：配置树 / 编辑器 / 存储。
- `proxy/`：本地 LLM 代理（ESM JS，不进 tsc）。
  - `server.js`：转发主路径 + `rewriteModel`（别名替换）+ `rewriteEffort` + API 接口。
  - `config-store.js`：配置读写 + 热重载 + modelAliases 映射表 + nextAliasId 计数器。
  - `trace-store.js`：trace 写时分流（model=原始别名、resolvedModel=映射后真实模型）。
- `test/mock-cli/`：Claude Code CLI 配置加载层等价重实现（探针 + 假设验证）。
- `test/derived-logic/`：派生节点纯逻辑单测。

## 测试与开发

- `npm run test:mock-cli`：mock-cli 套件。
- `node --test proxy/test/ test/derived-logic/test.mjs test/mock-cli/test/`：全量。
- 代理测试用 mock 上游（`mock/mock-server.js`），不依赖真实 LLM。
- 设计文档：`docs/claude code cli运行时model切换方案.md`（运行时 model 切换方案）。
