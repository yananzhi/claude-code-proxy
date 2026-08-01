# Claude Code Proxy

一个 VS Code 扩展，合四件事于一身：

1. **管理 + 切换 Claude Code 配置**（原名 cc-switch，现 claude-code-proxy）：保存多条命名的 LLM 配置（每条是完整 `settings.json` 内容），点一下就切换；支持导入/导出。配置分两层——**global**（机器级，写 `~/.claude/settings.json`）和 **workspace-local**（workspace 级，只用于终端启动的隔离会话）。
2. **本地 LLM 代理**（原 llmAutoRetry）：每条配置可选"直连"或"通过代理连接"。代理自动重试 Claude Code 处理不了的瞬时错误（如讯飞 503 system busy，code 10310），并提供 Web 控制台看重试参数 + trace 记录。
3. **Workspace 隔离的 Claude CLI 会话**：一个按钮 / 快捷键在终端打开 Claude Code CLI，用 `CLAUDE_CONFIG_DIR` 指向 `{workspace}/.claude_proxy/`，让该 workspace 的 Claude 状态独立于全局 `~/.claude/`。会话用当前 workspace-local active 配置。
4. **运行时模型切换（派生节点 alias）**：从一条 local 配置派生出"虚拟配置节点"，给 CLI 配固定假模型名（别名 `ccp-main-N` / `ccp-haiku-N` / `ccp-sonnet-N` / `ccp-opus-N`），代理在请求层把别名实时替换成真实模型——不用重启 CLI 就能切模型。支持 `[1m]` 会话档位（1M contextWindow）、四档映射在线改、跨档位警告。

---

## 1. 配置：global 与 workspace-local

配置分两层，互不干扰：

| 层 | 存储 | 作用域 | switch 行为 |
|---|---|---|---|
| **global config** | `globalStorage/configs.json`（机器级） | 全局 `~/.claude/` | 写 `~/.claude/settings.json` + Reload Window |
| **workspace-local config** | `{workspace}/.claude_proxy/local-configs.json` | 仅该 workspace 的终端会话 | 纯标记，不写 settings、不 reload |

侧边栏树结构（可折叠分组）：

- `Detected` — 检测到的环境 + 全局 `settings.json` 路径
- `global_llm_config` — global 配置列表
- `workspace_local_llm_config` — 当前 workspace 的 local 配置列表（开 workspace 才显示）

### 每条配置的连接模式

- **直连**（默认）：直接用配置内容里的上游。
- **通过代理连接**：代理用此配置的上游（token/baseUrl/model），配置改写成指向本地代理（`http://127.0.0.1:<port>`）。Claude Code 走代理，代理重试 503 等错误。

### workspace-local 配置

> ⚠️ 仅对用本扩展启动按钮/快捷键打开的**终端 Claude Code CLI 会话**生效，写入 `{workspace}/.claude_proxy/settings.json`。**不影响插件内视图、不写全局 `~/.claude/settings.json`、不影响已打开的其他终端会话。** active 标记只决定下次终端启动用哪条配置，切换不触发 reload。

- 在 `workspace_local_llm_config` 分组上点 `$(add)` 新建（仅开 workspace 时可见）。
- 编辑器内有「从 global 导入」下拉：选一条 global 配置即把它的 name/content 填入，可再编辑。
- 行内支持 switch / edit / delete。
- proxy 模式的 local 配置在终端启动时同样走本地代理（注入上游 + 合成 localhost settings）。

### 从旧版 cc-switch 迁移

扩展改名 `cc-switch → claude-code-proxy` 后，VS Code 按 publisher.id 分配了新 globalStorage 目录。首次激活会自动检测旧 `zaczh.cc-switch` 命名空间下的 `configs.json` / `active.json` 并复制到新目录，无需手动操作。

---

## 1.5 派生节点 + 运行时模型切换（v1.2.0+）

派生节点是从一条 **workspace-local** 配置派生出的"虚拟配置节点"，目的是**不重启 Claude Code CLI 就能切换真实模型**。

### 为什么需要

Claude Code CLI 的模型配置有三套独立机制（`ANTHROPIC_MODEL` env / `/model` 命令 / `ANTHROPIC_DEFAULT_*_MODEL`），启动后 session 内冻结，运行中改 settings 不换当前会话主模型。要"运行时切模型"，只能在**请求层**动手——给 CLI 配固定的假模型名（别名），代理拦截请求把别名替换成真实模型，映射表可在线热更新。这样切模型只需改代理映射表，下个请求就生效，不重启 CLI。

### 怎么用

1. 在一条 local 配置上点 `$(git-branch)`（派生）按钮，向代理申请一个全局唯一编号 N。
2. 派生编辑器里配四档映射 + 会话档位：
   - **Main 档**（主对话模型，走 `ANTHROPIC_MODEL`）：别名 `ccp-main-N` → 真实模型。
   - **Haiku / Sonnet / Opus 档**（子 agent alias，走 `ANTHROPIC_DEFAULT_*_MODEL`）：别名 `ccp-<tier>-N` → 真实模型。
   - **会话档位**：标准 200K 或 1M（别名带 `[1m]` 后缀，CLI 据此算 contextWindow）。默认从父配置的 `ANTHROPIC_MODEL` 是否带 `[1m]` 继承。
3. 四档映射默认从父配置继承；改任一档下拉值**即时同步到代理映射表**，刷新树，下个请求生效，无需重启 CLI、无需关闭编辑面板。
4. 点 `Save & 启动` 启动该派生节点的隔离 CLI 会话（终端 name 带 `#N`）。

派生节点**强制走代理**（别名只有经代理 `rewriteModel` 才会被重写为真实模型名；直连会把别名原样打到上游 → model not found）。继承父上游快照（防父删/改断链），BASE_URL/token 走 settings.env，别名走 shell env（session 内冻结）。

### 硬约束（不可逾越）

派生节点 / 模型别名机制受 Claude Code CLI 行为的物理约束，详见 `docs/model-aliasing-constraints.md`。关键几条：

- **代理换 model 对 CLI contextWindow 决策零影响**（请求层 vs 决策层分离）：CLI 按**别名**算 contextWindow，代理在请求层换 model 只影响发往上游的请求。跨 contextWindow 档位切（200K↔1M）会脱节——只弹通用警告，不硬拦。
- **`[1m]` 是 CLI 识别 contextWindow 档位的唯一信号**：别名带 `[1m]` → CLI 按 1M 算；不带 → 200K。代理映射表 key 一律不带后缀（CLI 发请求时剥掉 `[1m]`，代理剥后缀查表）。
- **`/model` 命令脱离代理感知**：用户在 CLI 内用 `/model` 改的模型会脱离别名体系，代理替换对主对话失效（子 agent 三档仍受控）。代理/扩展侧运行时检测不到，只能编辑页 main 行 hover 静态提示。
- **子 agent 三档别名稳定可追踪**：子 agent 不认 `/model`，代理能稳定识别 `ccp-haiku-N`/`ccp-sonnet-N`/`ccp-opus-N` 按 N 关联会话（trace 已记 `model` 原始别名 + `resolvedModel` 映射后真实模型）。

### 树结构

派生节点挂在父 local 配置下展开（`viewItem = derived-config`），description 显示四档摘要 `M:.. · S:.. · H:.. · O:..`。孤儿派生（父已删）标 ⚠ 禁启动。父删时弹确认是否级联删派生节点 + 清代理映射表四条。

---

## 2. 本地 LLM 代理

### 工作机制

- **进程内常驻**：代理跑在 VS Code 扩展宿主进程里，跟着 VS Code 生命周期。
- **单例**：开多个 VS Code 窗口只有一个实际跑代理（靠端口 bind），其他窗口只心跳监听。
- **2s 心跳接管**：宿主窗口关了导致代理停，其他窗口 2s 内接管拉起。
- **精确重试**：代理只重试 Claude Code 处理不了的——`HTTP 503` + body `error.code === 10310`（讯飞 system busy）。其余全部透传交给 Claude Code 自己处理：429/500/502/504（CC 当 5xx 重试）、网络错误/超时/断连/流中断（CC 当 APIConnectionError 重试，代理合成 502 回客户端）。可在控制台调 `retryOnStatus`/`retryOnBodyErrorCode`。
- **流式增量转发**（1.0.3+）：代理对上游响应（含 SSE）边收边转发给客户端，token 逐个到达，不再整体延迟到上游 `end`。body-error 重试仍生效——错误 body（实测 ~132 字节、合法 JSON、必在首个 chunk）在 `writeHead` 前就判出并丢弃重试；成功 SSE 首 chunk 非 JSON → 不误判、立即流式转发。
- **模型别名重写**（1.2.0+，派生节点用）：代理对请求 body 的 `model` 字段做热替换——CLI 配的是固定别名（`ccp-main-N` / `ccp-<tier>-N`，可能带 `[1m]`），代理剥掉 `[1m]` 后查映射表替换成真实模型名，下个请求生效。映射表可经扩展编辑页或 `/api/model-alias` 接口在线改、热重载，不重启代理。见 §1.5 派生节点。
- **跨平台**：`extensionKind: workspace`，WSL 里代理和 Claude Code 同 localhost。

### 端口（按平台分默认）

| 平台 | 默认端口 |
|---|---|
| Windows (`win32`) | `11434` |
| 原生 Linux / WSL (`linux`) | `11435` |
| macOS (`darwin`) | `11436` |

端口可在 Web 控制台改（写 config + 关监听，宿主心跳 2s 内自动重起生效）。范围 `1024..65535`。

### Trace 存储

- **写时分流**：每条 trace 落两个 JSONL——`.idx.jsonl`（瘦摘要 + body 定位指针）和 `.body.jsonl`（完整 trace）。
- **200MB 分片**：胖体文件写满 200MB 滚到下一个序号，跨天序号重置。文件名按中国时间（UTC+8）分组。
- **四档过滤**：`all` / `retried` / `failed` / `llm-error`。
- **7 天保留**：启动时 + 写入时清理过期文件，按天整组删。
- **日志目录可配**：控制台可改 trace/日志目录，立即生效。

---

## 3. Workspace 隔离的 Claude CLI 会话

点侧边栏视图标题栏的 `$(terminal)` 图标，或按 `Ctrl+Shift+Alt+C`（mac `Cmd+Shift+Alt+C`），在终端打开一个 workspace 隔离的 Claude Code CLI：

- 自动定位官方 `anthropic.claude-code` 扩展的 `claude.exe`（Windows）/ `claude`（Linux/macOS）完整路径，不依赖 PATH。
- `CLAUDE_CONFIG_DIR` 环境变量指向 `{workspace}/.claude_proxy/`，该会话状态独立于全局。
- 用当前 workspace-local active 配置写 `.claude_proxy/settings.json`；无 local active 则不写，claude 用默认。
- 自动合并 `bypassPermissions` 到项目级 `.claude/settings.local.json`。
- 首次建 `.claude_proxy/` 时若 workspace 是 git 仓库，自动把 `.claude_proxy/` 加进 `.gitignore`（检测 `.git` 目录，不依赖 git 命令）。

**跨平台 shell**：Windows 强制 PowerShell（`& "完整路径"`）；Linux/macOS 用平台默认 bash。env 用 `createTerminal` 的 `env` 选项进程级注入，跨 shell 无需区分语法。

---

## 用法

1. 点活动栏的 **Claude Code Proxy** 图标。
2. **+ New LLM Config**（global 分组）或 workspace-local 分组的 `$(add)`，填名字 + settings.json 内容，选连接模式，保存。
3. 点配置行激活。global 激活会写全局 settings + Reload；local 激活只是标记。
4. 命令面板 `LLM 代理: 打开控制台`（或点状态栏云朵图标）打开 Web 控制台。
5. 点 `$(terminal)` 或快捷键在终端启动 workspace 隔离 Claude。

### 状态栏

- `$(arrow-swap) CC: <名字> (代理|直连)`：当前激活的 **global** 配置。
- `$(cloud) 代理:本窗口运行|其他窗口运行|未运行`：代理宿主状态。

### 命令面板

| 命令 | 作用 |
|---|---|
| `Launch Workspace-Isolated Claude` | 终端启动 workspace 隔离 Claude（`Ctrl+Shift+Alt+C`） |
| `LLM 代理: 打开控制台` | 打开 Web 控制台（重试参数 + Trace + 别名映射表） |
| `LLM 代理: 重启代理` | 关闭监听，宿主心跳 2s 内自动重起 |
| `LLM 代理: 切换本窗口 backup proxy 开关` | 本窗口代理开关 |
| `LLM 代理: 诊断 proxy-agent 劫持` | 一键诊断代理接口（验证裸 socket 读写全链路 + http 栈对照），输出到 output 面板 |
| `Export Configs` / `Import Configs` | 导入/导出 **global** 配置 |

派生节点命令（树视图按钮触发，不常从命令面板调）：

| 命令 | 作用 |
|---|---|
| `New Derived Config` | 从 local 配置派生（申请编号 N + 开配置页） |
| `Edit (Derived)` | 编辑派生节点四档映射 + 会话档位 |
| `Launch Derived Claude` | 启动派生节点的隔离 CLI 会话 |
| `Delete (Derived)` | 删派生节点 + 清代理映射表四条 + 关联活终端 |

### Settings

| Setting | Default | Description |
|---|---|---|
| `claude-code-proxy.configFilePath` | `""` | 覆盖全局 Claude `settings.json` 路径，留空自动检测（全平台 `~/.claude/settings.json`，含 WSL）。 |
| `claude-code-proxy.claudeBinaryPath` | `""` | 覆盖终端启动用的 Claude CLI 二进制路径，留空自动从 `anthropic.claude-code` 扩展探测。 |

global 切换会先备份原 `settings.json`，toast 提供 **Reload Window** / **Undo**。

## 开发

```bash
npm install
npx tsc -p ./                              # 编译 TS 到 out/（CommonJS）
node --test proxy/test/ test/derived-logic/test.mjs test/mock-cli/test/  # 全量测试
npx @vscode/vsce package                  # 打包 .vsix
```

### 模块结构

- `src/`：VS Code 扩展 TS（编译到 `out/`，CommonJS）。
  - `proxyHost.ts`：代理宿主（ESM `import` proxy/server.js 进扩展进程，非子进程）+ 调代理接口的 wrapper（统一裸 `net` socket `rawHttp`，绕过扩展宿主 http 栈对本地响应 body 的吞没，详见 CLAUDE.md「空 body 坑」）。
  - `claudeLauncher.ts`：启动 workspace 隔离 CLI（`CLAUDE_CONFIG_DIR` + 别名走 shell env + token 走 settings.env）。
  - `derivedLogic.ts`：派生节点纯逻辑（继承快照、别名 env 构造、映射表同步、档位继承），抽出独立可单测。
  - `treeProvider.ts` / `webviewEditor.ts` / `localConfigStore.ts`：配置树 / 编辑器（含派生节点四档映射 UI）/ 存储。
  - `types.ts`：`ModelAliasMapping`（四档 main/haiku/sonnet/opus）+ `LLMConfig`（派生节点字段 + `sessionContext1m` 档位）。
- `proxy/`：本地 LLM 代理（ESM JS，不进 tsc）。
  - `server.js`：转发主路径 + `rewriteModel`（别名替换，剥 `[1m]` 查表）+ `rewriteEffort` + API 接口（所有 `res.end` 出口显式 `Content-Length`）。
  - `config-store.js`：配置读写 + 热重载 + modelAliases 映射表 + nextAliasId 计数器。
  - `trace-store.js`：trace 写时分流（`model` 原始别名 + `resolvedModel` 映射后真实模型）。
- `test/mock-cli/`：Claude Code CLI 配置加载层等价重实现（探针 + 假设验证，source of truth 是 CLI 源码）。
- `test/derived-logic/`：派生节点纯逻辑单测。
- `docs/`：设计文档与约束。
  - `claude code cli运行时model切换方案.md`：运行时 model 切换主方案。
  - `model-aliasing-constraints.md`：model aliasing 7 条硬约束（CLI 行为物理边界，改动必读）。

代理核心零依赖，扩展宿主用动态 `import()` 加载（详见 [docs/pitfall-esm-dynamic-import.md](docs/pitfall-esm-dynamic-import.md)）。TS 源在 `src/`，编译到 `out/`。
