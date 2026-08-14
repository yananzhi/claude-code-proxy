// test/standalone/tree-html.test.mjs — 树状管理页 HTML 结构测试
//
// 运行：node --test test/standalone/tree-html.test.mjs
//
// 覆盖：
//   T1 buildWorkspacesHtml 含树结构 + 终端 fetch 序列 + 新建终端入口
//   T2 XSS：用户数据不进 innerHTML
//   T3 buildTerminalHtml 用 terminalId + 无 POST-start
//
// 派生配置（derived/别名）功能已移除（2026-08）：树只有「配置/终端」两组、
// 配置行统一「新建终端」，终端一律标 [静态]。对应测试已随之改写。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_JS = resolve(__dirname, '..', '..', 'standalone', 'web', 'workspaces-html.js');
const { buildWorkspacesHtml, buildTerminalHtml, buildConfigEditorHtml } = await import(pathToFileURL(HTML_JS).href);

// ════════════════════════════════════════════════════════════
// T1 树状结构 + 终端路由
// ════════════════════════════════════════════════════════════
test('T1a: HTML 含树容器结构', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('class="tree"') || html.includes('id="list"'), '应有树/list 容器');
});

test('T1b: fetch normal 终端列表（/api/workspaces/:id/terminals）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('/terminals'), '应 fetch 终端列表');
    assert.ok(html.match(/\/api\/workspaces\/.*\/terminals/), '应有 /api/workspaces/:id/terminals fetch');
});

test('T1c: 新建终端 POST /api/workspaces/:id/terminals', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.match(/\/api\/workspaces\/.*\/terminals.*method.*POST/s) || html.includes("method: 'POST'"),
        '应有 POST 新建终端');
});

test('T1d: 配置级终端入口（POST /api/workspaces/:id/configs/:cfgId/terminals）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.match(/\/configs\/.*\/terminals/), '应有 /configs/:cfgId/terminals 入口');
});

test('T1g: 无派生/别名配置入口（newDerivedConfig / + 别名配置 / next-alias-id 已移除）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(!html.includes('newDerivedConfig'), '不应有 newDerivedConfig 函数');
    assert.ok(!html.includes('+ 别名配置'), '不应有「+ 别名配置」按钮');
    assert.ok(!html.includes('/next-alias-id'), '不应有 next-alias-id 请求');
});

// 怀疑点2（异常：终端 API 返回 {terminals: undefined} 时 renderWsBody 是否崩溃）
test('T1h4: normalTerms 有空兜底（t.terminals || []）防异常结构', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('t.terminals || []'), '应有 t.terminals || [] 兜底，防 terminals 字段缺失');
});

// 怀疑点6（一致性：终端组标题计数含全部终端）
test('T1h6: 终端组标题计数用 normalTerms.length', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(/终端（'\s*\+\s*normalTerms\.length/.test(html),
        '终端组标题计数应用 normalTerms.length');
    assert.ok(!/normalOnly\.length/.test(html), '不应残留 normalOnly.length 计数');
    assert.ok(!/normalOnly/.test(html), '不应残留 normalOnly 过滤变量');
    assert.ok(!html.includes("t.kind !== 'derived'"), '不应按 kind 过滤终端');
});

test('T1h7: 终端组 forEach 遍历 normalTerms 全量', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(/normalTerms\.forEach/.test(html), '终端组应直接遍历 normalTerms');
});

test('T1i: 配置行显示「设为默认」按钮（所有配置统一，无 isDerived 分支）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('设为默认'), '应有「设为默认」按钮文案');
    assert.ok(!/isDerived/.test(html), '不应残留 isDerived 逻辑（已移除派生）');
    assert.ok(!html.includes("'激活'") && !html.includes('"激活"'), '不应残留旧「激活」文案');
});

test('T1j: 配置行有「重命名」+「删除」按钮 + renameConfig/deleteConfig 函数', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('renameConfig'), '应有 renameConfig 函数');
    assert.ok(html.includes('deleteConfig'), '应有 deleteConfig 函数');
    assert.ok(html.includes('重命名'), '应有「重命名」按钮文案');
    assert.ok(/delCfgBtn/.test(html), '应有配置删除按钮变量');
});

// 看护：生成的内联 JS 必须语法合法（防模板字符串里 \n 误用导致整 script 解析失败）
test('T1k: buildWorkspacesHtml 内联 <script> JS 语法合法', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(m, '应有内联 <script>');
    assert.doesNotThrow(() => new Function(m[1]), '内联 JS 应语法合法（无跨行字符串/未转义字符）');
});

// ════════════════════════════════════════════════════════════
// T8 目录选择器 + 树状美化（图标/折叠/hover图标）
// ════════════════════════════════════════════════════════════
test('T8a: 目录选择器入口（browseDir 函数 + 选择目录按钮 + /api/browse-dir fetch）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('browseDir'), '应有 browseDir 函数');
    assert.ok(html.includes('选择目录'), '应有「选择目录」按钮');
    assert.ok(html.includes('/api/browse-dir'), '应 fetch /api/browse-dir');
    assert.ok(html.includes('id="dirPicker"'), '应有目录选择器弹出层容器');
});

test('T8b: 树含类型图标（📁 workspace / 📄 配置 / 🖥 终端；无派生 🔀）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('📁'), 'workspace 应有 📁 图标');
    assert.ok(html.includes('📄'), '配置组标题或配置行应有 📄 图标');
    assert.ok(html.includes('🖥'), '终端应有 🖥 图标');
    assert.ok(!html.includes('🔀'), '派生/别名配置已移除，不应有 🔀 图标');
});

test('T8c: 配置组/终端组可折叠（buildGroup toggle + group-body）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    const rMatch = html.match(/function renderWsBody[\s\S]*?^}/m);
    assert.ok(rMatch, '应找到 renderWsBody');
    assert.ok(/buildGroup/.test(rMatch[0]), '应有 buildGroup 构造器');
    assert.ok(/group-body/.test(rMatch[0]), '应有 group-body 折叠容器');
    assert.ok(/tog\.textContent\s*=\s*['"]▼['"]/.test(rMatch[0]), '应有 toggle 折叠逻辑');
});

test('T8d: 次要操作 hover 图标按钮（.icon-btn + ✎/✕ + title）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('.icon-btn'), '应有 .icon-btn CSS class');
    assert.ok(/opacity:\s*0/.test(html) && /hover.*icon-btn.*opacity:\s*1/.test(html.replace(/\n/g,'')), '应有 hover 显示规则');
    assert.ok(html.includes('✎') && html.includes('✕'), '应有 ✎ 重命名 / ✕ 删除 图标');
    assert.ok(/\.title\s*=\s*['"]重命名['"]/.test(html) && /\.title\s*=\s*['"]删除['"]/.test(html), '图标应有 title tooltip');
});

test('T8m: 移动端响应式（viewport meta + 触屏 icon-btn 常显 + 小屏断点）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(/name=["']viewport["']\s+content=["']width=device-width,\s*initial-scale=1\.0["']/.test(html), '应有 viewport meta');
    assert.ok(/@media\s*\(\s*hover:\s*none\s*\)/.test(html), '应有 @media (hover: none) 触屏规则');
    const touchBlock = html.match(/@media\s*\(\s*hover:\s*none\s*\)\s*\{([^}]*)\}/);
    assert.ok(touchBlock && /\.icon-btn\s*\{[^}]*opacity:\s*1/.test(touchBlock[1]), '触屏规则应让 .icon-btn opacity:1 常显');
    assert.ok(/@media\s*\(\s*max-width:\s*600px\s*\)/.test(html), '应有 @media (max-width: 600px) 小屏断点');
    const smallBlock = html.match(/@media\s*\(\s*max-width:\s*600px\s*\)\s*\{([\s\S]*?)^\s*\}/m);
    assert.ok(smallBlock, '应能匹配小屏断点块');
    assert.ok(/dir-picker/.test(smallBlock[1]) && /calc\(100vw/.test(smallBlock[1]), '小屏应让 dir-picker 全宽');
    assert.ok(/flex-wrap:\s*wrap/.test(smallBlock[1]), '小屏应让配置行换行避免横向溢出');
});

test('T8e: 目录选择器渲染不用 innerHTML 拼变量（DOM 构建，过 T2a 守卫）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    const rMatch = html.match(/function renderDirPicker[\s\S]*?^}/m);
    assert.ok(rMatch, '应找到 renderDirPicker');
    assert.ok(!/innerHTML\s*=\s*[a-zA-Z_]/.test(rMatch[0]), 'renderDirPicker 不应 innerHTML = 变量');
    assert.ok(/textContent/.test(rMatch[0]), '应用 textContent 渲染目录名');
});

test('T1e: 不含旧 /workspace/:id/terminal 链接', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(!html.match(/\/workspace\/.*\/terminal/), '不应残留旧 /workspace/:id/terminal 链接');
});

test('T1f: 终端节点打开走 /terminal/:tid', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('/terminal/'), '终端节点应链接到 /terminal/:tid');
});

// ════════════════════════════════════════════════════════════
// T1w 文案统一：无"派生/derived/Local LLM Configs"残留（用户可见处）
// ════════════════════════════════════════════════════════════
test('T1w1: 主列表页无"Local LLM Configs"/"Terminals（"英文残留', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(!html.includes('Local LLM Configs'), '不应残留 Local LLM Configs');
    assert.ok(!/Terminals（/.test(html), '不应残留 Terminals（ 英文分组标题');
});
test('T1w2: 主列表页无"派生配置/派生节点/derived 标签"残留（用户可见文案）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(!html.includes("'派生") && !html.includes('"派生'), '不应有派生字样的用户可见文案');
    assert.ok(!html.includes("tag.textContent = 'derived'"), '不应有 derived 文字标签');
    assert.ok(!html.includes('[mode='), '配置行不应残留 [mode=...] 显示');
});
test('T1w3: 终端行标 [静态]（派生/别名已移除，无 [别名]）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('[静态]'), '终端应标 [静态]');
    assert.ok(!html.includes('[别名]'), '派生/别名终端已移除，不应有 [别名] 标签');
});
test('T1w4: 配置行显示 [直连]/[代理] 徽标', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('[直连]'), '直连配置应标 [直连]');
    assert.ok(html.includes('[代理]'), '代理配置应标 [代理]');
});
test('T1w5: 配置编辑页无"派生/别名配置"残留（编辑页已无派生 UI）', () => {
    const html = buildConfigEditorHtml({
        workspaceId: 'w', workspaceName: 'ws', apiBase: '',
        config: { id: 'c', name: 'n', content: '{}', mode: 'proxy' },
    });
    assert.ok(!html.includes('派生节点'), '配置编辑页不应残留"派生节点"');
    assert.ok(!html.includes('别名配置'), '配置编辑页不应残留"别名配置"文案（派生 UI 已移除）');
    assert.ok(!html.includes('derivedBlock'), '不应有 derivedBlock 渲染块');
});

// ════════════════════════════════════════════════════════════
// T2 XSS：用户数据不进 innerHTML
// ════════════════════════════════════════════════════════════
test('T2a: buildWorkspacesHtml 用户数据不直接进 innerHTML（用 textContent）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    const lines = html.split('\n');
    const bad = lines.find(l => /innerHTML\s*=\s*[^'"`]/.test(l) && /innerHTML\s*=\s*[a-zA-Z_]/.test(l)
        && !/innerHTML\s*=\s*['"`]/.test(l));
    assert.ok(!bad, `不应有 innerHTML = 变量（应 textContent）: ${bad}`);
});

// ════════════════════════════════════════════════════════════
// T3 buildTerminalHtml 用 terminalId + 无 POST-start
// ════════════════════════════════════════════════════════════
test('T3a: buildTerminalHtml WS URL 指向 /api/terminals/:tid/ws', () => {
    const html = buildTerminalHtml({ terminalId: 't_abc', apiBase: '' });
    assert.ok(html.includes('/api/terminals/'), 'WS URL 应含 /api/terminals/');
    assert.ok(html.includes('/ws'), 'WS URL 应含 /ws');
});

test('T3b: buildTerminalHtml 无 POST-start（终端已存在，直接连 WS）', () => {
    const html = buildTerminalHtml({ terminalId: 't_abc', apiBase: '' });
    assert.ok(!html.includes("method: 'POST'") && !html.includes('method: "POST"'),
        '不应有 POST-start（终端已存在）');
    assert.ok(html.includes('WebSocket'), '应直接 new WebSocket 连接');
});

test('T3c: buildTerminalHtml terminalId 通过 encodeURIComponent 入 URL', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    const wsUrlLine = html.split('\n').find(l => l.includes('wsUrl') || (l.includes('/api/terminals/') && l.includes('ws')));
    assert.ok(wsUrlLine, '应有 wsUrl 构造');
    assert.ok(wsUrlLine.includes('encodeURIComponent'), 'wsUrl 应通过 encodeURIComponent(tid) 构造');
});

// ════════════════════════════════════════════════════════════
// T3d/T3g 终端顶栏（保留 alias-resolve 端点返回基础信息）
// ════════════════════════════════════════════════════════════
test('T3d: buildTerminalHtml 顶栏 fetch alias-resolve（含顶栏容器）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    assert.ok(html.includes('alias-resolve'), '顶栏应 fetch /api/terminals/:tid/alias-resolve');
    assert.ok(html.includes('id="barInfo"') || html.includes('bar-info'), '应有顶栏信息容器');
});

test('T3e: buildTerminalHtml 顶栏渲染 [静态] 配置名（无别名映射）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    assert.ok(html.includes('[静态]'), '顶栏应渲染 [静态] 标记');
    assert.ok(/startedConfigName/.test(html), '顶栏应渲染 startedConfigName');
    assert.ok(!html.includes('ccp-'), '不应有 ccp- 别名渲染逻辑');
});

test('T3g: 顶栏 polling 实时刷新（setInterval + 可见性暂停 + 清理）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    assert.ok(/setInterval/.test(html), '应有 setInterval 轮询');
    assert.ok(/document\.hidden/.test(html), '页面隐藏时应暂停轮询省资源');
    assert.ok(/beforeunload|clearInterval/.test(html), '页面卸载应清理轮询定时器');
    assert.ok(/lastBarText|text !== lastBarText/.test(html), '应有变化检测避免无谓重绘');
});

// ════════════════════════════════════════════════════════════
// 目标6 代码审查 TDD：前端怀疑点逐条确认（派生相关已随功能移除）
// ════════════════════════════════════════════════════════════

// 怀疑点 G1-fe（时序：refreshBarInfo 在 xterm 加载前调用）
test('G1-fe: refreshBarInfo 不依赖 xterm（在 xterm 检查前调用，非 bug）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    const refreshCallPos = html.indexOf('refreshBarInfo()');
    const xtermCheckPos = html.indexOf("typeof Terminal === 'undefined'");
    assert.ok(refreshCallPos > 0, '应调用 refreshBarInfo()');
    assert.ok(xtermCheckPos > 0, '应有 xterm 加载检查');
    assert.ok(refreshCallPos < xtermCheckPos, 'refreshBarInfo 应在 xterm 检查前调用（不依赖 xterm）');
    const refreshFnMatch = html.match(/function refreshBarInfo[\s\S]*?^  }/m);
    assert.ok(refreshFnMatch, '应存在 refreshBarInfo 函数');
    assert.ok(!/Terminal|FitAddon|term\b/.test(refreshFnMatch[0]), 'refreshBarInfo 不应引用 xterm 相关对象');
});

// 怀疑点 G2-fe（异常：fetch 失败/JSON 异常时前端不崩）
test('G2-fe: refreshBarInfo 有 .catch 兜底（fetch 失败不崩）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    const refreshFnMatch = html.match(/function refreshBarInfo[\s\S]*?^  }/m);
    assert.ok(refreshFnMatch, '应存在 refreshBarInfo 函数');
    assert.ok(/\.catch\s*\(/.test(refreshFnMatch[0]), 'refreshBarInfo 应有 .catch 兜底（fetch/json 失败不崩）');
});

// 怀疑点 G3-source（类型安全：alias-resolve 路由返回基础字段，无 modelAliases 逻辑）
test('G3-source: alias-resolve 路由不再读本地 config.modelAliases（派生已移除）', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'standalone', 'managementServer.js'), 'utf8');
    const aliasResolveBlock = src.match(/mAliasResolve[\s\S]*?sendJson\(res, 200, result\)/);
    assert.ok(aliasResolveBlock, '应找到 alias-resolve 路由块');
    assert.ok(!/modelAliases/.test(aliasResolveBlock[0]), 'alias-resolve 不应再读 modelAliases（派生已移除）');
    assert.ok(/kind: info\.kind/.test(aliasResolveBlock[0]), 'alias-resolve 应返回 kind 基础字段');
});

// 怀疑点 G5-fe（一致性：前端终端页只调 alias-resolve，不重复调 GET /terminals/:tid）
test('G5-fe: 终端页只调 alias-resolve（不重复调 GET /terminals/:tid）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    const iifeMatch = html.match(/\(function\(\)\s*\{[\s\S]*?\}\)\(\)/);
    assert.ok(iifeMatch, '应有 IIFE');
    const iife = iifeMatch[0];
    assert.ok(/alias-resolve/.test(iife), '应 fetch alias-resolve');
    const fetchCalls = iife.match(/fetch\s*\(/g) || [];
    assert.equal(fetchCalls.length, 1, '终端页 IIFE 应只有 1 个 fetch 调用（alias-resolve）');
    const fetchIdx = iife.indexOf('fetch(');
    const fetchContext = iife.slice(fetchIdx, fetchIdx + 200);
    assert.ok(/alias-resolve/.test(fetchContext), '唯一的 fetch 应是 alias-resolve');
});

// ════════════════════════════════════════════════════════════
// 跨目标冲突审查 TDD（目标1-7 整体）
// ════════════════════════════════════════════════════════════

// 怀疑点 X1（目标5 文案遗漏）：config 编辑页 hint 不应提"写入 settings.json"
test('X1: 静态配置编辑页 hint 不应提"写入 settings.json"（目标1/2 后终端走 env）', () => {
    const html = buildConfigEditorHtml({
        workspaceId: 'w', workspaceName: 'ws', apiBase: '',
        config: { id: 'c', name: 'n', content: '{}', mode: 'direct' },
    });
    assert.ok(!/写入\s*\.claude_proxy\/settings\.json/.test(html),
        '静态配置编辑页 hint 不应提"写入 .claude_proxy/settings.json"（目标1/2 后走 env）');
});

// 怀疑点 X2（派生相关删除）：managementServer 无 checkDerivedForAlias
test('X2: managementServer 无 checkDerivedForAlias', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'standalone', 'managementServer.js'), 'utf8');
    assert.ok(!/checkDerivedForAlias/.test(src), 'checkDerivedForAlias 应已删除');
});

// 怀疑点 X3（派生相关删除）：alias-resolve 简单返回，无 proxyForward / getLocalConfigs
test('X3: alias-resolve 路由无 proxyForward / getLocalConfigs（派生已移除）', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'standalone', 'managementServer.js'), 'utf8');
    const idx = src.indexOf('mAliasResolve');
    assert.ok(idx > 0, '应找到 alias-resolve 路由');
    const block = src.slice(idx, idx + 400);
    assert.ok(/kind: info\.kind/.test(block), 'alias-resolve 应返回 kind 基础字段');
    assert.ok(!/proxyForward/.test(block), 'alias-resolve 不应调代理 proxyForward');
    assert.ok(!/getLocalConfigs/.test(block), 'alias-resolve 不应读本地 config（派生已移除）');
});

// 怀疑点 X4（目标2 决策2）：配置行统一有「新建终端」按钮（无 isDerived 分支）
test('X4: 配置行统一有"新建终端"按钮（派生已移除，无需分支）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    const cfgRowMatch = html.match(/function buildConfigRow[\s\S]*?return row;/m);
    assert.ok(cfgRowMatch, '应找到 buildConfigRow 函数');
    const fn = cfgRowMatch[0];
    assert.ok(!/isDerived/.test(fn), 'buildConfigRow 不应有 isDerived 分支');
    assert.ok(/新建终端/.test(fn), '配置行应有"新建终端"按钮');
});
