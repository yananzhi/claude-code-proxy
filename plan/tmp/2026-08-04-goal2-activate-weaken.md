# 2026-08-04 目标2：激活弱化为默认配置标记

> 终端统一走 env 后（目标1），standalone 起终端不再依赖全局 active 配置。
> 「激活」从"写 settings.json + 注入 upstream + permissions/gitignore"降级为"只写默认配置标记"。
> 设计依据：docs/standalone管理界面重设计.md 第 6 节决策 1。

## 改造前（现状）

`activateConfig(manager, proxyPort, wsId, cfgId)`：
- direct：writeSettings 原样 content
- proxy：注入 upstream + 合成代理 settings + writeSettings
- 写 LocalActiveStateStore 标记
- ensureProjectPermissions + ensureGitignore

standalone 路由 `POST /api/workspaces/:id/configs/:cfgId/activate` 调它。
副作用：写 `.claude_proxy/settings.json` + 注入代理 upstream + 写 `.claude/settings.local.json` + `.gitignore`。

## 改造后（目标）

新增 `markDefaultConfig(manager, wsId, cfgId)`：
- 只写 LocalActiveStateStore 标记（cfgId + mode）
- **不**写 settings.json、**不**注入 upstream、**不**碰 permissions/gitignore
- 校验 workspace + config 存在（404），**不**校验 content 有效（标记只是指针，config 可后编辑）

standalone 路由 `POST /api/workspaces/:id/configs/:cfgId/activate` 改调 `markDefaultConfig`。
- 返回值：`{ marked: true, cfgId, mode }`（取代 `activated/settingsPath/note`）
- 存活终端警告：去掉（不再覆盖 settings.json，无"已开 session 受影响"风险）

`activateConfig` 原函数保留（VS Code 侧 `claudeLauncher` 仍用），本任务不动它。

## 正交维度

### 维度 A：标记行为
- 标记正常配置 → active 标记写入，返回 marked:true
- 标记不存在 config → 404 NotFoundError
- 标记不存在 workspace → 404 NotFoundError
- 派生配置能不能标记为默认？**能**（标记只是默认起终端指针，与"派生不能 active"旧约束无关——旧约束是"派生不写 settings.json"，现在都不写了）

### 维度 B：副作用（核心验证点）
- 标记后 `.claude_proxy/settings.json` **不**被创建/修改
- 标记后 `.claude/settings.local.json` **不**被创建/修改（无 permissions 写入）
- 标记后 `.gitignore` **不**被创建/修改
- 标记后代理 upstream **不**被注入（fwd.calls 无 /api/upstream）
- 标记后只有 LocalActiveStateStore 写入

### 维度 C：标记读取（GET /active 仍工作）
- 标记后 GET /active 返回 { active: { id, mode } }
- 无标记 → GET /active 返回 null
- 切换标记到另一 config → active 更新

### 维度 D：幂等
- 重复标记同 config → 标记不变，无副作用累积

### 维度 E：边界
- 标记的 config content 非法 JSON → 仍可标记（不校验 content，与 activateConfig 不同）
- 标记的 config 缺 BASE_URL/TOKEN → 仍可标记（标记 ≠ 启动，启动时 buildTerminalEnv 才校验）

## 测试用例（维度覆盖）

重写 `activate-config.test.mjs`：
| 用例 | 维度 | 现有/新增/重写 |
|---|---|---|
| A1 正常 config 标记 → marked:true + active 写入 | A+C | **重写**（原 D1a 写 settings） |
| A2 不存在 config → 404 | A | 保留（原 D7b） |
| A3 不存在 workspace → 404 | A | 保留（原 D7a） |
| A4 派生配置可标记为默认 | A | **新增** |
| B1 标记后 settings.json 不存在/未变 | B | **重写**（原 D1a 反向断言） |
| B2 标记后 .claude/settings.local.json 未被创建 | B | **重写**（原 D6a 反向） |
| B3 标记后 .gitignore 未被创建 | B | **重写**（原 D6c 反向） |
| B4 标记后代理无 upstream 注入 | B | **新增** |
| C1 标记后 GET /active 返回标记 | C | 保留（原 D5a） |
| C2 无标记 → GET /active null | C | 保留（原 D5c） |
| C3 切换标记 → active 更新 | C | 保留（原 D5e） |
| D1 重复标记同 config → 幂等 | D | 保留（原 D5d） |
| E1 content 非法 JSON → 仍可标记 | E | **新增** |
| E2 缺 BASE_URL → 仍可标记 | E | **新增** |

删除的旧用例（行为已不存在）：
- D2 proxy 模式 + 临时代理可达 → 合成 settings（不再合成）
- D3a/b/c proxy 模式 + proxy 不可达/缺 BASE_URL/content 非 JSON → 502/400（标记不校验这些）
- D6a/b/c/d permissions/gitignore 写入（不再写）
- REVIEW: proxy 返回 400 不假成功（标记不调代理）

## 不在范围
- activateConfig 函数本身不改（VS Code 侧用）
- VS Code 扩展侧（claudeLauncher）不改
- 起终端路由的"基于默认配置"逻辑（目标 3 改起终端入口时一起改）
