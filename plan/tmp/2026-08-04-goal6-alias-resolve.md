# 2026-08-04 目标6：别名终端顶栏实时查映射

> 别名终端顶栏显示 `ccp-xxx-N → 真实模型`，实时查代理 modelAliases。
> 设计依据：docs/standalone管理界面重设计.md 第 6 节决策 3。

## 现状
- 终端页 `buildTerminalHtml` 顶栏只有"Claude Code 终端"静态文案。
- `/api/terminals/:tid` 只支持 DELETE，无 GET 详情。
- `sessions` 有 `listByWorkspace`/`listByConfig`，无单终端 get。

## 改造

### 后端
1. `claudeSession.js` 加 `get(terminalId)` 返回终端详情（kind/configId/startedConfigName/workspaceId）。
2. `managementServer.js` 加 `GET /api/terminals/:tid` 返回终端详情。
3. `managementServer.js` 加 `GET /api/terminals/:tid/alias-resolve`：对别名终端，查代理 `GET /api/model-alias`，返回该终端别名的当前真实模型映射。
   - 静态终端返回 `{ kind: 'normal', model: startedConfigName 或真实 model }`。
   - 别名终端返回 `{ kind: 'derived', aliases: { main: 'ccp-main-N→realModel', ... } }`。

### 前端
`buildTerminalHtml` 顶栏：打开时 + 别名映射变更后 fetch `/api/terminals/:tid/alias-resolve`，渲染：
- 静态：`[静态] cfgName`
- 别名：`[别名] #N  ccp-main-N → realModel`（列出已配档）

## 正交维度
### A 终端类型
- 静态终端顶栏：显示配置名，无别名映射查询
- 别名终端顶栏：显示别名 + 实时真实模型

### B 别名映射查询
- 别名终端 → 查代理 modelAliases → 显示 ccp-<tier>-N → 真实模型
- 静态终端 → 不查代理

### C 实时性
- 打开终端页时查一次
- 别名映射变更后刷新（低频，不做 push，靠下次刷新/重连）

### D 错误路径
- 终端不存在 → 404
- 代理不可达 → 顶栏显示"别名映射查询失败"，终端仍可用
- 静态终端查 alias-resolve → 返回静态信息（不调代理）

## 测试用例
| 用例 | 维度 | 新增 |
|---|---|---|
| T3d buildTerminalHtml 顶栏含 alias-resolve fetch | A+B | 新增 |
| T3e 别名终端顶栏渲染别名→真实模型 | A+B | 新增 |
| R6a GET /api/terminals/:tid 返回详情 | A | 新增（terminal-routes） |
| R6b 别名终端 alias-resolve 查代理映射 | B | 新增 |
| R6c 静态终端 alias-resolve 不调代理 | B+D | 新增 |
| R6d 终端不存在 → 404 | D | 新增 |
| R6e 代理不可达 → 200 + 失败提示 | D | 新增 |

## 不在范围
- WS push 映射变更（低频，靠刷新）
- 终端页 xterm IO（不碰）
