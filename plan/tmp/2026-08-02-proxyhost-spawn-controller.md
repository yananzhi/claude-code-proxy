# M2 正交场景设计：ProxyHost 改造为控制器（spawn 子进程）

> 任务：把 ProxyHost 的 tryBecomeHost 从「in-proc import + startServer」改成「spawn 独立子进程 + 轮询 healthz 就绪」，子进程用 Code.exe + 净化env + ELECTRON_RUN_AS_NODE。rawHttp/healthz/所有 wrapper 一行不动。
> 用 dev-with-tdd-review 流程。依赖 M1（server.js 入口 CCP_* + exitOnKill）。

## 现状关键代码（proxyHost.ts）

- `tryBecomeHost`（489-522）：`import('../proxy/server.js')` + `startServer({configPath, logsDir, logsConfigPath})` → `this.handle = {server, port, host, stop}`。EADDRINUSE catch 当从机。
- `heartbeatTick`（524-552）：宿主自检 `healthz(this.handle.port)`，不通则 `handle.stop()` + 重起；从机探测 `healthz(port)`，不通则接管。
- `deactivate`（126-136）：`handle.stop()`。
- `ProxyHandle` 接口（54-59）：`{ server: unknown; port: number; host: string; stop: () => Promise<void> }`。
- `proxyModule` 字段（85）：缓存 ESM 模块。
- `rawHttp` / `healthz`（裸 socket）：所有 wrapper 用，**不动**。

## 改造点

### A. 新增 cleanEnv() 工具函数
净化 process.env：删 `NODE_OPTIONS`/`VSCODE_*`/`ELECTRON_*`/`CHROME_*`/`PIPE`（V1-f 验证过的死锁元凶），保留其余系统变量。加 `ELECTRON_RUN_AS_NODE='1'` + `CCP_CONFIG_PATH`/`CCP_LOGS_DIR`/`CCP_LOGS_CONFIG_PATH`。

### B. ProxyHandle 接口改 ChildProcess 化
`handle` 从 `{server, port, host, stop}` 变成 `{ child: ChildProcess; port: number; stop: () => Promise<void> }`。`stop` = `child.kill()` + 等退出。
- `proxyModule` 字段删除（不再 import）。
- `handle.port` 保留（spawn 时从 config 读，心跳自检用）。

### C. tryBecomeHost 改 spawn
- 删 `import('../proxy/server.js')`。
- `spawn(process.execPath, [serverPath], { env: cleanEnv(...), stdio:['ignore','pipe','pipe'], windowsHide:true })`。
- `serverPath = path.join(extensionPath, 'proxy', 'server.js')`。
- 子进程 stdout/stderr → OutputChannel（line 缓冲）。
- 就绪检测：轮询 `healthz(port)`，最多 ~5s，通=宿主成功；不通+子进程 exit → 看作启动失败。
- EADDRINUSE：子进程 exit(1) + 别的窗口 healthz 通 → 当从机（和现在逻辑一致）。
- 成功 → `this.handle = { child, port, stop }`。

### D. heartbeatTick 不变逻辑
- 宿主自检：`healthz(this.handle.port)` 不通 → `handle.stop()`（kill child）+ 清 handle + re-spawn（tryBecomeHost）。
- 从机探测：`healthz(port)` 不通 → tryBecomeHost（spawn）。
- 关键：子进程 crash（child exit）→ heartbeatTick 下次自检 healthz 不通 → re-spawn。但更快：监听 `child.on('exit')` 主动清 handle，不必等 2s 心跳。

### E. deactivate
`handle.stop()` = `child.kill()`。Windows 无信号，`child.kill()` → TerminateProcess。

## 正交维度

### 维度 1：启动结果 × 就绪检测
- **D1 spawn 后 listen 成功** → 轮询 healthz 通 → 宿主。
- **D2 spawn 后子进程 exit(1)（EADDRINUSE，别的窗口在跑）** → healthz 不通 + 别的窗口 healthz 通 → 当从机。
- **D3 spawn 后子进程 exit(1)（config 错误/其他 FATAL）** → healthz 不通 + 没别的窗口 → 启动失败，状态栏「未运行」，下次心跳重试。
- **D4 spawn 后子进程 hang（既不 listen 也不 exit）** → 轮询 5s 超时 → 视为失败，kill 子进程，下次心跳重试。
- **D5 spawn 后 listen 成功但 healthz 探测有延迟** → 轮询多次（100ms × 50）覆盖启动慢。

### 维度 2：生命周期事件
- **D6 子进程运行中 crash（child.on('exit') 触发）** → 清 handle，下次心跳 re-spawn。
- **D7 deactivate** → child.kill()，子进程退出。
- **D8 kill wrapper（POST /api/kill）** → 子进程 exitOnKill 触发 process.exit(0) → child.on('exit') → 清 handle → 心跳 re-spawn。
- **D9 改端口 POST /api/port** → 子进程 exit(0) → 清 handle → 心跳用新端口 re-spawn。

### 维度 3：env 净化
- **D10 cleanEnv 删 NODE_OPTIONS** → 子进程不死锁。
- **D11 cleanEnv 删 VSCODE_*/ELECTRON_*/CHROME_*** → 无 IPC handle 干扰。
- **D12 cleanEnv 保留 PATH** → 子进程能找到依赖（虽然 server.js 无外部依赖，但保留系统变量是安全的）。
- **D13 cleanEnv 设 ELECTRON_RUN_AS_NODE=1** → Code.exe 当纯 Node 跑。
- **D14 cleanEnv 设 CCP_* 路径** → 子进程读到正确 config/logs 路径。

### 维度 4：stdout/stderr 转发
- **D15 子进程 stdout（concise 日志）→ OutputChannel** → 用户能看到日志。
- **D16 子进程 stderr（FATAL）→ OutputChannel** → 能诊断启动失败。
- **D17 stdout 大量输出不阻塞子进程** → OutputChannel.appendLine 不阻塞（VS Code 内部缓冲）。

### 维度 5：多窗口协调不变
- **D18 窗口 A 宿主，窗口 B 从机**（B spawn 失败因 A 占端口）。
- **D19 A 关闭 → B 接管**（A deactivate kill child，B 心跳探测不通 re-spawn）。
- 这部分 M3 回归，M2 单测覆盖 D1-D9 + D10-D17。

## 测试策略

M2 改的是 `src/proxyHost.ts`（TS，跑在扩展宿主）。**单元测试难**——它依赖 vscode API + 扩展宿主环境。但 `cleanEnv()` 是纯函数，可抽出来单测。

- **抽 cleanEnv 到独立可测函数**（proxyHost.ts 内或单独 util），单测 D10-D14：给 dirty env，断言净化结果。
- **spawn + healthz 就绪逻辑**：难单测（需扩展宿主）。M3 用扩展开发宿主手动验证 D1/D6/D8/D18/D19。
- D15-D17 stdout 转发：M3 手动验证。

## 高风险维度复核
- 状态转换：D1-D9（启动/退出/crash/kill 各种状态）✓
- 异常路径：D3/D4（启动失败/hang）✓
- 时序：D5（就绪延迟）/D6（crash 检测时机）/D8（kill 先回 200 再 exit）✓
- 边界：D4（hang 超时）✓
- 与既有代码不一致：cleanEnv 命名、handle 接口变更对 wrapper 的影响（wrapper 用 rawHttp 不用 handle，应无影响）✓
