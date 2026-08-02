# 请教：VS Code 扩展宿主（Electron）spawn 子进程跑 ESM 脚本卡死，如何零依赖打通？

## 背景

我在做一个 VS Code 扩展（TypeScript，编译成 CJS 的 `out/extension.js`）。扩展目前把一个本地 HTTP 代理服务（`proxy/server.js`，**ESM 模块**，`proxy/package.json` 声明 `"type":"module"`）通过**动态 `import('../proxy/server.js')`** 加载进 Extension Host 进程内运行。

我想把这个代理服务改成**独立子进程**（主要为了能脱离 VS Code 写自动化测试，也为将来脱离 VS Code 铺路）。扩展宿主 spawn 一个子进程跑 `proxy/server.js`，扩展和子进程之间通过 `127.0.0.1` 的 HTTP 通信（已经用裸 `net` socket 实现，不依赖 http 栈）。

## 环境信息

- VS Code 版本：当前稳定版，Extension Host 是 **Electron 42.7.0**，内嵌 **Node 24.18.0**。
- 在扩展宿主进程里 `process.execPath` = `D:\...\Microsoft VS Code\Code.exe`，`process.versions.electron = 42.7.0`，`process.versions.node = 24.18.0`。
- 系统 PATH 里有纯 Node：`C:\nvm4w\nodejs\node.exe`（v20.19.1），用它直接 `node proxy/server.js` **完全正常**，能 listen、能响应。
- 操作系统：Windows 11。

## server.js 入口（ESM）

```js
// proxy/server.js 末尾
import { pathToFileURL, fileURLToPath } from 'node:url';

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  const cfgPath = process.env.CONFIG_PATH || new URL('./config.json', import.meta.url);
  startServer({ configPath: typeof cfgPath === 'string' ? cfgPath : fileURLToPath(cfgPath) }).catch((e) => {
    concise(`FATAL: ${e.message}`);
    process.exit(1);
  });
}
```

`startServer` 内部用 `http.createServer(...).listen(port, host, cb)`，cb 里 resolve。模块顶部有 `import http from 'node:http'` 等标准 ESM import，以及 `import.meta.url` 的使用。

server.js 依赖同目录的 ESM 模块（`./logger.js`、`./config-store.js`、`./trace-store.js`），都是 ESM。

## 我尝试过的方案及结果

### 方案 A：用 `process.execPath`（Code.exe）+ `ELECTRON_RUN_AS_NODE=1`

```js
spawn(process.execPath, [serverPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CONFIG_PATH: configPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

**结果：卡死。** 子进程既不 listen、也不 exit、stdout/stderr **零输出**。轮询 `/healthz` 5 秒不通，子进程一直挂着，最后被 kill。

命令行直接复现也一样：
```
$ ELECTRON_RUN_AS_NODE=1 CONFIG_PATH=... Code.exe proxy/server.js
（6 秒超时被 kill，零输出，没 listen 没 exit）
```

### 方案 B：用 `process.execPath`（Code.exe）不带 `ELECTRON_RUN_AS_NODE`

**结果：Code.exe 当作 GUI 应用启动了**，根本没执行 server.js（退出码 0，零输出，可能弹了个 VS Code 窗口）。

### 方案 C（对照组）：用系统纯 Node

```
$ CONFIG_PATH=... node proxy/server.js
proxy listening on http://127.0.0.1:11499
（healthz 200，正常）
```

**完全正常。** 但这依赖用户系统装了 Node，我希望能零依赖（用 VS Code 自带的 Node Runtime）。

## 我的问题

1. **为什么 `Code.exe + ELECTRON_RUN_AS_NODE=1` 跑 ESM 脚本会卡死、零输出？** 是 Electron 内嵌 Node 对 ESM 的支持有坑吗？还是 `ELECTRON_RUN_AS_NODE` 在新版 Electron（42.x）里行为变了？还是 `import.meta.url` / `type:module` 在 Electron 纯 Node 模式下有问题？

2. **有没有办法让 VS Code 扩展宿主用自带的 Node Runtime（不依赖系统 Node）spawn 一个能正常跑 ESM 的子进程？** 比如：
   - `ELECTRON_RUN_AS_NODE` 之外还有别的 env / flag 能让 Code.exe 以纯 Node 跑 ESM？
   - VS Code 是否暴露了它内部用的纯 Node 可执行路径（不是 Code.exe 本身）？
   - 有没有办法从扩展拿到一个「能跑 ESM 的 Node」路径，而不用要求用户系统装 Node？

3. **如果确实只能用系统 Node**，VS Code 扩展生态里有没有约定俗成的探测/降级做法？（比如有些扩展会要求用户配 `nodePath`，或者打包一个 Node runtime。）

## 我的约束

- 想保持**零依赖**（不要求用户系统装 Node），因为用 `process.execPath` 最干净。
- 如果零依赖实在打不通，可以接受「要求系统 Node + 可配置 Node 路径」，但想先确认 `process.execPath` 这条路是不是真的死透了。
- 不想把 server.js 从 ESM 改成 CJS（改动大，且 ESM 是有意选的），除非这是唯一出路。

## 关键疑问总结

`Code.exe`（Electron 42.7.0 / Node 24.18.0）+ `ELECTRON_RUN_AS_NODE=1` 跑一个标准的 ESM Node 脚本（`type:module` + `import` + `import.meta.url`）为什么会卡死零输出？同样的脚本用纯 Node（v20）完全正常。是已知问题吗？有没有解法或绕过？
