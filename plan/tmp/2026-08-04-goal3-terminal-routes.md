# 2026-08-04 目标3：起终端入口双通道 + 路由参数化

> 终端统一走 env + 激活弱化后，起终端不再依赖全局 active 配置。
> 起终端 API 支持指定 cfgId；配置行内按钮（带 cfgId）+ 终端组下拉（选 cfgId）共存。
> 设计依据：docs/standalone管理界面重设计.md 第 6 节决策 2。

## 改造前（现状）

| 入口 | 路由 | 限制 |
|---|---|---|
| workspace 级 | `POST /api/workspaces/:id/terminals` | 取 active config，**拒绝派生 active**（400），无 cfgId 参数 |
| config 级 | `POST /api/workspaces/:id/configs/:cfgId/terminals` | **必须派生配置**（普通配置 400） |

两个入口逻辑重复（取 config + buildTerminalEnv + ensureProjectPermissions + start），且类型限制相反。

## 改造后（目标）

抽 `startTerminalForConfig(manager, sessions, opts, wsId, cfgId)` 共享逻辑（取 config + parent + buildTerminalEnv + permissions/gitignore + start）。两个入口都调它：

| 入口 | 路由 | cfgId 来源 | 类型限制 |
|---|---|---|---|
| workspace 级 | `POST /api/workspaces/:id/terminals` | body 可选 cfgId；不传则用 active | 无（普通/派生都行） |
| config 级 | `POST /api/workspaces/:id/configs/:cfgId/terminals` | URL 参数（必传） | 无（普通/派生都行） |

**取消的限制**：
- workspace 级不再拒绝派生 active（标记可指向派生，起终端也允许）
- config 级不再拒绝普通配置

**kind 标记**：仍按 config 类型标 `normal`/`derived`（来自 cfg.derivedFrom），终端页区分用。

## 正交维度

### 维度 A：入口（workspace 级 vs config 级）
- workspace 级 + body 带 cfgId → 指定配置起终端
- workspace 级 + 无 cfgId → 用 active 起终端（兼容旧行为）
- config 级 + URL cfgId → 指定配置起终端

### 维度 B：config 类型（普通 vs 派生）
- workspace 级起普通配置终端 → kind=normal
- workspace 级起派生配置终端 → kind=derived（取消旧"拒绝派生 active"）
- config 级起普通配置终端 → kind=normal（取消旧"拒绝普通配置"）
- config 级起派生配置终端 → kind=derived

### 维度 C：cfgId 来源
- workspace 级 body.cfgId
- workspace 级无 body → active.id
- config 级 URL cfgId

### 维度 D：active 解析（workspace 级无 cfgId 时）
- 有 active → 用 active config
- 无 active → 400（引导先标记默认）
- active 指向已删 config → 400（悬空指针兜底，保留）

### 维度 E：错误路径
- workspace/config 不存在 → 404
- cfgId 指向不存在的 config → 404
- 无 active 且无 cfgId → 400
- 二进制缺失 → 400

### 维度 F：共享逻辑一致性
- 两个入口对同一 cfgId 产生相同 env/configDir/kind（除 terminalId 外）

## 测试用例（维度覆盖）

`terminal-routes.test.mjs`：
| 用例 | 维度 | 现有/新增/重写 |
|---|---|---|
| R1a 无 active + 无 cfgId → 400 | D+E | 保留 |
| R1b workspace 级 + active direct → 201 kind=normal | A+B+D | 保留 |
| R1c workspace 级 + body cfgId（普通）→ 201 用该 cfg | A+C | **新增** |
| R1d workspace 级 + body cfgId（派生）→ 201 kind=derived | A+B+C | **新增**（取消旧限制） |
| R2a config 级 + 普通配置 → 201（取消旧 400） | A+B | **重写** |
| R2b config 不存在 → 404 | E | 保留 |
| R2c config 级 + 派生配置 → 201 kind=derived | A+B | 保留（原 R2a 派生路径） |
| F1 两入口同 cfgId → env/configDir 一致 | F | **新增** |

## 不在范围
- 前端按钮/下拉（目标4 改树形时一起做）
- 别名终端顶栏（目标6）
