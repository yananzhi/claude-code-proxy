# 重试记录表格：首字节/末次耗时列 + 列宽修复 + 列配置驱动

## 背景

重试记录表格（`proxy/web/index.html`）现需：
1. **首字节耗时**：最后一次成功 attempt 从发出到收到首个有效 chunk 的耗时（前 N 次失败 attempt 不计入）。
2. **末次耗时**：最后一次成功 attempt 的完整 elapsedMs（从发出到上游响应 end）。
3. **列宽根治**：之前加列时列间距乱，根因是列定义散落 6 处 + 多处 colspan 不一致 + `.row` 类名冲突。
4. **列配置**：列宽自适应、每列可配置显隐，工具栏按钮+下拉面板，存 localStorage。
5. 所有时间/耗时列鼠标 hover 显示计算口径说明。

## 一、后端：采集首字节耗时

### 1.1 `forwardStreaming()` 抓首字节时刻

文件：`proxy/server.js`，函数 `forwardStreaming`（L140-297）。

`mode` 从 `'pending'` 首次转为 `'stream'` 的那一刻 = 首个有效 chunk 到达。失败的 attempt 走 `'buffer'` 分支，不触发，天然满足"前 N 次不算"。

改动：
- 在 `resp` 回调顶部初始化 `let firstChunkAt = null;`（`attT0` 在上层 `handleRequest`，这里记录绝对时刻 `Date.now()`，差值在上层算）。
- 在两处 `mode = 'stream'` 的位置（L213 `tryDecide` 内、L236 `resp.on('end')` 内）记录 `firstChunkAt = Date.now()`（用 `??=` 或 `if (firstChunkAt === null)` 保证只记首次）。
- `settle()` 返回对象加 `firstChunkAt`（L254、L271、L281、L289、L292 这几个 settle 点都要带上，未触发转发的为 `null`）。

注意：`req.on('timeout')`/`req.on('error')` 等未收到响应的路径，`firstChunkAt` 保持 `null`。

### 1.2 `handleRequest()` 落 attempt + trace

文件：`proxy/server.js`，函数 `handleRequest`（L518-714）。

- attempt 记录（L593 passthrough 分支、L657 重试分支）加两个字段：
  - `firstChunkAt`：该 attempt 的首字节到达绝对时刻（ISO 字符串，复用 `nowIso()` 风格；或存 ms 偏移）。**决策：存 ISO 字符串**，与 `startedAt`/`endedAt` 一致，详情面板和摘要都能直接用。
  - `firstChunkMs`：`firstChunkAt ? Date.parse(firstChunkAt) - attT0 : null`（相对该 attempt 发出的耗时 ms）。便于 attempt 详情展示"本次首字节卡了多久"。
- trace 级（L705-713 `traceStore.append`）加两个字段：
  - `firstChunkAt`：取**最终成功交付那次 attempt** 的 `firstChunkAt`。判定"成功那次" = 循环 break 时 `verdict === null`（已流式交付）的那次 attempt，即 `attempts.at(-1)` 在成功路径下。若 5 次全失败（outcome 为 `failed`/`passed-to-client` 等），为 `null`。
  - `lastAttemptMs`：最终成功 attempt 的 `elapsedMs`。同样从 `attempts.at(-1)` 取（成功路径）。全失败时取最后一次 attempt 的 elapsedMs（仍有参考价值，hover 说明会讲清楚）。

  实现方式：在 break 前的成功分支（L659-672）把 `r.firstChunkAt` 和 `r.elapsedMs`（即 `attMs`）提到外层变量 `finalFirstChunkAt` / `finalLastAttemptMs`，trace append 时用。

### 1.3 `trace-store.js` summarize 加字段

文件：`proxy/trace-store.js`，`summarize`（L205-239）。

trace 级摘要加：
- `firstChunkAt: r.firstChunkAt ?? null`
- `lastAttemptMs: r.lastAttemptMs ?? null`

attempt 级摘要（L220-228）加：
- `firstChunkMs: a.firstChunkMs ?? null`

（attempt 级的 `startedAt`/`endedAt` 现在没进摘要，详情走完整 trace，所以 attempt 级首字节只放 `firstChunkMs` 偏移即可。）

## 二、前端：列配置驱动重构 + 新列 + hover 说明

文件：`proxy/web/index.html`。

### 2.1 列定义提取为 JS 配置数组（核心重构）

在 `<script>` 顶部定义 `TRACE_COLUMNS` 数组，每项：
```js
{
  key: 'startedAt',          // 唯一键
  title: '发出时间',
  width: 13,                 // 默认百分比宽度
  defaultVisible: true,
  render: (t, ctx) => `...`,  // 返回 td innerHTML
  tdClass: 'time',           // td 的 class
  hover: '从客户端请求到达到代理开始处理的时刻。',  // 表头 title 属性
}
```

列清单（含新增，顺序按确认结果）：
1. 发出时间 `startedAt` (13%)
2. #ID `id` (4%)
3. 源IP `sourceIp` (6%)
4. 方法/路径 `method+path` (24%)
5. Model `model` (9%)
6. 错误码 `lastErrorStatus/finalStatus` (5%)
7. 尝试 `attCount` (4%)
8. 总耗时 `totalMs` (6%) ← hover 说明含失败重试
9. **首字节耗时 `firstChunkAt`（新增）** (6%) ← 用 `firstChunkAt` 算 duration 显示
10. **末次耗时 `lastAttemptMs`（新增）** (6%)
11. 结束时间 `endedAt` (10%, 原 16% 缩减)
12. 结果 `outcome` (13%)

百分比重分配至总和 100%（加两列各 6%，从结束时间扣 6%）。

### 2.2 动态生成 colgroup / thead / renderTraces

- **colgroup**：删除 HTML 里的 10 个 `<col>`，改由 JS 根据 `TRACE_COLUMNS`（可见列）动态生成，宽度从配置取。
- **thead**：删除硬编码 `<tr><th>...`，JS 动态生成，可见列才出 `<th>`，带 `title` hover。
- **renderTraces**：遍历可见列调 `render()` 生成 `<td>`。
- **所有 colspan**：全部改为 `visibleColumns.length` 动态计算，根治 796/981 行的硬编码 `8` bug。
  - L457 初始加载、L796 加载失败、L829 空数据、L857 初始展开子行、L981 动态展开子行。

### 2.3 hover 说明

所有时间/耗时列的 `<th>` 加 `title` 属性，`<td>` 内容也包一层 `<span title="...">`：

- 发出时间：`客户端请求到达代理的时刻。`
- 总耗时：`从客户端请求到达到最终交付客户端的总时长，包含所有失败重试和退避等待。`
- 首字节耗时：`最后一次成功 attempt 从发出到收到首个有效 chunk 的耗时。前 N 次失败的 attempt 不计入。全失败则为空。`
- 末次耗时：`最后一次 attempt 从发出到上游响应结束的耗时。`
- 结束时间：`代理完成交付、写 trace 的时刻。`

### 2.4 列配置 UI（工具栏按钮 + 下拉面板）

- 工具栏（L421-428 的 `.toolbar`）加一个"列设置"按钮。
- 点击弹出下拉面板（绝对定位），列出所有 `TRACE_COLUMNS`：
  - 每列一个 checkbox（显隐）。
  - 每列一个宽度 input（数字，百分比）或滑块。
  - "重置默认"按钮。
- 配置存 `localStorage` key `trace-columns-config`，结构 `{ [key]: { visible, width } }`。
- 启动时读取覆盖默认值；变更后重渲染表格（调 `renderTraces(lastListCache)`）。
- 可见列宽度按配置动态生成 colgroup，未配置的用默认 `width`。

### 2.5 列宽根治：`.row` 冲突 + overflow 容器

- `.row` 类名冲突（L153-157 已有注释 + 修复）：保留 `tr.row { display: table-row }` 修复，但**更干净的做法是重命名**表格行的 class 从 `row` → `trow`，彻底消除与配置页 `.row`（L60 flex）的冲突。检查所有 `tr.row` / `querySelectorAll('tr.row')` 引用同步改名。
- 确认表格没套在 overflow 容器里（现有注释已警告，检查 L429 `<table>` 父级）。

## 三、改动文件清单

| 文件 | 改动 |
|---|---|
| `proxy/server.js` | `forwardStreaming` 抓首字节时刻；`handleRequest` attempt+trace 加字段 |
| `proxy/trace-store.js` | `summarize` 加 `firstChunkAt`/`lastAttemptMs`/attempt 级 `firstChunkMs` |
| `proxy/web/index.html` | 列配置数组、动态 colgroup/thead/renderTraces、colspan 动态化、列设置面板、hover 说明、`.row`→`.trow` 改名 |

## 四、验证

- 重试场景：配一个会重试的上游（mock 的 200-busy 或真讯飞 system busy），看首字节耗时只记成功那次。
- 全失败场景：maxAttempts 用尽仍失败，首字节列应为空。
- 列显隐：勾掉某列，表格立即不显示该列，colspan 正确不乱。
- 列宽调节：改宽度，colgroup 更新，表头数据行不错位。
- hover：鼠标悬停时间列，看到计算口径说明。
