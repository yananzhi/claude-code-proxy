// test/standalone/tree-html.test.mjs — 树状管理页 HTML 结构测试
//
// 运行：node --test test/standalone/tree-html.test.mjs
//
// 覆盖：
//   T1 buildWorkspacesHtml 含树结构 + 终端 fetch 序列 + 新建终端入口
//   T2 XSS：用户数据不进 innerHTML
//   T3 buildTerminalHtml 用 terminalId + 无 POST-start

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

test('T1d: 派生配置终端入口（POST /api/workspaces/:id/configs/:cfgId/terminals）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.match(/\/configs\/.*\/terminals/), '应有 /configs/:cfgId/terminals 入口');
});

test('T1g: 静态配置有「+ 别名配置」入口（newDerivedConfig + next-alias-id）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('newDerivedConfig'), '应有 newDerivedConfig 函数');
    assert.ok(html.includes('+ 别名配置'), '静态配置行应有「+ 别名配置」按钮');
    assert.ok(html.includes('/next-alias-id'), '建别名配置应取 next-alias-id');
});

test('T1h: 别名终端统一挂终端组（不再过滤 derived）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // 终端组不应过滤派生终端（旧 t.kind !== 'derived' 已取消）
    assert.ok(!html.includes("t.kind !== 'derived'"), '终端组不应过滤派生终端（统一挂终端组）');
});

test('T1h2: buildDerivedConfigRow 不再加载终端子节点（终端移到终端组）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // 派生配置行不应再异步 fetch /configs/:cfgId/terminals 挂终端子节点
    // （终端统一挂终端组，派生配置节点下无终端子节点容器）
    assert.ok(!html.includes('derived-terms'), '派生配置节点不应有终端子节点容器');
    // buildDerivedConfigRow 若仍存在，不应包含 listByConfig 的终端 fetch
    const drMatch = html.match(/function buildDerivedConfigRow[\s\S]*?^}/m);
    if (drMatch) {
        assert.ok(!/\/configs\/.*\/terminals/.test(drMatch[0]), 'buildDerivedConfigRow 不应再 fetch 终端');
    }
});

// ── 目标4 TDD 审查：6 类怀疑点逐条确认 ──────────────────────────

// 怀疑点1（边界：只有别名终端时终端组是否仍列出）
// "bug 存在"断言：终端组仍按 kind 过滤（只列 normal）→ 只有别名终端时终端组为空
// 若 html 含 normalOnly 过滤则 bug 存在；不含则非 bug。
test('T1h3: 终端组无 kind 过滤（边界：只有别名终端也列出）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // 旧代码 var normalOnly = normalTerms.filter(t => t.kind !== 'derived') 应已移除
    assert.ok(!html.includes('normalOnly'), '不应残留 normalOnly 过滤变量（别名终端统一挂终端组）');
    assert.ok(!html.includes("t.kind !== 'derived'"), '不应按 kind 过滤终端');
});

// 怀疑点2（异常：终端 API 返回 {terminals: undefined} 时 renderWsBody 是否崩溃）
// "bug 存在"断言：normalTerms 直接取 t.terminals 无兜底 → undefined.forEach 崩
// 若 html 无 "t.terminals || []" 兜底则 bug 存在；有则非 bug。
test('T1h4: normalTerms 有空兜底（t.terminals || []）防异常结构', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('t.terminals || []'), '应有 t.terminals || [] 兜底，防 terminals 字段缺失');
});

// 怀疑点3+4（类型安全 + 状态转换：终端行 kind 标记是否透传）
// "bug 存在"断言：buildTerminalRow 不引用 t.kind → kind 丢失
// 若 buildTerminalRow 不含 t.kind 则 bug 存在；含则非 bug。
test('T1h5: buildTerminalRow 透传 t.kind（类型标记不丢失）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    const trMatch = html.match(/function buildTerminalRow[\s\S]*?^}/m);
    assert.ok(trMatch, '应存在 buildTerminalRow 函数');
    assert.ok(/t\.kind/.test(trMatch[0]), 'buildTerminalRow 应引用 t.kind 透传终端类型');
});

// 怀疑点6（一致性：终端组标题计数是否含别名终端）
// "bug 存在"断言：标题用过滤后计数（normalOnly.length）→ 不含别名
// 若标题用 normalOnly.length 则 bug 存在；用 normalTerms.length 则非 bug。
test('T1h6: 终端组标题计数用 normalTerms.length（含别名终端）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // 标题应引用 normalTerms.length（全部终端），非 normalOnly.length（过滤后）
    assert.ok(/终端（'\s*\+\s*normalTerms\.length/.test(html),
        '终端组标题计数应用 normalTerms.length（含别名终端）');
    assert.ok(!/normalOnly\.length/.test(html), '不应残留 normalOnly.length 计数');
});

// 怀疑点5（时序：别名终端是否出现在终端组列表）
// renderWsBody 的 normalTerms 来自 fetch /api/workspaces/:id/terminals（listByWorkspace）。
// listByWorkspace 按 workspaceId 过滤、不按 kind 过滤 → 别名终端（kind='derived'）也在列表里。
// 此为跨 claudeSession.js 的保证，需独立会话级测试确认（见 claude-session.test.mjs D4f-derived）。
// HTML 侧保证：终端组 forEach 遍历 normalTerms 全量、不过滤 kind。
test('T1h7: 终端组 forEach 遍历 normalTerms 全量（不过滤 kind）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // 终端组应直接 normalTerms.forEach（含别名），不先 filter
    assert.ok(/normalTerms\.forEach/.test(html), '终端组应直接遍历 normalTerms（不过滤）');
});

// 怀疑点6b（一致性：别名配置节点下真的没终端子节点容器）
// buildDerivedConfigRow 只 buildConfigRow + wrapper，不创建终端容器。
test('T1h8: buildDerivedConfigRow 不创建终端子节点容器', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    const drMatch = html.match(/function buildDerivedConfigRow[\s\S]*?^}/m);
    assert.ok(drMatch, '应存在 buildDerivedConfigRow 函数');
    // 不应在派生配置行内创建终端容器 div 或 fetch 终端
    assert.ok(!/termBox|term-container|derived-terms/.test(drMatch[0]),
        'buildDerivedConfigRow 不应创建终端子节点容器');
    assert.ok(!/\.forEach/.test(drMatch[0]), 'buildDerivedConfigRow 不应遍历终端');
});

test('T1i: 静态配置显示「设为默认」按钮（别名配置不显示，标记仅静态可用）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // 有"设为默认"按钮文案，且有 !isDerived 守卫（只在静态配置显示）
    assert.ok(html.includes('设为默认'), '应有「设为默认」按钮文案');
    assert.ok(/if\s*\(!isDerived\)/.test(html), '设为默认按钮应有 !isDerived 守卫');
    assert.ok(!html.includes("'激活'") && !html.includes('"激活"'), '不应残留旧「激活」文案');
});

test('T1j: 配置行有「重命名」+「删除」按钮 + renameConfig/deleteConfig 函数', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('renameConfig'), '应有 renameConfig 函数');
    assert.ok(html.includes('deleteConfig'), '应有 deleteConfig 函数');
    assert.ok(html.includes('重命名'), '应有「重命名」按钮文案');
    // 删除按钮（配置行，非 workspace 的删除）
    assert.ok(/delCfgBtn/.test(html), '应有配置删除按钮变量');
    // 重命名提示 #N 不变
    assert.ok(/编号.*不变|derivedIndex.*不变|cfg\.derivedIndex/.test(html), '重命名应提示 #N 编号不变');
});

// 看护：生成的内联 JS 必须语法合法（防模板字符串里 \n 误用导致整 script 解析失败）
// 之前 deleteConfig 的 confirm('...\n...') 里 \n 在外层模板字符串里被解析成真实换行，
// 致单引号字符串跨行 → JS 语法错 → loadList 不执行 → 配置组不渲染（e2e 才抓得到，单测盲区）。
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

test('T8b: 树含类型图标（📁 workspace / 📄 静态配置 / 🔀 别名配置 / 🖥 终端）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('📁'), 'workspace 应有 📁 图标');
    assert.ok(html.includes('📄'), '静态配置组标题或配置行应有 📄 图标');
    assert.ok(html.includes('🔀'), '别名配置应有 🔀 图标');
    assert.ok(html.includes('🖥'), '终端应有 🖥 图标');
});

test('T8c: 配置组/终端组可折叠（buildGroup toggle + group-body）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // renderWsBody 应有 buildGroup 构造器（toggle + group-body）
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

test('T8e: 目录选择器渲染不用 innerHTML 拼变量（DOM 构建，过 T2a 守卫）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // renderDirPicker 不应 innerHTML = 变量
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
// T1w 文案统一（目标5）：无"派生/derived/Local LLM Configs"残留（用户可见处）
// ════════════════════════════════════════════════════════════
test('T1w1: 主列表页无"Local LLM Configs"/"Terminals（"英文残留', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(!html.includes('Local LLM Configs'), '不应残留 Local LLM Configs');
    assert.ok(!/Terminals（/.test(html), '不应残留 Terminals（ 英文分组标题');
});
test('T1w2: 主列表页无"派生配置/派生节点/derived 标签"残留（用户可见文案）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // 排除代码标识符（derivedFrom/derivedIndex/buildDerivedConfigRow 等），只查用户可见文案
    // 用户可见的：textContent/label/提示信息里的"派生"
    assert.ok(!html.includes("'派生") && !html.includes('"派生'), '不应有派生字样的用户可见文案');
    assert.ok(!html.includes("tag.textContent = 'derived'"), '不应有 derived 文字标签');
    assert.ok(!html.includes('[mode='), '配置行不应残留 [mode=...] 显示');
});
test('T1w3: 终端行标 [静态]/[别名] 标签', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('[静态]'), '静态终端应标 [静态]');
    assert.ok(html.includes('[别名]'), '别名终端应标 [别名]');
});
test('T1w4: 配置行显示 [直连]/[代理] 徽标', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    assert.ok(html.includes('[直连]'), '直连配置应标 [直连]');
    assert.ok(html.includes('[代理]'), '代理配置应标 [代理]');
});
test('T1w5: 别名配置编辑页无"派生节点"残留', () => {
    const html = buildConfigEditorHtml({
        workspaceId: 'w', workspaceName: 'ws', apiBase: '',
        config: { id: 'c', name: 'd', derivedFrom: 'p', derivedIndex: 1, content: '{}', mode: 'proxy', modelAliases: {}, sessionContext1m: {} },
    });
    assert.ok(!html.includes('派生节点'), '别名配置编辑页不应残留"派生节点"');
    assert.ok(html.includes('别名配置'), '别名配置编辑页应有"别名配置"文案');
});

// ════════════════════════════════════════════════════════════
// T2 XSS：用户数据不进 innerHTML
// ════════════════════════════════════════════════════════════
test('T2a: buildWorkspacesHtml 用户数据不直接进 innerHTML（用 textContent）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // 检查 JS 源：不应有 innerHTML = 拼接用户数据的模式（如 ws.name 直接拼）
    // 允许 innerHTML 设静态模板字符串（无用户数据），但不允许 innerHTML 拼接变量
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
// T3d/T3e 别名终端顶栏实时查映射（目标6）
// ════════════════════════════════════════════════════════════
test('T3d: buildTerminalHtml 顶栏 fetch alias-resolve（含顶栏容器）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    assert.ok(html.includes('alias-resolve'), '顶栏应 fetch /api/terminals/:tid/alias-resolve');
    assert.ok(html.includes('id="barInfo"') || html.includes('bar-info'), '应有顶栏信息容器');
});

test('T3e: buildTerminalHtml 渲染别名→真实模型（[别名] #N ccp-xxx→model）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    // 顶栏 JS 应有渲染别名映射的逻辑（ccp-<tier>-N → 真实模型）
    assert.ok(html.includes('别名'), '顶栏应渲染 [别名] 标记');
    assert.ok(/resolvedModel|真实模型|→/.test(html), '顶栏应渲染 别名→真实模型 映射');
});

test('T3f: 别名各档之间用逗号分隔（非空格粘连）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    // parts.join 应为 ', '（逗号分隔），非 '  '（空格粘连）
    assert.ok(html.includes("parts.join(', ')"), '各档应逗号分隔');
    assert.ok(!html.includes("parts.join('  ')"), '不应空格粘连');
});

test('T3g: 顶栏别名映射 polling 实时刷新（setInterval + 可见性暂停 + 清理）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    // 应有 setInterval 轮询 alias-resolve（别名映射变更后顶栏自动更新）
    assert.ok(/setInterval/.test(html), '应有 setInterval 轮询');
    assert.ok(/document\.hidden/.test(html), '页面隐藏时应暂停轮询省资源');
    assert.ok(/beforeunload|clearInterval/.test(html), '页面卸载应清理轮询定时器');
    // 变化检测：只在新旧文本不同时更新 DOM
    assert.ok(/lastBarText|text !== lastBarText/.test(html), '应有变化检测避免无谓重绘');
});

// ════════════════════════════════════════════════════════════
// 目标6 代码审查 TDD：前端 6 类怀疑点逐条确认
// ════════════════════════════════════════════════════════════

// 怀疑点 G1-fe（时序：refreshBarInfo 在 xterm 加载前调用）
//   refreshBarInfo() 在 xterm 检查（typeof Terminal === 'undefined'）之前调用。
//   "bug 存在"断言：refreshBarInfo 依赖 xterm → 在 xterm 加载前调会崩。
//   若 refreshBarInfo 不依赖 xterm（只更新 barInfo textContent）则非 bug。
test('G1-fe: refreshBarInfo 不依赖 xterm（在 xterm 检查前调用，非 bug）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    // refreshBarInfo 调用应在 typeof Terminal 检查之前
    const refreshCallPos = html.indexOf('refreshBarInfo()');
    const xtermCheckPos = html.indexOf("typeof Terminal === 'undefined'");
    assert.ok(refreshCallPos > 0, '应调用 refreshBarInfo()');
    assert.ok(xtermCheckPos > 0, '应有 xterm 加载检查');
    assert.ok(refreshCallPos < xtermCheckPos, 'refreshBarInfo 应在 xterm 检查前调用（不依赖 xterm）');
    // refreshBarInfo 函数体不应引用 Terminal/FitAddon
    const refreshFnMatch = html.match(/function refreshBarInfo[\s\S]*?^  }/m);
    assert.ok(refreshFnMatch, '应存在 refreshBarInfo 函数');
    assert.ok(!/Terminal|FitAddon|term\b/.test(refreshFnMatch[0]), 'refreshBarInfo 不应引用 xterm 相关对象');
});

// 怀疑点 G2-fe（异常：fetch 失败/JSON 异常时前端不崩）
//   "bug 存在"断言：refreshBarInfo 无 .catch → fetch 失败或 r.json() 抛 → 崩。
//   若有 .catch 则非 bug。
test('G2-fe: refreshBarInfo 有 .catch 兜底（fetch 失败不崩）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    const refreshFnMatch = html.match(/function refreshBarInfo[\s\S]*?^  }/m);
    assert.ok(refreshFnMatch, '应存在 refreshBarInfo 函数');
    assert.ok(/\.catch\s*\(/.test(refreshFnMatch[0]), 'refreshBarInfo 应有 .catch 兜底（fetch/json 失败不崩）');
});

// 怀疑点 G3-fe（类型安全：modelAliases 为空对象时顶栏显示什么）
//   别名终端但 modelAliases 为 {}（用户没配任何档）→ tiers.forEach 不 push（real 为 falsy）。
//   顶栏只显示 '[别名] #N'（无映射）。
//   "bug 存在"断言：modelAliases 为空时 parts 为空 → barInfo.textContent = '' → 顶栏空白。
//   若 parts 至少含 '[别名] #N' 则非 bug。
test('G3-fe: modelAliases 为空时顶栏仍显示 [别名] #N（非空白）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    // 验证 parts 初始含 '[别名] #' + idx（即使 modelAliases 为空也有编号）
    const refreshFnMatch = html.match(/function renderBarInfo[\s\S]*?^  }/m);
    assert.ok(refreshFnMatch, '应存在 refreshBarInfo 函数');
    // parts 应初始化为 ['[别名] #' + idx]（至少一项，空 modelAliases 也有编号）
    assert.ok(/\[别名\]\s*#\s*['"]?\s*\+/.test(refreshFnMatch[0]) ||
              /parts\s*=\s*\[.*别名.*\]/.test(refreshFnMatch[0]),
              'parts 应初始化含 [别名] #N（modelAliases 空时不空白）');
});

// 怀疑点 G3-source（类型安全：路由 modelAliases 有 || {} 兜底）
//   managementServer.js alias-resolve 路由：result.modelAliases = cfg.modelAliases || {}
//   "bug 存在"断言：路由无兜底 → cfg.modelAliases 为 undefined 传前端 → aliases[t[0]] 崩。
//   若有 || {} 则非 bug。
test('G3-source: alias-resolve 路由 modelAliases 有 || {} 兜底', () => {
    // 读 managementServer.js 源码验证兜底
    const src = readFileSync(resolve(__dirname, '..', '..', 'standalone', 'managementServer.js'), 'utf8');
    // alias-resolve 路由块应有 modelAliases || {} 兜底
    const aliasResolveBlock = src.match(/mAliasResolve[\s\S]*?sendJson\(res, 200, result\)/);
    assert.ok(aliasResolveBlock, '应找到 alias-resolve 路由块');
    assert.ok(/modelAliases\s*\|\|\s*\{\}/.test(aliasResolveBlock[0]),
        'alias-resolve 路由应对 modelAliases 做 || {} 兜底');
});

// 怀疑点 G4-fe（边界：derivedIndex 为 0 或缺失时前端跳过别名渲染）
//   前端 if (d.kind === 'derived' && d.derivedIndex) → derivedIndex=0 时 falsy → 跳过。
//   configApi 校验 derivedIndex >= 1，但手动编辑的 config 文件可能 derivedIndex=0 或缺失。
//   "bug 存在"断言：derivedIndex=0 的别名终端顶栏不渲染别名（静默降级）。
//   翻转：derivedIndex >= 1 是创建校验保证的，0 不会出现。但前端 truthy 检查仍隐含风险。
//   验证：前端用 d.derivedIndex truthy 检查（非显式 >= 1 检查）→ 若 derivedIndex=0 会跳过。
//   这是设计接受的降级（derivedIndex=0 不合法，不出现），但 truthy 检查比 >= 1 检查脆弱。
test('G4-fe: 前端 derivedIndex 检查为 truthy（derivedIndex=0 会跳过，但校验保证 >=1）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    const refreshFnMatch = html.match(/function renderBarInfo[\s\S]*?^  }/m);
    assert.ok(refreshFnMatch, '应存在 refreshBarInfo 函数');
    // 前端检查 d.derivedIndex truthy（非 d.derivedIndex >= 1）
    assert.ok(/d\.derivedIndex/.test(refreshFnMatch[0]), '应检查 d.derivedIndex');
    // 当前实现用 truthy：d.kind === 'derived' && d.derivedIndex
    // derivedIndex >= 1 由 configApi 创建校验保证，0 不会出现 → truthy 等价于 >= 1（对合法数据）
    assert.ok(/d\.kind\s*===\s*['"]derived['"]\s*&&\s*d\.derivedIndex/.test(refreshFnMatch[0]),
        '前端用 truthy 检查 derivedIndex（合法值 >=1，等价于 >=1 检查）');
});

// 怀疑点 G5-fe（一致性：前端终端页只调 alias-resolve，不重复调 GET /terminals/:tid）
//   "bug 存在"断言：前端调两个接口 → 重复。
//   若只调 alias-resolve 则非 bug。
test('G5-fe: 终端页只调 alias-resolve（不重复调 GET /terminals/:tid）', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    // 终端页 IIFE 内 fetch 只应调 alias-resolve，不调 GET /api/terminals/:tid（非 /alias-resolve）
    const iifeMatch = html.match(/\(function\(\)\s*\{[\s\S]*?\}\)\(\)/);
    assert.ok(iifeMatch, '应有 IIFE');
    const iife = iifeMatch[0];
    // alias-resolve fetch 应存在
    assert.ok(/alias-resolve/.test(iife), '应 fetch alias-resolve');
    // 终端页只有 refreshBarInfo 调 fetch，WS 用 new WebSocket
    const fetchCalls = iife.match(/fetch\s*\(/g) || [];
    assert.equal(fetchCalls.length, 1, '终端页 IIFE 应只有 1 个 fetch 调用（alias-resolve），不重复调 GET /terminals/:tid');
    // 唯一的 fetch 应含 alias-resolve（fetch 调用行内应有 alias-resolve 字样）
    // 找到 fetch 调用所在行，验证该行含 alias-resolve
    const fetchLine = iife.split('\n').find(l => /fetch\s*\(/.test(l));
    assert.ok(fetchLine, '应找到 fetch 调用行');
    // fetch 行可能跨行，取 fetch 关键字后 200 字符验证
    const fetchIdx = iife.indexOf('fetch(');
    const fetchContext = iife.slice(fetchIdx, fetchIdx + 200);
    assert.ok(/alias-resolve/.test(fetchContext), '唯一的 fetch 应是 alias-resolve（非 GET /terminals/:tid）');
});

// 怀疑点 G6-fe（一致性：顶栏 tiers 顺序固定 main/haiku/sonnet/opus）
//   "bug 存在"断言：tiers 顺序不固定 → 顶栏映射顺序随机。
//   若 tiers 硬编码固定顺序则非 bug。
test('G6-fe: 顶栏 tiers 顺序固定 main → haiku → sonnet → opus', () => {
    const html = buildTerminalHtml({ terminalId: 't_x', apiBase: '' });
    const refreshFnMatch = html.match(/function renderBarInfo[\s\S]*?^  }/m);
    assert.ok(refreshFnMatch, '应存在 refreshBarInfo 函数');
    const fn = refreshFnMatch[0];
    // 验证 tiers 数组顺序
    const mainPos = fn.indexOf("'main'");
    const haikuPos = fn.indexOf("'haiku'");
    const sonnetPos = fn.indexOf("'sonnet'");
    const opusPos = fn.indexOf("'opus'");
    assert.ok(mainPos > 0 && haikuPos > mainPos && sonnetPos > haikuPos && opusPos > sonnetPos,
        'tiers 顺序应为 main → haiku → sonnet → opus');
});

// ════════════════════════════════════════════════════════════
// 跨目标冲突审查 TDD（目标1-7 整体）
// ════════════════════════════════════════════════════════════

// 怀疑点 X1（目标5 文案遗漏）：config 编辑页 hint 仍提"写入 .claude_proxy/settings.json"
//   目标1/2 后终端统一走 env、standalone 不再写 settings.json（markDefaultConfig 只写标记）。
//   但编辑页 hint 仍说"切换配置时写入 .claude_proxy/settings.json"——误导用户以为起终端依赖 settings.json。
//   "bug 存在"断言：hint 含 settings.json 写入描述 → 文案过时。
test('X1: 静态配置编辑页 hint 不应提"写入 settings.json"（目标1/2 后终端走 env）', () => {
    const html = buildConfigEditorHtml({
        workspaceId: 'w', workspaceName: 'ws', apiBase: '',
        config: { id: 'c', name: 'n', content: '{}', mode: 'direct' },
    });
    // hint 不应含"写入 .claude_proxy/settings.json"描述（终端走 env，不再写 settings）
    assert.ok(!/写入\s*\.claude_proxy\/settings\.json/.test(html),
        '静态配置编辑页 hint 不应提"写入 .claude_proxy/settings.json"（目标1/2 后走 env）');
});

// 怀疑点 X2（目标5 文案遗漏）：managementServer checkDerivedForAlias 错误信息仍含"派生节点"
//   目标5 全站文案统一为"静态配置/别名配置"，但 checkDerivedForAlias 返回的错误信息仍说"仅派生节点可设置别名"。
//   此错误信息经 management alias 路由返回给前端 showMsg，是用户可见文案。
//   "bug 存在"断言：错误信息含"派生节点" → 文案遗漏。
test('X2: checkDerivedForAlias 错误信息无"派生节点"残留（目标5 文案统一）', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'standalone', 'managementServer.js'), 'utf8');
    // checkDerivedForAlias 函数体内的错误信息不应含"派生节点"
    const fnMatch = src.match(/function checkDerivedForAlias[\s\S]*?^}/m);
    assert.ok(fnMatch, '应找到 checkDerivedForAlias 函数');
    assert.ok(!/派生节点/.test(fnMatch[0]),
        'checkDerivedForAlias 错误信息不应含"派生节点"（目标5 统一为"别名配置"）');
});

// 怀疑点 X3（目标6 决策3 文档 vs 代码）：alias-resolve 读本地 vs 文档说"查代理"
//   文档第6节决策3："别名终端顶栏真实模型 → 实时查代理 modelAliases"
//   实际实现：alias-resolve 路由读本地 config.modelAliases（managementServer.js 第171行注释"本地权威"）。
//   这是代码比文档更合理（本地经 updateConfigAlias 同步、避免代理往返），但文档与代码不一致。
//   翻转断言为正确行为：alias-resolve 读本地（非代理），文档需更新。
test('X3: alias-resolve 读本地 config.modelAliases（非代理，文档需更新）', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'standalone', 'managementServer.js'), 'utf8');
    const aliasResolveBlock = src.match(/mAliasResolve[\s\S]*?sendJson\(res, 200, result\)/);
    assert.ok(aliasResolveBlock, '应找到 alias-resolve 路由块');
    // 应读本地 config（manager.getLocalConfigs），非调代理 proxyForward
    assert.ok(/manager\.getLocalConfigs/.test(aliasResolveBlock[0]), 'alias-resolve 应读本地 config');
    assert.ok(!/proxyForward/.test(aliasResolveBlock[0]), 'alias-resolve 不应调代理 proxyForward（读本地）');
});

// 怀疑点 X4（目标2 决策2 文档 vs 代码）：静态配置行缺"新建终端"按钮
//   文档第6节决策2："静态配置行也加该按钮（新建终端）"。
//   实际代码：buildConfigRow 中 isDerived 才有"新建终端"按钮（第323-329行），!isDerived 只有"+ 别名配置"。
//   "bug 存在"断言：静态配置行无"新建终端"按钮 → 文档说有但代码没有。
test('X4: 静态配置行应有"新建终端"按钮（文档决策2 要求）', () => {
    const html = buildWorkspacesHtml({ apiBase: '', proxyPort: 11444 });
    // buildConfigRow 中 !isDerived 分支应有"新建终端"按钮（不只是"+ 别名配置"）
    const cfgRowMatch = html.match(/function buildConfigRow[\s\S]*?return row;/m);
    assert.ok(cfgRowMatch, '应找到 buildConfigRow 函数');
    const fn = cfgRowMatch[0];
    // 提取 isDerived 分支（if (isDerived) { ... }）内的按钮
    const derivedBlock = fn.match(/if\s*\(isDerived\)\s*\{([\s\S]*?)\}/);
    const derivedBtns = derivedBlock ? derivedBlock[1] : '';
    // 提取 !isDerived 分支内的按钮（两个 if(!isDerived) 块）
    const staticBlocks = fn.match(/if\s*\(!isDerived\)\s*\{[\s\S]*?\}/g) || [];
    const staticBtns = staticBlocks.join('\n');
    // 静态配置行应有"新建终端"按钮（当前 bug：只有"+ 别名配置"无"新建终端"）
    assert.ok(/新建终端/.test(staticBtns),
        '静态配置行（!isDerived 分支）应有"新建终端"按钮（文档决策2：静态配置行也加该按钮）');
});
