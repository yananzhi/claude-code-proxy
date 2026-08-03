# 独立后端形态 — 调研与实施计划

> 生成时间：2026-08-03
> 状态：探索阶段结论已对齐，待按阶段实施（每阶段走 `dev-with-tdd-review` skill）
> 前置文档：`docs/server独立进程化调研.md`（proxy 已独立成子进程，本篇在此基础上脱离 VS Code 宿主）

---

## 一、目标

一套代码，两种运行形态：

| 形态 | 宿主 | 运行时 | UI | workspace 概念 |
|---|---|---|---|---|
| A. VS Code 插件（现状冻结） | VS Code Extension Host | Code.exe (Electron Node) | webview + 控制台网页 | VS Code workspace folder（多窗口） |
| B. 独立后端（新建） | 独立 Node 进程 | 系统 node | 网页（浏览器） | 自管理"目录型 workspace" |

两种形态共享**同一套后端核心**（proxy + 派生逻辑 + 配置存储 + spawn 控制），只是"宿主适配层"和"UI 层"不同。

**VS Code 形态冻结不动**——它的优势（小发布包、复用 VS Code 运行环境、多窗口天然 workspace 隔离）要保住。本篇所有改造只为新增独立形态，不破坏 VS Code 形态现有行为与测试。

---

## 二、关键决策（探索阶段已对齐）

### 决策 1：proxy-config 是公共的、全局的一份

proxy-config（upstream / modelAliases / retryRules / effortLevel / listenPort / 日志目录）**不属于任何 workspace**，是公共配置，通过代理控制台网页（`proxy/web/index.html`）修改，所有 workspace 共用。两种形态都是这样。

### 决策 2："多 workspace"只在 CLI 配置层有意义

"多 workspace"有两层含义，必须分清：

- **第一层（CLI 配置隔离）**：每个 workspace 有自己的 `.claude_proxy/`、自己的 `CLAUDE_CONFIG_DIR`、自己的 local 配置/激活态。这一层两种形态都支持——VS Code 靠多窗口（每窗口一 workspace），独立形态靠 WorkspaceManager 管多个目录。
- **第二层（转发进程共用）**：所有 workspace 的 CLI 转发请求走同一个代理进程、同一份公共 proxy-config。两种形态都是单代理进程。

**独立形态的"多 workspace"只在第一层有意义**——多个 workspace 各自 CLI 配置隔离，但转发层完全等价（共用同一 upstream / 别名 / 重试规则）。proxy 核心几乎不改，因为单配置模型和现在完全一样。

### 决策 3：VS Code 形态冻结，不改多 workspace

VS Code 形态的多 workspace 能力（多窗口各自 CLI 配置 + 端口 bind 单例抢代理托管权）保持现状。不为"代码统一"去动 VS Code 形态的进程模型。

### 决策 4：独立形态 = 单进程单端口 + 公共 proxy-config + 多 workspace CLI 隔离

```
┌──────────────── 独立后端进程（单例）────────────────┐
│  一个 proxy/server.js 转发进程（spawn 子进程）        │
│  监听一个端口，加载一份公共 proxy-config              │
│  服务所有 workspace 的 CLI 转发                       │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ ws A      │  │ ws B      │  │ ws C      │  ← 各自   │
│  │ .claude_  │  │ .claude_  │  │ .claude_  │   CLI     │
│  │ proxy/    │  │ proxy/    │  │ proxy/    │   配置隔离 │
│  └──────────┘  └──────────┘  └──────────┘           │
│       ▲              ▲              ▲                │
│       └──────── 转发都用同一份公共 proxy-config ──────┘
└───────┼──────────────┼──────────────┼────────────────┘
        │              │              │
   CLI 会话 A     CLI 会话 B     CLI 会话 C
```

### 决策 5：独立形态也用 spawn 起代理（不用 in-proc）

独立形态没有 VS Code 扩展宿主的 env 污染，本可以 in-proc import `server.js`，但**选 spawn**，理由：

- 与 VS Code 形态、测试形态三者 spawn 路径统一，`proxySpawnController.ts` + `cleanEnv.ts` 完全复用，零分叉。
- 测试更容易模拟实际状态（测试形态本就 spawn）。
- 独立形态下 `process.execPath` 是普通 node，`cleanEnv` 里针对 Electron 的净化变成 no-op 但不碍事，`CCP_*` 路径注入照旧。

### 决策 6：CLI 会话调用系统安装的 claude code cli 二进制（node-pty + xterm.js）

- 阶段 3 实际用 **node-pty spawn**（PTY 让 claude CLI 以为在真终端，TUI 不降级），不走 PowerShell/shell 调用操作符。
- 每个会话一个 xterm.js 网页终端（CDN 加载），WebSocket 双向流 PTY 数据。
- ~~xterm.js 作为将来 todo~~ ——探索阶段中途决定一次性做到位，阶段 3 已含 xterm.js。
- 二进制探测三来源（见决策 7）。

### 决策 7：claude 二进制探测顺序

```
resolveClaudeBinary() 探测顺序：
  1. 用户指定的绝对路径（网页/配置里设置，最高优先级，覆盖一切）
  2. 系统安装的 claude cli：
     - Windows: where claude / PowerShell Get-Command claude
     - Linux/Mac: which claude / PATH 搜索
  3. VS Code 插件安装的 claude cli：
     - 扫描 VS Code 扩展目录（~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/）
     - 多版本取最新
  4. 都找不到 → 网页提示用户手动指定绝对路径
```

`claudeLauncher.ts` 现在的 `resolveBinaryPath()` 走 VS Code 设置 + `vscode.extensions.getExtension`。阶段 0 抽出纯函数版 `resolveClaudeBinary(opts)`，VS Code 形态传 vscode 探测结果作为来源之一，独立形态传系统探测 + 扩展目录扫描。

### 决策 8：磁盘目录 ↔ workspace 一对一

一个磁盘目录就是一个 workspace，避免配置归属混乱。

### 决策 9：token 先不管安全

本机使用，明文存 JSON，不做 chmod 600 / 加密。

### 决策 10：打包 npm 全局包

`package.json` 加 `bin` 入口指向 `standalone/cli.js`（带 shebang 的 wrapper，import main.js 调 launchStandalone——不直接用 main.js 因其 isMain 判断在 bin shim 下不稳定）。`files` 白名单含 out/+standalone/+proxy 核心文件，`prepublishOnly` 编译。

---

## 三、决策反转记录：旧文档 `plan-per-workspace-proxy.md` 作废

`docs/plan-per-workspace-proxy.md`（2026-07-21）提出"per-workspace 独立代理实例"方案——为每个 workspace 启动独立代理子进程，让每个 workspace 有自己的 upstream，解决"全局 upstream last-write-wins 串味"问题。

**本篇决策 1/2 反转了这个方向**：

- 旧文档把"全局共享 upstream"列为**缺陷 #2**，要解决。
- 本篇把"公共 proxy-config、所有 workspace 共用一个 upstream"定为**设计意图**——不是缺陷。

理由：独立形态下用户就是要所有 workspace 共用同一个 upstream（同一个 LLM 后端账号），"串味"问题在这个定位下不存在。旧文档要解决的"workspace A 走 OpenAI、workspace B 走 Anthropic"不是本篇的需求。

**`plan-per-workspace-proxy.md` 标记为作废**，其方案不实施。如未来确需 per-workspace upstream 隔离，另起方案（单进程多配置按 workspace 路由），不在本篇范围。

---

## 四、当前代码与 VS Code 耦合点摸底（探索结论）

代码分三圈：

### 第一圈：纯后端核心（零 vscode，零改造）

| 文件 | 说明 |
|---|---|
| `proxy/server.js` | LLM 代理 HTTP 服务器（转发 + 重试 + effort 改写 + model 别名重写 + REST API + 静态文件 serve）。纯 Node ESM。`isMainModule` 入口已支持 CLI 模式 |
| `proxy/config-store.js` | 代理配置读写 + 热重载 + modelAliases + nextAliasId + retryRules 迁移。纯 Node ESM |
| `proxy/trace-store.js` | 结构化 trace JSONL 存储。纯 Node ESM |
| `proxy/logger.js` | 双通道日志。纯 Node ESM |
| `proxy/web/index.html` | 代理控制台 Web UI（独立网页，fetch 调 REST API） |
| `src/types.ts` | 纯类型声明 |
| `src/upstream.ts` | `extractUpstream()` / `synthesizeProxySettings()` 纯函数 |
| `src/derivedLogic.ts` | 派生节点全部纯逻辑，已有独立单测 |
| `src/claudeConfig.ts` | settings.json 读写纯 fs 函数 |
| `src/localConfigStore.ts` | workspace-local 配置/激活态存储，纯 fs（构造参数是 string 路径） |

### 第二圈：轻度耦合（改参数类型/抽函数即独立）

| 文件 | 当前耦合 | 改造 |
|---|---|---|
| `src/configStore.ts` | 构造参数 `vscode.Uri`，只用 `.fsPath` | 改成接 `string` 路径 |
| `src/activeState.ts` | 同上 | 同上 |
| `src/proxySpawnController.ts` | 不 import vscode，但隐式假设 `process.execPath` = Code.exe | execPath 参数化（其实不用改，cleanEnv 已兼容两种 execPath） |
| `src/cleanEnv.ts` | 不 import vscode，存在原因是 VS Code env 污染 | 不改——独立形态下 Electron 净化变 no-op，`CCP_*` 注入照旧，两种形态共用 |
| `src/proxyToggle.ts` | `import vscode` 但完全不用 | 删无用 import |
| `src/claudeLauncher.ts` | `resolveBinaryPath()` 用 vscode 设置 + `getExtension`；`launch()`/`launchDerived()` 用 `createTerminal` | 抽 `resolveClaudeBinary()` 纯函数 + CLI 启动核心（spawn 化），VS Code 形态的 `createTerminal` 保留在适配层 |

### 第三圈：重度耦合（VS Code 专属，独立形态另建）

| 文件 | 说明 | 独立形态处理 |
|---|---|---|
| `src/extension.ts` | 26 个命令 + activate 编排 | 独立形态新建 `standalone/main.js` 编排 |
| `src/webviewEditor.ts` | 内联 HTML + `acquireVsCodeApi().postMessage` 通信 | 阶段 4 迁成独立网页 |
| `src/treeProvider.ts` | TreeDataProvider | 独立形态用网页树/列表 |
| `src/proxyHost.ts` | StatusBarItem / OutputChannel | 独立形态用 console + 日志文件 + Web 状态；spawn/心跳/rawHttp 业务逻辑复用 |
| `src/claudeLauncher.ts` 的 VS Code 终端部分 | `createTerminal` | 独立形态用 `child_process.spawn` |

### 通信通道关键认知

扩展↔代理的通信**本来就是 HTTP（裸 socket `rawHttp`），不是 VS Code API**。代理早已是"可独立运行的服务"，扩展只是它的一个客户端。这是能做双形态的最大资本。

### 配置存储关键认知

所有配置都是**文件存储**，没用 VS Code 的 `globalState`/`workspaceState`/`SecretStorage`。唯一依赖 VS Code 的是"文件路径来源"（`context.globalStorageUri.fsPath`）。脱离后改成 `~/.claude-code-proxy/`。

---

## 五、web UI 现状（影响阶段 4）

### `proxy/web/index.html`（控制台）能改的

- 重试参数：`maxAttempts` / `backoffSec` / `backoffMaxSec` / `retryRules` / `passthrough`（`POST /api/config`）
- `effortLevel`（`POST /api/effort`）
- `listenPort`（`POST /api/port`）
- 日志目录（`POST /api/logs-dir`）
- trace 查看 / 统计（`GET /api/traces` / `/api/stats`）

**这些独立形态全部继承，不用动。**

### `proxy/web/index.html` 改不了的（要靠 webviewEditor 迁移）

- 上游 env（baseUrl/token/model/timeout）——网页只读展示，`saveUpstream()` 是死代码（输入框 disabled，无按钮调用）
- `modelAliases`（别名映射）——网页完全没 UI（`/api/model-alias` 端点存在但网页不调）
- `sessionContext1m`（[1m] 档位）——网页不碰
- LLMConfig 本身（name/mode/content）——网页不碰

### `src/webviewEditor.ts` 能编辑的

- **global/local scope**：name / mode（direct/proxy）/ content（settings.json 全文，含 env 上游）
- **derived scope**：name / modelAliases 四档（main/haiku/sonnet/opus，即时生效）/ sessionContext1m per-tier

### 阶段 4 真实工作量

把 `webviewEditor.ts` 内联 HTML 编辑器迁成网页，覆盖：LLMConfig CRUD（name/mode/content）+ 派生节点别名映射 + sessionContext1m。`/api/model-alias` 端点已存在，网页补 UI 调它即可。上游 env 编辑是 content 编辑的一部分。

---

## 六、整体架构

```
                    ┌─────────────────────────────────┐
                    │     共享核心（host-agnostic）     │
                    │                                   │
                    │  proxy/*  ← 几乎不改（公共单配置） │
                    │    server.js / config-store.js    │
                    │    trace-store.js / logger.js     │
                    │    web/index.html（控制台网页）    │
                    │                                   │
                    │  src/derivedLogic.ts  (零改)       │
                    │  src/upstream.ts      (零改)       │
                    │  src/claudeConfig.ts  (零改)       │
                    │  src/types.ts         (零改)       │
                    │  src/localConfigStore.ts (零改)    │
                    │                                   │
                    │  src/configStore.ts   ← Uri→string │
                    │  src/activeState.ts   ← Uri→string │
                    │  src/proxySpawnController (共用)    │
                    │  src/cleanEnv.ts      (共用)        │
                    │  src/claudeLauncher 核心 ← spawn 化 │
                    │  + resolveClaudeBinary 纯函数       │
                    └─────────────────────────────────┘
                          ▲                    ▲
            ┌─────────────┘                    └──────────────┐
   ┌──────────────────────┐                ┌──────────────────────┐
   │ VS Code 形态（冻结）   │                │ 独立后端形态（新建）   │
   │ - extension.ts 编排   │                │ - standalone/main.js  │
   │ - treeProvider        │                │ - 单进程单端口         │
   │ - webviewEditor       │                │ - 公共 proxy-config   │
   │ - proxyHost vscode UI │                │   （网页改，和现在一样）│
   │ - 端口 bind 单例       │                │ - 多 workspace CLI 隔离│
   │ = 现状不动             │                │ - workspace 管理网页  │
   │                        │                │ - CLI 会话 spawn      │
   │                        │                │ - npm 全局包          │
   └──────────────────────┘                └──────────────────────┘
```

---

## 七、独立形态新建产物

1. **`standalone/main.js`**：入口。加载公共 proxy-config → spawn 代理子进程（复用 `proxySpawnController` + `cleanEnv`）→ serve 网页 UI → 单进程守护（crash 自恢复，去掉多窗口语义）。
2. **`standalone/workspaceManager.js`**：创建/列出/删除 workspace，索引存 `~/.claude-code-proxy/workspaces.json`，每个 workspace 在指定目录建 `.claude_proxy/`。复用 `localConfigStore.ts`。
3. **CLI 会话 spawn**：`claudeLauncher` 核心逻辑下沉（`CLAUDE_CONFIG_DIR` 指向 workspace 的 `.claude_proxy/`、settings.json 合并、.gitignore 追加），去掉 VS Code 终端依赖，改 `child_process.spawn`。日志重定向到文件/网页。
4. **网页 UI 扩展**（在 `proxy/web/index.html` 基础上加）：workspace 管理页 + 配置编辑页（迁 `webviewEditor`）。
5. **管理 HTTP API**：workspace CRUD + CLI 会话起停。代理现有 `/api/*` 覆盖 proxy-config 部分，独立形态补 workspace/CLI 会话相关 API。
6. **`package.json` bin 入口**：指向 `standalone/main.js`。

---

## 八、分阶段实施计划

每个阶段独立跑通测试，每个阶段走一次 `dev-with-tdd-review` skill（baseline 测试 → 场景设计 → 用例 → 实现 → 子代理 review → smoke → 存档）。

**测试基线**：352 tests / 350 pass / 0 fail / 2 skip（POSIX 专属在 Windows 跳过）。每阶段结束跑全量确保 VS Code 形态不破。

### 阶段 0：共享核心下沉（不改行为）

- `configStore.ts` / `activeState.ts`：构造参数 `vscode.Uri` → `string`。VS Code 形态调用处传 `context.globalStorageUri.fsPath`，行为不变。
- `claudeLauncher.ts`：抽 `resolveClaudeBinary()` 纯函数（三来源探测）+ CLI 启动核心（spawn 化，去掉 `vscode.window.createTerminal`）。VS Code 形态的 `createTerminal` 调用保留在适配层。
- `proxyToggle.ts`：删无用 `import vscode`。
- **验证**：全量测试不破 + 新增纯函数单测（`resolveClaudeBinary` 各来源优先级）。

### 阶段 1：独立后端入口骨架

- 新建 `standalone/main.js`：加载公共 proxy-config → spawn 代理子进程 → serve 网页 → 单进程守护。
- 确认 `proxy/server.js` 的 `isMainModule` 入口能被 standalone spawn 复用。
- **验证**：`node standalone/main.js` 起代理、`/healthz` 通、控制台网页可访问。

### 阶段 2：WorkspaceManager + workspace 管理网页

- 新建 `standalone/workspaceManager.js`：创建/列出/删除 workspace，索引存 `~/.claude-code-proxy/workspaces.json`。
- 网页加 workspace 管理页。新增管理 HTTP API（workspace CRUD）。
- **验证**：网页创建 workspace → `.claude_proxy/` 生成 → 能列出/删除。

### 阶段 3：claude 二进制探测 + CLI 会话 spawn（含 xterm.js）

- 新建 `standalone/claudeBinaryStandalone.js`：`resolveClaudeBinaryStandalone` 包一层，补系统 PATH 遍历（`searchPathForClaude`）+ VS Code 扩展目录扫描（`scanVscodeExtensionDir`，semver 取最新）。探测顺序：用户覆盖 > 系统 PATH > VS Code 扩展 > null。
- 新建 `standalone/claudeSession.js`：`ClaudeSessionManager` 用 **node-pty** spawn claude（PTY 让 TUI 不降级），每 workspace 一会话，`CLAUDE_CONFIG_DIR` 指向 `.claude_proxy/`。PTY onData→广播 WS，WS message→PTY write，onExit 清理。
- management API 加 CLI 会话路由（POST/GET/DELETE claude-session）+ 终端页路由 + WebSocket upgrade（/claude-session/ws）。
- 网页 `buildTerminalHtml`：xterm.js（CDN）+ WS 双向流。
- **验证**：网页选 workspace 起 CLI 会话，xterm 终端可交互、转发走代理、trace 进控制台。

### 阶段 4：配置编辑页迁移

- 把 `webviewEditor.ts` 内联 HTML 的配置 CRUD + 别名映射迁成独立网页，通信从 `postMessage` 换 fetch 调 `/api/*`。
- 补 modelAliases 网页 UI（调 `/api/model-alias`）。
- **验证**：网页新建/编辑配置、改别名映射、改 retryRules，改完生效。

### 阶段 5：打包 npm 全局包

- 新建 `standalone/cli.js`（shebang wrapper，import main.js 调 launchStandalone）。
- `package.json` 加 `bin`（claude-code-proxy → standalone/cli.js）+ `files` 白名单（out/+standalone/+proxy 具体文件，不含 logs/test 防泄露）+ `prepublishOnly` 编译。
- **验证**：`node standalone/cli.js` 起后端、`npm pack --dry-run` 含 out/standalone/proxy 不含 logs/test。

### 阶段 6：激活 local config（阶段 4 留的"激活"后续）

- `configApi.js` 加 `activateConfig`：direct 模式 writeSettings 原样 content；proxy 模式 extractUpstream→校验→proxyForward 注入 upstream→synthesizeProxySettings 合成→writeSettings。写 LocalActiveStateStore active 标记 + ensureProjectPermissions + ensureGitignore（复制自 claudeLauncher）。
- management API 加 POST /configs/:cfgId/activate + GET /active。
- 复用 out/upstream.js + out/claudeConfig.js + out/localConfigStore.js（零改）。
- **验证**：direct/proxy 激活写 settings.json + 注入 upstream + active 标记；新 spawn 会话读 settings.json 生效。测试用临时代理子进程，不碰真实代理 11434。

---

## 九、待定 / 将来 todo

- ~~xterm.js 终端模拟器~~：阶段 3 已完成。
- ~~激活 local config~~：阶段 6 已完成。
- **per-workspace upstream 隔离**：当前定为公共一份（last-write-wins）。如未来需要 workspace 级 upstream 隔离，另起方案（单进程多配置按 workspace 路由）。
- **token 安全**：当前明文存 JSON。如需可加 chmod 600 / 加密。
- **多用户/鉴权**：当前纯本机单用户（management API 监听 127.0.0.1 + CORS *）。如需可加本地 token 鉴权。
- **github 源码安装的 postinstall 编译**：当前 `files` 白名单 + `prepublishOnly` 保证 npm 包含 out/，但 `npm install -g github:repo` 无 out/（.gitignore 排除）。需 postinstall 编译或预编译发布。
