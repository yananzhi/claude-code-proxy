# standalone 管理界面重新设计

> 范围：独立进程管理界面 `http://127.0.0.1:11544/`（`standalone/run/run-dev.sh` 启动）。
> 现状界面设计有误，本文档定义重新设计后的信息架构、命名、终端启动方式与树形结构。
> 涉及代码：`standalone/web/workspaces-html.js`（HTML 生成）、`standalone/terminalApi.js`（终端 env 构造）、`standalone/configApi.js`（配置 CRUD + 激活）、`standalone/managementServer.js`（路由）。

---

## 1. 命名（已拍板，2026-08-04）

两种 config 重新命名。**只改用户可见文案，不改代码内部字段名**（`derivedFrom`/`derivedIndex`/`modelAliases`/`CV_DERIVED_CONFIG` 等保持原样，避免大面积破坏性重命名）。

| | 新名字（用户可见） | 代码内部标识符（不改） | 本质 |
|---|---|---|---|
| **A 类·静态配置** / Static Config | 「静态配置」 | `content` + `mode`(direct/proxy)，无 `derivedFrom` | env 写真实 modelname，可代理可直连，模型写死不可运行时切换 |
| **B 类·别名配置** / Alias Config | 「别名配置」 | `derivedFrom` + `derivedIndex`(编号 N) + `modelAliases` + `derivedSnapshot` | 假 modelname 别名 `ccp-<tier>-N`，运行时可动态改真实模型，必须走代理 |

配套终端术语：
- 静态配置 new 出的终端 = **静态终端**
- 别名配置 new 出的终端 = **别名终端**

命名理由：
- 「派生配置」只描述"从父继承"的实现细节，没体现 B 类真正的价值（运行时动态切模型），且不好听。
- 「别名配置」直接对应代理侧 `modelAliases` 字段 + `rewriteModel` 机制，名实相符。
- 「静态配置」点出模型写死的本质，与「别名配置」对称。

---

## 2. 终端启动方式：统一走 env（核心改动）

### 现状（有问题）

| 终端类型 | 现状启动方式 |
|---|---|
| 静态终端（normal） | `CLAUDE_CONFIG_DIR` 指向 `.claude_proxy/`，读 settings.json（`terminalApi.js` buildTerminalEnv） |
| 别名终端（derived） | env 注入 `ANTHROPIC_BASE_URL`(代理) + `ANTHROPIC_AUTH_TOKEN` + 四档别名 env，configDir 用 per-terminal 空目录 |

静态终端依赖 settings.json，导致必须先「激活配置」写 settings.json 才能起终端——这是设计失误的根源。

### 新设计：两类终端都走 env，不再读/写 settings.json

**静态终端 env**（`buildTerminalEnv` 改造）：
```
ANTHROPIC_BASE_URL   = 上游 baseUrl（直连）或 http://127.0.0.1:<proxyPort>（代理模式）
ANTHROPIC_AUTH_TOKEN = 上游 token
ANTHROPIC_MODEL      = 真实模型名（从 content.env.ANTHROPIC_MODEL 提取）
CLAUDE_CONFIG_DIR    = per-terminal 空目录（与别名终端一致，不再指向 .claude_proxy/）
```
- 直连模式：BASE_URL = 上游真实地址，CLI 直连。
- 代理模式：BASE_URL = `http://127.0.0.1:<proxyPort>`，上游通过 `/api/upstream` 注入代理（沿用现有 `activateConfig` 的 proxy 注入逻辑，但改为起终端时注入而非激活时）。

**别名终端 env**（基本不变）：
```
ANTHROPIC_BASE_URL        = http://127.0.0.1:<proxyPort>（强制代理）
ANTHROPIC_AUTH_TOKEN      = 上游 token
ANTHROPIC_MODEL           = ccp-main-N
ANTHROPIC_DEFAULT_HAIKU_MODEL  = ccp-haiku-N
ANTHROPIC_DEFAULT_SONNET_MODEL = ccp-sonnet-N
ANTHROPIC_DEFAULT_OPUS_MODEL   = ccp-opus-N
CLAUDE_CONFIG_DIR         = per-terminal 空目录
```

### 连带影响：「激活」概念弱化/去掉

终端统一走 env 后，起终端时现场拼 env，不再依赖全局 active 配置。
- standalone 管理页里每个终端自带配置，**不需要「先激活再起终端」**。
- 「激活」动作（`activateConfig`，写 settings.json + 注入 upstream）在新设计里：
  - standalone 管理页：保留为"设为默认"弱标记（不写 settings.json），仅影响「+ 新建终端」终端组按钮的默认配置。
  - VS Code 扩展侧：保留（VS Code 里直接开终端仍需 active 配置）。
- `activateConfig` 函数本身不删（VS Code 侧仍用），但 standalone 路由改调 `markDefaultConfig`（只写标记）；起终端时按需注入 upstream。

> 已定（第 6 节决策 1）：保留"设为默认"弱标记，不写 settings.json。

---

## 3. 信息架构：树形结构

每个 workspace 节点下，**第一级只有两个标签**：「配置」和「终端」。

```
workspace 节点
├── 配置
│   ├── 静态配置：glm-5.2          [直连]   [激活/✓已激活]
│   ├── 静态配置：kimi-k2          [代理]   [激活/✓已激活]
│   │   └── ↳ 别名配置 #3  glm会话          [编辑]
│   │   └── ↳ 别名配置 #4  kimi会话         [编辑]
│   └── [+ 新建静态配置]
│
└── 终端
    ├── 🖥 [静态] glm-5.2      pid=12345   [停止]
    ├── 🖥 [静态] kimi-k2      pid=12346   [停止]
    ├── 🖥 [别名] #3 ccp-main  pid=12347   [停止]
    ├── 🖥 [别名] #4 ccp-son   pid=12348   [停止]
    └── [+ 新建终端 ▾]
```

### 与现状对比

| 点 | 现状 | 新设计 |
|---|---|---|
| 第一级分组 | "Local LLM Configs" + "Terminals"（英文，命名混乱） | **「配置」+「终端」**（中文，清爽） |
| 别名配置挂哪 | 挂在父配置下（↳ 缩进） | **仍挂在父配置下**（体现继承关系），属于「配置」组 |
| 别名终端挂哪 | 挂在别名配置节点下（分散在配置组里） | **统一挂到「终端」组**，不再散落 |
| 终端类型区分 | 仅显示 `kind`（normal/derived），不直观 | 行首明确标 **`[静态]`/`[别名]`** + 显示用的 model |
| 终端显示的 model | startedConfigName（配置名） | 静态=真实模型名；别名=别名串 `ccp-<tier>-N` |
| 「+ 新建终端」 | 单按钮，基于 active 配置 | **双入口**：终端组按钮（用默认配置）+ 配置行内按钮（指定配置，静态/别名都有） |

### 别名配置仍挂父配置下的理由

别名配置的 `derivedFrom` + `derivedSnapshot` 体现"从父继承上游"，挂在父下能直观看到继承关系。用户在「配置」组里看到的是一棵配置继承树，而非扁平列表。

### 别名终端不挂别名配置下的理由

终端是"运行实例"，不是配置的从属物。把所有终端统一放「终端」组，用户一眼看到"这个 workspace 当前跑了哪些会话"，不用在配置树里翻找。终端行已用 `[静态]`/`[别名]` + 编号标明来源配置。

---

## 4. 页面设计

### 4.1 主列表页（`/`）

```
┌──────────────────────────────────────────────────────────┐
│ Claude Code Proxy — Workspace 管理                        │
│ 代理控制台：http://127.0.0.1:11444/                       │
│                                                          │
│ 新建 Workspace                                            │
│ [名字] [磁盘目录绝对路径] [创建]                          │
│                                                          │
│ 已注册 Workspaces                                        │
│ ┌────────────────────────────────────────────────────┐   │
│ │ ▼ my-project  [ws-7a3f]                            │   │
│ │   D:/code/my-project  · 08-04              [删除]  │   │
│ │                                                    │   │
│ │  ── 配置 ──────────────────  [+ 新建配置]           │   │
│ │    · glm-5.2          [直连]  [设为默认]  [新建终端]  [+ 别名配置] │   │
│ │    · kimi-k2          [代理]  ✓默认       [新建终端]  [+ 别名配置] │   │
│ │      ↳ 别名配置 #3  glm会话         [新建终端]      │   │
│ │      ↳ 别名配置 #4  kimi会话        [新建终端]      │   │
│ │                                                    │   │
│ │  ── 终端 ──────────────────  [+ 新建终端]          │   │
│ │    🖥 [静态] glm-5.2      pid=12345  [停止]        │   │
│ │    🖥 [静态] kimi-k2      pid=12346  [停止]        │   │
│ │    🖥 [别名] #3 ccp-main pid=12347  [停止]        │   │
│ │    🖥 [别名] #4 ccp-son  pid=12348  [停止]        │   │
│ └────────────────────────────────────────────────────┘   │
│ ┌────────────────────────────────────────────────────┐   │
│ │ ▶ another-ws  [ws-9b2c]  D:/code/other    [删除]   │   │
│ └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

「+ 新建终端」终端组按钮（基于默认配置启动）+ 配置行内「新建终端」按钮（基于指定配置启动）。
两个入口调同一个起终端 API（`POST /api/workspaces/:id/configs/:cfgId/terminals`），参数来源不同：
- 终端组按钮：不传 cfgId，用 active 默认配置
- 配置行内按钮：自带 cfgId（静态/别名配置行都有「新建终端」按钮）

### 4.2 配置编辑页

#### 静态配置编辑页（`/workspace/:wsId/configs/:cfgId/edit`）

```
┌───────────────────────────────────────────────────┐
│ 配置编辑 — my-project                               │
│ 名称    [glm-5.2                                 ] │
│ 连接模式  ◉ 直连   ○ 通过代理                       │
│ settings.json content                              │
│ ┌──────────────────────────────────────────────┐  │
│ │ {                                             │  │
│ │   "env": {                                    │  │
│ │     "ANTHROPIC_BASE_URL": "https://...",      │  │
│ │     "ANTHROPIC_AUTH_TOKEN": "sk-...",         │  │
│ │     "ANTHROPIC_MODEL": "glm-5.2"             │  │
│ │   }                                           │  │
│ │ }                                             │  │
│ └──────────────────────────────────────────────┘  │
│ 直连模式：env 写真实模型名，CLI 直连上游。           │
│                          [保存]  [取消]             │
└───────────────────────────────────────────────────┘
```
- 与现状结构一致，content 可编辑。
- 文案统一：去掉"派生节点"措辞。

#### 别名配置编辑页

```
┌───────────────────────────────────────────────────┐
│ 配置编辑 — my-project                               │
│ 名称    [glm-5.2 会话                            ] │
│ 连接模式  [强制代理]  （别名配置必须走代理）         │
│                                                    │
│ 模型别名映射（即时生效）          编号 #3           │
│   Main    ccp-main-3     → [glm-5.2          ] ☐1M │
│   Haiku   ccp-haiku-3    → [glm-flash        ] ☐1M │
│   Sonnet  ccp-sonnet-3   → [                ] ☐1M │
│   Opus    ccp-opus-3     → [                ] ☐1M │
│   改映射即时生效；改 1m 需重启 CLI（别名后缀变更）。 │
│                                                    │
│ settings.json content（只读·继承父）                │
│ ┌──────────────────────────────────────────────┐  │
│ │ { ... }   (readonly)                          │  │
│ └──────────────────────────────────────────────┘  │
│                          [保存]  [取消]             │
└───────────────────────────────────────────────────┘
```
- 与现状派生编辑页结构一致。
- 文案：「派生节点」→「别名配置」；「模型别名映射」保留。

### 4.3 终端页（`/terminal/:terminalId`）

顶栏标明终端类型 + model + 连接方式。

静态终端：
```
┌─ Claude Code 终端 ─────────────────── [← 返回列表] ─┐
│ [静态] glm-5.2  ·  pid=12345  ·  直连               │
├──────────────────────────────────────────────────────┤
│ $ claude                                             │
└──────────────────────────────────────────────────────┘
```

别名终端（显示别名 + 当前映射的真实模型）：
```
┌─ Claude Code 终端 ─────────────────── [← 返回列表] ─┐
│ [别名] #3  ccp-main-3 → glm-5.2  ·  pid=12347  · 代理│
├──────────────────────────────────────────────────────┤
```

---

## 5. 改动清单（按文件）

### 5.1 `standalone/web/workspaces-html.js`（界面文案 + 结构）

- `renderWsBody`：分组标题 "Local LLM Configs" → 「配置」，"Terminals" → 「终端」。
- `buildConfigRow`：普通配置行标签去掉 `mode=direct` 显示，改用 `[直连]`/`[代理]` 徽标；派生配置行前缀「↳ 别名配置 #N」取代「↳ {name} [mode=proxy] #N」+ `derived` 标签。
- `buildTerminalRow`：行首加 `[静态]`/`[别名]` 标签；显示 model 从 `startedConfigName` 改为「静态=真实模型名 / 别名=ccp-<tier>-N」。
- 别名终端从「挂在别名配置节点下」改为「统一挂到终端组」：`buildDerivedConfigRow` 不再异步加载终端子节点；`renderWsBody` 的终端组改为加载全部终端（含别名终端），按类型标记。
- 「+ 新建终端」双入口：终端组单按钮（用默认配置）+ 配置行内「新建终端」按钮（静态/别名配置行都有）。
- 「+ 新建配置」→ 「+ 新建配置」；"+ 派生"按钮 → "+ 别名配置"。
- 配置编辑页文案：「派生节点」→「别名配置」；hint 不再提"写入 settings.json"（终端走 env）。

### 5.2 `standalone/terminalApi.js`（终端统一走 env）

- `buildTerminalEnv` 静态配置分支：改为注入 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL` env，`CLAUDE_CONFIG_DIR` 用 per-terminal 空目录，不再依赖 settings.json。
- 代理模式的静态终端：起终端时调 `/api/upstream` 注入上游（复用 `configApi.proxyForward`），BASE_URL 指向代理。
- 别名终端分支：基本不变。

### 5.3 `standalone/configApi.js` / `standalone/managementServer.js`（激活弱化）

- standalone 起终端路由：不再调 `activateConfig` 写 settings.json；改为直接 `buildTerminalEnv` 拼 env 起终端。
- 「激活」路由：`activateConfig` 函数保留（VS Code 侧用），但 standalone 路由改调 `markDefaultConfig`（只写 `LocalActiveStateStore` 标记，不写 settings.json/不注入 upstream/不碰 permissions/gitignore）。
- UI：「激活」/「✓已激活」→「设为默认」/「✓ 默认」。
- 错误信息文案：`checkDerivedForAlias` 的"仅派生节点"→"仅别名配置"。

### 5.4 不改的部分

- 代码内部字段名：`derivedFrom`/`derivedIndex`/`modelAliases`/`sessionContext1m`/`derivedSnapshot`/`CV_DERIVED_CONFIG` 等全部保持。
- 代理侧：`proxy/server.js`、`proxy/config-store.js`、`rewriteModel`、`modelAliases` 表、`nextAliasId` 不变。
- `src/derivedLogic.ts` 纯逻辑不变。
- VS Code 扩展侧（`src/claudeLauncher.ts`、`src/treeProvider.ts`）不在本次范围（可后续同步文案）。

---

## 6. 已定决策（2026-08-04 拍板）

1. **「激活」概念 → 保留弱标记，不写 settings.json。**
   - `LocalActiveStateStore` 语义从"激活写文件"降级为"默认配置标记"，仅影响「+ 新建终端」终端组按钮的默认配置（多配置时直接点「+ 新建终端」用默认那个，不用在配置行指定）。
   - **不再写 settings.json、不再注入 upstream**（upstream 注入改到起终端时按需做）。
   - `activateConfig` 函数保留（VS Code 侧仍用），standalone 路由不再调用它的写文件逻辑；standalone 的"激活/设为默认"路由改为只写 `LocalActiveStateStore` 标记。
   - UI：保留「设为默认」/「✓默认」按钮（原「激活」/「✓已激活」改文案），但无文件副作用。

2. **起终端入口 → 两者共存。**
   - 配置行内保留「新建终端」按钮（点某个具体配置直接起终端，意图明确、一步到位）；**静态配置行也加该按钮**（现已实现，静态/别名配置行都有）。
   - 终端组的「+ 新建终端」按钮作为"总入口"（用默认配置起终端，不选具体配置）。
   - 两个入口调同一个起终端 API（`POST /api/workspaces/:id/configs/:cfgId/terminals`），参数来源不同：行内按钮自带 cfgId；终端组按钮不传 cfgId 用 active 默认。

3. **别名终端顶栏真实模型 → 读本地 `config.modelAliases`（经 management 路由与代理同步）。**
   - 终端页打开时，`GET /api/terminals/:tid/alias-resolve` 读本地 config 的 `modelAliases`（本地权威）。
   - 本地 modelAliases 经 management alias 路由（`POST /api/.../alias` + `POST /api/.../alias/delete`）与代理双向同步：代理成功后回写本地。
   - 映射变更是低频事件，不做 push；下次刷新终端页或重连 WS 时更新即可。
   - 注：不直接查代理 `GET /api/model-alias` 是为避免代理往返 + 保持本地/代理一致性（management 路由是唯一入口）。

---

## 7. 验收标准

- [x] 主列表页每个 workspace 下只有「配置」「终端」两个一级标签。
- [x] 所有终端（静态 + 别名）统一显示在「终端」组，行首标 `[静态]`/`[别名]`。
- [x] 别名配置仍挂在父静态配置下（↳ 缩进），标签为「别名配置 #N」。
- [x] 起任何终端都不再读/写 settings.json，env 现场拼。
- [x] 静态终端可直连、可代理；别名终端强制代理。
- [x] 「+ 新建终端」终端组按钮用默认配置；静态/别名配置行都有「新建终端」按钮指定配置。
- [x] 别名配置编辑页改映射即时生效（代理侧 `modelAliases` 更新）+ 回写本地，终端页顶栏读本地反映当前映射。
- [x] 全站文案无"派生/derived/Local LLM Configs"残留（用户可见处，含错误信息）。
- [x] 现有测试套件（`test/standalone/`）适配后全绿；新增终端统一走 env 的覆盖测试。
- [ ] e2e 套件（`test/e2e/`）覆盖第 8 节列出的关键行为，`npm run test:e2e` 全绿。

---

## 8. 测试策略：Playwright 薄 e2e（已定，2026-08-04）

引入 Playwright 作为**独立 e2e 套件**，不混进现有 `node --test` 体系。

### 8.1 基建

- 依赖：`@playwright/test`（devDependency），装 chromium 即可（不装 firefox/webkit）。
- 目录：`test/e2e/`，配置 `playwright.config.ts`（放工程根或 `test/e2e/`）。
- 命令：`npm run test:e2e`（新增 script），**不进现有全量测试命令**（`node --test --test-concurrency=1 ...`），避免 CI 必须装浏览器。
- 启动方式：e2e 套件自己起 standalone 子进程（复用 `test/standalone/` 起 server.js 子进程的模式，CCP_HOME 用临时目录、端口避开 11434/11444/11544），测试结束 teardown。

### 8.2 薄 e2e 覆盖范围（只断言重设计关键行为）

| 用例 | 断言 |
|---|---|
| 树形结构 | workspace 下只有「配置」「终端」两个一级标签；别名配置挂父配置下、标「别名配置 #N」 |
| 终端归类 | 所有终端（静态+别名）统一在「终端」组，行首 `[静态]`/`[别名]` 标签 |
| 起静态终端不写 settings.json | 起终端前后断言 `.claude_proxy/settings.json` 不存在（或内容未变） |
| 配置行内新建终端 | 静态配置行有「新建终端」按钮，点击起终端 |
| 终端组按钮 | 「+ 新建终端」按钮用默认配置起终端 |
| 配置编辑页文案 | 静态/别名编辑页无"派生/derived/Local LLM Configs"残留 |
| 别名终端顶栏实时映射 | 改别名配置映射 → 刷新终端页 → 顶栏「ccp-xxx-N → 真实模型」反映最新映射 |
| 默认配置弱标记 | 「设为默认」只写标记不写 settings.json |

### 8.3 不做（手动验证，沿用现有约定）

- xterm 真实 IO / PTY 交互（CLAUDE.md 明确"真实 PTY/conpty 集成手动验证不进套件"）。
- WebSocket 双向流的完整对话流。
- 真实 LLM 上游调用（继续用 mock 上游，不依赖真实 LLM）。

### 8.4 与现有测试的边界

- `node --test`（现有）：API 级、纯逻辑、配置层。继续跑，适配重设计后的 API 变化（如起终端路由参数、激活路由语义变化）。
- `test/e2e/`（新）：DOM 渲染、用户可见行为、跨页面交互。Playwright 独占。
- 两者不交叉：e2e 不重复 API 级断言，`node --test` 不碰 DOM。
