# 阶段 1 正交场景设计 — 独立后端入口骨架

> 日期：2026-08-03
> 任务：阶段 1，standalone/main.js 入口骨架
> 硬约束：VS Code 形态 362 用例不破；不碰 src/ 下 VS Code 形态代码

## 产物

`standalone/main.js`（ESM JS，不进 tsc）。职责：

1. 加载/初始化公共 proxy-config（config 不存在则写默认，幂等）
2. mkdir logsDir
3. cleanEnv 生成 env（createRequire 从 out/cleanEnv.js 加载）
4. spawnProxyChild spawn proxy/server.js（createRequire 从 out/proxySpawnController.js 加载）
5. 单进程守护：2s 心跳 healthz 自检，崩了 re-spawn
6. 不 serve 网页（server.js 自己 serve proxy/web/）

## 默认 config 模板

照 proxyHost.ts 第 601-624 行 DEFAULT_PROXY_CONFIG 复刻（127.0.0.1 + 平台端口）：

```js
{
  env: { ANTHROPIC_AUTH_TOKEN:'', ANTHROPIC_BASE_URL:'', API_TIMEOUT_MS:'600000', ANTHROPIC_MODEL:'' },
  effortLevel: 'max',
  proxy: { listenHost:'127.0.0.1', listenPort:<平台端口>, maxAttempts:20, backoffSec:3, backoffMaxSec:16, passthrough:false, retryRules:[{status:503,code:10310},{status:200,code:10310}] }
}
```

- 平台端口：win32→11434 / linux→11435 / darwin→11436（与 proxyHost DEFAULT_PORT 一致，避免同机 WSL 冲突）
- 不写 modelAliases/nextAliasId（config-store 兜底 `{}`/`0`）

## 配置/日志目录

- 默认 `~/.claude-code-proxy/`（`os.homedir()/.claude-code-proxy/`）
  - `proxy-config.json`
  - `logs/`（trace JSONL）
  - `logs/logs-config.json`
- 支持环境变量覆盖：`CCP_HOME`（自定义根目录）。便于测试用临时目录。

## 正交维度

### D1 配置初始化（config 文件存在性）

- D1a：config 不存在 → 写默认 config（含正确端口/字段）→ 后续 spawn 能读
- D1b：config 已存在 → **不覆盖**（幂等，保留用户已改的 upstream/aliases）
- D1c：config 已存在但内容非法（损坏 JSON）→ 当前阶段不处理（server.js 会崩，守护 re-spawn 也起不来；属用户数据问题，记日志即可）。**阶段 1 不深究，记日志 + 让 spawn 失败可见。**

### D2 目录初始化

- D2a：logsDir 不存在 → mkdir recursive 创建
- D2b：logsDir 已存在 → 不报错（mkdir recursive 幂等）
- D2c：根目录（CCP_HOME）不存在 → 连同 config/logs 一起创建

### D3 spawn 就绪

- D3a：spawn 后 server.js 正常 listen → handle 返回非 null → healthz 通
- D3b：spawn 后 server.js 启动失败（如端口被占 EADDRINUSE）→ handle 返回 null → 不应崩 main.js，记日志
- D3c：serverPath 错误（server.js 不存在）→ spawn 触发 error 事件 → handle null

### D4 守护心跳 + re-spawn

- D4a：子进程正常跑 → 心跳 healthz 通 → 不动作
- D4b：子进程 crash（被外部 kill）→ onExit 触发 → 心跳下次 tick 检测 healthz 不通 → re-spawn
- D4c：re-spawn 守卫：re-spawn 进行中（spawning=true）不重入
- D4d：disposed（main.js 收到 SIGINT/SIGTERM 退出）→ 心跳不再 spawn + stop 现有 handle

### D5 生命周期 / 信号

- D5a：SIGINT → disposed=true + 清心跳 + stop handle + 退出
- D5b：SIGTERM → 同上
- D5c： disposed 后心跳 tick 不再 spawn（防退出过程中泄漏子进程）

### D6 平台端口

- D6a：win32 → 11434
- D6b：linux → 11435
- D6c：darwin → 11436

## 高风险维度对照

| 高风险类别 | 适用维度 | 说明 |
|---|---|---|
| 状态转换 | D4 | spawning→spawned→crashed→re-spawning |
| 异常/错误路径 | D3b/D3c, D1c | spawn 失败、config 损坏 |
| 时序/竞态 | D4c/D4d/D5c | re-spawn 重入、disposed 与 spawn 竞争、心跳与退出竞争 |
| 空/null/初始态 | D1a/D2a/D2c | 首次启动全空 |
| 幂等性 | D1b/D2b | config/logsDir 已存在不破坏 |
| 边界输入 | D6 | 平台端口边界 |

## 用例选取（Step 3 依据）

每个独立维度 ≥1 用例，高风险维度加边界：

- D1a：config 不存在 → 建出含正确字段的 config
- D1b：config 已存在 → 不覆盖（保留原内容）
- D2a/c：根目录不存在 → 连同 logs 一起创建
- D3a：spawn 正常 → healthz 通
- D3b：端口被占 → handle null + main 不崩
- D4b：crash → 心跳 re-spawn 恢复 healthz
- D4c：re-spawn 重入守卫（crash 后单次 tick 不重复 spawn）
- D4d/D5c：disposed → 心跳不 spawn
- D5a：SIGINT → stop handle + 退出
- D6：平台端口（win32/linux/darwin 三值，单测纯函数 platformPort()）
- D1c：config 损坏 → 记日志（不崩 main.js）

## 设计决策

- **测试入口**：把 standalone/main.js 的核心逻辑（建 config、建目录、spawn、心跳、生命周期）抽成可 import 的函数，而不是全塞进顶层 IIFE。这样测试能 import 单元测，不必每次真起 main.js。具体：导出 `ensureConfig(homeDir)`、`platformPort(platform)`、`createStandaloneBackend(opts)` 等。main.js 顶层只在"直接运行"时调启动逻辑（仿 server.js 的 isMainModule 模式）。
- **心跳复用 healthz**：从 out/proxySpawnController.js 取 healthz（裸 socket），2s 间隔。
- **re-spawn 守卫**：spawning 布尔 + disposed 布尔，照 proxyHost 模式。
- **信号处理**：SIGINT/SIGTERM → disposed + stop + exit(0)。
