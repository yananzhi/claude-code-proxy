// standalone/web/workspaces-html.js — workspace 管理网页 HTML（ESM JS）
//
// 阶段 2 最小管理页：列出/创建/删除 workspace + 显示每个 workspace 的 local 配置（只读）。
// 配置编辑（CRUD/别名）留阶段 4。
//
// 通信：fetch 调同端口 management API（/api/workspaces）。

/** 生成 workspace 管理网页 HTML。proxyPort 用于显示"打开控制台"链接。 */
export function buildWorkspacesHtml({ apiBase = '', proxyPort } = {}) {
    const proxyLink = proxyPort ? `http://127.0.0.1:${proxyPort}/` : '';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Claude Code Proxy — Workspace 管理</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; color: #222; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 24px; }
  .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; flex-wrap: wrap; }
  input[type=text] { padding: 4px 8px; min-width: 200px; }
  button { padding: 4px 12px; cursor: pointer; }
  .ws-card { border: 1px solid #ccc; border-radius: 6px; padding: 12px; margin: 8px 0; }
  .ws-card .name { font-weight: 600; }
  .ws-card .meta { color: #666; font-size: 0.85rem; margin: 4px 0; }
  .ws-card .configs { font-size: 0.85rem; color: #444; margin-top: 8px; }
  .ws-card .config-item { padding: 2px 0; }
  .danger { color: #c00; }
  .msg { padding: 8px; margin: 8px 0; border-radius: 4px; }
  .msg.err { background: #fee; color: #c00; }
  .msg.ok { background: #efe; color: #060; }
  .proxy-link { margin: 8px 0; }
</style>
</head>
<body>
<h1>Claude Code Proxy — Workspace 管理</h1>
${proxyLink ? `<div class="proxy-link">代理控制台（trace/统计）：<a href="${proxyLink}" target="_blank">${proxyLink}</a></div>` : ''}

<h2>新建 Workspace</h2>
<div class="row">
  <input id="name" type="text" placeholder="名字（如 my-project）">
  <input id="dir" type="text" placeholder="磁盘目录绝对路径（如 D:/code/my-project）" style="min-width:400px">
  <button onclick="createWs()">创建</button>
</div>
<div id="msg"></div>

<h2>已注册 Workspaces</h2>
<div id="list">加载中...</div>

<script>
const API = '${apiBase}';
function showMsg(text, isErr) {
  const el = document.getElementById('msg');
  el.className = 'msg ' + (isErr ? 'err' : 'ok');
  el.textContent = text;
  setTimeout(() => { el.textContent = ''; el.className = ''; }, 4000);
}
async function loadList() {
  try {
    const r = await fetch(API + '/api/workspaces');
    const data = await r.json();
    const list = document.getElementById('list');
    if (!data.workspaces || data.workspaces.length === 0) {
      list.textContent = '（无 workspace）';
      return;
    }
    list.innerHTML = '';
    for (const ws of data.workspaces) {
      const card = document.createElement('div');
      card.className = 'ws-card';
      card.innerHTML = '<div class="name"></div><div class="meta"></div><div class="configs">配置加载中...</div>';
      card.querySelector('.name').textContent = ws.name + '  [' + ws.id + ']';
      card.querySelector('.meta').textContent = ws.dir + '  ·  创建于 ' + (ws.createdAt || '?');
      const delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.textContent = '删除（仅移除索引）';
      delBtn.onclick = async () => {
        if (!confirm('删除 workspace "' + ws.name + '"？\\n（只移除索引，不删磁盘文件）')) return;
        const rr = await fetch(API + '/api/workspaces/' + ws.id, { method: 'DELETE' });
        if (rr.ok) { showMsg('已删除'); loadList(); } else { const e = await rr.json(); showMsg(e.error, true); }
      };
      card.querySelector('.meta').appendChild(document.createElement('br'));
      card.querySelector('.meta').appendChild(delBtn);
      // 加载该 workspace 的 local 配置
      fetch(API + '/api/workspaces/' + ws.id).then(r => r.json()).then(d => {
        const cfgs = d.configs || [];
        const c = card.querySelector('.configs');
        if (cfgs.length === 0) { c.textContent = '（无 local 配置）'; return; }
        // 用 textContent 而非 innerHTML 拼接，防配置名 XSS
        c.textContent = '';
        c.appendChild(document.createTextNode('Local 配置（' + cfgs.length + '）：'));
        c.appendChild(document.createElement('br'));
        for (const cfg of cfgs) {
          const item = document.createElement('div');
          item.className = 'config-item';
          item.textContent = '· ' + (cfg.name || cfg.id) + ' [mode=' + (cfg.mode || 'direct') + ']';
          c.appendChild(item);
        }
      }).catch(() => { card.querySelector('.configs').textContent = '配置加载失败'; });
      list.appendChild(card);
    }
  } catch (e) {
    document.getElementById('list').textContent = '加载失败: ' + e.message;
  }
}
async function createWs() {
  const name = document.getElementById('name').value.trim();
  const dir = document.getElementById('dir').value.trim();
  if (!name || !dir) { showMsg('name 和 dir 都必填', true); return; }
  try {
    const r = await fetch(API + '/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, dir }),
    });
    const data = await r.json();
    if (r.ok) { showMsg('已创建' + (data.created ? '（新建 .claude_proxy/）' : '（复用已有 .claude_proxy/）')); document.getElementById('name').value=''; document.getElementById('dir').value=''; loadList(); }
    else { showMsg(data.error, true); }
  } catch (e) { showMsg(e.message, true); }
}
loadList();
</script>
</body>
</html>`;
}

/**
 * 生成 CLI 终端页 HTML（xterm.js + WebSocket 双向流）。
 * 阶段 3：每 workspace 一个 xterm 终端，连 /api/workspaces/:id/claude-session/ws。
 */
export function buildTerminalHtml({ workspaceId, workspaceName, apiBase = '' } = {}) {
    // 防注入：workspaceId 可能来自 URL（decodeURIComponent），含任意字符。
    // - 插入 HTML 上下文（title/bar）→ escapeHtml
    // - 插入 JS 字符串字面量 → JSON.stringify（转义引号/反斜杠/换行）
    // - 插入 URL 路径 → encodeURIComponent
    const safeId = safeJsonForScript(String(workspaceId ?? ''));
    const safeApiBase = safeJsonForScript(String(apiBase));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Claude Code — ${escapeHtml(workspaceName || workspaceId)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 8px; background: #1e1e1e; color: #ddd; }
  .bar { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; }
  .bar a { color: #6cf; }
  #terminal { padding: 8px; }
  .msg { color: #f88; padding: 4px 8px; }
</style>
</head>
<body>
<div class="bar">
  <span>Claude Code — ${escapeHtml(workspaceName || workspaceId)}</span>
  <span><a href="${escapeHtml(apiBase)}/">← 返回 workspace 列表</a></span>
</div>
<div id="msg"></div>
<div id="terminal"></div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
<script>
(function() {
  var apiBase = ${safeApiBase};
  var wsId = ${safeId};
  var wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + apiBase + '/api/workspaces/' + encodeURIComponent(wsId) + '/claude-session/ws';
  var term = new Terminal({ cursorBlink: true });
  var fit = new FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('terminal'));
  fit.fit();
  var msgEl = document.getElementById('msg');

  // 会话可能未启动 → 先 POST 启动，再连 WS
  fetch(apiBase + '/api/workspaces/' + encodeURIComponent(wsId) + '/claude-session', { method: 'POST' })
    .then(r => r.json())
    .then(d => {
      if (d.error) { msgEl.textContent = '启动会话失败: ' + d.error; return; }
      connectWs();
    })
    .catch(e => { msgEl.textContent = '启动会话异常: ' + e.message; });

  function connectWs() {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => { msgEl.textContent = ''; term.focus(); };
    ws.onmessage = (ev) => {
      // 消息可能是 binary（PTY 输出）或 text（控制事件如 exit）
      if (typeof ev.data === 'string') {
        try {
          const obj = JSON.parse(ev.data);
          if (obj.type === 'exit') { msgEl.textContent = 'Claude 已退出（code=' + obj.exitCode + '）'; }
          else if (obj.type === 'error') { msgEl.textContent = obj.error; }
        } catch { term.write(ev.data); }
      } else {
        ev.data.text().then(t => term.write(t));
      }
    };
    ws.onclose = (ev) => {
      if (!msgEl.textContent) msgEl.textContent = '连接已关闭（' + (ev.reason || ev.code) + '）';
    };
    ws.onerror = () => { msgEl.textContent = 'WebSocket 错误'; };
    // 用户输入 → PTY
    term.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
    window.addEventListener('resize', () => fit.fit());
  }
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
        errorEl.textContent = '已保存';
        // 新建后更新 cfgId，后续保存变更新
        if (d.config && d.config.id && !cfgId) { cfgId = d.config.id; cfg = d.config; isDerived = d.config.derivedFrom !== undefined; }
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





