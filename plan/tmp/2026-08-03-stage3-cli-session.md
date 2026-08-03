# 阶段 3 正交场景设计 — claude 二进制探测 + CLI 会话 spawn（xterm.js）

> 日期：2026-08-03
> 任务：阶段 3，CLI 会话交互式终端
> 硬约束：VS Code 形态 428 用例不破；不碰 src/ 下 VS Code 形态代码；proxy/ 不动

## 设计决策（先定的点）

### 二进制探测：包一层，不改 claudeBinary.ts

新建 `standalone/claudeBinaryStandalone.js`，导出 `resolveClaudeBinaryStandalone(opts)`：
- 来源①用户覆盖（透传给 `resolveClaudeBinary`）
- 来源③系统 PATH：遍历 `process.env.PATH`（`path.delimiter` 分隔），Windows 找 `claude.exe`/`claude.cmd`/`claude.bat`，Unix 找 `claude` + `X_OK` 权限检查
- 来源④VS Code 扩展目录扫描：`~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/`，多版本取最新（semver 比较），扫到目录后作为 `vscodeExtensionPath` 传给 `resolveClaudeBinary` 复用来源②拼路径逻辑

**探测顺序**（决策 7）：用户覆盖 > 系统 PATH > VS Code 扩展目录 > null。注意：与 `resolveClaudeBinary` 原顺序（用户 > 扩展 > null）不同，独立形态把系统 PATH 提到扩展前面（系统装的 claude 优先于 VS Code 扩展里的）。

### PTY 会话：node-pty

- `node-pty.spawn(binaryPath, [], { cwd: workspaceDir, env: { ...process.env, CLAUDE_CONFIG_DIR } })`
- PTY 让 claude CLI 以为在真终端（TUI 不降级）
- 每个会话一个 pty 进程，`Map<workspaceId, SessionHandle>`
- SessionHandle: `{ pty, pid, startedAt, wsClients: Set }`（一个会话可多个 WS 客户端连，如多 tab 看同一会话）

### WebSocket 协议

- 端点：`/api/workspaces/:id/claude-session/ws`
- 升级成 WS 后：
  - PTY `onData` → 广播到所有 wsClients（binary frame）
  - WS `on('message')` → PTY `write`（用户输入）
  - WS `on('close')`：从 wsClients 移除；最后一个客户端断开**不杀 PTY**（会话保持，可重连）
  - PTY `onExit` → 广播退出事件到 wsClients + 从 Map 移除 + 关闭所有 WS

### 会话生命周期

- `POST /api/workspaces/:id/claude-session` → 启动会话（若已有则复用，返回 sessionId）
- `DELETE /api/workspaces/:id/claude-session` → kill PTY + 移除
- `GET /api/workspaces/:id/claude-session` → 状态（running/stopped + pid + startedAt）
- WS 升级前若会话不存在 → 自动启动（或拒绝？**拒绝，要求先 POST**，避免 WS 隐式创建难追踪）

### xterm.js 前端

- `standalone/web/claude-terminal.html`（由 managementServer 的某路由 serve，如 `GET /workspace/:id/terminal`）
- xterm.js 从 CDN 加载（不本地装 npm 包，简化）或本地 vendored。**首版用 CDN**（`https://cdn.jsdelivr.net/npm/xterm@5`），离线再考虑 vendored
- 前端开 WS 连 `/api/workspaces/:id/claude-session/ws`，双向流

### 复用 claudeLauncher 的配置准备逻辑

独立形态 spawn 前也要做 VS Code 形态 launch() 的配置准备：
- `ensureGitignore(workspaceDir)` — 纯 fs，可复用（但它在 claudeLauncher.ts 里是 private 方法，绑 vscode。**抽出来到 standalone 或复制逻辑**）
- `ensureProjectPermissions(workspaceDir)` — 同上
- 写 `.claude_proxy/settings.json`（local active 配置合成）— 这部分依赖 proxyHost，独立形态用 HTTP 调代理 API

**阶段 3 范围收缩**：配置准备（settings.json 合成 + upstream 注入 + 别名同步）逻辑较重，且依赖 proxy HTTP API 客户端。**阶段 3 先做最小可用：spawn claude + CLAUDE_CONFIG_DIR + cwd + env，不写 settings.json（claude 用默认）**。完整的 settings.json 合成（proxy 模式 + 派生节点）留后续——因为那需要独立形态的 proxyHost HTTP 客户端 + 复用 resolveSettingsContent/synthesizeDerivedSettings，是另一块工作。

这样阶段 3 的 spawn 是"裸 claude 会话"（CLAUDE_CONFIG_DIR 指向 .claude_proxy/，但不预写 settings.json）。用户可在 .claude_proxy/ 里手动放 settings.json，或后续阶段补自动合成。

## 正交维度

### D1 二进制探测来源

- D1a：用户覆盖存在 → 返回用户路径
- D1b：用户覆盖不存在 → 降级系统 PATH
- D1c：系统 PATH 找到 → 返回 PATH 中的路径
- D1d：系统 PATH 没找到 → 降级 VS Code 扩展目录
- D1e：VS Code 扩展目录扫描到 → 返回最新版的二进制
- D1f：都没找到 → null
- D1g：优先级顺序（用户 > PATH > 扩展）

### D2 系统 PATH 遍历

- D2a：PATH 含 claude → 找到第一个匹配
- D2b：PATH 不含 claude → 返回 null
- D2c：PATH 为空/undefined → 返回 null（不崩）
- D2d：Windows 找 .exe/.cmd/.bat 三种扩展名
- D2e：Unix X_OK 权限检查（无执行权限的跳过）
- D2f：PATH 多个目录都有 claude → 返回第一个（PATH 顺序优先）

### D3 VS Code 扩展目录扫描

- D3a：扩展目录存在 + 多版本 → 取最新（semver）
- D3b：扩展目录存在 + 单版本 → 返回该版本
- D3c：扩展目录不存在 → 返回 null
- D3d：扩展目录存在但无 anthropic.claude-code-* → 返回 null
- D3e：版本目录存在但 native-binary/claude 缺失 → 跳过该版本
- D3f：semver 比较正确（1.10.0 > 1.9.0，非字典序）

### D4 PTY 会话生命周期

- D4a：启动会话 → PTY spawn + 入 Map + 返回 sessionId
- D4b：重复启动同 workspace → 复用已有（不重复 spawn）
- D4c：停止会话 → kill PTY + 出 Map
- D4d：停止不存在的会话 → 拒绝/无操作
- D4e：PTY 自然退出 → onExit 清 Map + 通知 WS 客户端
- D4f：workspace 不存在 → 启动拒绝

### D5 WebSocket 双向流

- D5a：WS 升级 + 会话存在 → 建立，PTY onData 广播到 WS
- D5b：WS message（用户输入）→ PTY write
- D5c：WS close → 移除客户端，PTY 保持（可重连）
- D5d：PTY exit → 广播退出 + 关闭所有 WS
- D5e：会话不存在时 WS 升级 → 拒绝（404 或 close code）
- D5f：多 WS 客户端连同一会话 → 都收到 PTY 输出

### D6 二进制不可用时的处理

- D6a：resolveClaudeBinaryStandalone 返回 null → POST 启动会话返回错误（不 spawn）
- D6b：PTY spawn 失败（二进制存在但执行报错）→ 记日志 + 返回错误

### D7 cleanup / 进程退出

- D7a：standalone 收 SIGINT/SIGTERM → kill 所有活 PTY 会话
- D7b：会话 Map 内存不泄漏（PTY exit 后条目移除）

## 高风险维度对照

| 高险类别 | 适用维度 | 说明 |
|---|---|---|
| 状态转换 | D4 | 会话 spawn/stop/exit 状态机 |
| 异常/错误路径 | D6, D3e, D4f | 二进制不可用、workspace 不存在、spawn 失败 |
| 时序/竞态 | D5, D4e | WS 握手与 PTY exit 竞争、多 WS 客户端并发、PTY exit 与 cleanup 竞争 |
| 空/null/初始态 | D2c, D3c, D1f | PATH 空、扩展目录不存在、都没找到 |
| 幂等性 | D4b | 重复启动复用 |
| 边界输入 | D2d/e, D3f | 扩展名候选、semver 比较 |

## 用例选取（Step 3 依据）

- D1a-g：探测来源优先级（多来源组合）
- D2a-f：PATH 遍历各情况
- D3a-f：扩展目录扫描各情况
- D4a-f：会话生命周期
- D5a-f：WS 双向流
- D6a-b：二进制不可用
- D7a-b：cleanup

## 范围收缩说明

阶段 3 不做 settings.json 自动合成（proxy 模式 upstream 注入 + 派生节点别名）。spawn 的是"裸 claude 会话"（CLAUDE_CONFIG_DIR + cwd + env，不预写 settings.json）。完整的配置合成留后续（需独立形态 proxyHost HTTP 客户端 + 复用 resolveSettingsContent/synthesizeDerivedSettings）。

xterm.js 首版用 CDN 加载（不本地 vendored），离线场景后续优化。
