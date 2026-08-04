// standalone/web/workspaces-html.js — workspace 管理网页 HTML（ESM JS）
//
// 阶段 2 最小管理页：列出/创建/删除 workspace + 显示每个 workspace 的 local 配置（只读）。
// 配置编辑（CRUD/别名）留阶段 4。
//
// 通信：fetch 调同端口 management API（/api/workspaces）。

/** 生成 workspace 管理网页 HTML（树状：workspace → configs → derived → terminals）。
 * proxyPort 用于显示"打开控制台"链接。通信：fetch 调同端口 management API。 */
export function buildWorkspacesHtml({ apiBase = '', proxyPort } = {}) {
    const proxyLink = proxyPort ? `http://127.0.0.1:${proxyPort}/` : '';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Claude Code Proxy — Workspace 管理</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 980px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 24px; }
  .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
  input[type=text] { padding: 4px 8px; min-width: 200px; }
  button { padding: 4px 12px; cursor: pointer; }
  .tree { margin: 8px 0; }
  .ws-node { border: 1px solid #ddd; border-radius: 6px; margin: 8px 0; padding: 0; }
  .ws-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #f7f7f7; border-radius: 6px 6px 0 0; }
  .ws-head .name { font-weight: 600; }
  .ws-head .meta { color: #666; font-size: 0.82rem; }
  .ws-body { padding: 6px 12px 10px 12px; }
  .toggle { cursor: pointer; user-select: none; width: 16px; display: inline-block; color: #555; }
  .group { margin: 6px 0 6px 24px; }
  .group-title { font-size: 0.85rem; color: #555; font-weight: 600; margin: 6px 0 2px 0; }
  .config-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; margin-left: 8px; }
  .derived-row { display: flex; align-items: center; gap: 8px; padding: 3px 0 3px 28px; }
  .term-row { display: flex; align-items: center; gap: 8px; padding: 2px 0 2px 44px; font-size: 0.85rem; }
  .cfg-link { color: #06c; text-decoration: none; }
  .cfg-link:hover { text-decoration: underline; }
  .term-link { color: #06c; text-decoration: none; }
  .term-link:hover { text-decoration: underline; }
  .cfg-act { padding: 2px 8px; font-size: 0.8rem; cursor: pointer; }
  .cfg-new-term { padding: 2px 8px; font-size: 0.8rem; cursor: pointer; background: #eef; border: 1px solid #ccd; border-radius: 3px; }
  .active-badge { color: #060; background: #efe; padding: 2px 6px; border-radius: 3px; font-size: 0.78rem; font-weight: 600; }
  .derived-tag { color: #649; font-size: 0.78rem; }
  .danger { color: #c00; }
  .msg { padding: 8px; margin: 8px 0; border-radius: 4px; }
  .msg.err { background: #fee; color: #c00; }
  .msg.ok { background: #efe; color: #060; }
  .msg.warn { background: #ffd; color: #960; }
  .proxy-link { margin: 8px 0; }
</style>
</head>
<body>
<h1>Claude Code Proxy — Workspace 管理</h1>
${proxyLink ? `<div class="proxy-link">代理控制台（trace/统计）：<a href="${escapeHtml(proxyLink)}" target="_blank">${escapeHtml(proxyLink)}</a></div>` : ''}

<h2>新建 Workspace</h2>
<div class="row">
  <input id="name" type="text" placeholder="名字（如 my-project）">
  <input id="dir" type="text" placeholder="磁盘目录绝对路径（如 D:/code/my-project）" style="min-width:400px">
  <button onclick="createWs()">创建</button>
</div>
<div id="msg"></div>

<h2>已注册 Workspaces</h2>
<div id="list" class="tree">加载中...</div>

<script>
var API = ${safeJsonForScript(apiBase)};
function showMsg(text, kind) {
  var el = document.getElementById('msg');
  el.className = 'msg ' + (kind || 'ok');
  el.textContent = text;
  setTimeout(function() { el.textContent = ''; el.className = ''; }, kind === 'warn' ? 8000 : 4000);
}

// 从 normal 父配置新建派生配置：取 next-alias-id → POST 派生 → 跳编辑页
function newDerivedConfig(wsId, parentId, parentName) {
  fetch(API + '/api/workspaces/' + encodeURIComponent(wsId) + '/next-alias-id')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error || d.id == null) { showMsg('取派生编号失败: ' + (d.error || '未知'), 'err'); return; }
      var idx = d.id;
      var body = { name: (parentName || 'cfg') + ' #' + idx, derivedFrom: parentId, derivedIndex: idx };
      return fetch(API + '/api/workspaces/' + encodeURIComponent(wsId) + '/configs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function(r) { return r.json(); }).then(function(dd) {
        if (dd.error) { showMsg('建派生配置失败: ' + dd.error, 'err'); return; }
        showMsg('已建派生配置 #' + idx + '，请在编辑页配别名', 'ok');
        setTimeout(function() {
          window.location.href = API + '/workspace/' + encodeURIComponent(wsId) + '/configs/' + encodeURIComponent(dd.config.id) + '/edit';
        }, 300);
      });
    })
    .catch(function(e) { showMsg('建派生配置异常: ' + e.message, 'err'); });
}

// 新建 normal 终端（基于 active config）
function newTerminal(wsId) {
  fetch(API + '/api/workspaces/' + encodeURIComponent(wsId) + '/terminals', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) { showMsg('新建终端失败: ' + d.error, 'err'); return; }
      window.open(API + '/terminal/' + encodeURIComponent(d.terminalId), '_blank');
      loadList();
    })
    .catch(function(e) { showMsg('新建终端异常: ' + e.message, 'err'); });
}
// 新建派生终端
function newDerivedTerminal(wsId, cfgId) {
  fetch(API + '/api/workspaces/' + encodeURIComponent(wsId) + '/configs/' + encodeURIComponent(cfgId) + '/terminals', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) { showMsg('新建派生终端失败: ' + d.error, 'err'); return; }
      window.open(API + '/terminal/' + encodeURIComponent(d.terminalId), '_blank');
      loadList();
    })
    .catch(function(e) { showMsg('新建终端异常: ' + e.message, 'err'); });
}
// 激活 config
function activateCfg(wsId, cfgId, btn) {
  btn.disabled = true;
  fetch(API + '/api/workspaces/' + encodeURIComponent(wsId) + '/configs/' + encodeURIComponent(cfgId) + '/activate', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) { showMsg(d.error, 'err'); btn.disabled = false; return; }
      var msg = '已激活（' + (d.mode || '') + '）';
      if (d.warning) { showMsg(msg + '  ⚠ ' + d.warning, 'warn'); }
      else { showMsg(msg, 'ok'); }
      loadList();
    })
    .catch(function(e) { showMsg(e.message, 'err'); btn.disabled = false; });
}
// 删除 terminal
function stopTerminal(tid, btn) {
  fetch(API + '/api/terminals/' + encodeURIComponent(tid), { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(d) { loadList(); })
    .catch(function(e) { showMsg(e.message, 'err'); });
}

async function loadList() {
  try {
    var r = await fetch(API + '/api/workspaces');
    var data = await r.json();
    var list = document.getElementById('list');
    if (!data.workspaces || data.workspaces.length === 0) {
      list.textContent = '（无 workspace，上方新建）';
      return;
    }
    list.textContent = '';
    for (var ws of data.workspaces) {
      list.appendChild(buildWsNode(ws));
    }
  } catch (e) {
    document.getElementById('list').textContent = '加载失败: ' + e.message;
  }
}

function buildWsNode(ws) {
  var node = document.createElement('div');
  node.className = 'ws-node';
  var head = document.createElement('div');
  head.className = 'ws-head';
  var tog = document.createElement('span');
  tog.className = 'toggle';
  tog.textContent = '▼';
  head.appendChild(tog);
  var name = document.createElement('span');
  name.className = 'name';
  name.textContent = ws.name;
  head.appendChild(name);
  var idTag = document.createElement('span');
  idTag.className = 'meta';
  idTag.textContent = '[' + ws.id + ']  ' + ws.dir + '  ·  创建于 ' + (ws.createdAt || '?');
  head.appendChild(idTag);
  var delBtn = document.createElement('button');
  delBtn.className = 'danger';
  delBtn.textContent = '删除';
  delBtn.onclick = async function() {
    if (!confirm('删除 workspace "' + ws.name + '"？\\n（只移除索引，不删磁盘文件）')) return;
    var rr = await fetch(API + '/api/workspaces/' + encodeURIComponent(ws.id), { method: 'DELETE' });
    if (rr.ok) { showMsg('已删除'); loadList(); } else { var e = await rr.json(); showMsg(e.error, 'err'); }
  };
  head.appendChild(delBtn);
  node.appendChild(head);

  var body = document.createElement('div');
  body.className = 'ws-body';
  node.appendChild(body);

  tog.onclick = function() {
    var hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    tog.textContent = hidden ? '▼' : '▶';
  };

  // 异步加载 configs + active + normal terminals
  Promise.all([
    fetch(API + '/api/workspaces/' + encodeURIComponent(ws.id)).then(function(r){return r.json();}),
    fetch(API + '/api/workspaces/' + encodeURIComponent(ws.id) + '/active').then(function(r){return r.json();}),
    fetch(API + '/api/workspaces/' + encodeURIComponent(ws.id) + '/terminals').then(function(r){return r.json();}),
  ]).then(function(results) {
    var d = results[0], a = results[1], t = results[2];
    var configs = d.configs || [];
    var activeId = (a.active && a.active.id) || null;
    var normalTerms = t.terminals || [];
    renderWsBody(body, ws, configs, activeId, normalTerms);
  }).catch(function() {
    body.appendChild(document.createTextNode('加载失败'));
  });
  return node;
}

function renderWsBody(body, ws, configs, activeId, normalTerms) {
  body.textContent = '';
  // 分离 parent configs 和 derived
  var parents = configs.filter(function(c){ return c.derivedFrom === undefined; });
  var derivedOf = {};
  configs.forEach(function(c){ if (c.derivedFrom !== undefined) { (derivedOf[c.derivedFrom] = derivedOf[c.derivedFrom] || []).push(c); } });

  // Local LLM Configs 分组
  var cfgGroup = document.createElement('div');
  cfgGroup.className = 'group';
  var cfgTitle = document.createElement('div');
  cfgTitle.className = 'group-title';
  cfgTitle.textContent = 'Local LLM Configs（' + parents.length + '）';
  cfgGroup.appendChild(cfgTitle);

  // 新建配置链接
  var newCfgLink = document.createElement('a');
  newCfgLink.href = API + '/workspace/' + encodeURIComponent(ws.id) + '/configs/new/edit';
  newCfgLink.textContent = '+ 新建配置';
  newCfgLink.className = 'cfg-link';
  cfgGroup.appendChild(newCfgLink);

  parents.forEach(function(cfg) {
    cfgGroup.appendChild(buildConfigRow(ws, cfg, activeId, false));
    // 派生配置挂父下（派生配置可展开，下挂其派生终端）
    var deriveds = derivedOf[cfg.id] || [];
    deriveds.forEach(function(dc) {
      cfgGroup.appendChild(buildDerivedConfigRow(ws, dc));
    });
  });
  if (parents.length === 0) {
    var hint = document.createElement('div');
    hint.style.cssText = 'color:#999;font-size:0.82rem;margin-left:8px';
    hint.textContent = '（无配置，点上面「新建配置」创建）';
    cfgGroup.appendChild(hint);
  }
  body.appendChild(cfgGroup);

  // Terminals 分组（只列 normal 终端；派生终端挂在各自派生配置节点下）
  var normalOnly = normalTerms.filter(function(t){ return t.kind !== 'derived'; });
  var termGroup = document.createElement('div');
  termGroup.className = 'group';
  var termTitle = document.createElement('div');
  termTitle.className = 'group-title';
  termTitle.textContent = 'Terminals（' + normalOnly.length + '）';
  termGroup.appendChild(termTitle);

  var newTermBtn = document.createElement('button');
  newTermBtn.className = 'cfg-new-term';
  newTermBtn.textContent = '+ 新建终端';
  newTermBtn.title = '基于当前 active normal 配置启动';
  newTermBtn.onclick = function() { newTerminal(ws.id); };
  termGroup.appendChild(newTermBtn);

  normalOnly.forEach(function(t) {
    termGroup.appendChild(buildTerminalRow(t));
  });
  if (normalOnly.length === 0) {
    var tHint = document.createElement('div');
    tHint.style.cssText = 'color:#999;font-size:0.82rem;margin-left:8px';
    tHint.textContent = '（先激活一个 normal 配置，再点「新建终端」）';
    termGroup.appendChild(tHint);
  }
  body.appendChild(termGroup);
}

// 派生配置行：可展开，下挂该派生配置的终端子节点（异步加载）
function buildDerivedConfigRow(ws, cfg) {
  var wrapper = document.createElement('div');
  // 配置行本身
  var row = buildConfigRow(ws, cfg, null, true);
  wrapper.appendChild(row);
  // 终端子节点容器
  var termBox = document.createElement('div');
  termBox.className = 'derived-terms';
  termBox.style.cssText = 'margin-left:44px';
  termBox.textContent = '终端加载中...';
  wrapper.appendChild(termBox);
  // 异步加载该派生配置的活终端
  fetch(API + '/api/workspaces/' + encodeURIComponent(ws.id) + '/configs/' + encodeURIComponent(cfg.id) + '/terminals')
    .then(function(r){return r.json();})
    .then(function(d) {
      var terms = (d && d.terminals) || [];
      termBox.textContent = '';
      if (terms.length === 0) {
        var hint = document.createElement('div');
        hint.style.cssText = 'color:#999;font-size:0.78rem';
        hint.textContent = '（无终端，点上方「新建终端」开启）';
        termBox.appendChild(hint);
        return;
      }
      terms.forEach(function(t) {
        var r2 = buildTerminalRow(t);
        r2.style.marginLeft = '0';
        termBox.appendChild(r2);
      });
    })
    .catch(function() { termBox.textContent = '终端加载失败'; });
  return wrapper;
}

function buildConfigRow(ws, cfg, activeId, isDerived) {
  var row = document.createElement('div');
  row.className = isDerived ? 'derived-row' : 'config-row';
  var isActive = cfg.id === activeId;
  var editLink = document.createElement('a');
  editLink.href = API + '/workspace/' + encodeURIComponent(ws.id) + '/configs/' + encodeURIComponent(cfg.id) + '/edit';
  editLink.className = 'cfg-link';
  var label = (isDerived ? '  ↳ ' : '· ') + (cfg.name || cfg.id) + ' [mode=' + (cfg.mode || 'direct') + ']';
  if (isDerived && cfg.derivedIndex) label += '  #' + cfg.derivedIndex;
  editLink.textContent = label;
  row.appendChild(editLink);
  if (isDerived) {
    var tag = document.createElement('span');
    tag.className = 'derived-tag';
    tag.textContent = 'derived';
    row.appendChild(tag);
  }
  // 激活态/按钮仅 normal 配置（派生配置不能 active，走 env 不读 settings.json）
  if (!isDerived) {
    if (isActive) {
      var badge = document.createElement('span');
      badge.className = 'active-badge';
      badge.textContent = '✓ 已激活';
      row.appendChild(badge);
    } else {
      var actBtn = document.createElement('button');
      actBtn.className = 'cfg-act';
      actBtn.textContent = '激活';
      actBtn.onclick = function() { activateCfg(ws.id, cfg.id, actBtn); };
      row.appendChild(actBtn);
    }
  }
  // normal 配置：可新建派生配置
  if (!isDerived) {
    var derBtn = document.createElement('button');
    derBtn.className = 'cfg-new-term';
    derBtn.textContent = '+ 派生';
    derBtn.title = '基于此配置创建派生节点（env 注入别名，运行时可改模型）';
    derBtn.onclick = function() { newDerivedConfig(ws.id, cfg.id, cfg.name); };
    row.appendChild(derBtn);
  }
  // 派生配置：自己的「新建终端」入口
  if (isDerived) {
    var dtBtn = document.createElement('button');
    dtBtn.className = 'cfg-new-term';
    dtBtn.textContent = '新建终端';
    dtBtn.onclick = function() { newDerivedTerminal(ws.id, cfg.id); };
    row.appendChild(dtBtn);
  }
  return row;
}

function buildTerminalRow(t) {
  var row = document.createElement('div');
  row.className = 'term-row';
  var link = document.createElement('a');
  link.href = API + '/terminal/' + encodeURIComponent(t.terminalId);
  link.className = 'term-link';
  link.target = '_blank';
  link.textContent = '🖥 terminal ' + t.terminalId + (t.startedConfigName ? ' (' + t.startedConfigName + ')' : '');
  row.appendChild(link);
  var meta = document.createElement('span');
  meta.style.cssText = 'color:#888';
  meta.textContent = 'pid=' + t.pid + '  ' + (t.kind || '');
  row.appendChild(meta);
  var stopBtn = document.createElement('button');
  stopBtn.className = 'danger';
  stopBtn.style.cssText = 'padding:1px 6px;font-size:0.75rem';
  stopBtn.textContent = '停止';
  stopBtn.onclick = function() { stopTerminal(t.terminalId, stopBtn); };
  row.appendChild(stopBtn);
  return row;
}

async function createWs() {
  var name = document.getElementById('name').value.trim();
  var dir = document.getElementById('dir').value.trim();
  if (!name || !dir) { showMsg('name 和 dir 都必填', 'err'); return; }
  try {
    var r = await fetch(API + '/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, dir: dir }),
    });
    var data = await r.json();
    if (r.ok) { showMsg('已创建' + (data.created ? '（新建 .claude_proxy/）' : '（复用已有 .claude_proxy/）')); document.getElementById('name').value=''; document.getElementById('dir').value=''; loadList(); }
    else { showMsg(data.error, 'err'); }
  } catch (e) { showMsg(e.message, 'err'); }
}
loadList();
</script>
</body>
</html>`;
}

/**
 * 生成 CLI 终端页 HTML（xterm.js + WebSocket 双向流）。
 * 终端已由管理页 POST 创建（terminalId 已生成），此页只连 WS 重入/连接。
 *
 * @param {{ terminalId: string, apiBase?: string }} opts
 */
export function buildTerminalHtml({ terminalId, apiBase = '' } = {}) {
    // 防注入：terminalId 走 escapeHtml（HTML 上下文）+ safeJsonForScript（JS 字符串）+ encodeURIComponent（URL）
    const safeId = safeJsonForScript(String(terminalId ?? ''));
    const safeApiBase = safeJsonForScript(String(apiBase));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Claude Code 终端</title>
<link rel="stylesheet" href="${escapeHtml(apiBase)}/vendor/xterm.css">
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: system-ui, sans-serif; padding: 0; background: #1e1e1e; color: #ddd; display: flex; flex-direction: column; overflow: hidden; }
  .bar { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; flex: 0 0 auto; }
  .bar a { color: #6cf; }
  #msg { flex: 0 0 auto; }
  #terminal { padding: 4px 8px; flex: 1 1 auto; overflow: hidden; }
  .msg { padding: 4px 8px; font-size: 13px; }
  .msg.err { color: #f88; }
  .msg.ok { color: #8f8; }
  .msg.info { color: #88c; }
</style>
</head>
<body>
<div class="bar">
  <span>Claude Code 终端</span>
  <span><a href="${escapeHtml(apiBase)}/">← 返回 workspace 列表</a></span>
</div>
<div id="msg" class="msg info">正在连接终端...</div>
<div id="terminal"></div>
<script src="${escapeHtml(apiBase)}/vendor/xterm.min.js"></script>
<script src="${escapeHtml(apiBase)}/vendor/xterm-addon-fit.min.js"></script>
<script>
(function() {
  var apiBase = ${safeApiBase};
  var tid = ${safeId};
  var msgEl = document.getElementById('msg');

  // 检查 xterm 是否加载成功（CDN 失败时 Terminal 未定义）
  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
    msgEl.className = 'msg err';
    msgEl.textContent = 'xterm.js 加载失败（/vendor/xterm.min.js 不可达）。请确认 standalone/web/vendor/ 资源存在。';
    return;
  }

  var term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Consolas, Menlo, "DejaVu Sans Mono", "Courier New", monospace',
    fontSize: 14,
    lineHeight: 1.1,
    letterSpacing: 0,
    scrollback: 1000,
    allowProposedApi: true,
    reflowCursorLine: true,
  });
  var fit = new FitAddon.FitAddon ? new FitAddon.FitAddon() : new FitAddon();
  term.loadAddon(fit);
  var termEl = document.getElementById('terminal');
  term.open(termEl);
  try { fit.fit(); } catch (e) {}
  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(function () {
      try { fit.fit(); } catch (e) {}
    });
    ro.observe(termEl);
  }
  window.addEventListener('resize', function () { try { fit.fit(); } catch (e) {} });

  var wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + apiBase + '/api/terminals/' + encodeURIComponent(tid) + '/ws';

  function connectWs() {
    var ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    function sendResize() {
      try {
        var cols = term.cols, rows = term.rows;
        var rect = term.element ? term.element.getBoundingClientRect() : { width: 0, height: 0 };
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize', cols: cols, rows: rows,
            pixelWidth: Math.round(rect.width), pixelHeight: Math.round(rect.height),
          }));
        }
      } catch (e) {}
    }
    var resizeTimer = null;
    function sendResizeDebounced() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendResize, 100);
    }
    ws.onopen = function () {
      msgEl.className = 'msg ok';
      msgEl.textContent = '';
      term.focus();
      sendResize();
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        try {
          var obj = JSON.parse(ev.data);
          if (obj.type === 'exit') {
            msgEl.className = 'msg info';
            msgEl.textContent = 'Claude 已退出（code=' + obj.exitCode + '）。在管理页可重新新建终端。';
          } else if (obj.type === 'error') {
            msgEl.className = 'msg err';
            msgEl.textContent = obj.error;
          } else {
            term.write(ev.data);
          }
        } catch (e) { term.write(ev.data); }
      } else {
        term.write(new Uint8Array(ev.data));
      }
    };
    ws.onclose = function (ev) {
      if (msgEl.textContent === '') {
        msgEl.className = 'msg info';
        msgEl.textContent = '终端连接已关闭（' + (ev.reason || ev.code) + '）';
      }
    };
    ws.onerror = function () {
      msgEl.className = 'msg err';
      msgEl.textContent = 'WebSocket 连接错误（终端可能已退出）';
    };
    term.onData(function (data) { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    term.onBinary(function (data) { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    term.onResize(function () { sendResizeDebounced(); });
    window.addEventListener('resize', function () { try { fit.fit(); } catch (e) {} });
  }

  connectWs();
})();
</script>
</body>
</html>`;
}

/**
 * 生成 local config 编辑页 HTML（阶段 4：迁移 webviewEditor）。
 * - 普通配置：name + mode(direct/proxy) + content textarea(JSON)
 * - derived：name + modelAliases 四档(即时生效) + sessionContext1m per-tier + content 只读
 * 通信：fetch 调 management API（/api/workspaces/:id/configs/... + alias 转发）
 */
export function buildConfigEditorHtml({ workspaceId, workspaceName, config, catalog = [], apiBase = '' } = {}) {
    // 防注入：所有插值都走转义
    const cfg = config || null;
    const isDerived = cfg && cfg.derivedFrom !== undefined;
    const name = cfg?.name || '';
    const content = cfg?.content || TEMPLATE;
    const mode = cfg?.mode === 'proxy' ? 'proxy' : 'direct';
    const cfgId = cfg?.id || '';

    // 安全插值：JSON.stringify 嵌 JS 字面量（需转义 </script> 防 HTML 解析器提前结束 script 块），
    // escapeHtml 嵌 HTML 上下文。
    const safeWid = safeJsonForScript(String(workspaceId));
    const safeCfgId = safeJsonForScript(String(cfgId));
    const safeApiBase = safeJsonForScript(String(apiBase));
    const safeCatalog = safeJsonForScript(catalog);
    // 把 config 整体传给前端（供 derived 别名/1m 渲染）
    const safeCfg = safeJsonForScript(cfg);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>配置编辑 — ${escapeHtml(name || '新建')}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 16px auto; padding: 0 16px; color: #222; }
  label { display: block; margin: 0 0 6px; font-weight: 600; }
  .row { margin-bottom: 16px; }
  input[type=text], select { width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 380px; resize: vertical; padding: 8px; font-family: monospace; font-size: 13px; white-space: pre; overflow: auto; }
  .hint { color: #666; font-size: 12px; margin-top: 4px; }
  .alias-row { display: grid; grid-template-columns: 70px 160px 16px 1fr auto; align-items: center; gap: 8px; margin: 6px 0; }
  .alias-name { font-family: monospace; font-size: 12px; background: #f0f0f0; padding: 4px 6px; border-radius: 2px; }
  #error { margin: 8px 0; min-height: 18px; color: #c00; font-size: 12px; white-space: pre-wrap; }
  .actions { margin-top: 12px; display: flex; gap: 8px; }
  button { padding: 6px 14px; cursor: pointer; font-size: 13px; }
  button:disabled { opacity: 0.5; }
  button.secondary { background: #eee; }
</style>
</head>
<body>
<h2>配置编辑 — ${escapeHtml(workspaceName || workspaceId)}</h2>
<div class="row">
  <label for="name">名称</label>
  <input type="text" id="name" value="${escapeHtml(name)}" placeholder="如 glm-5.2" />
</div>
<div class="row">
  <label>连接模式</label>
  ${isDerived ? `<div class="hint">派生节点强制代理模式（别名经代理重写为真实模型）</div><input type="hidden" id="mode" value="proxy" />`
    : `<label style="font-weight:normal"><input type="radio" name="mode" value="direct" ${mode === 'direct' ? 'checked' : ''} /> 直连</label>
       <label style="font-weight:normal"><input type="radio" name="mode" value="proxy" ${mode === 'proxy' ? 'checked' : ''} /> 通过代理</label>`}
</div>
<div id="derivedBlock"></div>
<div class="row">
  <label for="content">settings.json content${isDerived ? '（只读·继承父）' : ''}</label>
  <textarea id="content" spellcheck="false" ${isDerived ? 'readonly' : ''}>${escapeHtml(content)}</textarea>
  <div class="hint">${isDerived ? '派生节点继承父配置 content，不可编辑。' : '切换配置时写入 .claude_proxy/settings.json（direct）或作为代理上游（proxy）。'}</div>
</div>
<div id="error" aria-live="polite"></div>
<div class="actions">
  <button id="save">保存</button>
  <button id="cancel" class="secondary">取消</button>
</div>
<script>
(function() {
  var apiBase = ${safeApiBase};
  var wid = ${safeWid};
  var cfgId = ${safeCfgId};
  var cfg = ${safeCfg};
  var catalog = ${safeCatalog};
  var isDerived = cfg && cfg.derivedFrom !== undefined;
  var nameEl = document.getElementById('name');
  var contentEl = document.getElementById('content');
  var errorEl = document.getElementById('error');
  var derivedBlock = document.getElementById('derivedBlock');

  // derived 渲染别名四档 + 1m checkbox
  if (isDerived && cfg.derivedIndex >= 1) {
    var idx = cfg.derivedIndex;
    var aliases = cfg.modelAliases || {};
    var perTier = cfg.sessionContext1m || { main: false, haiku: false, sonnet: false, opus: false };
    var catalogOpts = [''].concat(catalog).map(function(m) {
      return '<option value="' + esc(m) + '">' + (m ? esc(m) : '— 不设置（透传） —') + '</option>';
    }).join('');
    var tiers = [
      { key: 'main', label: 'Main' },
      { key: 'haiku', label: 'Haiku' },
      { key: 'sonnet', label: 'Sonnet' },
      { key: 'opus', label: 'Opus' },
    ];
    var html = '<div class="row"><label>模型别名映射（即时生效）</label>' +
      '<div class="hint">编号 #' + idx + '</div>' +
      '<datalist id="model-catalog">' + catalogOpts + '</datalist>';
    tiers.forEach(function(t) {
      var alias = 'ccp-' + t.key + '-' + idx + (perTier[t.key] ? '[1m]' : '');
      var cur = aliases[t.key] || '';
      html += '<div class="alias-row">' +
        '<span class="alias-label">' + t.label + '</span>' +
        '<code class="alias-name" data-tier="' + t.key + '">' + esc(alias) + '</code>' +
        '<span>→</span>' +
        '<input type="text" list="model-catalog" class="alias-model" data-tier="' + t.key + '" value="' + esc(cur) + '" placeholder="真实模型名" />' +
        '<label class="hint"><input type="checkbox" data-ctx1m="' + t.key + '" ' + (perTier[t.key] ? 'checked' : '') + ' />1M</label>' +
        '</div>';
    });
    html += '<div class="hint">改映射即时生效；改 1m 需重启 CLI（别名后缀变更）。</div></div>';
    derivedBlock.innerHTML = html;

    // 别名 input change → 空值走 delete、非空走 set（即时生效）
    derivedBlock.querySelectorAll('.alias-model').forEach(function(el) {
      el.addEventListener('change', function() {
        var tier = el.getAttribute('data-tier');
        var model = el.value.trim();
        var alias = 'ccp-' + tier + '-' + idx;
        var url, body;
        if (model) {
          url = apiBase + '/api/workspaces/' + encodeURIComponent(wid) + '/configs/' + encodeURIComponent(cfgId) + '/alias';
          body = JSON.stringify({ alias: alias, model: model });
        } else {
          url = apiBase + '/api/workspaces/' + encodeURIComponent(wid) + '/configs/' + encodeURIComponent(cfgId) + '/alias/delete';
          body = JSON.stringify({ alias: alias });
        }
        fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: body,
        }).then(function(r) { return r.json(); }).then(function(d) {
          errorEl.textContent = d.error ? ('别名操作失败: ' + d.error) : (tier + ' 档已同步（下个请求生效）');
        }).catch(function(e) { errorEl.textContent = '别名操作异常: ' + e.message; });
      });
    });
    // 1m checkbox change → PUT 更新 config（sessionContext1m）+ 提示重启
    derivedBlock.querySelectorAll('input[data-ctx1m]').forEach(function(el) {
      el.addEventListener('change', function() {
        var tier = el.getAttribute('data-ctx1m');
        var updated = Object.assign({}, cfg.sessionContext1m || {});
        updated[tier] = el.checked;
        fetch(apiBase + '/api/workspaces/' + encodeURIComponent(wid) + '/configs/' + encodeURIComponent(cfgId), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameEl.value, sessionContext1m: updated }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.error) { errorEl.textContent = '档位更新失败: ' + d.error; return; }
          cfg = d.config;
          // 刷新别名文本后缀
          var code = derivedBlock.querySelector('code.alias-name[data-tier="' + tier + '"]');
          if (code) { code.textContent = 'ccp-' + tier + '-' + idx + (el.checked ? '[1m]' : ''); }
          errorEl.textContent = tier + ' 档改为 ' + (el.checked ? '1M' : '200K') + '，需重启 CLI 生效';
        }).catch(function(e) { errorEl.textContent = '档位更新异常: ' + e.message; });
      });
    });
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function(c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }

  function selectedMode() {
    var checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : (isDerived ? 'proxy' : 'direct');
  }
  function validate() {
    var nameOk = nameEl.value.trim().length > 0;
    if (isDerived) { document.getElementById('save').disabled = !nameOk; return; }
    var text = contentEl.value.trim();
    var ok = nameOk && text.length > 0;
    if (ok) { try { JSON.parse(text); errorEl.textContent = ''; } catch (e) { ok = false; errorEl.textContent = 'Invalid JSON: ' + e.message; } }
    else { errorEl.textContent = ''; }
    document.getElementById('save').disabled = !ok;
  }
  nameEl.addEventListener('input', validate);
  if (!isDerived) { contentEl.addEventListener('input', validate); }

  document.getElementById('save').addEventListener('click', function() {
    var body = { name: nameEl.value, content: contentEl.value, mode: selectedMode() };
    var url, method;
    if (cfgId) {
      // 更新（derived 不传 content/mode，后端 updateLocalConfig 保留）
      if (isDerived) { body = { name: nameEl.value }; }
      url = apiBase + '/api/workspaces/' + encodeURIComponent(wid) + '/configs/' + encodeURIComponent(cfgId);
      method = 'PUT';
    } else {
      url = apiBase + '/api/workspaces/' + encodeURIComponent(wid) + '/configs';
      method = 'POST';
    }
    fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r) { return r.json(); }).then(function(d) {
        if (d.error) { errorEl.textContent = d.error; return; }
        errorEl.textContent = '已保存，返回列表...';
        // 新建后更新 cfgId（后续保存变更新）
        if (d.config && d.config.id && !cfgId) { cfgId = d.config.id; cfg = d.config; isDerived = d.config.derivedFrom !== undefined; }
        // 保存成功后跳回 workspace 列表页（列表页加载时重新拉取，避免不刷新）
        setTimeout(function() { window.location.href = apiBase + '/'; }, 500);
      }).catch(function(e) { errorEl.textContent = '保存异常: ' + e.message; });
  });
  document.getElementById('cancel').addEventListener('click', function() {
    window.location.href = apiBase + '/';
  });
  validate();
})();
</script>
</body>
</html>`;
}

const TEMPLATE = `{
  "env": {
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_MODEL": ""
  }
}`;

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 安全把值 JSON.stringify 后插入 <script> 块。
 * 裸 JSON.stringify 不转义 <，若值含 </script> 会被 HTML 解析器当作 script 结束标签（XSS）。
 * 转义 </> 防破出 script 块；转义 U+2028/U+2029 行分隔符（JS 字符串合法但 JSON 解析器拒收）。
 */
function safeJsonForScript(value) {
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const lt = String.fromCharCode(0x5c) + "u003c";
    const gt = String.fromCharCode(0x5c) + "u003e";
    const lsEsc = String.fromCharCode(0x5c) + "u2028";
    const psEsc = String.fromCharCode(0x5c) + "u2029";
    return JSON.stringify(value)
        .replace(/</g, lt)
        .replace(/>/g, gt)
        .replace(new RegExp(LS, "g"), lsEsc)
        .replace(new RegExp(PS, "g"), psEsc)
}





