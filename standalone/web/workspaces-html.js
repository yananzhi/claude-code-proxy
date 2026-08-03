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
