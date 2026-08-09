# 求助：xterm.js 网页终端 Shift+Enter 换行——发 \n 仍被 Claude CLI 当作提交

> 这是写给另一个大模型看的求助提示词。把以下完整内容贴给对方即可。

---

## 一句话问题

网页终端（xterm.js 5.3.0 + WebSocket → 后端 Node PTY 跑 Claude Code CLI）。我拦截 Shift+Enter 按键，**直接通过 WebSocket 发送原始 `\n`（LF）给后端 PTY**，绕过了 xterm。但 Claude Code CLI 仍然把 `\n` 当作"提交消息"，而不是"在输入框内换行"。我想知道：**Claude Code CLI（基于 Ink/React 的 TUI）的多行输入，到底期望接收什么字符序列才能在输入框内插入换行而不是提交？**

---

## 背景

### 项目

VS Code 扩展的 standalone 独立后端模式：Node 起 HTTP+WS 服务，浏览器用 xterm.js 渲染终端，按键通过 WebSocket 发到后端，后端 `pty.write(text)` 写进 PTY（跑 `claude` CLI）。PTY 输出回传浏览器渲染。

- 后端：Node.js ESM，`ws` 库做 WS 服务端，`node-pty` 起 PTY。
- 前端：xterm.js 5.3.0（vendored 本地 `xterm.min.js`）+ FitAddon。
- 访问：浏览器开 `http://127.0.0.1:11544/terminal/<terminalId>`。

### 数据链路

```
浏览器按键 → xterm _keyDown → attachCustomKeyEventHandler(我注册的)
  → [我直接] ws.send('\n') → 后端 ws.on('message') → pty.write('\n') → claude CLI
```

正常按键链路（非 Shift+Enter）：
```
xterm _keyDown → evaluateKeyboardEvent → triggerDataEvent → term.onData → ws.send(data) → pty.write(data)
```

---

## 我做的改动

### 已确认的事实（xterm 5.3.0 源码级）

1. **xterm 默认 Enter (keyCode 13) 发 `\r`（CR）**，且 `evaluateKeyboardEvent` 对 case 13 只检查 `e.altKey`、**忽略 `e.shiftKey`**——所以 Shift+Enter 和 Enter 默认都发 `\r`。`\r` 被 Claude CLI 当提交。

2. **`term.paste(text)` 内部会调 `prepareTextForTerminal`**，其实现是：
   ```js
   function i(e){return e.replace(/\r?\n/g,"\r")}
   ```
   **即 `term.paste('\n')` 会被转成 `\r`**——所以走 `term.paste` 发 LF 是无效的，发出去的还是 CR，等于 Enter。我已排除这条路。

3. `attachCustomKeyEventHandler(fn)` 内层实现就是 `this._customKeyEventHandler = e`，纯赋值不抛错。handler 返回 `false` 时 xterm 跳过默认按键处理（不发 `\r`）。

### 当前代码（Shift+Enter 部分）

我把 `ws` 提升到外层作用域，handler 里 Shift+Enter **直接 `ws.send('\n')` 发原始 LF**，完全绕过 xterm 的 paste/triggerDataEvent：

```js
var ws = null;
term.attachCustomKeyEventHandler(function (e) {
  if (e.type !== 'keydown') return true;
  // Shift+Enter → 换行
  if (e.keyCode === 13 && e.shiftKey) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send('\n');
    return false;   // 阻止 xterm 默认发 \r
  }
  // Ctrl+V → 粘贴（已验证可用，用 term.paste）
  if (e.keyCode === 86 && (e.ctrlKey || e.metaKey)) { /* ... term.paste(text) ... */ return false; }
  return true;
});

// ... 后面 connectWs() 里：
function connectWs() {
  ws = new WebSocket(wsUrl);
  // ...
  term.onData(function (data) { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}
connectWs();
```

### 后端（未改）

```js
// claudeSession.js spawn：
const env = {
  ...process.env,                 // ← 继承 standalone 后端进程自身的 env
  CLAUDE_CONFIG_DIR: configDir,
  ...params.env,                  // ← buildTerminalEnv 注入的 ANTHROPIC_* 路由 key
};
ptyProcess = this.pty.spawn(params.binaryPath, [], {
  cwd: params.cwd, env, cols: 80, rows: 24,
});

// attachWs：
ws.on('message', (msg) => {
  const text = msg.toString();
  handle.pty.write(text);   // 直接写进 PTY，无任何字符转换
});
```

**后端不做任何字符转换**，`ws.send('\n')` → `pty.write('\n')` 原样进 PTY。

### ⚠ 关键发现：spawn env 不含 TERM（已查证）

我查了后端 spawn PTY 的 env 构造链路：

1. `buildTerminalEnv`（`standalone/terminalApi.js`）**只注入 `ANTHROPIC_*` 路由 key（BASE_URL / AUTH_TOKEN / MODEL 等），完全不碰 `TERM`**。
2. `claudeSession.js` spawn 时 `env = { ...process.env, CLAUDE_CONFIG_DIR, ...params.env }`——**`TERM` 来自 standalone 后端进程自身继承的 `process.env.TERM`**。
3. **standalone 后端是从 Windows `cmd.exe` 窗口启动的**（`start-external-service.bat` → `run-standalone.bat` → `node standalone/cli.js`）。**Windows cmd 默认不设 `TERM` 环境变量**（除非用户系统全局设过）。

**所以 PTY spawn 时，子进程的 `TERM` 很可能是 `undefined`/空**（待我用日志最终确认，但代码链路已证 `buildTerminalEnv` 不注入 TERM、cmd 默认无 TERM）。

这是我目前**最怀疑的根因**：Claude CLI 检测到 `TERM` 缺失（或无法识别终端类型），退化成"单行输入模式"，把所有行结束符（`\r` 和 `\n`）都当提交，从而禁用了 Shift+Enter 多行输入。

---

## 症状

- **Enter**：发 `\r`（xterm 默认）→ Claude CLI 提交消息。✅ 正常。
- **Shift+Enter**（我的 handler）：直接 `ws.send('\n')` → `pty.write('\n')` → **Claude CLI 仍然提交消息，没有在输入框换行**。❌

即：发 `\n`（LF）给 Claude CLI，它当成提交，而不是换行。

---

## 我已排除的可能

1. ❌ **不是 xterm 把 `\n` 转成 `\r`**：我已经绕过 xterm，直接 `ws.send('\n')`，后端 `pty.write('\n')` 收到的就是 LF。
2. ❌ **不是后端做了转换**：后端 `ws.on('message')` 直接 `pty.write(text)`，无处理。
3. ❌ **不是 handler 没触发**：Ctrl+V 用同一个 handler 机制（`return false` 拦截）已验证可用，说明 handler 注册和拦截逻辑正常。Shift+Enter 的 `return false` 也阻止了 xterm 默认的 `\r`（否则会发两次），且 `ws.send('\n')` 确实执行了。

---

## 我的怀疑与问题

**核心怀疑：Claude Code CLI 的多行输入框组件（基于 Ink），把 LF（`\n`）也当作了"提交/换行结束"信号，而不是"插入换行符到当前输入"。**

在 canonical（cooked）模式的 PTY 里，ICANON 把 `\n` 和 `\r` 都当行结束符——这意味着 PTY 层在 `\n` 进来时就触发一次行提交，Claude CLI 收到的是一个完整行，于是当提交。

**我想问：**

1. **Claude Code CLI 的多行输入（Shift+Enter 换行）到底期望什么字符或转义序列？** 是不是根本不靠"发某个字符"，而是靠终端的某种模式（如 raw 模式 + 特定按键解析）？Claude CLI 是否在启动时把 PTY 设成 raw 模式、自己读按键？如果是 raw 模式，`\n` 不该被 ICANON 截断，那它为什么不换行？
2. **官方 Claude Code（桌面 app / CLI）里 Shift+Enter 换行，底层发的到底是什么？** 有没有人逆向/文档记录过？是 `\n`、`\r\n`、ESC 序列、还是别的？
3. **会不会是 PTY 的 ICANON/INLCR/ICRNL 设置问题？** 比如 PTY 默认 `ICRNL`（把输入的 CR 转 NL）、`INLCR`（把输入的 NL 转 CR）。如果我发 `\n`，而 PTY 没设 `INLCR`，`\n` 直接送进 Claude CLI——但 Claude CLI 可能期望的是别的。是否需要在后端 `node-pty` spawn 时调整 termios 设置？我用的 spawn 参数：`pty.spawn(binaryPath, [], { cwd, env, cols:80, rows:24 })`。
4. **有没有可能是 Claude CLI 检测到终端不支持某种能力（如 bracketed paste / 某个 terminfo 能力），从而禁用了多行输入模式？** 比如 `TERM` 环境变量设的是什么会影响 Claude CLI 是否启用多行输入。我该检查哪些 env？
5. **最稳妥的实验方案**：我想在后端 `pty.write` 前打个日志，确认 Shift+Enter 时实际写进 PTY 的字节是什么。同时尝试发不同的字节（`\n` / `\r\n` / `\r` / `\x1b` 开头的转义序列）看哪种能换行。你建议我系统地试哪些候选字节序列？

---

## 关键环境信息

- PTY: `node-pty`（Windows 上底层是 conpty），spawn `claude` CLI（Claude Code）。
- **`TERM` 环境变量：极可能缺失/空**（代码链路已证 `buildTerminalEnv` 不注入 TERM；standalone 后端从 Windows cmd 启动，cmd 默认无 TERM）。**这是首要怀疑点。**
- 终端尺寸：cols 80, rows 24（spawn 时），后续通过 WS resize 消息更新。
- xterm.js 5.3.0，浏览器 Chrome。
- 平台：Windows 11（conpty）。

---

## 我的猜测排序（请验证或反驳）

1. **最可能：PTY 子进程 `TERM` 缺失，Claude CLI 退化成单行输入模式**——所有行结束符（`\r` 和 `\n`）都当提交。需确认：(a) standalone 后端进程实际 `process.env.TERM` 是什么；(b) Claude CLI 是否依赖 `TERM`/terminfo 决定是否启用多行输入；(c) 若是，给 PTY 注入 `TERM=xterm-256color` 能否恢复多行。
2. **次可能：Claude CLI 期望的是 `\r\n`（CRLF）或某个特定转义序列**，单独 `\n` 不被识别为"插入换行"。需系统试候选字节。
3. **可能：PTY termios（conpty 无传统 termios，但 node-pty 在 Unix 有）把 `\n` 转成了 `\r`**（INLCR）——那样发 `\n` 等于发 `\r` 等于 Enter。但 Windows conpty 无 termios，此条仅 Unix 适用。

请重点帮我判断第 1 点：**Claude Code CLI 是否依赖 `TERM` 环境变量来决定是否启用多行输入（Shift+Enter 换行）？如果 `TERM` 为空，它会不会禁用多行、把所有换行符当提交？给 PTY 注入 `TERM=xterm-256color` 是否是正确的修复方向？** 以及第 2 点（期望字符序列）。
