# 阶段 2 正交场景设计 — WorkspaceManager + management API + 网页

> 日期：2026-08-03
> 任务：阶段 2，workspace 管理
> 硬约束：VS Code 形态 385 用例不破；不碰 src/ 下 VS Code 形态代码；proxy/ 转发核心不加 workspace 概念

## 设计决策（先定的点）

### Management API 端口策略

- proxy（转发）监听 `platformPort`：win32→11434 / linux→11435 / darwin→11436
- **management API 监听 `platformPort + 100`**：win32→11534 / linux→11535 / darwin→11536
  - +100 而非 +1：避开 proxy 端口附近可能的保留/冲突，且 management 是不同语义层
  - 可被环境变量 `CCP_MGMT_PORT` 覆盖（便于测试）
- management API server 由 standalone/main.js 起（http.createServer），不污染 proxy/server.js

### workspace 索引结构

存 `~/.claude-code-proxy/workspaces.json`：
```json
{ "workspaces": [ { "id": "ws_a3f2", "name": "my-project", "dir": "D:/code/my-project", "createdAt": "2026-08-03T10:00:00Z" } ] }
```
- `id`：`ws_` + 8 位随机（不依赖 Date.now/Math.random 在 workflow 脚本里受限——但这是 standalone 运行时，可用 crypto.randomBytes）
- `name`：用户给的名字（可重名？暂允许，id 唯一即可）
- `dir`：磁盘目录绝对路径
- `createdAt`：ISO 时间戳

### dir ↔ id 唯一性约束（一对一）

- **一个目录只能注册一个 workspace**：创建时检查 dir 是否已被注册（按 dir 路径归一化后比对），已注册 → 拒绝（返回错误，不创建）
- 路径归一化：`path.resolve(dir)` + 统一分隔符，避免 `D:\a\b` vs `D:/a/b` vs `D:\a\b\` 被当成不同目录
- id 全局唯一（crypto 随机，理论撞概率极低，但仍查重兜底）

### 删除 workspace 是否删磁盘文件

- **不删磁盘文件**：只从索引移除该 workspace 记录。磁盘上的 `.claude_proxy/` 和用户代码保留（用户可能只是不想让后端管了，不该删文件）。
- 删除后该 workspace 的 CLI 配置仍在磁盘但后端不再索引。重新创建同目录会重新索引（.claude_proxy/ 已存在则复用，LocalConfigStore load 时自动处理）。

### workspace 目录约束

- dir 必须存在（用户指定一个已存在的文件夹）？还是创建时自动 mkdir？
  - **dir 必须已存在**（用户指定一个真实项目目录）。不存在 → 拒绝（返回错误提示路径不存在）。这避免后端乱建目录。
  - `.claude_proxy/` 子目录由后端在创建 workspace 时 mkdir（LocalConfigStore 首次 save 时会建，但创建 workspace 时主动建更明确）

## 产物

1. `standalone/workspaceManager.js`（ESM JS）：WorkspaceManager 类 + 索引读写 + create/list/remove
2. `standalone/managementServer.js`（ESM JS）：http.createServer，路由 workspace CRUD API
3. management API 路由：
   - `GET /api/workspaces` → 列出所有 workspace
   - `POST /api/workspaces` `{name, dir}` → 创建
   - `DELETE /api/workspaces/:id` → 删除
   - `GET /api/workspaces/:id` → 查单个（含该 workspace 的 local 配置列表，复用 LocalConfigStore.load）
4. 网页：阶段 2 先做最小管理页（列出/创建/删除），不涉及配置编辑（阶段 4）。serve 方式待定（见下）

### 网页 serve 方式

- proxy/server.js 已 serve `proxy/web/index.html`（控制台）在 proxy 端口
- management 网页放哪？两个选择：
  - A. management API server 自己 serve 管理页 HTML（监听 management 端口）
  - B. 把管理页加到 proxy/web/ 控制台里（一个页面两种功能）
- **阶段 2 选 A**：management server 自己 serve 一个最小 HTML（`standalone/web/workspaces.html` 或内联），功能独立、不碰 proxy/web/。控制台（trace/统计）和管理页分离，符合"proxy 核心不被 workspace 概念污染"。

## 正交维度

### D1 workspace 索引读写

- D1a：索引文件不存在 → 列出返回空数组
- D1b：索引文件已存在 → 列出返回所有记录
- D1c：索引文件损坏 JSON → 列出不崩（返回空 + 记日志，还是抛错？**返回空 + 记日志**，不阻断管理 API）

### D2 创建 workspace

- D2a：dir 存在 + 未注册 → 创建成功（建 .claude_proxy/ + 写索引 + 返回新 workspace）
- D2b：dir 不存在 → 拒绝（错误，不创建）
- D2c：dir 已注册 → 拒绝（一对一约束）
- D2d：name 缺失/空 → 拒绝（必填）
- D2e：.claude_proxy/ 已存在（用户之前用过 claude）→ 复用，不报错（LocalConfigStore load 兼容）

### D3 删除 workspace

- D3a：id 存在 → 从索引移除（不删磁盘）
- D3b：id 不存在 → 拒绝（错误）
- D3c：删除后磁盘文件保留（.claude_proxy/ 还在）

### D4 dir 路径归一化（一对一约束的关键）

- D4a：`D:\a\b` 与 `D:\a\b\` 视为同目录（尾斜杠归一）
- D4b：`D:/a/b` 与 `D:\a\b` 视为同目录（分隔符归一）
- D4c：相对路径 `./a` resolve 成绝对后再比对
- D4d：Windows 大小写（`D:\A` vs `D:\a`）—— Windows 文件系统不区分大小写，归一化时小写化比对

### D5 management API

- D5a：GET /api/workspaces → 200 + 列表
- D5b：POST /api/workspaces 合法 → 201 + 新 workspace
- D5c：POST /api/workspaces 非法（dir 不存在/已注册/缺 name）→ 400 + 错误信息
- D5d：DELETE /api/workspaces/:id 存在 → 200
- D5e：DELETE /api/workspaces/:id 不存在 → 404
- D5f：GET /api/workspaces/:id → 200 + 单个（含 local configs）
- D5g：未知路由 → 404
- D5h：body 非 JSON → 400

### D6 id 生成

- D6a：id 格式 `ws_` + 8 位 hex
- D6b：id 全局唯一（撞概率极低但查重兜底）

### D7 索引并发写

- D7a：两个创建并发 → 都成功，索引不丢记录（原子写：读-改-写用临时文件 rename）
- D7b：创建与删除并发 → 索引一致

## 高风险维度对照

| 高风险类别 | 适用维度 | 说明 |
|---|---|---|
| 状态转换 | D2/D3 | 创建/删除索引状态 |
| 异常/错误路径 | D2b/c/d, D3b, D5c/e/g/h, D1c | 各种拒绝/错误 |
| 时序/竞态 | D7 | 索引并发写 |
| 空/null/初始态 | D1a, D2d | 空索引、缺 name |
| 幂等性 | D2c(重复创建同 dir) | 重复创建应拒绝非重复 |
| 边界输入 | D4 | 路径归一化边界 |

## 用例选取（Step 3 依据）

- D1a：索引不存在 → list 返回 []
- D1b：索引已存在 → list 返回所有
- D1c：索引损坏 → list 不崩返回 []
- D2a：dir 存在+未注册 → 创建成功 + .claude_proxy/ 生成 + 索引含新记录
- D2b：dir 不存在 → 拒绝
- D2c：dir 已注册 → 拒绝（一对一）
- D2d：name 缺失 → 拒绝
- D2e：.claude_proxy/ 已存在 → 复用不报错
- D3a：删除 id 存在 → 索引移除 + 磁盘保留
- D3b：删除 id 不存在 → 拒绝
- D4a-d：路径归一化（尾斜杠/分隔符/相对/大小写）视为同目录
- D5a-h：API 各路由 + 错误路径
- D6：id 格式 + 唯一
- D7：并发创建索引不丢（原子写）

## 范围说明

- 阶段 2 只做 workspace CRUD + 最小管理网页。**配置编辑（LLMConfig CRUD/别名）是阶段 4**，不在本阶段。
- management 网页最小化：列出/创建/删除 workspace + 显示每个 workspace 的 local 配置列表（只读）。编辑留阶段 4。
