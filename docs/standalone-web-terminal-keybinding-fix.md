# Standalone 网页终端 Shift+Enter / Ctrl+V 失效分析与修复方案

> 调查日期：2026-08-09
> 状态：**已修复并加回归测试**（2026-08-09）
> 适用范围：Standalone 模式（独立后端网页管理界面）下通过 xterm.js 打开的终端

## 现象

Standalone 模式在网页管理界面打开的终端（运行 Claude Code CLI）有两个按键问题：

1. **Shift+Enter 无法换行**：按 Shift+Enter 直接把当前输入的消息发出去了，跟 Enter 行为一样，不能在输入框内换行。
2. **Ctrl+V 粘贴不工作**：按 Ctrl+V 无法粘贴剪贴板内容到终端。

## 涉及文件

| 文件 | 作用 | 是否需改 |
|---|---|---|
| `standalone/web/workspaces-html.js` | 前端终端页面生成（`buildTerminalHtml` 函数），含 xterm.js 初始化、WebSocket 连接、按键/数据转发全部前端逻辑 | **是，唯一修复点** |
| `standalone/claudeSession.js` | 后端 PTY 会话管理，`attachWs`（第 264-317 行）处理 WebSocket 消息 → PTY 写入 | 否，转发链路本身没问题 |
| `standalone/managementServer.js` | HTTP/WS 服务器，WebSocket 升级路由（第 448-470 行） | 否 |
| `standalone/web/vendor/xterm.min.js` | xterm.js 5.3.0 内嵌渲染引擎（`evaluateKeyboardEvent` / `_keyDown` / `handlePasteEvent` 等） | 否，不动 vendor |

## 真正的根因（2026-08-09 经 Playwright + 真实 xterm 5.3.0 vendor 实测确认）

> ⚠ 本节**修正**了下方「旧静态分析」的不完整结论。旧分析认为"xterm `evaluateKeyboardEvent` 忽略 shiftKey → Shift+Enter 发 `\r`"，但实际前端已用 `attachCustomKeyEventHandler` 拦截了 Shift+Enter 并 `return false`，`_keyDown` 并不会走到 `evaluateKeyboardEvent`。真正的泄漏在另一条路径。

### 实测证据（`test/e2e/xterm-shift-enter.spec.ts` — 永久回归测试，真实 xterm 5.3.0 vendor + Playwright 真实键盘事件）

加载真实 `standalone/web/vendor/xterm.min.js`，注册与 `workspaces-html.js` 完全一致的 `attachCustomKeyEventHandler`，用 Playwright `page.keyboard.press` 驱动真实键盘事件，捕获 `term.onData` 输出：

| 按键 | handler 行为 | onData 收到 | ws.send 路径 |
|---|---|---|---|
| plain Enter | 不拦截（return true） | `'\r'` | — |
| Shift+Enter（**修复前**：仅 return false） | ws.send('\n') + return false | **`'\r'`（泄漏！）** | `'\n'` |
| Shift+Enter（**修复后**：preventDefault+stopPropagation+return false） | ws.send('\n') + return false | **（空，不泄漏）** | `'\n'` |
| Ctrl+J | 不拦截 | `'\n'` | — |

### 泄漏机制

xterm 5.3.0 的 `_keyDown`（vendor 内）：

```js
_keyDown(e){
  this._keyDownHandled=!1,
  this._keyDownSeen=!0,
  this._customKeyEventHandler && !1===this._customKeyEventHandler(e) ? return !1 : ...
}
```

当自定义 handler 返回 `false` 时，`_keyDown` 直接 `return false`——**但全程不调 `e.preventDefault()`**。于是：

1. `keydown` → handler 跑 `ws.send('\n')`，return false → xterm `_keyDown` return false，**本次不发 `\r`**。
2. 浏览器因没被 preventDefault，**仍为 Enter 触发后续 `keypress`/`input` 事件**。
3. xterm 的 `_keyPress`（或 `_inputEvent`）捕获该事件——handler 对 `keypress` 返回 `true`（因 `e.type !== 'keydown'`），`_keyPress` 走 `cancel(e)` + `String.fromCharCode(13)` = `'\r'` → **`triggerDataEvent('\r')` → `onData('\r')` → `ws.send('\r')`**。
4. PTY 依次收到 `'\n'`（换行）+ `'\r'`（提交）。**净效果 = 提交**。这正是用户现象。

**根因：`attachCustomKeyEventHandler` 返回 `false` 时 xterm 5.3.0 不 preventDefault，浏览器后续 keypress/input 把 Enter 转成 `'\r'` 经 onData 泄漏。**

## 修复方案（已实施）

在 Shift+Enter 分支里，`return false` **之前**显式调 `e.preventDefault()` + `e.stopPropagation()`，阻止浏览器后续 keypress/input 事件，使 `'\n'` 成为唯一发到 PTY 的字节。

`standalone/web/workspaces-html.js`（`buildTerminalHtml` 内）：

```js
term.attachCustomKeyEventHandler(function (e) {
  if (e.type !== 'keydown') return true;
  if (e.keyCode === 13 && e.shiftKey) {
    // 必须 preventDefault+stopPropagation：仅 return false 不阻止浏览器后续
    // keypress/input，xterm 会把 Enter 的 keypress 转成 '\r' 经 onData 泄漏（=提交）。
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(window.__CCP_NEWLINE_SEQ);
    return false;
  }
  if (e.keyCode === 86 && (e.ctrlKey || e.metaKey)) {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (text) {
        if (text) term.paste(text);
      }).catch(function () {});
    }
    return false;
  }
  return true;
});
```

### 关键实现细节

1. **为什么用 `ws.send` 而非 `term.paste`**：xterm 的 `prepareTextForTerminal` 会把所有 LF 统一替换成 CR（结果跟 Enter 一样被 CLI 当提交）。故 Shift+Enter 直接 `ws.send` 发原始字节给 PTY，绕过 xterm 转换。`ws` 由 `connectWs()` 赋值；未连上时 `readyState` 检查自然丢弃，不报错。Ctrl+V 仍用 `term.paste(text)`：粘贴多行文本时 LF→CR 是期望行为（整段输入），不受影响。

2. **`preventDefault` + `stopPropagation` 是修复核心**：仅 `return false` 不够（见上节泄漏机制）。两者一起调，才能既阻止 xterm 默认的 `\r`，又阻止浏览器后续 keypress/input 泄漏的 `\r`。

3. **`e.type !== 'keydown'` 早返回 `true`**：xterm 对 keydown 和 keypress 都会回调 handler，只在 keydown 处理一次。注意：正是这条让 keypress 路径的 handler 返回 true、`_keyPress` 得以继续——所以 preventDefault 必须在 keydown 阶段做掉。

4. **Shift+Enter 发 `\n`（0x0a LF）**：PTY 层实测（node-pty 驱动真实 `claude.exe` + mock 上游，计 API 请求数判定 submit vs newline）确认 raw mode 下 0x0a 插入换行、不提交；只有 0x0d（CR）提交。故默认 `__CCP_NEWLINE_SEQ = '\n'`。DevTools 控制台可改 `window.__CCP_NEWLINE_SEQ` 切候选（`'\x1b[13;2u'` kitty shift+enter / `'\x1b\r'` alt-enter），无需改代码重启。

5. **Ctrl+V 用 `navigator.clipboard.readText()`**：现代浏览器 API。非安全上下文（http + 非 localhost）下可能不可用，catch 静默；退化场景下用户仍可右键粘贴（xterm 右键菜单走 `paste` 事件，不受影响）。Cmd+V（Mac）也覆盖（`e.metaKey`）。

### 不需要改的部分

- 后端 `claudeSession.js` / `managementServer.js`：WS→PTY 转发链路本身没问题（`handle.pty.write(text)` 原样透传，无转换）。
- `xterm.min.js`：不动 vendor。

## 回归测试

`test/e2e/xterm-shift-enter.spec.ts`：用真实 xterm 5.3.0 vendor + 复刻 handler，Playwright 真实键盘事件驱动，断言 onData 契约：
- plain Enter → onData `['\r']`（提交，不变）
- Shift+Enter → ws.send `['\n']`，onData **不含** `'\r'`（修复核心断言）
- Ctrl+J → onData `['\n']`（换行，不经 handler）

已验证：去掉修复（不调 preventDefault）时，Shift+Enter 用例在 `expect(onData).not.toContain('\r')` 处失败——证明是真实回归守卫，非恒真断言。

## 旧静态分析（保留供回溯，结论已被上方「真正的根因」修正）

<details>
<summary>xterm evaluateKeyboardEvent 对 Enter 的处理（旧理论，不完整）</summary>

xterm.js 5.3.0 的 `evaluateKeyboardEvent` 对 Enter 键（keyCode 13）的处理：

```js
case 13: o.key = e.altKey ? s.C0.ESC + s.C0.CR : s.C0.CR, o.cancel = true; break;
```

旧分析认为：Enter → `C0.CR`（`\r`），只检查 `altKey`、忽略 `shiftKey`，故 Shift+Enter 和 Enter 生成相同 `\r`，`o.cancel=true` → preventDefault。

**为何不完整**：前端已用 `attachCustomKeyEventHandler` 拦截 Shift+Enter，`_keyDown` 在调 `evaluateKeyboardEvent` 之前就 return false 了，根本走不到这个 case。真正泄漏的是 return false 后浏览器仍触发的 keypress/input 事件（见上方「泄漏机制」）。

</details>

## 风险

- `navigator.clipboard.readText()` 在非安全上下文退化：本地/frp-https 无影响，http-非localhost 退化到右键粘贴（已有能力，不丢功能）。
- Shift+Enter 发 `\n` vs `\r\n`：PTY 层实测 `\n`（0x0a）在 raw mode 下插入换行不提交，无需 `\r\n`。若个别环境不生效，DevTools 改 `window.__CCP_NEWLINE_SEQ` 切候选排查。
- `attachCustomKeyEventHandler` 返回 `false` + 显式 preventDefault 仅对明确拦截的 Shift+Enter 生效，其余 `return true`，不影响其他按键。
