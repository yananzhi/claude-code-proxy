# 2026-08-04 目标1：终端统一走 env — 静态终端改造

> 重设计地基。改 `standalone/terminalApi.js` 的 `buildTerminalEnv` normal 分支：
> 从"env 只注入 CLAUDE_CONFIG_DIR 读 settings.json"改为"env 注入 ANTHROPIC_* 真实配置 + per-terminal 空目录"。
> 设计依据：docs/standalone管理界面重设计.md 第 2 节。

## 改造前（现状）

| config 类型 | env | configDir | 代理交互 |
|---|---|---|---|
| normal-direct | `{}`（空，靠 settings.json） | `{ws}/.claude_proxy` | 不碰代理 |
| normal-proxy | `{}`（空，靠 settings.json） | `{ws}/.claude_proxy` | 注入 upstream |
| derived | BASE_URL(代理)+TOKEN+四档别名 | `{ws}/.claude_proxy/sessions/{tid}` | 注入 upstream + 同步别名 |

问题：normal 终端依赖 settings.json（需先 activateConfig 写文件），与"终端统一走 env"初衷冲突。

## 改造后（目标）

| config 类型 | env | configDir | 代理交互 |
|---|---|---|---|
| normal-direct | BASE_URL(上游)+TOKEN+MODEL(+SMALL_FAST_MODEL?+TIMEOUT?) | `{ws}/.claude_proxy/sessions/{tid}` | 不碰代理 |
| normal-proxy | BASE_URL(代理)+TOKEN+MODEL(+SMALL_FAST_MODEL?+TIMEOUT?) | `{ws}/.claude_proxy/sessions/{tid}` | 注入 upstream |
| derived | 不变 | 不变 | 不变 |

## 正交维度

### 维度 A：config 类型（normal-direct / normal-proxy / derived）
- normal-direct：env 含上游真实地址
- normal-proxy：env BASE_URL 指向代理（http://127.0.0.1:proxyPort）
- derived：不变（不在本次改造范围，但保留 D3 测试不破）

### 维度 B：env 字段注入（normal 新增）
- ANTHROPIC_BASE_URL：direct=上游地址 / proxy=代理地址
- ANTHROPIC_AUTH_TOKEN：上游 token（direct/proxy 都用上游 token）
- ANTHROPIC_MODEL：content 里有则注入
- ANTHROPIC_SMALL_FAST_MODEL：content 里有则注入（可选）
- API_TIMEOUT_MS：content 里有则注入（可选，秒→毫秒字符串，与 derived 一致）

### 维度 C：configDir（normal 改 per-terminal）
- direct/proxy：`{ws}/.claude_proxy/sessions/{terminalId}`（per-terminal 空目录，不再指向共享 .claude_proxy）
- 与 derived 一致（防 settings.json 覆盖 env）

### 维度 D：代理交互（normal 不变）
- direct：不碰代理（fwd.calls 无 /api/upstream）
- proxy：注入 upstream（POST /api/upstream，含 model/smallFastModel/timeoutSec）

### 维度 E：错误路径（保留现有）
- direct/proxy 缺 BASE_URL → ValidationError
- direct/proxy 缺 TOKEN → ValidationError
- direct/proxy content 非法 JSON → ValidationError
- proxy 模式代理拒绝 upstream → ProxyUnavailableError

### 维度 F：边界
- content 无 ANTHROPIC_MODEL（可选字段）→ env 不含 ANTHROPIC_MODEL（不报错）
- content 无 ANTHROPIC_SMALL_FAST_MODEL → env 不含
- content 无 API_TIMEOUT_MS → env 不含
- content API_TIMEOUT_MS 非法/非正 → env 不含（与 derived timeoutSec 逻辑一致）

## 测试用例（维度覆盖）

| 用例 | 维度 | 现有/新增/重写 |
|---|---|---|
| D1a direct → env 含上游 BASE_URL/TOKEN/MODEL + per-terminal configDir + 不碰代理 | A+B+C+D | **重写** |
| D1b direct 缺 BASE_URL → throw | E | 保留 |
| D1c direct 缺 TOKEN → throw | E | 保留 |
| D1d direct content 非法 JSON → throw | E | 保留 |
| D1e direct content 无 MODEL → env 不含 MODEL（不报错） | F | **新增** |
| D1f direct content 无 SMALL_FAST_MODEL/TIMEOUT → env 不含 | F | **新增** |
| D1g direct → env 含 SMALL_FAST_MODEL + TIMEOUT（毫秒字符串） | B+F | **新增** |
| D2a proxy → env BASE_URL=代理 + TOKEN + MODEL + per-terminal configDir + 注入 upstream | A+B+C+D | **重写** |
| D2b proxy + 代理拒绝 → throw | E | 保留 |
| D2c proxy → upstream body 含 model/smallFastModel/timeoutSec | D | **新增** |
| D3 derived（不变，验证不破） | A | 保留 |

## 不在范围
- 调用方（managementServer 起终端路由）暂不改（目标 3 改起终端入口时一起改）
- activateConfig 暂不改（目标 2 弱化激活时一起改）
- derived 分支不动
