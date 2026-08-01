# CLAUDE.md — claude-code-proxy

VS Code 扩展：管理 Claude Code 配置切换 + 本地 LLM 代理（重试 503/10310）+ workspace 隔离 CLI 会话 + 运行时模型切换（派生节点 alias）。

## 关键陷阱（必读，避免重复踩坑）

### 扩展宿主调本地 HTTP 服务的空 body 坑（最难定位，曾耗时数小时）

**现象**：扩展侧用 `http.get`/`http.request`/`fetch` 调本地代理（`127.0.0.1:<port>`），拿到 `status 200` 但 **body 为空**（`rawLen=0`），`JSON.parse('')` 报 `Unexpected end of JSON input`。同样的 URL 用 `curl` 或命令行 `node -e` 却能拿到正常 body。

**根因**：VS Code 扩展宿主（Electron-based extension host）内置的 `@vscode/proxy-agent` **劫持（monkey-patch）了 Node 原生的 `http.get`/`http.request`/`fetch`**。当系统开了代理（HTTP_PROXY/HTTPS_PROXY）或 VS Code `http.proxySupport` 设置时，proxy-agent 会把发往本地 127.0.0.1 的请求也改写（请求行改成绝对路径、响应重编码成 chunked 并可能丢 body）。命令行 node 不加载 proxy-agent，所以表现不一致。

**已验证的诡异特征**：
- 代理侧用 `res.end(string)` 一次性写完（本该是 Content-Length + 完整 body），扩展侧看到的却是 `transfer-encoding: chunked` + 空 body。
- `content-type: application/json` header 仍在（说明请求到达了代理、走了 sendJson），但 data 事件没触发、end 触发了。
- POST 接口可能"看起来成功"（只看 status 200 没解析 body），实际也没真到达——别被 POST 的假成功骗了。

**修复方案（本工程已采用）**：
1. **扩展侧调代理接口用裸 `net` socket**（见 `src/proxyHost.ts` 的 `nextAliasId`）：`net.connect` + 手写 HTTP 请求行 + 手动解析响应（含 chunked 解码 `dechunk`）。`@vscode/proxy-agent` hook 不到 `net` 模块，彻底绕过。
2. **`src/extension.ts` activate 最早注入 `NO_PROXY=127.0.0.1,localhost`**（双保险）。
3. **代理侧 `proxy/server.js handleRequest` 用 `new URL(req.url, ...)` 规范化 urlPath**，免疫 proxy-agent 发的绝对路径请求行（防路由失配 fall-through 到代理转发）。

**复现/定位手法**：
- 在扩展侧 `res.on('end')` 打印 `res.headers` + raw。若看到 `transfer-encoding: chunked` 但代理侧用的是 `res.end(string)`（非 chunked），就是被 proxy-agent 改写了。
- 在代理路由最顶加 `console.log(req.method, req.url)`，看扩展侧请求的 `req.url` 是不是绝对路径（`http://127.0.0.1:.../api/...` 而非 `/api/...`）。
- 用裸 `net` socket 复刻请求，能正常拿到 body → 确证是 proxy-agent 的锅。

**规则**：本工程里**扩展宿主侧调本地代理接口，一律用裸 socket**，不用 `http.get`/`fetch`。新增接口的 wrapper 照 `proxyHost.nextAliasId` 的模式写。

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
