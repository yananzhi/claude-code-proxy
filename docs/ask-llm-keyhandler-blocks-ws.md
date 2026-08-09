# 求助：xterm.js attachCustomKeyEventHandler 是否可能阻断 WebSocket 连接？

> 这是写给另一个大模型看的求助提示词。把以下完整内容贴给对方即可。

---

## 一句话问题

在一个网页终端（xterm.js 5.3.0 + WebSocket）里，**仅仅在 `term.open()` 之后加了一段 `term.attachCustomKeyEventHandler(...)`，新建的终端页面就一直停在"正在连接终端..."，WebSocket 仿佛连不上**。把这段 handler 注释掉（其余代码一字不改）后，连接恢复正常。

我想确认：**从 xterm.js / 浏览器原理上看，`attachCustomKeyEventHandler` 有没有任何可能阻断 WebSocket 连接？还是说一定是别的因素（比如旧进程缓存）在作祟？**

---

## 背景：这是什么项目

一个 VS Code 扩展的 **standalone 独立后端模式**：用 Node 起一个 HTTP+WS 服务（management 端口 11544），提供网页管理界面。其中"网页终端"功能：在浏览器里用 xterm.js 渲染终端，通过 WebSocket 把按键发到后端，后端写进 PTY（跑 Claude Code CLI），PTY 输出再通过 WS 回传给浏览器渲染。

技术栈：
- 后端：Node.js（ESM），`http` + `http` upgrade → `WebSocket`（用 `ws` 库做 WS 服务端）。
- 前端：原生 HTML（后端用模板字符串拼出来返回），xterm.js 5.3.0（vendored 本地 `xterm.min.js`，非 CDN）+ FitAddon。
- 访问方式：浏览器开 `http://127.0.0.1:11544/terminal/<terminalId>`。

---

## 我做了什么改动（唯一改动点）

前端终端页由后端函数 `buildTerminalHtml({terminalId, apiBase})` 生成（一个模板字符串）。原代码在 `term.open(termEl)` 之后**没有**注册任何 `attachCustomKeyEventHandler`。

我为修两个按键 bug（Shift+Enter 不换行、Ctrl+V 不粘贴），在 `term.open()` 之后、`connectWs()`（建立 WebSocket 的函数）之前，加了这段：

```js
var termEl = document.getElementById('terminal');
term.open(termEl);
try { fit.fit(); } catch (e) {}

// ===== 我新加的这段 =====
term.attachCustomKeyEventHandler(function (e) {
  if (e.type !== 'keydown') return true;
  // Shift+Enter → 换行
  if (e.keyCode === 13 && e.shiftKey) {
    term.paste('\n');
    return false;
  }
  // Ctrl+V / Cmd+V → 粘贴剪贴板
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
// ===== 新加段结束 =====

if (typeof ResizeObserver !== 'undefined') { /* ... ResizeObserver ... */ }
```

之后的 `connectWs()`（一字未改）长这样：

```js
var wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + apiBase
          + '/api/terminals/' + encodeURIComponent(tid) + '/ws';

function connectWs() {
  var ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onopen = function () {
    msgEl.className = 'msg ok';
    msgEl.textContent = '';   // ← 清掉"正在连接终端..."提示
    term.focus();
    sendResize();
  };
  ws.onmessage = function (ev) { /* ... term.write ... */ };
  ws.onclose = function (ev) { /* 显示关闭原因 */ };
  ws.onerror = function () { /* 显示"WebSocket 连接错误" */ };
  term.onData(function (data) { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
  // ...
}

connectWs();  // 立即调用
```

页面初始 HTML 里有个 `<div id="msg">正在连接终端...</div>`，**只有 `ws.onopen` 会把它清空**。所以"一直停在正在连接终端"=`ws.onopen` 没触发 = WebSocket 没连上（或连上了但 onopen 没跑）。

---

## 现象与对照

| 场景 | 现象 |
|---|---|
| 加了 handler | 新建终端页停在"正在连接终端..."，`onopen` 不触发 |
| 把 handler 整段注释掉（其余代码不改） | 连接正常，`onopen` 触发，提示清空，终端可用 |

**注意**：这个对照不是 100% 干净——见下文"干扰因素"。

---

## 已做的诊断（都指向"不是 handler 的锅"，但现象又像）

1. **后端 WS 握手正常**：用 `curl` 模拟 WS 升级请求，后端返回 `101 Switching Protocols`，PTY 进程也活着。
2. **terminalId 在后端存在**：后端能查到对应的 PTY session。
3. **HTML 正确返回**：`GET /terminal/<tid>` 返回的 HTML 含我加的 handler 代码。
4. **关键干扰因素**：standalone 后端是 ESM，**在进程启动时 import 了生成 HTML 的模块**。改这个模块的源文件后，**运行中的旧进程不会热更新**——必须重启服务才生效。我曾遇到：改了代码不重启，旧进程仍跑着旧 HTML（或中间态），表现为"卡在连接中"；重启服务后正常。

---

## 干扰因素（为什么我不能 100% 断定是 handler）

- 上一次同样现象（卡在连接中），最终靠**重启服务**解决，当时 handler 是被注释掉的。所以"卡连接"可能纯粹是旧进程/状态问题，跟 handler 无关。
- 但这次用户报告"又卡了"，且用户认为就是新代码引入的。我无法 100% 排除用户又没重启服务，或者重启了但浏览器缓存了旧 HTML。

---

## 我的分析（为什么我觉得 handler 不该阻断 WS）

1. `attachCustomKeyEventHandler` 注册的是一个**按键事件回调**，只在用户按键时被 xterm 的 `_keyDown` 调用。页面刚加载、还没人按键时，这个 handler 根本不会执行。
2. WebSocket 连接是 `connectWs()` 里 `new WebSocket(wsUrl)` 发起的，跟 handler 注册**完全独立**，handler 不会抛异常中断 `connectWs()`（handler 注册语句本身是同步的、不会抛——`term.attachCustomKeyEventHandler` 只是存个函数引用）。
3. handler 里用的 `term.paste`、`navigator.clipboard` 都在按键回调内部，连接建立阶段不会跑到。
4. handler 返回 `true`（默认放行）对所有非 Shift+Enter/Ctrl+V 的按键，不影响 xterm 正常行为。

**所以从原理上我想不通 handler 怎么阻断 WS。** 但对照实验又显示注释掉就好。

---

## 我想问的问题

1. **`term.attachCustomKeyEventHandler(fn)` 在 xterm.js 5.3.0 里，有没有任何副作用会影响到页面其它部分（比如事件循环、focus、甚至抛错中断后续脚本）？** 比如注册时机、handler 内部对 term 状态的假设、或者 5.3.0 某个已知 bug？
2. **handler 注册语句本身会不会抛异常？** 如果 `term.attachCustomKeyEventHandler` 在 `term.open()` 之后、`connectWs()` 之前调用，如果它抛错（比如某个版本要求在 open 前注册，或要求特定 addon），**会不会导致后面的 `connectWs()` 根本没执行**——从而 WS 没建立，停在"连接中"？这是我目前能想到的最合理解释。请帮我判断这个 API 的注册时机约束。
3. **`term.paste()` 在 handler 里调用是否安全？** 尤其当 WS 还没连上时（`onData` 绑定的 `ws.send` 有 `readyState` 守卫，应该安全）。
4. **如果不是 handler 本身的问题，最可能是什么？** 我怀疑是 ESM 模块缓存（旧进程没热更新）+ 浏览器缓存旧 HTML 的组合。但用户认为是新代码引入的。你如何建议我做一次**干净的对照实验**来彻底区分"代码问题"vs"进程/缓存问题"？
5. 有没有更稳妥的注册位置/方式（比如挪到 `ws.onopen` 之后，或用 try-catch 包住），既能修按键又不冒险影响连接？

---

## 关键文件片段（完整终端页生成函数的脚本部分）

```html
<script>
(function () {
  var tid = 'TID_PLACEHOLDER';   // 后端填入真实 terminalId
  var apiBase = 'APIBASE_PLACEHOLDER';
  var msgEl = document.getElementById('msg');

  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
    msgEl.className = 'msg err';
    msgEl.textContent = 'xterm.js 加载失败';
    return;
  }

  var term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Consolas, Menlo, monospace',
    fontSize: 14,
    scrollback: 1000,
    allowPropposedApi: true,
  });
  var fit = new FitAddon.FitAddon ? new FitAddon.FitAddon() : new FitAddon();
  term.loadAddon(fit);
  var termEl = document.getElementById('terminal');
  term.open(termEl);
  try { fit.fit(); } catch (e) {}

  // 【我加的】自定义按键 handler
  term.attachCustomKeyEventHandler(function (e) {
    if (e.type !== 'keydown') return true;
    if (e.keyCode === 13 && e.shiftKey) { term.paste('\n'); return false; }
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

  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(function () { try { fit.fit(); } catch (e) {} });
    ro.observe(termEl);
  }

  var wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host
            + apiBase + '/api/terminals/' + encodeURIComponent(tid) + '/ws';

  function connectWs() {
    var ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { msgEl.textContent = ''; term.focus(); sendResize(); };
    ws.onmessage = function (ev) { /* term.write */ };
    ws.onclose = function (ev) { /* 显示关闭 */ };
    ws.onerror = function () { /* 显示错误 */ };
    term.onData(function (data) { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
  }

  connectWs();
})();
</script>
```

---

## 我的猜测排序（请验证或反驳）

1. **最可能：进程/缓存问题，与 handler 无关。** ESM 旧进程没热更新 + 浏览器缓存旧 HTML，导致"加了 handler 后卡"是时间巧合。证据：上次同现象靠重启解决。
2. **次可能：handler 注册在 open 之后、connectWs 之前，某种原因抛错，中断了 connectWs。** 但 `attachCustomKeyEventHandler` 只是存函数引用，理论上不该抛。需确认 5.3.0 是否有注册时机约束。
3. **不太可能：handler 内部逻辑间接影响。** 但连接阶段没人按键，handler 不执行。

请重点帮我判断第 2 点是否成立，以及给一个干净对照实验方案。
