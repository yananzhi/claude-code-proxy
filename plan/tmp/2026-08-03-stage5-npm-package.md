# 阶段 5 正交场景设计 — npm 全局包打包

> 日期：2026-08-03
> 任务：阶段 5，npm 全局包
> 硬约束：VS Code 形态 499 用例不破；不碰 src/ 下 VS Code 形态代码；proxy/ 不动；VS Code 扩展形态（main/engines.vscode/contributes）保持

## 设计决策（先定的点）

### bin 入口：新建 standalone/cli.js wrapper（不直接用 main.js）

`standalone/main.js` 的 `isMain` 判断用 `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`。当 main.js 被 npm bin shim 调用时，`process.argv[1]` 是 shim 路径或被 node 解析后的 main.js 路径——isMain 可能不稳定。新建 `standalone/cli.js` 作 bin 入口，带 shebang，内部 import main.js 调 launchStandalone，更干净。

**bin 名**：`claude-code-proxy`（与 npm 包名一致）。不与 VS Code 扩展命令冲突（VS Code 命令是 `claude-code-proxy.xxx`，在 VS Code 内部，与终端 bin 无关）。

### shebang + ESM

`standalone/cli.js` 顶部 `#!/usr/bin/env node`。npm 会保留 shebang + chmod +x。ESM JS 文件 shebang 在 Node 20 支持（Node 会跳过首行 shebang）。

### out/ 发布问题

**关键风险**：`.gitignore` 排除 `out/`，standalone 依赖 `out/cleanEnv.js`/`proxySpawnController.js`/`localConfigStore.js`/`claudeBinary.js`/`derivedLogic.js`/`upstream.js`。全局安装后若 out/ 缺失，standalone 启动失败。

解决：
- `package.json` 加 `files` 白名单，显式包含 `out/`、`standalone/`、`proxy/`、`package.json`、`standalone/package.json`、`README`。
- `prepublishOnly` 脚本：`npm run compile`（发布前编译，确保 out/ 存在）。
- 首版支持 `npm install -g .`（本地，out/ 已编译）+ `npm link`。github 安装的 postinstall 编译留后续（需用户有 tsc，或预编译发布）。

### CCP_HOME 默认值

bin 执行时 `CCP_HOME` 默认 `~/.claude-code-proxy/`（与 main.js resolvePaths 一致）。bin 不传 CCP_HOME 时用默认。

### bin 与 VS Code main 共存

`package.json` 同时有 `main`（VS Code 扩展用 `./out/extension.js`）+ `bin`（npm 用 `standalone/cli.js`）。两者不冲突——VS Code 读 main，npm 读 bin。

## 产物

1. `standalone/cli.js` — bin 入口，shebang + import main.js + launchStandalone
2. `package.json` 加 `bin` + `files` + `prepublishOnly` 脚本
3. 测试：cli.js 可执行性 + CCP_HOME 解析 + out/ 路径解析

## 正交维度

### D1 bin 入口可执行

- D1a：cli.js 含 shebang
- D1b：cli.js import main.js 调 launchStandalone
- D1c：node standalone/cli.js 能起后端（healthz 通）
- D1d：CCP_HOME 环境变量覆盖默认 home

### D2 package.json 字段

- D2a：bin 字段指向 standalone/cli.js
- D2b：files 白名单含 out/ + standalone/ + proxy/ + package.json + standalone/package.json
- D2c：prepublishOnly 脚本编译
- D2d：main/engines.vscode/contributes 保持不变（VS Code 形态不破）

### D3 out/ 路径解析

- D3a：standalone 模块从 out/ 加载编译产物（cli.js 执行时 PROJECT_ROOT 解析正确）
- D3b：全局安装后 out/ 存在（files 白名单保证）

### D4 不破坏现有

- D4a：VS Code 形态 main 入口仍工作（compile 后 out/extension.js 在）
- D4b：npm run compile 仍工作
- D4c：全量测试不破

## 高风险维度对照

| 高险类别 | 适用维度 | 说明 |
|---|---|---|
| 状态转换 | 无 | 静态打包配置 |
| 异常/错误路径 | D3b | out/ 缺失 |
| 时序/竞态 | 无 | 无并发 |
| 空/null/初始态 | D1d | CCP_HOME 默认 |
| 幂等性 | 无 | |
| 边界输入 | D2d | VS Code 字段保留 |

## 用例选取（Step 3 依据）

- D1a-d：bin 入口各情况
- D2a-d：package.json 字段
- D3a-b：out/ 路径
- D4a-c：不破坏现有

## 范围说明

阶段 5 只做 npm 全局包打包（bin + files + prepublishOnly）。github 安装的 postinstall 编译、跨平台 .cmd shim 验证留后续。
