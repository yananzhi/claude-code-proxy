// standalone/web/workspaces-html.js — workspace 管理网页 HTML（ESM JS）
//
// 阶段 2 最小管理页：列出/创建/删除 workspace + 显示每个 workspace 的 local 配置（只读）。
// 配置编辑（CRUD/别名）留阶段 4。
//
// 通信：fetch 调同端口 management API（/api/workspaces）。

/** 生成 workspace 管理网页 HTML（树状：workspace → configs → terminals）。
 * proxyPort 用于显示"打开控制台"链接。通信：fetch 调同端口 management API。 */
export function buildWorkspacesHtml({ apiBase = '', proxyPort } = {}) {
    const proxyLink = proxyPort ? `http://127.0.0.1:${proxyPort}/` : '';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
  .group-title { font-size: 0.85rem; color: #555; font-weight: 600; margin: 6px 0 2px 0; cursor: pointer; user-select: none; }
  .config-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; margin-left: 8px; }
  .term-row { display: flex; align-items: center; gap: 8px; padding: 2px 0 2px 44px; font-size: 0.85rem; }
  .cfg-link { color: #06c; text-decoration: none; }
  .cfg-link:hover { text-decoration: underline; }
  .term-link { color: #06c; text-decoration: none; }
  .term-link:hover { text-decoration: underline; }
  .cfg-act { padding: 2px 8px; font-size: 0.8rem; cursor: pointer; }
  .cfg-new-term { padding: 2px 8px; font-size: 0.8rem; cursor: pointer; background: #eef; border: 1px solid #ccd; border-radius: 3px; }
  .active-badge { color: #060; background: #efe; padding: 2px 6px; border-radius: 3px; font-size: 0.78rem; font-weight: 600; }
  .icon-btn { padding: 1px 5px; font-size: 0.85rem; cursor: pointer; background: transparent; border: none; color: #888; opacity: 0; transition: opacity 0.1s; }
  .config-row:hover .icon-btn, .term-row:hover .icon-btn { opacity: 1; }
  .icon-btn:hover { color: #c00; }
  .config-row:hover, .term-row:hover { background: #f5f5f5; border-radius: 3px; }
  .danger { color: #c00; }
  .msg { padding: 8px; margin: 8px 0; border-radius: 4px; }
  .msg.err { background: #fee; color: #c00; }
  .msg.ok { background: #efe; color: #060; }
  .msg.warn { background: #ffd; color: #960; }
  .proxy-link { margin: 8px 0; }
  .dir-picker { position: fixed; top: 60px; left: 50%; transform: translateX(-50%); width: 560px; max-height: 70vh; overflow: auto; background: #fff; border: 1px solid #888; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); z-index: 1000; padding: 12px; }
  .dir-picker .dp-head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .dir-picker .dp-path { flex: 1; font-family: monospace; font-size: 0.82rem; color: #555; word-break: break-all; }
  .dir-picker .dp-list { max-height: 40vh; overflow: auto; border: 1px solid #eee; border-radius: 4px; }
  .dir-picker .dp-item { padding: 4px 8px; cursor: pointer; font-size: 0.85rem; }
  .dir-picker .dp-item:hover { background: #eef; }
  .dir-picker .dp-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  /* 触屏设备（无 hover）让次要操作图标常显，否则手机上 ✎/✕ 永远不可见 */
  @media (hover: none) {
    .icon-btn { opacity: 1; }
  }
  /* 小屏自适应：手机浏览器（宽度 <= 600px） */
  @media (max-width: 600px) {
    body { margin: 12px auto; padding: 0 10px; }
    h1 { font-size: 1.2rem; }
    .row input[type=text] { min-width: 0; flex: 1 1 100%; }
    .ws-head { flex-wrap: wrap; }
    .group { margin-left: 12px; }
    .config-row, .term-row { flex-wrap: wrap; }
    .dir-picker { width: calc(100vw - 20px); max-width: 560px; left: 10px; right: 10px; transform: none; }
  }
</style>
</head>
<body>
<h1>Claude Code Proxy — Workspace 管理</h1>
${proxyLink ? `<div class="proxy-link">代理控制台（trace/统计）：<a href="${escapeHtml(proxyLink)}" target="_blank">${escapeHtml(proxyLink)}</a></div>` : ''}

<h2>新建 Workspace</h2>
<div class="row">
  <input id="name" type="text" placeholder="名字（如 my-project）">
  <input id="dir" type="text" placeholder="磁盘目录绝对路径（如 D:/code/my-project）">
  <button onclick="browseDir()">选择目录</button>
  <button onclick="createWs()">创建</button>
</div>
<div id="dirPicker" class="dir-picker" style="display:none"></div>
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

// 目录选择器：后端 fs 列目录（浏览器沙箱拿不到绝对路径）
var dirPickerCurrent = '';
function browseDir(initial) {
  var picker = document.getElementById('dirPicker');
  picker.style.display = 'block';
  dirPickerCurrent = initial || document.getElementById('dir').value || '';
  renderDirPicker(dirPickerCurrent);
}
function renderDirPicker(parent) {
  var picker = document.getElementById('dirPicker');
  var url = API + '/api/browse-dir?parent=' + encodeURIComponent(parent || '');
  fetch(url).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { showMsg('列目录失败: ' + d.error, 'err'); return; }
    dirPickerCurrent = d.current || parent;
    // DOM 构建（不用 innerHTML 拼变量，防 XSS + 过 T2a 守卫）
    picker.textContent = '';
    var head = document.createElement('div');
    head.className = 'dp-head';
    var pathSpan = document.createElement('span');
    pathSpan.className = 'dp-path';
    pathSpan.textContent = dirPickerCurrent || '(选择盘符/目录)';
    head.appendChild(pathSpan);
    var refreshBtn = document.createElement('button');
    refreshBtn.textContent = '刷新';
    refreshBtn.onclick = function() { renderDirPicker(dirPickerCurrent); };
    head.appendChild(refreshBtn);
    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = closeDirPicker;
    head.appendChild(cancelBtn);
    var okBtn = document.createElement('button');
    okBtn.textContent = '确定';
    okBtn.onclick = confirmDirPicker;
    head.appendChild(okBtn);
    picker.appendChild(head);
    var list = document.createElement('div');
    list.className = 'dp-list';
    (d.entries || []).forEach(function(e) {
      var item = document.createElement('div');
      item.className = 'dp-item';
      item.textContent = (e.up ? '⬆ ..' : '📁 ' + e.name);
      item.onclick = function() { renderDirPicker(e.path); };
      list.appendChild(item);
    });
    picker.appendChild(list);
  }).catch(function(e) { showMsg('列目录异常: ' + e.message, 'err'); });
}
function closeDirPicker() { document.getElementById('dirPicker').style.display = 'none'; }
function confirmDirPicker() {
  document.getElementById('dir').value = dirPickerCurrent;
  closeDirPicker();
}

// 起终端共享逻辑（newTerminal/newConfigTerminal 共用）。
// settings.json 是唯一事实源：起终端调 /activate 写 settings.json（config 级入口内部先激活）。
function doCreateTerminal(url) {
  fetch(API + url, { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) {
        showMsg('新建终端失败: ' + d.error, 'err');
        return;
      }
      window.open(API + '/terminal/' + encodeURIComponent(d.terminalId), '_blank');
      loadList();
    })
    .catch(function(e) { showMsg('新建终端异常: ' + e.message, 'err'); });
}
// 新建 normal 终端（基于 active config）
function newTerminal(wsId) {
  doCreateTerminal('/api/workspaces/' + encodeURIComponent(wsId) + '/terminals');
}
// 新建终端（基于指定 config；走 config 级路由，先激活该 config 再起）
function newConfigTerminal(wsId, cfgId) {
  doCreateTerminal('/api/workspaces/' + encodeURIComponent(wsId) + '/configs/' + encodeURIComponent(cfgId) + '/terminals');
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
// 重命名配置（只改 name）
function renameConfig(wsId, cfg, oldName) {
  var newName = prompt('重命名配置：', oldName || cfg.id);
  if (newName === null) return;
  newName = String(newName).trim();
  if (!newName) { showMsg('名字不能为空', 'err'); return; }
  if (newName === oldName) return;
  fetch(API + '/api/workspaces/' + encodeURIComponent(wsId) + '/configs/' + encodeURIComponent(cfg.id), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) { showMsg('重命名失败: ' + d.error, 'err'); return; }
    showMsg('已重命名', 'ok');
    loadList();
  }).catch(function(e) { showMsg('重命名异常: ' + e.message, 'err'); });
}
// 删除配置
function deleteConfig(wsId, cfg) {
  var label = cfg.name || cfg.id;
  if (!confirm('删除配置 "' + label + '"？')) return;
  fetch(API + '/api/workspaces/' + encodeURIComponent(wsId) + '/configs/' + encodeURIComponent(cfg.id), { method: 'DELETE' })
    .then(function(r) { return r.json(); }).then(function(d) {
      if (d.error) { showMsg('删除失败: ' + d.error, 'err'); return; }
      showMsg('已删除', 'ok');
      loadList();
    }).catch(function(e) { showMsg('删除异常: ' + e.message, 'err'); });
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
  name.textContent = '📁 ' + ws.name;
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

  // 可折叠 group 构造器：标题（▶/▼ + 文字）点击切 body 显示
  function buildGroup(titleText, icon) {
    var group = document.createElement('div');
    group.className = 'group';
    var head = document.createElement('div');
    head.className = 'group-title';
    var tog = document.createElement('span');
    tog.className = 'toggle';
    tog.textContent = '▼';
    head.appendChild(tog);
    head.appendChild(document.createTextNode(' ' + (icon || '') + ' ' + titleText));
    var gb = document.createElement('div');
    gb.className = 'group-body';
    head.onclick = function() {
      var hidden = gb.style.display === 'none';
      gb.style.display = hidden ? '' : 'none';
      tog.textContent = hidden ? '▼' : '▶';
    };
    group.appendChild(head);
    group.appendChild(gb);
    return { group: group, body: gb };
  }

  // 配置 分组
  var cfgG = buildGroup('配置（' + configs.length + '）', '📄');
  var cfgBody = cfgG.body;
  // 新建配置链接
  var newCfgLink = document.createElement('a');
  newCfgLink.href = API + '/workspace/' + encodeURIComponent(ws.id) + '/configs/new/edit';
  newCfgLink.textContent = '+ 新建配置';
  newCfgLink.className = 'cfg-link';
  cfgBody.appendChild(newCfgLink);

  configs.forEach(function(cfg) {
    cfgBody.appendChild(buildConfigRow(ws, cfg, activeId));
  });
  if (configs.length === 0) {
    var hint = document.createElement('div');
    hint.style.cssText = 'color:#999;font-size:0.82rem;margin-left:8px';
    hint.textContent = '（无配置，点上面「新建配置」创建）';
    cfgBody.appendChild(hint);
  }
  body.appendChild(cfgG.group);

  // 终端 分组（列全部终端）
  var termG = buildGroup('终端（' + normalTerms.length + '）', '🖥');
  normalTerms.forEach(function(t) {
    termG.body.appendChild(buildTerminalRow(t));
  });
  if (normalTerms.length === 0) {
    var tHint = document.createElement('div');
    tHint.style.cssText = 'color:#999;font-size:0.82rem;margin-left:8px';
    tHint.textContent = '（无终端，点上方配置行的「新建终端」开启）';
    termG.body.appendChild(tHint);
  }
  body.appendChild(termG.group);
}

function buildConfigRow(ws, cfg, activeId) {
  var row = document.createElement('div');
  row.className = 'config-row';
  var isActive = cfg.id === activeId;
  var editLink = document.createElement('a');
  editLink.href = API + '/workspace/' + encodeURIComponent(ws.id) + '/configs/' + encodeURIComponent(cfg.id) + '/edit';
  editLink.className = 'cfg-link';
  var modeLabel = (cfg.mode === 'proxy') ? '[代理]' : '[直连]';
  editLink.textContent = '📄 ' + (cfg.name || cfg.id) + ' ' + modeLabel;
  row.appendChild(editLink);
  // 激活标记（settings.json 为唯一事实源：激活 = 写 settings.json）
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
  // 新建终端（主操作显文字）
  var stBtn = document.createElement('button');
  stBtn.className = 'cfg-new-term';
  stBtn.textContent = '新建终端';
  stBtn.title = '基于此配置启动终端（先激活该配置写 settings.json）';
  stBtn.onclick = function() { newConfigTerminal(ws.id, cfg.id); };
  row.appendChild(stBtn);
  // 重命名 + 删除（次要操作，hover 图标按钮）
  var rnBtn = document.createElement('button');
  rnBtn.className = 'icon-btn';
  rnBtn.textContent = '✎';
  rnBtn.title = '重命名';
  rnBtn.onclick = function() { renameConfig(ws.id, cfg, cfg.name); };
  row.appendChild(rnBtn);
  var delCfgBtn = document.createElement('button');
  delCfgBtn.className = 'icon-btn';
  delCfgBtn.textContent = '✕';
  delCfgBtn.title = '删除';
  delCfgBtn.onclick = function() { deleteConfig(ws.id, cfg); };
  row.appendChild(delCfgBtn);
  return row;
}

function buildTerminalRow(t) {
  var row = document.createElement('div');
  row.className = 'term-row';
  var link = document.createElement('a');
  link.href = API + '/terminal/' + encodeURIComponent(t.terminalId);
  link.className = 'term-link';
  link.target = '_blank';
  link.textContent = '🖥 [静态] ' + t.terminalId + (t.startedConfigName ? ' (' + t.startedConfigName + ')' : '');
  row.appendChild(link);
  var meta = document.createElement('span');
  meta.style.cssText = 'color:#888';
  meta.textContent = 'pid=' + t.pid;
  row.appendChild(meta);
  var stopBtn = document.createElement('button');
  stopBtn.className = 'icon-btn';
  stopBtn.textContent = '✕';
  stopBtn.title = '停止';
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
  .bar { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; flex: 0 0 auto; gap: 8px; }
  .bar a { color: #6cf; }
  .bar-info { color: #9cf; font-size: 12px; }
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
  <span id="barInfo" class="bar-info">Claude Code 终端</span>
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
  var barInfo = document.getElementById('barInfo');

  // 顶栏：查终端详情（显示所起配置名）
  // polling：配置名固定，但保留轮询结构以防后续改动；页面隐藏时暂停省资源。
  // 变化检测：只在新旧文本不同时更新 DOM，避免无谓重绘。
  var lastBarText = '';
  function renderBarInfo(d) {
    var text = '[静态] ' + (d.startedConfigName || '');
    if (text !== lastBarText) {
      barInfo.textContent = text;
      lastBarText = text;
    }
  }
  function refreshBarInfo() {
    fetch(apiBase + '/api/terminals/' + encodeURIComponent(tid) + '/alias-resolve')
      .then(function(r) { return r.json(); })
      .then(renderBarInfo)
      .catch(function() { /* 查询失败不影响终端使用，保留默认文案 */ });
  }
  refreshBarInfo();
  // polling：页面可见时每 4s 轮询顶栏信息
  var pollTimer = setInterval(function() {
    if (!document.hidden) refreshBarInfo();
  }, 4000);
  // 页面卸载时清理
  window.addEventListener('beforeunload', function() { clearInterval(pollTimer); });

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

  // 自定义按键：修复 xterm 5.3.0 默认映射对 Shift+Enter / Ctrl+V 不友好的问题。
  // 详见 docs/standalone-web-terminal-keybinding-fix.md
  //
  // ⚠ 真正的根因（2026-08-09 经 Playwright + 真实 xterm 5.3.0 vendor 实测确认，
  //   见 test/e2e/xterm-shift-enter.spec.ts）：xterm 的 attachCustomKeyEventHandler 在
  //   handler 返回 false 时，_keyDown 直接 return false —— 但【不调 preventDefault】。
  //   于是浏览器仍为 Enter 触发后续 keypress/input 事件，xterm 的 _keyPress/_inputEvent
  //   会把它变成 '\\r' 经 onData 泄漏出去（ws.send('\\r') → PTY 收到 → CLI 当提交）。
  //   结果：handler 发了 '\\n'（换行），紧接着 onData 又泄漏 '\\r'（提交），净效果=提交。
  //   这正是用户"Shift+Enter 跟 Enter 一样直接发消息"的现象。
  //   修复：在 keydown handler 里显式 e.preventDefault()+e.stopPropagation()，阻止
  //   浏览器后续 keypress/input，使 '\\n' 成为唯一发到 PTY 的字节。
  //
  // 为什么用 ws.send 而非 term.paste：xterm 的 prepareTextForTerminal 会把 LF 统一替换
  // 成 CR（结果跟 Enter 一样被 CLI 当提交），故直接 ws.send 原始字节给 PTY 绕过转换。
  // ws 由 connectWs 赋值；未连上时 readyState 检查自然丢弃，不报错。
  // Ctrl+V 仍用 term.paste(text)：粘贴多行文本时 LF→CR 是期望行为（整段输入），不受影响。
  //
  // Shift+Enter 发什么字节？后端已注入 TERM=xterm-256color 让 Claude CLI 进 raw mode（前提）。
  // raw mode 下换行序列候选（Gemini 分析 + 实测）：
  //   C(默认) LF            = Ctrl+J，raw mode 下 CLI 应区别于 CR(Enter=提交)
  //   A        ESC[13;2u    = CSI u 协议的 Shift+Enter（现代 TUI 标准）
  //   B        ESC+CR       = Alt+Enter（Ink TextInput 常绑定为换行）
  // 调试时可在 DevTools 控制台直接改 window.__CCP_NEWLINE_SEQ 切候选，无需改代码重启服务。
  var ws = null;
  window.__CCP_NEWLINE_SEQ = window.__CCP_NEWLINE_SEQ || '\\n';
  term.attachCustomKeyEventHandler(function (e) {
    if (e.type !== 'keydown') return true;
    // Shift+Enter → 换行（发可切换的候选字节序列给 PTY，不经 xterm paste 的 LF→CR 转换）
    if (e.keyCode === 13 && e.shiftKey) {
      // 必须显式 preventDefault+stopPropagation：仅 return false 不阻止浏览器后续
      // keypress/input，xterm 会把 Enter 的 keypress 转成 '\\r' 经 onData 泄漏（=提交）。
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(window.__CCP_NEWLINE_SEQ);
      return false;
    }
    // Ctrl+V / Cmd+V → 粘贴剪贴板（xterm 默认发 0x16 且 preventDefault，paste 事件不触发）
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
    var ro = new ResizeObserver(function () {
      try { fit.fit(); } catch (e) {}
    });
    ro.observe(termEl);
  }
  window.addEventListener('resize', function () { try { fit.fit(); } catch (e) {} });

  var wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + apiBase + '/api/terminals/' + encodeURIComponent(tid) + '/ws';

  function connectWs() {
    ws = new WebSocket(wsUrl);
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
 * 通信：fetch 调 management API（/api/workspaces/:id/configs/...）
 */
export function buildConfigEditorHtml({ workspaceId, workspaceName, config, apiBase = '' } = {}) {
    // 防注入：所有插值都走转义
    const cfg = config || null;
    const name = cfg?.name || '';
    const content = cfg?.content || TEMPLATE;
    // 新建配置默认 proxy（cfg 无 mode 时）；已有配置按自身 mode
    const mode = cfg?.mode ? (cfg.mode === 'proxy' ? 'proxy' : 'direct') : 'proxy';
    const cfgId = cfg?.id || '';

    // 安全插值：JSON.stringify 嵌 JS 字面量（需转义 </script> 防 HTML 解析器提前结束 script 块），
    // escapeHtml 嵌 HTML 上下文。
    const safeWid = safeJsonForScript(String(workspaceId));
    const safeCfgId = safeJsonForScript(String(cfgId));
    const safeApiBase = safeJsonForScript(String(apiBase));

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
  <label style="font-weight:normal"><input type="radio" name="mode" value="direct" ${mode === 'direct' ? 'checked' : ''} /> 直连</label>
  <label style="font-weight:normal"><input type="radio" name="mode" value="proxy" ${mode === 'proxy' ? 'checked' : ''} /> 通过代理</label>
</div>
<div class="row">
  <label for="content">settings.json content</label>
  <textarea id="content" spellcheck="false">${escapeHtml(content)}</textarea>
  <div class="hint">保存后激活该配置会写进 workspace 的 .claude_proxy/settings.json（settings.json 是 CLI 路由唯一事实源：直连=上游真实地址，代理=经代理转发）。</div>
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
  var nameEl = document.getElementById('name');
  var contentEl = document.getElementById('content');
  var errorEl = document.getElementById('error');

  function selectedMode() {
    var checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : 'direct';
  }
  function validate() {
    var nameOk = nameEl.value.trim().length > 0;
    var text = contentEl.value.trim();
    var ok = nameOk && text.length > 0;
    if (ok) { try { JSON.parse(text); errorEl.textContent = ''; } catch (e) { ok = false; errorEl.textContent = 'Invalid JSON: ' + e.message; } }
    else { errorEl.textContent = ''; }
    document.getElementById('save').disabled = !ok;
  }
  nameEl.addEventListener('input', validate);
  contentEl.addEventListener('input', validate);

  document.getElementById('save').addEventListener('click', function() {
    var body = { name: nameEl.value, content: contentEl.value, mode: selectedMode() };
    var url, method;
    if (cfgId) {
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





