# 阶段 6 正交场景设计 — 激活 local config

> 日期：2026-08-04
> 任务：阶段 6，激活 local config（阶段 4 留的"激活"后续）
> 硬约束：VS Code 形态 518 用例不破；不碰 src/ 下 VS Code 形态代码；proxy/ 不动；proxy-config 公共一份

## 设计决策（先定的点）

### 激活是独立动作，与 spawn 解耦

激活（`POST /api/workspaces/:id/configs/:cfgId/activate`）只做"写 settings.json + 注入 upstream + 写 active 标记"，不 spawn/重启 CLI 会话。已 spawn 的会话读 settings.json 的时机由 Claude Code CLI 决定（启动时读，可能不热重载）。激活 API 响应里提示"新会话或重启会话生效"。

### 两模式路径

- **direct 模式**：`writeSettings(.claude_proxy/settings.json, cfg.content)` 原样。不碰 proxy upstream（direct 不走代理）。
- **proxy 模式**：
  1. `extractUpstream(cfg.content)` 解 env，校验 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 非空
  2. 构造 upstream：baseUrl/token/model/smallFastModel/timeoutSec（API_TIMEOUT_MS 毫秒→秒 `Math.round(/1000)`，空/非数→不传）
  3. `proxyForward(proxyPort, '/api/upstream', 'POST', { upstream })` 注入（proxy 不在→502）
  4. `synthesizeProxySettings(cfg.content, proxyPort)` 合成（BASE_URL→localhost:port）
  5. `writeSettings(.claude_proxy/settings.json, synthesized)`

### 复用逻辑（从 out/ 加载，零改）

- `extractUpstream`/`synthesizeProxySettings`（out/upstream.js，configApi 已加载 extractUpstream，补 synthesizeProxySettings）
- `writeSettings`（out/claudeConfig.js，新加载）
- `LocalActiveStateStore`（out/localConfigStore.js，已加载未用，现用 `.write(cfgId, mode)` + `.load()`）

### 复制逻辑（ensureProjectPermissions + ensureGitignore）

从 claudeLauncher.ts 复制到 configApi.js（~65 行），`this.output.appendLine` → `opts.log`。理由：它们是 ClaudeLauncher 的 private 方法，抽成共享纯函数要改 claudeLauncher.ts（碰 VS Code 形态），复制更安全。

- `ensureProjectPermissions(workspaceRoot)`：写 `{workspace}/.claude/settings.local.json` 合并 `permissions.defaultMode=bypassPermissions`（已设别的模式则尊重不覆盖）
- `ensureGitignore(workspaceRoot)`：若 git 仓库且未忽略 `.claude_proxy/` 则追加

### active 标记一致性

激活后写 `LocalActiveStateStore.write(cfgId, mode)`。`GET /api/workspaces/:id/active` 读 `LocalActiveStateStore.load()`。激活同 config 幂等（重复激活同 config → 重写 settings.json + 重注入 upstream + 重写 active 标记，无害）。

### 路由顺序

`POST /api/workspaces/:id/configs/:cfgId/activate` 的正则 `^/api/workspaces/([^/]+)/configs/([^/]+)/activate$` 必须在 `mCfgOne`（`^/api/workspaces/([^/]+)/configs/([^/]+)$`）之前注册，避免 `/activate` 被当 cfgId 的一部分（实际上 mCfgOne 正则 `[^/]+$` 锚定结尾，不会匹配带 /activate 的路径，但显式前置更清晰）。

## 产物

1. `standalone/configApi.js` 加 `activateConfig(manager, proxyPort, workspaceId, cfgId)` + 复制 `ensureProjectPermissions`/`ensureGitignore`
2. `standalone/managementServer.js` 加路由：
   - `POST /api/workspaces/:id/configs/:cfgId/activate`
   - `GET /api/workspaces/:id/active`

## 正交维度

### D1 direct 模式激活

- D1a：direct config 激活 → writeSettings 原样 content + active 标记
- D1b：settings.json 内容 == cfg.content（不合成）

### D2 proxy 模式激活

- D2a：proxy config 激活 → 注入 upstream + 合成 settings + writeSettings + active 标记
- D2b：settings.json BASE_URL == localhost:proxyPort（合成）
- D2c：upstream 注入 body 格式正确（{upstream:{baseUrl,token,model,smallFastModel,timeoutSec}}）

### D3 upstream 注入失败

- D3a：proxy 不可达 → 502（proxyForward 抛 ProxyUnavailableError）
- D3b：content 缺 BASE_URL/TOKEN → 400（校验）
- D3c：content 非 JSON → extractUpstream 返 null → 400

### D4 timeout 转换

- D4a：API_TIMEOUT_MS='600000' → timeoutSec=600
- D4b：API_TIMEOUT_MS 缺失/空/非数 → 不传 timeoutSec
- D4c：API_TIMEOUT_MS='0'/负数 → 不传（非正）

### D5 active 标记

- D5a：激活后 LocalActiveStateStore 记 {id, mode}
- D5b：GET /active 返回当前激活
- D5c：无激活 → GET /active 返回 null
- D5d：重复激活同 config → active 标记不变（幂等）
- D5e：切换激活到另一 config → active 标记更新

### D6 ensureProjectPermissions + ensureGitignore

- D6a：激活时写 .claude/settings.local.json bypassPermissions
- D6b：已设别的 defaultMode → 不覆盖
- D6c：git 仓库 → .gitignore 加 .claude_proxy/
- D6d：非 git 仓库 → 不创建 .gitignore

### D7 不存在/错误路径

- D7a：workspace 不存在 → 404
- D7b：config 不存在 → 404
- D7c：derived config 激活（derived 强制 proxy，但 derived 的 content 继承父，应能激活）

## 高风险维度对照

| 高险类别 | 适用维度 | 说明 |
|---|---|---|
| 状态转换 | D5 | active 标记切换 |
| 异常/错误路径 | D3, D7 | upstream 注入失败、不存在 |
| 时序/竞态 | 无 | 激活是同步动作 |
| 空/null/初始态 | D5c, D4b | 无激活、timeout 缺失 |
| 幂等性 | D5d | 重复激活同 config |
| 边界输入 | D4 | timeout 转换边界 |

## 用例选取（Step 3 依据）

- D1a-b：direct 激活
- D2a-c：proxy 激活（upstream 注入需 mock proxy 或真 proxy，用真 proxy 测端到端 + 502 测失败）
- D3a-c：注入失败
- D4a-c：timeout 转换
- D5a-e：active 标记
- D6a-d：permissions + gitignore
- D7a-c：不存在

## 范围说明

阶段 6 只做激活（写 settings + 注入 upstream + active 标记）。不 spawn/重启 CLI 会话。已跑会话是否热重载 settings 由 Claude Code CLI 决定，激活 API 响应提示"重启会话生效"。
