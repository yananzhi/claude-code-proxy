# 2026-08-14 — 回退：激活写 settings.json（settings.json 为唯一事实源）

## 背景

用户要求恢复旧行为：**激活 workspace-local config 时写 `.claude_proxy/settings.json`**。
选择了「彻底回退：settings.json 为唯一事实源」——终端不再 env 注入路由 key，
CLI 直接读 settings.json。这是对 c917d06（插件 launch 改 env 注入）+ 895eeda
（standalone 激活弱化为默认标记）两层演进的反向回退。

派生节点（derived）功能已于 b180c50 移除，本回退不涉及派生。

## 目标形态

| 链路 | 现状（b180c50） | 目标（回退后） |
|---|---|---|
| standalone 激活 | `markDefaultConfig` 只写 active 标记 | `activateConfig` 恢复：写 settings.json + 注入 upstream + 标记 + permissions/gitignore |
| standalone 起终端 | `buildTerminalEnv` env 注入 BASE_URL/token/model | env 只注入 `CLAUDE_CONFIG_DIR`，LLM 配置走 settings.json |
| standalone 冲突检测 | `CONFLICT_KEYS` + strip-conflict-keys | 删除（settings.json 是唯一事实源，非残留） |
| 插件 doLocalSwitch | 只写 active 标记 | 激活即写 settings.json |
| 插件 claudeLauncher.launch() | env 注入（buildWorkspaceEnv） | 读 active 配置 → 写 settings.json（resolveSettingsContent 恢复） |
| Web UI | 「设为默认」/「✓ 默认」 | 「激活」/「✓ 已激活」 |

## 正交维度

### D1 激活写 settings.json 的写入内容
- D1a direct：`writeSettings` 原样 content
- D1b proxy：extractUpstream → 校验 → 注入 upstream → synthesizeProxySettings（BASE_URL 指 localhost:proxyPort）→ writeSettings
- D1c proxy 模式代理不可达 → 502（不假成功）
- D1d proxy 模式缺 BASE_URL/TOKEN → 400
- D1e content 非法 JSON → 400
- D1f 激活后 active 标记写入（mode 兜底 direct）

### D2 激活副作用（恢复）
- D2a 写 `.claude/settings.local.json` bypassPermissions（已设别的 defaultMode 不覆盖）
- D2b git 仓库 → .gitignore 加 .claude_proxy/；非 git 不创建

### D3 激活错误路径
- D3a workspace 不存在 → 404
- D3b config 不存在 → 404
- D3c 幂等（重复激活同 config → 标记不变）
- D3d 切换激活到另一 config → 更新

### D4 起终端（settings.json 为唯一事实源）
- D4a direct：env 只含 CLAUDE_CONFIG_DIR（不含 BASE_URL/token/model），configDir 指向 {ws}/.claude_proxy
- D4b proxy：起终端前确保 upstream 注入 + env 只含 CLAUDE_CONFIG_DIR
- D4c 无 active + 无 cfgId → 400
- D4d 带 cfgId（非 active）→ 用该 cfg 的 settings 起终端
- D4e config 不存在 → 404
- D4f pty spawn 失败 → 500
- D4g content 缺 BASE_URL → 400（buildTerminalEnv 校验保留）

### D5 冲突检测删除
- D5a settings.json 含路由 key 不再拒绝起终端（原 CONFLICT_KEYS 检测删除）
- D5b strip-conflict-keys 端点删除 → 404
- D5c 前端确认框/一键删除调用移除

### D6 Web UI
- D6a 按钮文案「设为默认」→「激活」
- D6b 徽标「✓ 默认」→「✓ 已激活」
- D6c 点「激活」→ 调 /activate → 变徽标

### D7 插件侧
- D7a doLocalSwitch：激活即写 settings.json（direct=content / proxy=注入+合成）
- D7b claudeLauncher.launch()：读 active 配置写 settings.json；无 active 不写
- D7c launch 的 env 只含 CLAUDE_CONFIG_DIR/CLAUDE_BIN（不注入路由 key）

### D8 兼容/回归
- D8a 无 workspace → doLocalSwitch/launch 报错不崩
- D8b 代理未初始化 → 报错不崩
- D8c legacy derived 字段仍剥离（load 层不变，派生已移除）

## 测试策略

- 重写 `test/standalone/activate-config.test.mjs`（markDefaultConfig 语义 → activateConfig 语义）
- 更新 `test/standalone/terminal-env.test.mjs`（D6 冲突检测 → 删除；D1/D2 改为只注入 CLAUDE_CONFIG_DIR）
- 更新 `test/standalone/terminal-routes.test.mjs`（R1b/R5a 等激活 warning 恢复）
- 更新 `test/e2e/workspaces.spec.ts`（按钮/徽标文案）
- 更新 `test/standalone/config-editor-review.test.mjs` 若引用 markDefaultConfig
- `docs/plan/tmp/` 存档 + CLAUDE.md 更新
