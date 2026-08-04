# 独立后端形态 — 手动验证指南

> 本文档教你如何手动验证 `claude-code-proxy` 的独立后端形态（脱离 VS Code，纯 Node + 浏览器运行）。
> 适用：开发自测 / 发布前冒烟。VS Code 插件形态不在此文档范围。

## 前置准备

```bash
# 1. 编译 TS → out/（独立形态依赖 out/ 编译产物）
npm run compile

# 2. 确认 node-pty + ws 已装（阶段 3 引入的运行时依赖）
node -e "require('node-pty'); require('ws'); console.log('deps OK')"
# 若报错：npm install

# 3. 确认系统装了 Claude Code CLI（二选一）
#    a) 全局安装：npm install -g @anthropic-ai/claude-code  →  which claude 有值
#    b) VS Code 装了 anthropic.claude-code 扩展（独立后端会扫描扩展目录）
claude --version  # 或 where claude / which claude
```

## ⚙ 指定端口验证（不关正在运行的插件）——推荐先用这个

**场景**：你的 VS Code 插件代理正占着默认端口 11434，不想关它，又想验证独立后端。

**关键概念**：
- **CCP_HOME**：独立后端的根目录环境变量，所有数据放它下面（`proxy-config.json` / `logs/` / `workspaces.json`）。不设时默认 `~/.claude-code-proxy/`（即 `C:\Users\HONOR\.claude-code-proxy\`）。
- **proxy.listenPort**：`$CCP_HOME/proxy-config.json` 里的字段，决定代理转发端口。
- **management 端口** = proxy 端口 + 100（固定，无单独配置项，见 `standalone/ports.js`）。
- 默认端口 win32→11434/11534，和你 VS Code 插件代理撞 → 必须**换端口**。

**步骤**：预设一个临时 CCP_HOME + 临时端口（如 11444，management 自动 11544），三全其美：不碰插件配置、不撞插件端口、用完即删。

```bash
# 1. 建临时目录 + 预设端口 11444 的 proxy-config.json
#    （Windows bash / WSL / git-bash 都行；纯 PowerShell 用下面的等价命令）
mkdir -p /tmp/ccp-test
cat > /tmp/ccp-test/proxy-config.json <<'JSON'
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "你的真实token",
    "ANTHROPIC_BASE_URL": "你的真实上游",
    "API_TIMEOUT_MS": "600000",
    "ANTHROPIC_MODEL": "你的真实model"
  },
  "effortLevel": "max",
  "proxy": {
    "listenHost": "127.0.0.1",
    "listenPort": 11444,
    "maxAttempts": 20,
    "backoffSec": 3,
    "backoffMaxSec": 16,
    "passthrough": false,
    "retryRules": [{"status":503,"code":10310},{"status":200,"code":10310}]
  }
}
JSON

# 2. 启动（CCP_HOME 指向临时目录）
CCP_HOME=/tmp/ccp-test node standalone/cli.js
```

启动后：
- 代理转发：http://127.0.0.1:11444/
- **management 网页**（workspace 管理 + 配置编辑 + CLI 终端）：http://127.0.0.1:11544/（= 11444+100）
- 你插件的 11434 完全不受影响 ✅

> **Windows 纯 PowerShell 等价命令**（heredoc 在 PS 里语法不同）：
> ```powershell
> New-Item -ItemType Directory -Force C:\tmp\ccp-test | Out-Null
> @'
> { "env": { "ANTHROPIC_AUTH_TOKEN":"你的token", "ANTHROPIC_BASE_URL":"你的上游", "API_TIMEOUT_MS":"600000", "ANTHROPIC_MODEL":"你的model" }, "effortLevel":"max", "proxy": { "listenHost":"127.0.0.1", "listenPort":11444, "maxAttempts":20, "backoffSec":3, "backoffMaxSec":16, "passthrough":false, "retryRules":[{"status":503,"code":10310},{"status":200,"code":10310}] } }
> '@ | Set-Content C:\tmp\ccp-test\proxy-config.json -Encoding UTF8
> $env:CCP_HOME = "C:\tmp\ccp-test"
> node standalone/cli.js
> ```

> **不想填真实 upstream？** 直接留空（`"ANTHROPIC_BASE_URL":""`）也能起后端，management 网页/配置编辑/CLI 终端都能验证，只是真发 LLM 请求会失败（用来验证转发链路足够）。

## 方式 A：直接 node 跑（开发自测，最快）

```bash
# 用临时 CCP_HOME，避免污染你真实在跑的 VS Code 插件代理（默认 ~/.claude-code-proxy/）
# ⚠ 若你 VS Code 插件正开着、占着默认端口 11434，独立后端会 EADDRINUSE（预期，退避 re-spawn 不崩）
#   要避免冲突：改 proxy-config.json 的 listenPort 成别的端口

# 启动（前台，看日志）
node standalone/cli.js

# 或指定 CCP_HOME
CCP_HOME=/tmp/ccp-test node standalone/cli.js
```

启动成功日志（正常）：
```
[standalone] 配置: /tmp/ccp-test/proxy-config.json
[standalone] 日志: /tmp/ccp-test/logs
[standalone] 代理已启动：http://127.0.0.1:11434/ （浏览器访问控制台）
[standalone] workspace 管理 API + 网页：http://127.0.0.1:11534/
```

## 方式 B：npm 全局安装后跑（验证发布形态）

```bash
# 本地全局安装（package.json 的 bin 生效）
npm install -g .

# 现在 claude-code-proxy 命令可用
claude-code-proxy
# 等价于 node standalone/cli.js，但走 npm 生成的 bin shim

# 卸载
npm uninstall -g claude-code-proxy
```

## 验证清单（逐项手动确认）

> 以下端口按默认 11434/11534 写。若你按上面「指定端口验证」用了 11444，请把 11434→11444、11534→11544 替换。

启动后端后，浏览器打开 **http://127.0.0.1:11534/**（management 端口，workspace 管理页）。

### 1. 代理转发层（proxy，端口 11434）

| 项 | 操作 | 预期 |
|---|---|---|
| healthz | `curl http://127.0.0.1:11434/healthz` | `{"ok":true,"upstream":"...","ts":"..."}` |
| 控制台网页 | 浏览器开 http://127.0.0.1:11434/ | 显示「LLM Gateway」控制台（trace/统计/重试参数/effort/端口/日志） |
| upstream 注入 | 控制台网页改 upstream（或激活 proxy 配置，见下） | `/healthz` 的 upstream 字段更新 |

### 2. Workspace 管理（management，端口 11534）

| 项 | 操作 | 预期 |
|---|---|---|
| 管理页 | 浏览器开 http://127.0.0.1:11534/ | 显示 workspace 列表页（新建/删除表单） |
| 创建 workspace | 填 name + 一个**真实存在的磁盘目录**（如 `D:/code/myproj`）→ 创建 | 提示「已创建」+ 该目录下生成 `.claude_proxy/` |
| 列出 | 刷新 | 显示刚建的 workspace 卡片 + 其 local 配置 |
| 删除 | 点删除 | 索引移除，磁盘 `.claude_proxy/` 保留（不删文件） |
| 重复创建同目录 | 同目录再建一次 | 拒绝（一对一约束） |

### 3. 配置编辑（local config CRUD + 别名）

| 项 | 操作 | 预期 |
|---|---|---|
| 新建配置 | workspace 卡片或访问 `/workspace/<id>/configs/new/edit` → 填 name + mode + content(JSON) → 保存 | 配置存入 `.claude_proxy/local-configs.json` |
| 编辑配置 | 点已有配置的编辑页 → 改 name/content → 保存 | 更新生效 |
| content JSON 校验 | 填非法 JSON → 保存 | 禁用保存按钮 + 错误提示 |
| derived 创建 | 用 API 或后续网页建 derived（需先有普通配置当父） | derived 强制 proxy，继承父别名 + 快照 |
| 别名即时生效 | derived 编辑页改某档别名模型 → change | POST /api/model-alias 转发到 proxy，下个请求生效 |
| 别名清空 | 清空某档别名 input → change | 走 /alias/delete 删除映射 |

> 别名编辑是前端 JS 动态渲染，编辑页静态 HTML 含 cfg JSON 数据。

### 4. 激活配置（写 settings.json + 注入 upstream）

| 项 | 操作 | 预期 |
|---|---|---|
| direct 激活 | POST `/api/workspaces/<id>/configs/<cfgId>/activate`（direct 配置） | 写 `.claude_proxy/settings.json`（原样 content）+ active 标记 + bypassPermissions + .gitignore |
| proxy 激活 | 同上（proxy 配置，content 含 BASE_URL/TOKEN） | 注入 upstream 到 proxy + 合成 settings（BASE_URL→localhost:11434）+ 写盘 |
| 激活后查 active | GET `/api/workspaces/<id>/active` | 返回 `{id, mode}` |
| 切换激活 | 激活另一 config | active 标记更新 |

curl 示例：
```bash
# 激活
curl -X POST http://127.0.0.1:11534/api/workspaces/<wsId>/configs/<cfgId>/activate
# 查 active
curl http://127.0.0.1:11534/api/workspaces/<wsId>/active
```

### 5. CLI 会话（xterm.js 交互式终端）

| 项 | 操作 | 预期 |
|---|---|---|
| 打开终端页 | workspace 卡片点「打开终端」或访问 `/workspace/<id>/terminal` | 显示 xterm.js 终端页 |
| 自动启动会话 | 终端页加载 | 自动 POST 启动 claude-session + 连 WS |
| 交互 | 在终端里输入 | claude CLI 响应（TUI 正常，未降级） |
| 转发走代理 | （若已激活 proxy 配置）CLI 发请求 | 请求经 127.0.0.1:11434 代理转发，控制台 trace 可见 |
| 停止会话 | DELETE `/api/workspaces/<id>/claude-session` | PTY 进程退出 |
| 重连 | 关闭终端页再开 | 新 WS 连到同一会话（若会话还活着）或新起 |

> ⚠ 真实 PTY/conpty 集成不进 `node --test`（node-pty handle 卡 event loop），**必须手动验证此项**。

### 6. 生命周期 / 守护

| 项 | 操作 | 预期 |
|---|---|---|
| crash 自恢复 | kill 代理子进程（`kill <proxy pid>`） | 2s 心跳检测不通 → re-spawn，healthz 恢复 |
| 端口被占退避 | 启动时端口已被占 | EADDRINUSE 退出 + 心跳指数退避 re-spawn（不刷屏） |
| 优雅关闭 | Ctrl+C（SIGINT） | 停所有 PTY 会话 + 停代理子进程 + 退出 |
| disposed 不泄漏 | 关闭过程中 | 心跳不再 spawn 新子进程 |

## 常见问题

**Q: 启动报 EADDRINUSE 11434？**
A: 你的 VS Code 插件代理正占着 11434。改 `~/.claude-code-proxy/proxy-config.json` 的 `proxy.listenPort` 成别的端口（如 11435），或关掉 VS Code 插件。

**Q: 终端页提示「未找到 Claude Code CLI 二进制」？**
A: 系统没装 claude，且 VS Code 没装 anthropic.claude-code 扩展。装其一，或在 management 网页指定二进制绝对路径（阶段 3 探测顺序：用户指定 > 系统 PATH > VS Code 扩展）。

**Q: 跑测试会不会污染我正在运行的代理？**
A: 不会。所有 `test/standalone/*.test.mjs` 用临时 CCP_HOME + 临时端口，不连真实代理 11434。激活测试用临时端口 11621 起独立临时代理子进程。已验证跑全量后全局 `proxy-config.json` md5 不变。

**Q: management 网页和 proxy 控制台是两个端口？**
A: 是。proxy 转发（11434）+ 控制台网页在 proxy 端口；workspace 管理 + 配置编辑 + CLI 终端在 management 端口（11534，= proxy+100）。两者独立，management 不污染 proxy 转发核心。
