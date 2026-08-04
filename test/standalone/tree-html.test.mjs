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
