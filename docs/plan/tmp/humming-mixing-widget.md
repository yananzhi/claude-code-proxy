# standalone 管理主页移动端响应式适配

## Context

standalone 独立后端的工作区管理主页（`buildWorkspacesHtml`）当前是**纯 PC 布局，零移动端适配**：无 viewport meta、无 `@media`、无响应式。手机打开会按 980px 视口渲染后整体缩小，文字极小；更致命的是配置行的编辑/删除/停止按钮（`.icon-btn`）靠 `hover` 才显示——手机没 hover，这些按钮永远不可见，导致管理主页在手机上基本不可用。

本次目标：让管理主页在手机浏览器上自动可用（PC 不受影响）。**范围仅限 `buildWorkspacesHtml` 一个函数**——配置编辑器、终端页（xterm）本次不动（终端页的"聊天框模式"留作后续探索）。

设备判断策略：**纯 CSS 响应式**（viewport meta + `@media` 断点 + `@media (hover: none)`），不引入 JS UA 嗅探 / 触屏检测。理由：
- 主页唯一的"触屏特殊处理"就是 icon-btn 常显，`@media (hover: none)` 纯 CSS 即可解决，不需要 JS。
- 不动 JS 逻辑就不会碰到 CLAUDE.md 反复强调的反引号模板 `\n`/`\r` 转义陷阱（已踩 2 次的坑）。
- UA 嗅探易过时、手机可请求桌面版，CSS 媒体查询直接反映真实可用宽度/指针类型，更可靠。
- 项目内 `proxy/web/index.html` 已是此模式（行 5 有 viewport meta），照着来。

## 改动文件

只改一个文件：`standalone/web/workspaces-html.js` 的 `buildWorkspacesHtml` 函数（行 10-511），且**只改 CSS `<style>` 块（行 17-61）+ `<head>` 加 viewport meta（行 16 后）**，JS 逻辑（行 80-508）和 HTML 结构（行 64-78）原则上不动。

## 具体改动

### 1. `<head>` 加 viewport meta（行 16 后插入）

```
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

照 `proxy/web/index.html` 行 5 的写法。这是手机正常渲染的前提（否则手机按 980px 默认视口整体缩小）。

### 2. `<style>` 块加响应式规则（在现有 CSS 末尾、`</style>` 前追加 `@media` 块）

针对小屏（断点 `max-width: 600px`）和触屏（`hover: none`）两类，追加：

**(a) 小屏布局自适应** `@media (max-width: 600px)`：
- `body`：`margin: 12px auto; padding: 0 10px;`（缩小外边距/内边距，max-width 980px 在小屏自然不触发）
- `.row`（新建 workspace 表单行）：已是 `flex-wrap: wrap`，小屏让 input 占满宽——`input[type=text] { min-width: 0; flex: 1 1 100%; }`，去掉行 70 内联 `style="min-width:360px"` 的固定宽度（改为 `min-width:0` 或直接移除内联 style 让媒体查询接管）。⚠ 移除内联 style 是改 HTML 结构行 70，需确认；若不想动 HTML，可用 `input#dir { min-width: 0 !important; }` 覆盖（但项目风格少用 !important，优先改内联 style）。
- `.dir-picker`（目录选择器弹窗）：`width: 560px` → 小屏改 `width: calc(100vw - 20px); max-width: 560px; left: 10px; right: 10px; transform: none;`（全宽，去掉 translateX 居中）。
- `.ws-head`：`flex-wrap: wrap;`（workspace 头部的名字/meta/删除按钮在小屏换行，删除按钮独占一行或跟在后面）。
- `.config-row / .derived-row / .term-row`：`flex-wrap: wrap;`（配置行按钮多，小屏允许换行，避免横向溢出）。
- `.group`：`margin-left: 12px;`（缩小缩进，原 24px 在小屏占太多）。

**(b) 触屏 icon-btn 常显** `@media (hover: none)`：
- `.icon-btn { opacity: 1; }`（触屏设备无 hover，让重命名/删除/停止按钮常显，否则永远看不见）。
- 这是核心——解决"手机上配置行按钮不可见"的致命问题。

### 3. 测试看护同步更新

**`test/standalone/tree-html.test.mjs` T8d（行 192-198）**——当前断言：
```js
assert.ok(/opacity:\s*0/.test(html) && /hover.*icon-btn.*opacity:\s*1/.test(html.replace(/\n/g,'')), '应有 hover 显示规则');
```
改动后 HTML 仍含 `.icon-btn { opacity: 0 }`（PC 默认规则保留）和 `@media (hover: none) .icon-btn { opacity: 1 }`，原断言的 `hover.*icon-btn.*opacity:1` 正则会匹配 `@media (hover: none)` 里的 `icon-btn ... opacity: 1`，**大概率仍通过**（正则不区分 hover 是 `:hover` 还是 `(hover: none)`）。需实跑确认；若不通过，把断言放宽为"PC 有 hover 显示规则 + 触屏有常显规则"两条分别断言。

其余测试（T1k 内联 JS 语法体检、T2a XSS 守卫、T1a-T1w 结构/文案断言）**不受影响**——因为只改 CSS、不动 JS/HTML 结构。T1k 尤其要跑过（验证没误碰模板转义）。

### 4. 新增移动端回归测试（建议）

在 `tree-html.test.mjs` 加 1-2 条断言看护移动端适配不被回退：
- `viewport` meta 存在：`assert.ok(/name="viewport".*width=device-width/.test(html))`
- 触屏常显规则存在：`assert.ok(/@media\s*\(\s*hover:\s*none\s*\)/.test(html) && /icon-btn.*opacity:\s*1/.test(html))`

## 不改动的部分（明确边界）

- **JS 逻辑不动**（行 80-508）：不引入 UA 判断、不引入 `navigator.maxTouchPoint`、不改任何交互函数。降低踩模板转义陷阱的风险。
- **配置编辑器**（`buildConfigEditorHtml`）本次不动——5 列 grid 别名表在小屏虽会溢出，但用户明确"只做管理主页"，配置编辑器手机上少用。
- **终端页**（`buildTerminalHtml` / xterm）本次不动——xterm 移动端硬伤（无软键盘、无组合键）留待"聊天框模式"探索。
- **`managementServer.js` 路由不动**——纯前端 CSS 改动，后端零改动。

## 验证

1. **单元测试**（看护不回退）：
   ```
   node --test test/standalone/tree-html.test.mjs
   ```
   重点看 T8d（hover 规则）、T1k（内联 JS 语法）、新增的 viewport/触屏断言。

2. **e2e**（如有主页 e2e）：`npm run test:e2e`，确认 `workspaces.spec.ts` 不受影响。

3. **手动验证（关键）**：起 standalone 后端，浏览器 DevTools 切设备模拟（或手机真机访问）：
   - PC（>600px）：布局与改动前一致，icon-btn 仍 hover 显示（回归确认）。
   - 手机（≤600px）：文字正常大小（非缩小）、新建表单 input 占满宽、目录选择器全宽、配置行按钮换行不溢出。
   - 触屏（hover:none）：配置行的 ✎/✕、终端行的 ✕ 停止按钮**常显可见可点**（核心修复点）。

4. **全量回归**（确保零副作用）：
   ```
   node --test --test-concurrency=1 test/standalone/
   ```
