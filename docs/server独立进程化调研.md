# Server 独立进程化 — 调研文档

> 目标（第一阶段）：把 `proxy/server.js` 从「Extension Host 进程内 ESM 模块」变成「独立 Node 子进程」，主要收益是**让测试脱离 VS Code host**，可以写大量自动化用例；同时为将来脱离 VS Code 铺路。
>
> 本文档只调研方案，不改代码。

---

## 1. 现状：Server 不是子进程，是进程内 ESM 模块

### 1.1 加载方式

`src/proxyHost.ts:506` 里：

```ts
this.proxyModule = await import('../proxy/server.js') as ProxyModule;
this.handle = await this.proxyModule.startServer({
    configPath, logsDir, logsConfigPath,
});
```

- `proxy/package.json` 声明 `"type": "module"`，`server.js` 是 ESM。
- `import('../proxy/server.js')` 用**相对路径**（不是 `pathToFileURL` 绝对 file://），原因是 VS Code 扩展宿主（Electron）对带 `file://` scheme 的字符串走 CJS require 拦截路径会报 `Cannot find module 'file://'`。相对路径让 Node 按 `proxy/package.json` 的 `type:module` 当 ESM 加载，三平台一致（`proxyHost.ts:496-509` 注释）。
- `startServer()` 返回 `{ server, port, host, stop }`，`server` 是 `http.Server` 实例，**直接在 Extension Host 进程里监听端口**。

### 1.2 进程关系

```
VS Code
 └── Extension Host (Electron Node)
       └── extension.js (out/, CJS)
             └── ProxyHost
                   └── import('../proxy/server.js')  ← 同进程
                         └── http.createServer().listen(11434)
```

server 崩了 = Extension Host 崩；server 占的内存/句柄都在宿主进程里。

### 1.3 与宿主的通信

扩展侧调代理接口**不走 http 栈**——因为扩展宿主 http 栈对 `127.0.0.1` 响应 body 单向吞没（CLAUDE.md 关键陷阱）。所有 wrapper 走**裸 `net` socket**（`proxyHost.ts:443 rawHttp`）：

- `getModelAliases` / `setModelAlias` / `removeModelAlias` / `nextAliasId` → `rawHttp('GET'|'POST', '/api/...')`
- `setUpstream` → `rawHttp('POST', '/api/upstream')`
- `kill` → `rawHttp('POST', '/api/kill')`
- `healthz(port)` → 裸 socket `GET /healthz`（`proxyHost.ts:584`）

**关键结论**：扩展↔server 的通信通道**已经是 HTTP over localhost**，只是用裸 socket 实现。独立进程化后，这条通道**完全不用改**——子进程监听同一个端口，裸 socket 照样连得上。这是整个改造能低成本落地的核心前提。

### 1.4 生命周期 & 多窗口协调

`ProxyHost` 的「宿主/从机」机制（`proxyHost.ts:81-575`）：

- **单例靠端口 bind**：`startServer` listen 时 `EADDRINUSE` → 本窗口当从机（`proxyHost.ts:515`）。
- **心跳 2s**：宿主自检 `/healthz`，断了重启；从机探测宿主，断了接管（`heartbeatTick`）。
- **开关**：`setEnabled(on)` 控本窗口是否启动/接管（`proxyToggle`）。
- **kill**：`POST /api/kill` 让运行中的 server `server.close()`，宿主心跳 2s 内重起（`server.js:544`）。
- **deactivate**：`handle.stop()` 关监听，其他窗口心跳接管。

这套机制**全是基于「端口占用 + healthz 探测」的进程间协调**，不依赖 server 在哪个进程里。所以独立进程化后，多窗口协调逻辑**天然仍然成立**——只是「宿主窗口」现在 spawn 一个子进程，而不是 in-proc 起 server。

### 1.5 server.js 已有 CLI 入口

`server.js:860-868`：

```js
const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  const cfgPath = process.env.CONFIG_PATH || new URL('./config.json', import.meta.url);
  startServer({ configPath: ... }).catch((e) => {
    concise(`FATAL: ${e.message}`);
    if (e.code === 'EADDRINUSE') concise(`  port already in use ...`);
    process.exit(1);
  });
}
```

**`node proxy/server.js` 已经能独立跑**——这是独立进程化的另一个核心前提：server.js 本身已经设计成可独立运行，扩展只是用 `import` 复用了它的 `startServer`。

### 1.6 配置/日志路径注入

扩展通过 `startServer` 参数注入三个路径（`proxyHost.ts:95-98`）：

- `configPath` = `globalStorageUri/proxy-config.json`
- `logsDir` = `globalStorageUri/logs`
- `logsConfigPath` = `globalStorageUri/logs-config.json`

`config-store.init(configPath)` 读配置；`traceStore.setLogDir/setLogsConfigPath` 设日志目录。CLI 入口目前只传 `configPath`（靠 `CONFIG_PATH` env），不传 logsDir/logsConfigPath——走默认。

独立进程化后，这三个路径要通过 **spawn 的 env 或命令行参数**传给子进程，子进程在 `isMainModule` 入口里接收并转给 `startServer`。

### 1.7 现有测试怎么起 server

`proxy/test/server-alias-e2e.test.mjs:40-44`：

```js
async function startProxy(configPath, logsDir) {
    const mod = await import('../server.js');
    const handle = await mod.startServer({ configPath, logsDir, logsConfigPath: ... });
    return handle;
}
```

**测试也是 in-proc import**——测试进程内加载 server.js、起 server、用 `fetch` 打 `127.0.0.1:port`。

- `fetch` 在普通 Node 进程里**不会被扩展宿主 http 栈吞 body**（那是 Electron 特有行为），所以测试里 `fetch` 能正常拿 body。
- 测试用 `PROXY_PORT=11499` 避开真实代理端口 11434-11436。
- mock 上游用 `http.createServer` 起 `11500`。

**纯逻辑单测**（`config-store-alias.test.mjs`、`review-suspects.test.mjs`、`code-review-ms3.test.mjs`）直接 `import * as cs from '../config-store.js'`，不起 HTTP，测的是模块函数。

---

## 2. 独立进程化方案

### 2.1 总体架构（第一阶段目标）

```
VS Code
 └── Extension Host
       └── ProxyHost（控制器）
             │ spawn(process.execPath, [server.js], { env })
             ↓
       Independent Server Process（Node）
             └── http.createServer().listen(11434)
             │
   通信：扩展侧裸 net socket → 127.0.0.1:11434（通道不变）
```

扩展侧 `ProxyHost` 从「in-proc 起 server」变成「spawn 子进程 + 管生命周期」。通信通道（裸 socket HTTP）**零改动**。

### 2.2 用 VS Code 自带 Node Runtime（`process.execPath`），不打包二进制

调研结论与你一致：

- **用 `process.execPath`**：VS Code 自带 Node，`spawn(process.execPath, [serverPath])` 即可。不依赖用户系统装 Node，零额外体积，三平台兼容。
- **不打包 Node 二进制**（pkg/nexe/SEA）：会增 40-80MB × 6 平台，发布复杂度爆炸。第一阶段完全没必要。

> 注意一个潜在坑：`process.execPath` 在 VS Code 里**是 Electron 的可执行**，不是纯 Node。Electron 运行普通 Node 脚本时，需要 `ELECTRON_RUN_AS_NODE=1` env 才会以纯 Node 模式跑（否则可能带 Electron 运行时行为）。这是独立进程化要验证的头号风险点（见 §4.1）。如果 `process.execPath` 是 Electron，spawn 时要带 `env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }`。

### 2.3 spawn 入口设计

server.js 的 `isMainModule` 入口要扩展，接收扩展注入的路径。两种传参方式：

**方式 A：env 传参（推荐）**

扩展侧：
```ts
spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',           // 若 execPath 是 Electron
    CCP_CONFIG_PATH: this.configPath,
    CCP_LOGS_DIR: this.logsDir,
    CCP_LOGS_CONFIG_PATH: this.logsConfigPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

server.js `isMainModule` 入口：
```js
if (isMainModule) {
  startServer({
    configPath: process.env.CCP_CONFIG_PATH || defaultConfigPath,
    logsDir: process.env.CCP_LOGS_DIR || undefined,
    logsConfigPath: process.env.CCP_LOGS_CONFIG_PATH || undefined,
  }).catch(...process.exit(1));
}
```

优点：env 传参不占 `argv`，`isMainModule` 判断（基于 `argv[1]`）不受影响；扩展侧不用拼命令行；和现有 `CONFIG_PATH` env 思路一致（可统一命名空间）。

**方式 B：命令行参数**

`spawn(process.execPath, [serverPath, '--config', path, '--logs', dir])`，server.js 用 `process.argv` 解析。

缺点：要写 argv 解析；`isMainModule` 判断要小心 `argv` 偏移。不推荐。

### 2.4 ProxyHost 改造点（控制器化）

`ProxyHost` 内部从「持 `handle`（in-proc server 句柄）」变成「持 `child`（ChildProcess）」：

| 现状（in-proc） | 改造后（子进程） |
|---|---|
| `import('../proxy/server.js')` 动态加载 | `spawn(process.execPath, [serverPath], {env})` |
| `this.handle = await startServer(...)` | `this.child = spawn(...)` + 等监听就绪信号 |
| `this.handle.stop()` → `server.close()` | `this.child.kill()`（SIGTERM） |
| `EADDRINUSE` 从 `startServer` reject 拿到 | 从子进程 stderr / 退出码拿到 |
| `proxyModule` 缓存（reload window 才重载） | 不需要——每次 spawn 都是全新进程，**改了 proxy 代码 spawn 即生效**（额外收益） |

**关键设计：怎么知道子进程 listen 成功？**

in-proc 时 `startServer` 返回 Promise 在 `listen` 回调里 resolve。子进程化后，扩展侧 spawn 是同步返回的，**listen 成功/失败要靠子进程通知**。三种方式：

1. **轮询 `/healthz`**（最简单，复用现有 `healthz()`）：spawn 后循环探测 `healthz(port)`，通了即就绪；超时即失败。和现有心跳机制天然吻合。
2. **解析 stdout**：子进程 `concise('proxy listening on ...')` 那行（`server.js:834`）写到 stdout，扩展侧监听 `child.stdout` 看到这行即就绪。EADDRINUSE 等也走 stderr。
3. **就绪信号文件/IPC**：子进程 listen 成功写一个 ready 文件或发 IPC 消息。

**推荐方式 1（轮询 healthz）**：零新增协议、复用现有 `healthz()`、和心跳统一。代价是 spawn 后有个 ~50-200ms 的探测窗口，但扩展侧本来就有 2s 心跳节奏，完全可接受。失败检测靠「轮询超时 + 子进程提前 exit（exit 事件）」双保险。

**EADDRINUSE 判定**：spawn 后若端口被占（别的窗口已起），子进程会 `process.exit(1)`（`server.js:866`）。扩展侧监听 `child.on('exit')`：若在就绪前 exit 且 code=1，结合 stderr 含 `EADDRINUSE` → 当从机。这比 in-proc 时 catch EADDRINUSE 稍繁，但可行。

### 2.5 多窗口协调：不变

现有「端口 bind 单例 + 心跳接管」机制完全基于进程间端口探测，独立进程化后：

- 窗口 A spawn 子进程 listen 11434 成功 → A 是宿主。
- 窗口 B spawn 子进程 → listen 失败 EADDRINUSE → 子进程 exit → B 当从机，只保心跳。
- A 的子进程崩了 → A 心跳探测 healthz 不通 → A 重新 spawn。
- A 关闭 → `deactivate` kill 子进程 → B 心跳探测不通 → B spawn 接管。

**唯一差别**：从机窗口现在也会 spawn 一个「立刻 exit」的短命子进程（因为 EADDRINUSE）。为避免每 2s 心跳都 spawn 一次空子进程，**从机应该先 `healthz` 探测，通了就不 spawn**（现有 `tryBecomeHost` 已经是这逻辑：`if (await healthz(port)) return;` 在 spawn 之前，`proxyHost.ts:493`）。所以从机不会反复 spawn——只在真正需要接管时才 spawn。✅

### 2.6 kill / 重启语义

- `POST /api/kill`（`server.js:544`）：子进程 `server.close()` 后**进程不退出**（`isMainModule` 入口里 `startServer` 的 Promise 不会因 `server.close` resolve/reject，进程空转）。这会变成「子进程活着但没监听」的僵尸态。
  - **需要改**：`/api/kill` 在独立进程模式下应该 `process.exit(0)` 让子进程退出，宿主心跳发现 healthz 不通重新 spawn。或者在 server.js 入口给 `stop()` 加一个「close 后 exit」的钩子。
  - 这是独立进程化要顺带调整的点（见 §3.2）。
- 扩展侧 `kill()` wrapper（`proxyHost.ts:206`）调 `/api/kill` 的语义不变——让运行中的 server 停监听，宿主重起。只是「重起」从 in-proc `startServer` 变成 re-spawn。

### 2.7 日志/stdout 处理

子进程 `stdio: ['ignore', 'pipe', 'pipe']`：

- `concise()` 走 `console.log` → stdout（`logger.js:1-4`）。扩展侧应把 `child.stdout` 接到 `output` OutputChannel，保留实时日志可见性。
- `detail()` 走文件（`logs/trace-*.log`），不受进程化影响。
- stderr 接 OutputChannel，便于诊断 EADDRINUSE / FATAL。

注意：in-proc 时 `concise` 直接打到 Extension Host 的 console；子进程化后要主动 pipe，否则日志丢。

---

## 3. 对测试的影响（第一阶段核心收益）

### 3.1 现有测试分类与改造

| 测试 | 现状起 server 方式 | 独立进程化后 |
|---|---|---|
| `config-store-alias.test.mjs` | 不起 HTTP，`import` 模块函数 | **不变**（纯逻辑） |
| `review-suspects.test.mjs` | 同上 | **不变** |
| `code-review-ms3.test.mjs` | `import trace-store` | **不变** |
| `server-alias-e2e.test.mjs` | `import('../server.js')` in-proc + `fetch` | 可选改造为 spawn 子进程 |
| `trace-store.test.mjs` | `import trace-store` | **不变** |

**关键认知**：纯逻辑单测（直接 import 模块函数）**完全不受独立进程化影响**——它们测的是 `config-store.js` / `trace-store.js` 的导出函数，不需要 server 在跑。这些测试已经能脱离 VS Code 跑了（`node --test`）。

真正「需要 server 在跑」的 e2e 测试（`server-alias-e2e`）目前是 in-proc import。独立进程化后有两种选择：

**选择 1：e2e 测试也改成 spawn 子进程**

```js
async function startProxy(configPath, logsDir) {
  const child = spawn(process.execPath, ['../server.js'], {
    env: { ...process.env, CCP_CONFIG_PATH: configPath, CCP_LOGS_DIR: logsDir, ... },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 轮询 healthz 就绪
  await waitForHealthz(port);
  return { child, stop: () => child.kill() };
}
```

收益：测试路径与扩展 spawn 路径**完全一致**，测的就是真实独立进程行为（包括 ELECTRON_RUN_AS_NODE、env 传递、stdout、exit 处理）。这是「让测试脱离 VS Code host」的最完整形态。

**选择 2：e2e 测试保持 in-proc import**

不变。测试进程是普通 Node，`fetch` 不被吞 body，in-proc 起 server 测得很好。

**推荐**：第一阶段两者并存。in-proc import 保留给快速逻辑验证（快、能直接拿 handle）；新增一个 spawn 子进程的 e2e 套件验证「独立进程启动/通信/退出」这条链路本身。这样既不破坏现有测试，又覆盖了新架构。

### 3.2 新增可写的自动化用例（独立进程化解锁的）

独立进程化后，可以写一批**以前难写**的用例（因为以前 server 在 host 进程里，没法测进程级行为）：

- **进程崩溃恢复**：kill 子进程 → 宿主（或测试里的控制器）心跳发现 → re-spawn → 恢复。
- **EADDRINUSE 从机化**：先起一个子进程占端口，再 spawn 第二个 → 第二个应 exit(1) → 当从机。
- **kill/restart 语义**：`POST /api/kill` → 子进程退出 → 重新 spawn → 新进程接上配置（从 config.json 读回 modelAliases 等）。
- **stdout/stderr 通路**：子进程 `concise` 输出能被控制器收到。
- **配置热重载跨进程**：子进程跑着，改 config.json，下个请求生效（验证 config-store 的 watch 逻辑在独立进程里仍工作）。
- **多客户端并发**：多个 fetch 并发打子进程 server，验证 trace 分流不串。

这些用例把 server 当黑盒进程测，是「脱离 VS Code」的最直接验证。

---

## 4. 风险与待验证点

### 4.1 🔴 `process.execPath` 是 Electron 还是纯 Node（头号风险）

VS Code 的 `process.execPath` 通常是 Electron 可执行。Electron 跑普通 Node 脚本需 `ELECTRON_RUN_AS_NODE=1`，否则可能：
- 带 Electron 运行时（GPU、窗口初始化开销）。
- 某些 Node API 行为差异。
- ESM 加载行为可能不同（Electron 的 ESM 支持历史上有坑）。

**验证手法**：在扩展里 `console.log(process.execPath, process.versions.electron)`。若有 `process.versions.electron`，spawn 必须带 `ELECTRON_RUN_AS_NODE: '1'`。

> 备选：若 Electron 作 Node 跑 ESM 有问题，可用 `process.execPath` + `--experimental-vm-modules` 或退而求其次用系统 Node 探测。但首选 `ELECTRON_RUN_AS_NODE`，最稳。

### 4.2 🟡 ESM 在子进程的加载

`server.js` 是 ESM（`proxy/package.json` `type:module`）。子进程 `node proxy/server.js`：
- 普通 Node 直接跑 ESM 文件**没问题**（Node ≥ 14 原生支持，工程要求 `@types/node ^20`）。
- 但若 `process.execPath` 是 Electron + `ELECTRON_RUN_AS_NODE`，要验证 Electron 版本的 Node 是否支持 ESM。VS Code 1.80+ 的 Electron 应该够新，但需实测。
- `isMainModule` 判断（`pathToFileURL(process.argv[1]).href === import.meta.url`）在子进程里要确认 `process.argv[1]` 是绝对路径（spawn 传绝对路径即可）。

### 4.3 🟡 `/api/kill` 后子进程不退出

见 §2.6。`server.close()` 只关监听，进程空转。独立进程模式下需要 `/api/kill` 触发 `process.exit`，否则宿主心跳永远探测不通、但子进程还活着占内存。

**改法**（实施阶段）：`server.js` 入口里给 `startServer` 返回的 `stop()` 加一个「close 后 process.exit(0)」选项，或 `/api/kill` handler 里 `setImmediate(() => process.exit(0))`。要区分「扩展调 kill 想重起」vs「deactivate 想彻底停」——前者靠宿主 re-spawn，后者靠 `child.kill()`。

### 4.4 🟡 stderr 解析 EADDRINUSE

in-proc 时 `startServer` reject `EADDRINUSE` 是结构化错误（`err.code`）。子进程化后只能从 stderr 文本解析，或靠「exit code=1 + 端口被占」推断。稍脆但可接受——其实从机化判定可以**不靠 stderr**：spawn 后轮询 healthz，若 **别的进程**已 healthz 通 → 当从机；若自己 listen 成功 → 宿主。EADDRINUSE 时自己的子进程 exit、别的窗口 healthz 通，自然判为从机。stderr 只作日志。

### 4.5 🟢 通信通道不变

裸 socket HTTP 通道（`rawHttp` / `healthz`）**完全不受影响**——子进程监听同端口，裸 socket 照连。这是改造最大保险。

### 4.6 🟢 配置/日志路径注入

靠 env 传三个路径（§2.3），子进程入口接收。和 in-proc 参数注入等价，无风险。

### 4.7 🟡 Windows 子进程清理

Windows 上 `child.kill()` 默认发 SIGTERM 但 Windows 无信号，Node 会 `TerminateProcess`。`deactivate` 时要确保子进程被 kill，否则残留进程占端口。`server.js` 的 `openInFileManager` 用 `detached:true` + `unref()`（`server.js:568`）——那是给资源管理器用的，server 子进程**不要** detached，要跟着宿主生命周期。

---

## 5. 实施阶段建议步骤（仅规划，不在本次执行）

1. **验证 §4.1**：扩展里打印 `process.execPath` / `process.versions.electron`，确定是否需要 `ELECTRON_RUN_AS_NODE`。
2. **扩展 server.js 入口**：`isMainModule` 接收 env 路径参数；`/api/kill` 触发 `process.exit`（§4.3）。
3. **新增 `ServerManager`**（或改造 `ProxyHost`）：`spawn` + `healthz` 轮询就绪 + `child.on('exit')` 处理 + stdout→OutputChannel。`rawHttp`/`healthz`/wrapper 全部不动。
4. **保留 in-proc 路径作 fallback？**：可考虑加个开关，独立进程跑挂了能退回 in-proc。但增加复杂度，第一阶段可不保留。
5. **新增 spawn 模式 e2e 测试**（§3.1 选择 1）：验证独立进程启动/通信/退出/崩溃恢复。
6. **现有 e2e 测试**保持 in-proc，不破坏。
7. **更新 CLAUDE.md**：架构速览里 `proxyHost.ts` 描述从「ESM import 进扩展进程」改成「spawn 独立子进程」；空 body 坑章节补充「独立进程后扩展侧裸 socket 仍必须，因为宿主 http 栈吞 body 行为不变」。

---

## 6. 一句话结论

**独立进程化成本可控**：server.js 已有 CLI 入口、扩展↔server 通信已是裸 socket HTTP（不依赖 in-proc）、多窗口协调已基于端口探测。核心改造是把 `ProxyHost` 的 `import + startServer` 换成 `spawn + healthz 轮询就绪 + child 生命周期管理`，通信层零改动。头号风险是 `process.execPath` 的 Electron/Node 身份（§4.1），需先验证。测试收益：纯逻辑单测本就脱离 host；独立进程化后新增 spawn 模式 e2e + 进程级行为（崩溃恢复/从机化/kill 重启）用例，把 server 当黑盒进程测，是「脱离 VS Code」最直接的验证。

---

# 执行计划

> 独立进程化有若干**不可绕过的前置验证点**——任何一个不打通，后续计划就要返工。所以分三阶段：阶段 0 关键验证（探索性，必须先打通）→ 阶段 1 最小可用 → 阶段 2 测试与收尾。每个验证点标了「通了怎样 / 不通怎样」。

## 阶段 0：关键验证（先搞，逐个打通）

### V1 🔴 `process.execPath` 在扩展宿主里的身份 + ESM 加载

**为什么先搞**：整个方案的前提是「spawn 出来的进程能以纯 Node 跑 ESM server.js」。如果 `process.execPath` 是 Electron 且 `ELECTRON_RUN_AS_NODE=1` 下 ESM 有坑，方案要返工。

**怎么验证**：写一个临时 VS Code 命令（或临时改 `activate`），在扩展宿主里：
1. 打印 `process.execPath`、`process.versions.electron`、`process.versions.node`。
2. `spawn(process.execPath, [server.js绝对路径], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CCP_CONFIG_PATH: <tmp>, CCP_LOGS_DIR: <tmp> } })`，监听 stdout/stderr/exit。
3. 轮询 `healthz(11499)` 看子进程是否 listen 成功。
4. 用裸 socket `rawHttp` 打 `/api/config` 看是否拿到 body。

**通了怎样**：子进程 listen 成功 + 裸 socket 拿到完整 body → 确认 `ELECTRON_RUN_AS_NODE` 方案可行，进入 V2。
**不通怎样**：
- 若不带 `ELECTRON_RUN_AS_NODE` 就能跑 → 不需要这个 env（更简单）。
- 若带 `ELECTRON_RUN_AS_NODE` 仍 ESM 失败 → 退路：探测系统 `node`（`which node` / `where node`）作 fallback；或 server.js 临时编译成 CJS。但这是退路，先验证主方案。

### V2 🟡 `/api/kill` 子进程退出语义

**为什么先搞**：in-proc 时 `server.close()` 只关监听、进程空转没问题（宿主还能再 startServer）。子进程化后 `server.close()` 会让进程变僵尸（活着不监听），宿主心跳探测不通但又 kill 不掉语义混乱。这是必须改的点，要先确认改法可行。

**怎么验证**：在 V1 的临时命令里，子进程 listen 后 `POST /api/kill`，观察：
- 现状：子进程是否还活着（`child.on('exit')` 不触发）？
- 改 `server.js` `/api/kill` handler 加 `setImmediate(() => process.exit(0))` 后，子进程是否干净退出？

**通了怎样**：`/api/kill` → 子进程 exit(0) → 宿主心跳探测不通 → re-spawn。语义清晰。
**不通怎样**：若有未关闭的句柄导致 `process.exit` 前还有残留，再排查。

### V3 🟡 EADDRINUSE 从机化判定

**为什么先搞**：多窗口单例靠这个。in-proc 时 `startServer` reject 结构化 `err.code === 'EADDRINUSE'`；子进程化后要从「子进程 exit + 别的 healthz 通」推断。

**怎么验证**：先 spawn 一个子进程占 11499，再 spawn 第二个 → 第二个应 exit(1)（`server.js:866`）。观察 stderr 是否含 `EADDRINUSE`，以及第二个子进程 exit 时机。

**通了怎样**：确认从机判定逻辑可行（先 healthz 探测，通了不 spawn；自己 spawn 后 exit 且别人 healthz 通 = 从机）。
**不通怎样**：若 exit 信号不可靠，靠「spawn 后 N ms 内 healthz 是否通 + 自己子进程是否还活着」组合判定。

## 阶段 1：最小可用（V0 全通后）

### M1 扩展 server.js 入口接收 env 路径

- `isMainModule` 入口读 `CCP_CONFIG_PATH` / `CCP_LOGS_DIR` / `CCP_LOGS_CONFIG_PATH`，转给 `startServer`。
- `/api/kill` 改为 `process.exit(0)`（V2 验证过的改法）。
- 保留 in-proc `startServer` 导出不变（测试还要用）。

### M2 改造 ProxyHost 为控制器

把 `tryBecomeHost` 里的 `import + startServer` 换成：
- `spawn(process.execPath, [serverPath], { env, stdio })`，env 含 V1 验证过的 `ELECTRON_RUN_AS_NODE`（若需要）+ 三个路径。
- `child.stdout`/`stderr` → OutputChannel。
- 就绪：轮询 `healthz(port)`（复用现有函数），超时 = 启动失败。
- `child.on('exit')`：若本窗口是宿主 → 清 handle，下个心跳 re-spawn。
- `deactivate`：`child.kill()`。
- `handle` 字段从「server 句柄」改成「ChildProcess + stop=kill」。

**关键：`rawHttp` / `healthz` / 所有 wrapper（`getModelAliases`/`setUpstream`/...）一行不动**——这是最大保险。

### M3 多窗口协调回归

- 窗口 A spawn 成功 = 宿主；窗口 B 先 healthz 通 → 不 spawn = 从机。
- A 的子进程 kill → A 心跳 re-spawn。
- A deactivate → B 接管。
- 从机不反复 spawn 空子进程（`tryBecomeHost` 已先 healthz 探测）。

## 阶段 2：测试与收尾

### T1 新增 spawn 模式 e2e 测试

- 起 mock 上游 + spawn 子进程 server + fetch 打 → 验证别名替换/effort/trace 全链路（复用 `server-alias-e2e` 的断言）。
- 这是「脱离 VS Code host」的核心验证。

### T2 新增进程级行为用例（独立进程化解锁的）

- 崩溃恢复：kill 子进程 → 控制器 re-spawn → 恢复。
- EADDRINUSE 从机化（V3 的自动化版）。
- kill/restart：`POST /api/kill` → 子进程 exit → re-spawn → 配置从 config.json 读回。
- stdout 通路：子进程 `concise` 输出能被控制器收到。

### T3 现有测试不破坏

- 纯逻辑单测（config-store / trace-store）不动。
- 现有 in-proc e2e 保留（快速逻辑验证）。

### T4 文档收尾

- 更新 CLAUDE.md 架构速览：`proxyHost.ts` 从「ESM import 进扩展进程」→「spawn 独立子进程」。
- 空 body 坑章节补一句：独立进程后裸 socket 仍必须（宿主 http 栈吞 body 行为不变）。

## 优先级与依赖

```
V1 (execPath 身份) ──┬─→ M1 ──→ M2 ──→ M3 ──→ T1 ──→ T4
                     │
V2 (kill 退出语义) ──┘
V3 (EADDRINUSE) ───────────────→ T2
```

- **V1 是最关键的单点**——不通就要换退路（系统 node / CJS 编译），整个方案形状会变。先打通它。
- V2、V3 可与 V1 并行验证（都用临时命令探）。
- 阶段 1 必须等 V1/V2 全通；阶段 2 等阶段 1。

---

# 验证记录

## V1 验证

### V1-a 纯 Node 子进程模式（命令行预验证）✅ 通过

**目的**：先排除 server.js 本身的问题，把宿主里跑不通时能定位到 Electron 身份问题。

**做法**：`CONFIG_PATH=<windows路径> node proxy/server.js`，然后裸 socket 打 `/healthz`。

**结果**（2026-08-02）：
- `node proxy/server.js` 以子进程方式启动正常，listen 11499 成功。
- 裸 socket `GET /healthz` → `HTTP/1.1 200 OK` + 完整 JSON body `{"ok":true,...}`。
- server.js 的 `isMainModule` 入口认 `CONFIG_PATH` env（`server.js:862`）。

**关键发现**：`CONFIG_PATH` 路径必须是 Windows 风格（`C:\...`）。msys 风格 `/tmp/...` 在 Windows Node 下读不到 → FATAL exit。这在 VS Code 扩展宿主里不是问题（`context.extensionPath` 等本来就是 Windows 路径），但**测试脚本要注意**：用 `os.tmpdir()` + `path.join`，别用 msys 路径。

**结论**：server.js 子进程模式本身完全可用。剩下 V1-b 验证宿主里 `process.execPath`（Electron 身份）。

### V1-b 扩展宿主 process.execPath 身份 + ESM 加载 ✅ 已验证（结论：process.execPath 不可用，改用系统 Node）

**做法**：探针 `runV1Probe` 在扩展 activate 时自动跑，结果落盘 `v1-probe-result.txt`。

**结果**（2026-08-02，扩展宿主内实测）：

```
[1] process.execPath 身份
  execPath: D:\Users\HONOR\AppData\Local\Programs\Microsoft VS Code\Code.exe
  versions.electron: 42.7.0      ← 是 Electron！
  versions.node: 24.18.0
  versions.electron exists → 是 Electron 宿主
[3] spawn 尝试: ELECTRON_RUN_AS_NODE=1
（卡死，无后续输出）
```

**命令行复现**（用真实 `Code.exe` 跑 server.js）：

| 尝试 | 命令 | 结果 |
|---|---|---|
| 1 | `Code.exe + ELECTRON_RUN_AS_NODE=1` 跑 server.js | 6s 超时被 kill，**零输出**（卡在 ESM 加载，没 listen 没 exit 没 stdout） |
| 2 | `Code.exe` 不带 `ELECTRON_RUN_AS_NODE` 跑 server.js | 退出码 0，**零输出**（Code.exe 当 GUI 启动，server.js 没跑） |

**结论**：**`process.execPath`（Code.exe / Electron）不能用来 spawn ESM server.js**——无论带不带 `ELECTRON_RUN_AS_NODE`：

- 带 `ELECTRON_RUN_AS_NODE=1`：Electron 42.7.0 的 Node 24.18.0 跑 ESM server.js **卡死在模块加载**（不 listen、不 exit、不输出）。推测是 Electron 内嵌 Node 的 ESM 加载有坑，或 GUI 运行时残留干扰。
- 不带：Code.exe 直接当 GUI 应用启动，根本不执行脚本。

**方案调整（采用 §4.1 备选退路）**：扩展 spawn 时**不用 `process.execPath`**，改用**系统装的 Node**：

- 系统 Node 路径：`/c/nvm4w/nodejs/node`（v20.19.1，纯 Node，跑 ESM server.js 完全正常，见 V1-a）。
- 扩展需探测系统 Node 路径（`where node` / `which node` / 常见安装路径），找不到则提示用户。
- **代价**：依赖用户系统装了 Node（不像 `process.execPath` 那样零依赖）。但本扩展的目标用户本来就在用 Claude Code CLI（需 Node 环境），系统有 Node 是合理前提；可在配置项里允许手动指定 Node 路径（类似已有的 `claudeBinaryPath`）。

**V1 最终结论**：✅ 独立进程化可行，但 spawn 用**系统 Node**而非 `process.execPath`。server.js 子进程模式 + 裸 socket 通信链路全通（V1-a）。下一步 V2/V3 用系统 Node 验证。

### V1-c 复盘：`process.execPath` 卡死的真正原因 + `fork()` 假设（2026-08-02 补）

**起因**：借鉴 `D:\work_dir\knowledge_map` 项目的 Electron 踩坑记录（该项目从前后台系统改造为 Electron 兼容，用 `child_process.fork()` 跑后端 Fastify 子进程）。子 agent 搜回的关键文档：

- `knowledge_map/plan/tmp/2026-07-08-electron-windows-e2e-explore.md`：`ELECTRON_RUN_AS_NODE` 残留导致 Electron 静默退出。
- `knowledge_map/docs/跨平台设计/跨平台设计.md` 行 306-338：Electron 内嵌 Node 的 ESM loader 有崩溃先例。
- `knowledge_map/packages/electron/src/backend-process.ts`：用 `child_process.fork(serverMainPath, [], { env, stdio:[...,'ipc'] })`，**不指定 execPath**（用默认 `process.execPath`）。

**对照实验**（命令行，用真实 `Code.exe` 跑最小脚本，孤立 ESM/CJS × RUN_AS_NODE 四象限）：

| 对照 | 脚本 | `ELECTRON_RUN_AS_NODE` | 结果 |
|---|---|---|---|
| 1 | 最小 ESM（仅 http.createServer.listen） | `=1` | **卡死**（143 超时，零输出） |
| 2 | 最小 ESM | 清掉 | 退出码 0，没 listen（当 GUI 跑） |
| 3 | 最小 CJS | `=1` | **卡死**（143 超时，零输出） |
| 4 | 最小 CJS | 清掉 | 退出码 0，没 listen（当 GUI 跑） |

**关键结论**：**ESM 不是元凶**——CJS 一样卡死。`Code.exe + ELECTRON_RUN_AS_NODE=1` 在 Electron 42.7.0 上连最小 CJS 都跑不起来（零输出卡死）；不带则当 GUI 启动。`process.execPath`（Code.exe）用 `spawn` 方式在本环境彻底走不通。

**但 `knowledge_map` 用 `fork()` 能跑通**——差别假设：
- `knowledge_map` 的 `fork()` 在 **Electron 主进程**里调用，`fork()` 内部自动设 `ELECTRON_RUN_AS_NODE=1` 启动纯 Node 子进程，这是 `fork()` 的内置行为。
- 我们之前用 `spawn(Code.exe, [script], {env:{ELECTRON_RUN_AS_NODE:'1'}})`，是**手动**设 env，可能在新版 Electron 上与 `fork()` 的内部机制不一致。
- **待验证假设**：改用 `child_process.fork(serverPath, [], { env, stdio })`（不手动设 `ELECTRON_RUN_AS_NODE`），让 `fork()` 自己处理，可能在扩展宿主里也能跑通 → 零依赖路径复活。

**注意**：扩展宿主进程本身已是 RUN_AS_NODE 模式的 Node 进程（VS Code 用它跑扩展），其 `process.execPath` 是 `Code.exe`。`fork()` 在这种进程里的行为需实测——这是 V1-d。

### V1-d 待验证：`fork()` 模式（零依赖路径的最后机会）

改探针加 `fork()` 分支：`fork(serverPath, [], { env: {...process.env, CONFIG_PATH}, stdio:['ignore','pipe','pipe','ipc'] })`，不手动设 `ELECTRON_RUN_AS_NODE`。

- **通了** → `process.execPath` 零依赖路径复活，方案回到原版（用 `fork()` 代替 `spawn`）。
- **不通** → `process.execPath` 彻底死透，采用系统 Node 方案。

### V1-e 转折：命令行 `Code.exe + ELECTRON_RUN_AS_NODE=1` 实际能跑 server.js（2026-08-02）

**关键纠正**：之前 V1-b/V1-c 命令行复现的「卡死」是**测试方法错误导致的假象**——`timeout 6 Code.exe server.js | head` 里，server.js listen 成功后正常挂起等请求，`timeout` 6 秒后 SIGTERM 杀进程，`head` 在管道里因进程被杀拿不到完整输出，**误判为卡死**。

**正确测法**（后台启动 + healthz 实测端口）证明 `Code.exe + ELECTRON_RUN_AS_NODE=1` 跑真 server.js **完全正常**：
- stdout：`proxy listening on http://127.0.0.1:11487` + 全部正常启动日志
- 裸 socket `/healthz` → 200 + 完整 JSON body
- 最小 ESM HTTP server、ESM `import.meta` 判断脚本同样正常

**证伪的假设**：
- ❌ Gemini 根因 2（ESM Loader 死锁）：最小 ESM HTTP 能跑，ESM 不是元凶。
- ❌ Gemini 根因 3（Windows 路径大小写）：`pathToFileURL(argv[1])` 与 `import.meta.url` 在 `Code.exe` 下完全相等（大写 C），`===` 返回 true。

**那么扩展宿主探针里 spawn 卡死的真因**（Gemini 根因 1，未排除）：扩展宿主 `process.env` 注入了 VS Code 私货（`NODE_OPTIONS` / `VSCODE_*` 等），原样透传给子进程导致死锁。命令行纯 `Code.exe` 没这些注入所以能跑。

**待验证（V1-f）**：扩展宿主 spawn 时**净化 env**（删 `NODE_OPTIONS` / `VSCODE_*`，仅保留必要的 PATH 等 + 显式 `ELECTRON_RUN_AS_NODE=1`），看是否能跑通 → 这是零依赖路径的真正关键。

**借鉴**：`knowledge_map` 项目用 `child_process.fork()` 跑通 Electron 后端子进程，但他们是 Electron 主进程（完整 Electron runtime），与 VS Code 扩展宿主（RUN_AS_NODE 受限进程）环境不同，fork 在扩展宿主里也卡死（V1-d 探针停在 `[3] fork()` 无后续）。fork 不是解药，**净化 env 才是对症的关键**。

### V1-f 验证通过 ✅✅✅（2026-08-02，零依赖路径打通）

**做法**：探针 spawn `process.execPath`（Code.exe）跑 server.js，env 净化（删 `NODE_OPTIONS`/`VSCODE_*`/`ELECTRON_*`/`CHROME_*` 等注入变量）+ 显式 `ELECTRON_RUN_AS_NODE=1` + `windowsHide:true`。

**结果**（扩展宿主内实测，落盘 `v1-probe-result.txt`）：

```
[3] 尝试: spawn + 净化env + ELECTRON_RUN_AS_NODE=1（V1-f 核心）  (port=11491)
  spawn 返回，child.pid=17900
  等待 1s（测事件循环）...
  事件循环存活 ✓（1s 后回来了），exitCode=null
```

子进程 `exitCode=null`（活着没退出）。从**命令行直接探测探针 spawn 的子进程端口 11491**：

```
CONNECTED
RESP: HTTP/1.1 200 OK
content-type: application/json
content-length: 57
{"ok":true,"upstream":...
```

**子进程 listen 成功 + healthz 200 + 完整 JSON body。零依赖路径完全打通。**

**命中的真因（Gemini 根因 1）**：扩展宿主 `process.env` 注入了 VS Code 私货（`NODE_OPTIONS` 含 `--require bootstrap-fork.js` / `VSCODE_*` IPC handle 等），原样透传给子进程会死锁（子进程等 IPC 句柄、stdio 管道还没输出就挂起）。**净化 env 后死锁解除**。

**证伪的假设**：
- ❌ ESM Loader 死锁（V1-e 证伪：最小 ESM HTTP 能跑）。
- ❌ Windows 路径大小写（V1-e 证伪：`pathToFileURL` 与 `import.meta.url` 完全相等）。
- ❌ `process.execPath` 跑 ESM 不行（V1-e/V1-f 证伪：净化 env 后完全正常）。
- ❌ `fork()` 是解药（V1-d 证伪：fork 在扩展宿主里也卡死，因为 fork 默认透传污染的 env）。

**探针 healthz 探测卡住的说明**（不影响结论）：探针在扩展宿主里用裸 `net` socket 探 healthz 时卡住，没写出 `healthz 通 ✓`——但**从命令行探测同一子进程端口能拿到完整响应**，证明子进程本身正常。卡住的是探针的 healthz 实现或扩展宿主 net.connect 行为，不是子进程。生产代码 `proxyHost.rawHttp`（裸 socket）已被 `diagProxyHttp` 命令证明在扩展宿主里能正常拿 body，所以这个探针 healthz 卡住不影响后续——阶段 1 的 `ProxyHost` 改造直接复用 `rawHttp`，不用探针的 healthz。

## V1 最终结论（取代前面所有 V1-x 结论）

✅ **独立进程化可行，且 `process.execPath`（VS Code 自带 Node Runtime）完全可用——零依赖路径打通。**

spawn 方案：
```ts
spawn(process.execPath, [serverPath], {
  env: {
    // 净化：删 NODE_OPTIONS / VSCODE_* / ELECTRON_* / CHROME_* 等 VS Code 注入
    ...(净化的 process.env),
    ELECTRON_RUN_AS_NODE: '1',
    CONFIG_PATH: configPath,
    CCP_LOGS_DIR: logsDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
```

就绪检测：复用 `proxyHost.rawHttp`/`healthz`（裸 socket，已验证可用）。多窗口协调（端口 bind + 心跳）不变。通信通道（裸 socket HTTP）不变。

**V1 头号风险解除。进入 V2（kill 退出语义）、V3（EADDRINUSE 从机化）验证，然后阶段 1 实现。**


