# M1 正交场景设计：server.js 入口接收 CCP_* env + kill 退出语义

> 任务：让 server.js 能作为独立子进程被 spawn 启动（接收 CCP_* env 路径），并让 /api/kill 在子进程模式下干净退出进程（而非空转）。
> 用 dev-with-tdd-review 流程。基线：303 pass / 0 fail / 1 skipped（2026-08-02）。

## 改动面（两处）

### A. 入口（isMainModule，server.js:894-902）
- env 命名统一：`CONFIG_PATH` → `CCP_CONFIG_PATH`；新增 `CCP_LOGS_DIR` / `CCP_LOGS_CONFIG_PATH`。
- 三路径传给 `startServer({ configPath, logsDir, logsConfigPath })`。
- 子进程模式标记：`startServer` 加 `exitOnKill: true`（子进程入口传，测试不传）。

### B. kill 退出（/api/kill 579-587 + /api/port POST 564-578）
- 现状：`setImmediate(() => runningServer?.close?.())` → 只关监听，进程空转。
- 子进程模式（`exitOnKill=true`）：`setImmediate(() => process.exit(0))` → 进程退出，宿主心跳 re-spawn。
- in-proc 模式（测试，`exitOnKill` 默认 false）：保持 `server.close()`（测试进程不能 exit）。

## 正交维度

### 维度 1：调用方模式 × env 传参
两条独立路径：
- **D1 子进程入口**：`isMainModule` + `CCP_*` env → startServer 收到三路径 + exitOnKill=true。
- **D2 in-proc 测试 import**：直接调 `startServer({ configPath, logsDir, logsConfigPath })`，不传 exitOnKill → 默认 false。
- **D3 CLI 直接 `node server.js`**：无 CCP_* env → 走默认 `./config.json`（向后兼容，CLI 模式仍可用）。

### 维度 2：kill 触发路径 × 退出行为
- **D4 /api/kill 子进程模式**：→ process.exit(0)。
- **D5 /api/kill in-proc 模式**：→ server.close()（不退出进程）。
- **D6 /api/port POST 子进程模式**：改端口后 → process.exit(0)（端口改了必须重启，子进程退出让宿主 re-spawn 新端口）。
- **D7 /api/port POST in-proc 模式**：→ server.close()。

### 维度 3：env 缺省/边界
- **D8 CCP_CONFIG_PATH 缺省**：子进程入口未传 → fallback 默认 `./config.json`（不崩）。
- **D9 CCP_LOGS_DIR 缺省**：未传 → logsDir=undefined → startServer 内部走默认 LOG_DIR（已有逻辑）。
- **D10 CCP_LOGS_CONFIG_PATH 缺省**：未传 → logsConfigPath=undefined → 不调 setLogsConfigPath（已有逻辑）。
- **D11 旧 CONFIG_PATH env 仍存在**（向后兼容）：`mock/test-*.mjs`（test-model/test-stream/test-logs/test-effort/test-port，5 个 spawn 子进程测试）都依赖 `CONFIG_PATH`。**决定：入口同时认 CCP_CONFIG_PATH（优先）和 CONFIG_PATH（fallback），不破坏 mock 测试。** 新扩展子进程用 CCP_*，老 mock 测试用 CONFIG_PATH，两不耽误。CLI 直接 `node server.js` 无 env 走默认 config.json。

### 维度 4：退出时序
- **D12 kill 先回 200 再退出**：`sendJson(200)` 后 `setImmediate(process.exit)` —— 响应必须先发出，否则客户端拿不到 200（已有注释说明，需回归）。
- **D13 退出时未关闭句柄**：process.exit(0) 强制退出，是否有未 flush 的 trace 写入丢失？（traceStore.append 是同步 writeFileSync，process.exit 不影响已同步的写入；但若 kill 时正好有 in-flight 请求转发中，会截断——这是 kill 的固有行为，不回归。）

## 测试用例（按维度覆盖）

> 在 `proxy/test/server-entry-kill.test.mjs` 新建。用 in-proc import startServer（测 D2/D5/D7 路径）+ 直接 spawn 子进程（测 D1/D4/D6/D8）。

1. **D2 in-proc startServer 不传 exitOnKill** → 默认 false，/api/kill 后 server.close 不退出进程（healthz 不通但测试进程活着）。
2. **D5 in-proc /api/kill** → 调 /api/kill，200 响应能拿到，之后 healthz 不通（监听关了），测试进程不退出（能继续断言）。
3. **D7 in-proc /api/port POST** → 改端口，200 响应，旧端口 healthz 不通。
4. **D1+D4 spawn 子进程 + /api/kill** → spawn server.js（CCP_* env），healthz 通后 POST /api/kill，拿到 200，子进程 exit(0)。
5. **D1+D6 spawn 子进程 + /api/port POST** → POST 改端口，200，子进程 exit(0)。
6. **D8 spawn 子进程不传 CCP_CONFIG_PATH** → fallback 默认 config.json，仍能 listen（向后兼容）。
7. **D9 spawn 子进程不传 CCP_LOGS_DIR** → listen 正常，日志走默认目录。
8. **D12 kill 响应时序** → /api/kill 必须先返回 200 再退出（客户端能拿到 200 body，不是连接复位）。
9. **D11 向后兼容** → 确认代码库无别处依赖旧 CONFIG_PATH（grep 确认，可能无测试）。
10. **D3 CLI 模式** → `node server.js` 无 env，走默认 config.json，listen 成功（已被 V1-a 验证，补一个测试固化）。

## 高风险维度复核
- 状态转换：D4/D5/D6/D7（kill/port 改监听状态）✓ 有边界用例（D12 时序）
- 异常路径：D8/D9 缺省 ✓
- 时序：D12 ✓
- 幂等：kill 两次？第二次 healthz 已不通，wrapper 报「代理未运行」——这是 ProxyHost 层逻辑，M1 不覆盖（M2/M3）
- 边界：D8/D9/D10 缺省 ✓
