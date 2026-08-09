// test/e2e/terminal-connect.spec.ts — 终端页"卡在正在连接"回归测试
//
// 锁定 2026-08-09 修过的复发 bug：standalone/web/workspaces-html.js 的 buildTerminalHtml
// 用反引号模板字符串拼整页 HTML，内含 <script> 块。模板里写 JS 注释/字符串字面量时若
// 裸写 '\r' / '\n' / '\x..'，Node 解析模板字符串时会把它们解释成真实控制字节（CR=0x0d /
// LF=0x0a）塞进生成的 HTML——一个 CR 落在 // 注释里会把注释从中间断开，断点后文字变裸代码
// → <script> 块 SyntaxError: Invalid or unexpected token → 整个内联 JS 不执行 →
// connectWs() 永远不跑 → 终端页永远停在"正在连接终端..."（WebSocket 根本没尝试连接，
// 表面像"连不上"，实际是前端 JS 炸了没起来）。
//
// 修复：模板里所有 '\r'/'\n' 写双反斜杠 '\\r'/'\\n'（或用 CR/LF 文字），让 Node 输出
// 字面量 backslash-r 文本给浏览器。
//
// 两条互补的看护：
//   1) 页面级（真实浏览器）：打开真实 /terminal/:tid 页面，断言 #msg 离开"正在连接终端..."。
//      tid 不存在也行（页面 HTML 不依赖 session）。不起真 PTY、不需要 claude.exe。
//      - 内联 JS SyntaxError → connectWs() 不执行 → #msg 永远停在"正在连接终端..." → 超时失败。
//      - 内联 JS 正常 → connectWs() 连 WS → 因 tid 无 session，服务端回
//        {type:'error', error:'终端不存在...'} 后 close → #msg 变"终端不存在..."（离开"正在连接..."即通过）。
//   2) 静态级（不依赖浏览器 pageerror 行为）：抓取被服务的 HTML，抽出内联 <script>，
//      用 new Function(code) 做语法体检。Chromium 对内联 <script> 的 SyntaxError 不稳定
//      触发 pageerror 事件（实测本场景不发），故不能靠 page.on('pageerror') 看护，必须静态抽检。
import { test, expect } from './fixtures.js';

test.describe('终端页连接（回归 2026-08-09：反引号模板转义致 <script> SyntaxError → 卡"正在连接"）', () => {
    test('#msg 离开"正在连接终端..."（真实浏览器，证明内联 JS 解析成功 + connectWs 跑起来）', async ({ page, standalone }) => {
        // tid 用一个不存在的值——页面 HTML 照常返回，无需真实终端 session。
        // 关键是被服务的 HTML 里的内联 <script> 能否解析执行。
        await page.goto(`${standalone.url}/terminal/regression-guard-tid`, { waitUntil: 'domcontentloaded' });

        // #msg 必须在合理时间内离开"正在连接终端..."——
        // 只要 connectWs() 跑了（连上 WS → onopen 清 msg，或服务端拒绝 → onmessage/onclose 改 msg），
        // 文本就会变（这里会变成"终端不存在，请先在管理页新建终端"——因 tid 无 session 被服务端拒）。
        // 若内联 JS SyntaxError → connectWs 永不跑 → #msg 永远停在"正在连接终端..."，这里超时失败，正是回归信号。
        await expect(page.locator('#msg')).not.toHaveText('正在连接终端...', { timeout: 8000 });
    });

    test('内联 <script> 可解析（静态抽检，不依赖浏览器 pageerror）', async ({ request, standalone }) => {
        // 抓取被服务的终端页 HTML，抽出内联 <script> 块做语法体检。
        // Chromium 对内联 <script> 的 SyntaxError 不稳定触发 pageerror（实测本场景不发），
        // 故不能靠浏览器事件看护；直接静态抽检最可靠。
        const resp = await request.get(`${standalone.url}/terminal/static-check-tid`);
        expect(resp.ok()).toBe(true);
        const html = await resp.text();

        // 抽出所有 <script>...</script>（含非 vendor 的内联块）。vendor 的 xterm.min.js 也一并检，
        // 它本身是合法的，不会误报；真正要守的是 buildTerminalHtml 生成的那段内联 JS。
        const scriptRe = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
        let m: RegExpExecArray | null;
        let checked = 0;
        while ((m = scriptRe.exec(html)) !== null) {
            const code = m[1];
            if (!code.trim()) continue; // 空 script（如 src 引用的）跳过
            // new Function 只做语法解析（不执行），抛 SyntaxError 即语法非法。
            // 用 try 包裹，把错误信息附上方便定位。
            try {
                // eslint-disable-next-line no-new-func
                new Function(code);
            } catch (e: any) {
                throw new Error(`内联 <script> 语法错误（反引号模板转义回归？）: ${e.message}\n--- 片段 ---\n${code.slice(0, 400)}`);
            }
            checked++;
        }
        // 至少应检到一段内联 JS（buildTerminalHtml 的 IIFE）。若 0 段说明 HTML 结构变了，测试需更新。
        expect(checked, '应至少检到一段内联 <script>，实际 0 段——HTML 结构变了？').toBeGreaterThan(0);
    });
});
