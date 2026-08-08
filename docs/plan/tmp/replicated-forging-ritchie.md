# 计划：standalone 终端冲突 key「确认框 + 一键删除」

## Context（为什么做这个）

1.3.2 把 workspace-local 终端改纯 env 注入后，代码不再往 `{workspace}/.claude_proxy/settings.json` 写路由 key。但**旧版插件（≤1.3.1）的脏文件不会被自动清理**——所有从旧版升级、且 workspace 里残留旧 `settings.json`（含 `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL`）的用户，在 standalone 模式新建终端时会撞冲突检测（`standalone/terminalApi.js:86-107`）被拒，错误信息只说"请删除该 key 后重试"，但**不提供删除手段**——用户得手动找文件改 JSON。

用户已实测确认：手动删掉 `.claude_proxy/settings.json` 里的 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 后终端能起来。

用户决策（2026-08-08）：**不做静默自动清理**（不擅自改用户文件、不在 activate 时清），做成"检测到冲突时弹确认框 + 一键删除冲突 key 后重试"。保留纯拒绝语义，把删除动作交给用户点一下。

本计划实现 standalone 侧的 (a) 剥离冲突 key 的 HTTP endpoint + (b) 前端确认框重试。插件侧 workspace-local 终端不读 settings.json 做冲突检测，**无需改**。

## 错误流现状（探路 agent 已确认）

- 冲突检测抛点：`standalone/terminalApi.js:101-106`，throw `ValidationError(检测到 ${settingsPath} 的 env.${conflictKey} 会覆盖...)`。
- `ValidationError` 定义：`standalone/configApi.js:451-454`（`constructor(msg){ super(msg); this.name='ValidationError'; }`）。
- 错误映射：两个起终端路由的 catch → `sendTermError(res, e)`（`managementServer.js:603-609`）→ `ValidationError` 走 `sendJson(res, 400, { error: e.message })`。顶层 catch（`managementServer.js:432-444`）同理。
- 前端：`workspaces-html.js` 的 `newTerminal`（:165-174）/`newConfigTerminal`（:176-185），`if (d.error) { showMsg('新建终端失败: ' + d.error, 'err'); return; }`——只显示不重试。页面已有 `confirm()` 模式（删配置 :227 / 删 workspace :275）。
- 现有 settings.json 读写：`out/claudeConfig.js` 的 `readSettings`（返回原始 string 或 null）/`writeSettings`（全文件覆盖），`configApi.js` 已 import `writeSettings`。`CONFLICT_KEYS` 定义在 `terminalApi.js:86-89`（未导出）。
- 现有测试：`test/standalone/terminal-routes.test.mjs` R7a-R7d 覆盖冲突检测（R7a 断言 `d.error` 匹配 `/ANTHROPIC_BASE_URL|覆盖.*modelname|不支持共存/`）。

## 实现方案

### 1. `ValidationError` 携带可选 `code`（最小侵入的结构化信号）

**文件**：`standalone/configApi.js:452-454`

改 `ValidationError` 构造器接受可选第二参 `code`：
```js
export class ValidationError extends Error {
    constructor(msg, code) { super(msg); this.name = 'ValidationError'; this.code = code; }
}
```
所有现有 throw 点不传 `code` → `this.code = undefined`，行为不变，零破坏。

### 2. 冲突检测 throw 时带 `code: 'CONFLICT_KEYS'`

**文件**：`standalone/terminalApi.js:101-106`

throw 改为 `new ValidationError(msg, 'CONFLICT_KEYS')`。错误消息文本不动（R7a 正则断言仍过）。

同时**导出 `CONFLICT_KEYS`**（在 `const CONFLICT_KEYS = [...]` 前加 `export`），供 strip helper 复用，避免重复定义。

### 3. 错误响应转发 `code` 字段

**文件**：`standalone/managementServer.js`

- `sendTermError`（:603-609）：`ValidationError` 分支改为 `sendJson(res, 400, e.code ? { error: e.message, code: e.code } : { error: e.message })`。
- 顶层 catch（:439-441）：`ValidationError` 分支同理带上 `code`（若 `err.code` 存在）。

这样前端拿到 `d.code === 'CONFLICT_KEYS'` 即可判定是冲突类错误。非冲突错误 `code` 缺失，前端行为不变。

### 4. 新增 strip-conflict-keys endpoint + helper

**新 helper**：`standalone/configApi.js` 末尾新增导出函数：
```js
/**
 * 从 workspace 的 .claude_proxy/settings.json 剥离会与终端 env 注入冲突的 key。
 * 剥离范围：CONFLICT_KEYS（5 个路由 key）+ ANTHROPIC_AUTH_TOKEN（token 残留不被检测拦，
 *   但会留在文件里被 CLI 当 env 用、可能串味，一并清掉）。
 * 只删 env 下命中的 key，保留 env 里其余 key（如 CLAUDE_CODE_AUTO_COMPACT_WINDOW）+ 文件其余字段。
 * @returns {Promise<{ removed: string[], settingsPath: string }>}
 * @throws {NotFoundError} workspace 不存在
 * @throws {ValidationError} settings.json 不存在 / 无法解析
 */
export async function stripConflictKeysFromSettings(manager, workspaceId) { ... }
```
实现要点：
- `manager.get(workspaceId)` 取 `ws`，不存在 throw `NotFoundError`。
- `settingsPath = path.join(ws.dir, WORKSPACE_CONFIG_DIR, 'settings.json')`。
- `readSettings(settingsPath)`（已在 configApi 顶部 import `readSettings`，需补到现有 `require(out/claudeConfig.js)` 解构里）；`null` → throw `ValidationError('settings.json 不存在，无需剥离')`。
- `JSON.parse` 失败 → throw `ValidationError('settings.json 无法解析：...')`。
- `parsed.env` 不存在或无命中 key → 返回 `{ removed: [], settingsPath }`（幂等，不算错）。
- 命中 key 删掉；若删完 `env` 变空对象，删掉 `env` 字段本身（避免留空 `env: {}`）。
- `writeSettings(settingsPath, JSON.stringify(parsed, null, 2))` 写回。
- 返回删掉的 key 列表。

**import 调整**：`configApi.js` 顶部 `require(out/claudeConfig.js)` 现只解构 `writeSettings`，需补 `readSettings`。`CONFLICT_KEYS` 从 `terminalApi.js` import（注意：`configApi.js` 当前未 import terminalApi，需新增 `import { CONFLICT_KEYS } from './terminalApi.js'`——但 terminalApi.js 顶部 import 了 configApi.js，会有循环依赖。需验证：terminalApi 只在**调用** `buildTerminalEnv` 时用 configApi 的运行时值（`proxyForward`/`ValidationError`），ESM 循环 import 对**具名导出常量** `CONFLICT_KEYS` 通常安全，因为 configApi 的 strip helper 只在运行时被调用、届时 terminalApi 模块已初始化完。若实测循环依赖致 `CONFLICT_KEYS` 为 undefined，回退方案：在 configApi 内本地定义 `CONFLICT_KEYS` + `AUTH_TOKEN` 常量，注释指明与 terminalApi 保持同步。**先按 import 方案，实测不过再回退**）。

**新路由**：`standalone/managementServer.js`，放在 activate 路由（:345）之后、active 路由（:347）之前：
```js
// POST /api/workspaces/:id/settings/strip-conflict-keys → 剥离 settings.json 里与终端 env 注入冲突的 key
const mStrip = pathname.match(/^\/api\/workspaces\/([^/]+)\/settings\/strip-conflict-keys$/);
if (method === 'POST' && mStrip) {
    const id = decodeURIComponent(mStrip[1]);
    const result = await stripConflictKeysFromSettings(manager, id);
    sendJson(res, 200, result);
    return;
}
```
`stripConflictKeysFromSettings` 需加到顶部 `configApi.js` 的 import 列表（:21-26）。错误由顶层 catch 自动映射（`ValidationError→400`/`NotFoundError→404`）。

⚠ 路由顺序：此路由路径 `/api/workspaces/:id/settings/strip-conflict-keys` 不会与 `/api/workspaces/:id/configs/...` 或 `/api/workspaces/:id`（GET/DELETE，:393/:407）冲突——后两者是 `^/api/workspaces/([^/]+)$` 精确匹配单段，多段路径不匹配。安全。

### 5. 前端确认框 + 一键删除重试

**文件**：`standalone/web/workspaces-html.js`

抽出一个共享的"起终端 + 冲突重试"逻辑，`newTerminal`/`newConfigTerminal` 都用：

- 起终端 fetch 的 `if (d.error)` 分支：先判 `if (d.code === 'CONFLICT_KEYS')`，是则 `confirm('检测到 settings.json 残留旧版路由配置（会覆盖终端注入）。是否一键删除冲突 key 并重试？')`；用户确认 → `fetch(stripEndpoint, { method:'POST' })` → 成功后 `showMsg('已删除 N 个冲突 key，重试创建终端...', 'ok')` → 重新调一次原起终端 fetch；strip 失败 → `showMsg('删除冲突 key 失败: ' + d.error, 'err')`。
- 非冲突错误维持原 `showMsg('新建终端失败: ' + d.error, 'err')`。
- 重试只重试一次（防无限循环）——用一个 `retry` 布尔参数控制，重试调用时传 `false`，再遇冲突直接 `showMsg` 报错不再弹框。

实现上把起终端逻辑提成 `doCreateTerminal(url, isRetry)`，`newTerminal`/`newConfigTerminal` 调它；冲突分支里 `doCreateTerminal(url, true)` 重试。

## 测试

新增 `test/standalone/terminal-routes.test.mjs` 的 R8 组（沿用 `startMgmt`/`createWsAndDirectConfig` 基建，proxyPort=19998，mock pty）：

- **R8a**：settings.json 含 `ANTHROPIC_BASE_URL` → 起终端 400 且 `d.code === 'CONFLICT_KEYS'`（验证结构化信号）。
- **R8b**：POST `/api/workspaces/:id/settings/strip-conflict-keys` → 删掉 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`，保留 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`，返回 `removed` 含两项；之后再起终端 201 成功（端到端验证剥离生效）。
- **R8c**：settings.json 无冲突 key（仅 theme/skipDangerous）→ strip 返回 `removed: []`（幂等不报错），文件内容不变。
- **R8d**：workspace 无 settings.json → strip 返回 400（`ValidationError`，settings.json 不存在）。
- **R8e**：settings.json 损坏（非法 JSON）→ strip 返回 400（无法解析）。
- **R8f**：workspace 不存在 → strip 返回 404。

前端 confirm 框为浏览器交互，不进 node --test（与现有 confirm/deleteConfig 一致，手动 smoke 验证）。

## 验证步骤

1. `npm run compile`（TS 无变化，确认 out/ 仍一致——standalone ESM 直接跑，不依赖编译，但确认无碍）。
2. `node --test test/standalone/terminal-routes.test.mjs` 跑 R7（回归）+ R8（新增）。
3. `node --test --test-concurrency=1 proxy/test/ test/derived-logic/test.mjs test/mock-cli/test/ test/proxyHost/ mock/ test/standalone/` 全量回归（确认 0 fail）。
4. 手动 smoke：standalone 模式，在 workspace 的 `.claude_proxy/settings.json` 塞回 `ANTHROPIC_BASE_URL`，新建终端 → 弹确认框 → 点确认 → 终端起来。
5. 实测通过后 `npx vsce package --no-git-tag-version` 重新打包 .vsix（用户手动测 standalone 需新包）。

## 不改的部分

- 插件侧 `src/claudeLauncher.ts`：workspace-local 终端不读 settings.json 做冲突检测，无需改。
- global 链路 `doSwitch` + `~/.claude/settings.json`：不动。
- standalone 冲突检测本身的拒绝语义：不放宽（放宽=容忍 settings 路由 key 会让 env 注入被覆盖、路由错乱）。
