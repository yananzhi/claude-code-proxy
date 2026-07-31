# Claude Code CLI 运行时 Model 切换方案

> 状态：设计草案。本文只讲清「要达到什么、切换什么、采取什么方案」，不含实现。

---

## 1. 运行时切换：目标行为规格

### 1.1 功能定义

提供一个**模型重路由**能力：在 Claude Code CLI 会话存活期间，由外部配置变更决定该会话后续请求所命中的真实 LLM 模型，且变更对 CLI 进程透明。

### 1.2 行为约束（精确规格）

| 维度 | 规格 |
|---|---|
| 触发方式 | 代理侧配置变更（非 CLI 侧命令） |
| 生效时机 | 下一次出站请求即生效（无需等待当前请求完成外的任何同步点） |
| 生效范围 | 该代理实例服务的全部请求流（受代理单例作用域约束，见 §4） |
| CLI 感知 | 无——CLI 进程的环境变量与会话状态在切换前后保持不变 |
| 重启要求 | 无——不重启 CLI、不 reload window、不重发 `/model` |
| 切换粒度 | 按"模型档位"独立切换（档位定义见 §2），档间互不影响 |
| 切换可逆性 | 可逆——同一档位可反复变更目标模型，无累积副作用 |

### 1.3 与 CLI 内置 `/model` 的职责边界

`/model` 是 CLI 内置的主对话模型切换命令，其作用域与机制与本方案不同：

| | `/model`（CLI 内置） | 本方案 |
|---|---|---|
| 切换对象 | 主对话模型（`ANTHROPIC_MODEL`） | 子任务档位模型（`ANTHROPIC_DEFAULT_*_MODEL`，见 §2） |
| 触发者 | CLI 侧用户命令 | 代理侧配置 |
| CLI 是否感知 | 是（CLI 改自身状态） | 否（CLI 无感） |
| 覆盖的请求 | 主对话流 | 子 agent / 后台任务等档位请求 |

两者**并存且不重叠**：`/model` 管主对话，本方案管档位子任务。本方案不替代、不干扰 `/model`。

### 1.4 本方案不实现的行为

- **请求内中途换模型**：单个请求一旦发出，其目标模型在本次往返内固定，不在推理过程中切换。
- **按子 agent 实例粒度换模型**：本方案粒度为"档位"，同一档位的所有子 agent 共用同一目标模型，不区分单个子 agent 实例（见 §4 边界）。


---

## 2. 切换对象：档位模型

### 2.1 CLI 的模型配置入口

Claude Code CLI 通过下列环境变量声明各路请求使用的模型：

| 环境变量 | 语义 | 运行时可切换性 |
|---|---|---|
| `ANTHROPIC_MODEL` | 主对话流模型 | CLI 内置 `/model` 可换（CLI 侧状态变更） |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | haiku 档目标模型 | CLI 无切换命令 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | sonnet 档目标模型 | CLI 无切换命令 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | opus 档目标模型 | CLI 无切换命令 |

CLI 内部按"档位"路由模型：子任务（子 agent / 后台轻量任务）调用时声明所属档位，CLI 将档位解析为对应 `ANTHROPIC_DEFAULT_*_MODEL` 的值，填入请求体 `model` 字段后发出。

### 2.2 本方案的切换对象

| 项 | 规格 |
|---|---|
| 切换对象 | haiku / sonnet / opus 三个档位 |
| 档间独立性 | 三档各自独立配置与切换，互不影响 |
| 设计约束 | 不得将"三档相同"硬编码为唯一形态；须按三档各自独立映射设计，支持三档指向不同真实模型 |
| 主模型归属 | `ANTHROPIC_MODEL` 不纳入本方案，走 `/model`（见 §3.3） |

**职责划分**：主对话模型由 `/model` 管；三档子任务模型由本方案管。两套机制作用域不重叠。

---

## 3. 方案：代理层 Model Aliasing

### 3.1 机制

在 CLI 与真实 LLM 之间引入一层**模型名重写**：

1. CLI 的 `ANTHROPIC_DEFAULT_*_MODEL` 环境变量配置为**固定的别名（alias）**，而非真实模型名。别名在 CLI 进程生命周期内不变。
2. 代理接收出站请求时，依据内存中的**别名映射表**将请求体 `model` 字段的别名替换为真实模型名，再转发至上游。
3. "切换模型" = 变更映射表中某别名指向的真实模型名。CLI 状态零变更，下个请求即生效。

### 3.2 配置规格

> ⚠️ 本节是**单会话简化版**：别名不带编号、写进 settings.json。**§6 派生节点方案落地后，别名改走 shell env、按会话编号区分（`ccp-sonnet-N`），本节的"写 settings.json + 无编号"做法废弃，不与 §6 并存。** 本节保留只为说明机制原理；实际实现以 §6 为准。

**CLI 侧（固定，写入 settings.json）：**

| 环境变量 | 值 | 说明 |
|---|---|---|
| `ANTHROPIC_MODEL` | 真实模型名 / 留空 | 主对话，走 `/model`，不入 alias（见 §3.3） |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `ccp-haiku` | haiku 档别名 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `ccp-sonnet` | sonnet 档别名 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `ccp-opus` | opus 档别名 |

**代理侧（可热更新）：别名映射表**

| 别名 | 目标真实模型 |
|---|---|
| `ccp-haiku` | `<haiku 档真实模型>` |
| `ccp-sonnet` | `<sonnet 档真实模型>` |
| `ccp-opus` | `<opus 档真实模型>` |

**转发替换规则**：请求体 `model` 命中映射表别名 → 替换为真实模型名；未命中 → 原样透传并记日志。

### 3.3 `ANTHROPIC_MODEL` 不入 alias 的理由

| 若 `ANTHROPIC_MODEL` 也配别名 | 后果 |
|---|---|
| 用户经 `/model` 切换主模型 | CLI 改写 `ANTHROPIC_MODEL` 为真实档位名，请求 `model` 字段不再等于别名，替换规则失配 |

**结论**：`ANTHROPIC_MODEL` 配真实模型名（或留空用 CLI 默认），使 `/model` 正常工作；仅三档 `DEFAULT_*` 配别名走 alias。两套机制作用域分离，互不干扰。

### 3.4 热更新接口规格

| 项 | 规格 |
|---|---|
| 存储 | 映射表驻留代理进程内存；可持久化至 `globalStorage` 供重启恢复 |
| 变更通道 | HTTP 接口，复用现有 `POST /api/upstream` 模式（`proxy/server.js` L378） |
| 接口 | `POST /api/model-alias` |
| 请求体 | `{ "alias": "ccp-sonnet", "model": "claude-sonnet-5" }` |
| 生效时机 | 写入内存映射表后立即对下一请求生效 |
| 调用方 | VS Code 扩展侧 UI 入口 |

### 3.5 实现落点

代理转发主路径位于 `proxy/server.js`。该路径已在转发前 `JSON.parse` 请求体并提取 `model` 字段（L554-562），且存在请求体改写先例 `rewriteEffort`（L568-570）：

```js
const outBody = (effortLevel && isMessagesMain)
  ? rewriteEffort(body, effortLevel, id, req.headers['content-type'])
  : body;
```

新增并列函数 `rewriteModel`，与 `rewriteEffort` 串联：

```js
// 伪代码，非最终实现
let outBody = (effortLevel && isMessagesMain) ? rewriteEffort(...) : body;
outBody = rewriteModel(outBody, modelAliasMap, id, req.headers['content-type']);
```

`rewriteModel` 行为：解析请求体 → 若 `model` 命中别名映射表则替换 → 重新序列化；未命中则原样返回。复用 `rewriteEffort` 的 parse/serialize 容错模式。

### 3.6 替换规则安全边界

出站请求的 `model` 字段取值不止三档别名，可能包括：

- 主对话请求的 `ANTHROPIC_MODEL` 值（或 `/model` 切换后的真实档位名）；
- 后台任务、`count_tokens` 等子路径请求的其他值。

**约束**：替换规则须为**白名单式**——仅当 `model` 命中别名集合（`ccp-haiku`/`ccp-sonnet`/`ccp-opus`）时替换；其余一律原样透传并记日志。禁止"未识别即替换"语义，避免误改主对话或其他请求的目标模型。

---

## 4. 范围与边界

### 本方案覆盖

- haiku / sonnet / opus 三档模型的运行时切换，三档独立。
- 代理层 alias 替换 + 热更新接口 + UI 入口。

### 本方案不覆盖

- 主对话模型（`ANTHROPIC_MODEL`）——走 `/model`，不纳入 alias。
- "不同子 agent 用不同模型"的细粒度需求——本方案是**按档**换，不是按子 agent 换。同一档的所有子 agent 共用一个假名，一换全换。（若未来要按子 agent 粒度，需在 CLI 侧给不同子 agent 配不同假名，是另一套工作。）
- 全局单例代理的并发串味问题（见 `docs/pitfall-proxy-shared-upstream.md`）——换映射表是全局生效，所有走代理的会话一起换。这是已知架构限制，本方案不解决。

### 待验证的前提

`ANTHROPIC_MODEL` 与三档的关系本文按"主对话独立于三档"假设（§3.3）。若实际 CLI 行为是 `ANTHROPIC_MODEL` 内部解析到某档，则主对话与该档共用映射，需调整。验证方法：把三档配成**不同**假名，开子 agent 观察请求 `model` 字段，确认档位与假名对应关系。此项在实现前需先做。

---

## 5. 并行 CLI 会话的独立模型切换

### 5.1 背景

§3 的方案存在一个隐含约束：别名（`ccp-haiku`/`ccp-sonnet`/`ccp-opus`）写在 Workspace Local LLM Config 中，由该 config 启动的 CLI 会话共享同一套别名；而代理层映射表是全局单例（一份）。由此产生耦合：

- 多个并行 CLI 会话若由**同一** Workspace Local LLM Config 启动，它们向代理发出请求时携带**相同的**别名；
- 代理映射表 `ccp-sonnet → 真实模型` 只能指向一个真实模型；
- 会话 A 欲将子 agent 模型切至 Opus、会话 B 欲切至 Sonnet 时，二者在代理映射表上**冲突**，表现为 last-write-wins，无法各自独立。

### 5.2 期望能力

每个 Claude CLI 会话**独立**地、**在线**地变更自身子 agent 所用模型，并行会话间互不干扰。

### 5.3 已验证：CLI 配置读取机制（源码调研）

调研对象：`D:\work_dir\Claude_Code-_Source_Code`。下列结论均有代码证据支撑。

**结论 A：CLI 运行时重读 settings.json，不启动时读一次。**

- `utils/settings/changeDetector.ts` 用 chokidar 监听所有 settings 文件（`main.tsx:422` 初始化）。
- `settingsCache.ts` 有三层缓存，文件变更触发 `fanOut()` → `resetSettingsCache()` 清空，下次读从磁盘重载。
- 模型解析函数 `getDefaultSonnetModel()` 等（`utils/model/model.ts:105-134`）每次调用直接读 `process.env.ANTHROPIC_DEFAULT_*_MODEL`，不缓存。

**结论 B：settings.json 的 env 字段优先级高于 shell 环境变量。**

- `applyConfigEnvironmentVariables()`（`utils/managedEnv.ts:187-190`）用 `Object.assign(process.env, filterSettingsEnv(settings.env))` 覆盖式写入，后写者赢。
- 启动时序：shell env 先进 `process.env` → settings.env 后覆盖。
- 优先级：`settings.json.env` > `shell 环境变量` > 内置默认。

| 配置组合 | 最终读到 |
|---|---|
| 只有 shell | shell 值 |
| 只有 settings.env | settings.env 值 |
| 两者都有 | **settings.env 值** |
| 都没设 | 内置默认 |

**结论 C：settings.env 的运行时变更是 additive-only（可加、可覆盖、不可删）。**

源码注释（`state/onChangeAppState.ts:163`）："This is additive-only: new vars are added, existing may be overwritten, nothing is deleted"。

- 运行中往 settings.env **加**变量 → `Object.assign` 覆盖对应 shell 值。
- settings.env 里**没有**的变量 → shell 值不受影响。
- 运行中从 settings.env **删**变量 → `process.env` 里该 key **删不掉**，保留旧值（`Object.assign` 不删 key）。

**结论 D：纯 shell 环境变量启动 CLI 完全可行，不要求 settings.json。**

- settings.json 不存在 → `parseSettingsFile` 返回 `{ settings: null, errors: [] }`，ENOENT 仅 debug 日志不报错。
- `loadSettingsFromDisk` 返回 `{ settings: {}, errors: [] }`，`getInitialSettings()` 返回 `{}`。
- `applyConfigEnvironmentVariables()` 中 `filterSettingsEnv(undefined)` 返回 `{}`，`Object.assign(process.env, {})` 是 **no-op**。
- `process.env` 只剩 shell 继承值，模型函数直接读到 shell 值。CLI 正常运行，无强制要求 settings.json 之处。

### 5.4 推论：shell env 注入的别名在运行中冻结

由结论 B + C + D 推出：若别名经 **shell 环境变量**注入（而非 settings.env），且 settings.env 中**不含同名 key**，则：

- 别名进 `process.env` 是进程启动快照，CLI 运行中不主动重读 shell env。
- settings.env 不含该 key → `Object.assign` 是 no-op → chokidar 重读 settings 也读不到同名 key → 别名**不受任何文件监听影响**，运行中冻结。

即"每会话专属别名"成立，但**别名侧须走 shell env、不可走 settings.env**——否则会被运行时重读 / additive 覆盖机制干扰。

> ⚠️ **TODO 第 1 项（待用户协助验证）**：§5.3-5.4 的结论是源码静态调研推出的，但"shell env 别名运行中冻结"这个核心前提**未经运行时实证**。整个方案依赖它，若假设错误则后续全白搭。需用户协助跑下列验证用例（自动化做不了，要人启 CLI 会话观察）：
>
> 1. **别名冻结验证**：用一个走代理的 CLI 会话，别名 `ANTHROPIC_DEFAULT_SONNET_MODEL=ccp-sonnet-test1` 经 shell env 注入（settings.json 的 env **不含**此 key）。会话起来后，经代理控制台改 `ccp-sonnet-test1` 指向的模型 → 观察后续请求是否走新模型（走新值=代理替换生效；若 CLI 报 model not found 则别名被某处改了）。
> 2. **不被 settings 重读干扰验证**：同一会话运行中，**往 settings.json 的 env 里加** `ANTHROPIC_DEFAULT_SONNET_MODEL=别的值` → 观察 CLI 后续请求的 `model` 字段（经代理 trace 看）是否仍是 `ccp-sonnet-test1`（是=别名未被 settings 覆盖、冻结成立；变了=settings.env 覆盖了 shell env、冻结不成立、§5.4 推论错）。
> 3. **删不掉验证**：运行中从 settings.env 删一个变量，确认 process.env 保留旧值（additive-only，结论 C）。
>
> 这三项验证通过，§5.4 前提才成立，才可进入实现。列为实现前第一道闸。

### 5.5 定案：纯 shell env 每会话专属别名

基于 §5.3 / §5.4，并行会话独立切换采用下列方案，替代 §3 的"别名写进 Workspace Local LLM Config"路径。

**机制**：每个 CLI 会话启动时，经 shell 环境变量注入**该会话专属且唯一**的别名；别名运行中冻结；切换模型只动代理映射表，不动 CLI 侧。

**会话级注入**（launcher `createTerminal` 的 `env` 选项，进程级）：

| 环境变量 | workspace A 的会话值 | workspace B 的会话值 |
|---|---|---|
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `ccp-haiku-<N_A>` | `ccp-haiku-<N_B>` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `ccp-sonnet-<N_A>` | `ccp-sonnet-<N_B>` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `ccp-opus-<N_A>` | `ccp-opus-<N_B>` |

`<N>` 为会话专属编号（全局唯一递增整数）。各 workspace 各自起会话，各持独立编号与别名，代理映射表各持独立条目。

> **编号来源（澄清）**：编号 N **全局唯一递增、永不回收**——由共享代理进程的 `nextAliasId` 计数器分配（持久化进 `proxy-config.json`，跨 workspace、跨代理重启不重号，详见 §6.2 P2 修订）。不是按 workspace 分配、不回收。理由：回收会复用旧号，若旧会话终端残留请求命中新会话映射会静默改路由。全局递增最简单、最安全。异常情况（窗口打开但无 workspace）不分配编号——无 workspace 则无法起隔离会话（launcher 依赖 workspaceRoot，§6.5），无编号需求。

**代理映射表（每会话每档一条）**：

| 别名 | 目标真实模型 |
|---|---|
| `ccp-sonnet-<idA>` | `<会话 A 的 sonnet 档真实模型>` |
| `ccp-sonnet-<idB>` | `<会话 B 的 sonnet 档真实模型>` |

会话 A 欲切 sonnet 档至 Opus → 改 `ccp-sonnet-<idA>` 一行；会话 B 不受影响。在线切换、CLI 无感。

**关键约束**：

- **别名侧不写 settings.env**——不往 `.claude_proxy/settings.json` 的 `env` 字段写 `ANTHROPIC_DEFAULT_*_MODEL`，避免被运行时重读 / additive 覆盖干扰（§5.4）。
- **别名一次写定、运行中冻结**——切换只改代理映射表。
- **`ANTHROPIC_MODEL` 仍走 `/model`**（§3.3），不注入专属别名。
- launcher 现有 `env: { CLAUDE_CONFIG_DIR: configDir }` 进程级注入机制可直接扩展，追加三个 `ANTHROPIC_DEFAULT_*_MODEL`。

**映射表生命周期**：会话关闭后其专属别名条目**不回收**——编号 N 递增不复用，避免旧会话残留请求命中新会话映射导致静默改路由（与 §6.9 一致）。代理需能区分按会话的映射条目与全局共享条目。

### 5.6 与 §3 / §6 方案的关系

三套别名机制的关系（自洽性修订）：

- **§3**（别名写 settings.json、无编号 `ccp-sonnet`）：单会话简化版，仅说明机制原理。
- **§5.5**（纯 shell env、每会话编号别名 `ccp-sonnet-N`）：本方案的会话独立切换路径。
- **§6**（派生虚拟节点）：**§5.5 的具体落地实现**——派生节点带编号 N、别名走 shell env、映射表按会话分区，正是 §5.5 描述的机制。

**落地取舍**：§6 派生节点方案落地后，**§3 的"写 settings.json + 无编号"做法废弃**（别名必须走 shell env 才能运行中冻结，§5.4），二者不并存。§3 仅作为原理说明保留。实现直接落 §6，无需先落 §3 再迁移。代理层是同一套替换机制（白名单命中即替换），区别仅在别名是否带编号、走 shell env 还是 settings.env。

### 5.7 已验证：memory / skill 的加载依赖（源码调研）

调研对象：`D:\work_dir\Claude_Code-_Source_Code`。本节回答"纯 env 启动、不写 settings.json"会不会让 memory / skill 失效。

**结论 E：memory / skill 不依赖 settings.json，只依赖 CLAUDE_CONFIG_DIR 的目录结构。**

- settings.json 不存在时，`getInitialSettings()` 返回 `{}`，所有相关检查（`autoMemoryEnabled`、`pluginOnly`、`isSettingSourceEnabled`）走默认值，默认值全是"启用"。
- memory、user 级 skill 的路径均从 `CLAUDE_CONFIG_DIR` 派生（`utils/envUtils.ts:9` 的 `getClaudeConfigHomeDir()`）。

**结论 F：memory / skill 路径均从 CLAUDE_CONFIG_DIR 派生，且不回退 `~/.claude/`。**

| 功能 | 路径派生 | 文件:行号 |
|---|---|---|
| memory baseDir | `CLAUDE_CONFIG_DIR`（或 `CLAUDE_CODE_REMOTE_MEMORY_DIR` 覆盖） | `memdir/paths.ts:85-90` |
| memory 实际目录 | `<configDir>/projects/<sanitized-git-root>/memory/`（**不是** `<configDir>/memory/`） | `memdir/paths.ts` |
| user 级 skill | `<configDir>/skills/<name>/SKILL.md`（目录格式，非裸 .md） | `skills/loadSkillsDir.ts:640` |
| project 级 skill | 从 CWD 向上找 `.claude/skills/`（**与 CLAUDE_CONFIG_DIR 无关**） | `skills/loadSkillsDir.ts` |

`getClaudeConfigHomeDir()` 只返回一个值（`CLAUDE_CONFIG_DIR` 或 `~/.claude`），**无回退机制**——`CLAUDE_CONFIG_DIR` 指哪就只看哪，不会回落到 `~/.claude/`。

**结论 G：无独立 `CLAUDE_MEMORY_DIR` / `CLAUDE_SKILLS_DIR` env，但有其他解耦手段。**

| 手段 | 覆盖什么 | 来源 |
|---|---|---|
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env | memory 全路径 | `memdir/paths.ts:161` |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` env | memory baseDir | `memdir/paths.ts:86` |
| settings.json `autoMemoryDirectory` 字段 | memory 目录（仅受信任来源） | `memdir/paths.ts:179` |
| `--add-dir <dir>` 启动参数 | 额外 skill 目录（含 `.claude/skills/`） | `loadSkillsDir.ts:649` |
| `--plugin-dir` 启动参数 | 插件 skill（不依赖 config dir） | `main.tsx:945` |

**结论 H：skill 列表是启动快照 + 运行时动态发现。** `getSkillDirCommands()` 被 memoize 缓存（`loadSkillsDir.ts:638`）；另有 `discoverSkillDirsForPaths()` 在文件操作触及某路径时动态发现并加入 `dynamicSkills`。

### 5.8 取舍：config dir 共享 vs 每会话独立

§5.5 定了"每会话专属别名走 shell env"，但未明确 `CLAUDE_CONFIG_DIR` 是共享还是每会话独立。由结论 F（不回退 `~/.claude/`）知：若每会话独立 config dir，则 memory / user 级 skill 需各自塞一份，否则各自为空。两条路：

**路 A：config dir 共享，会话独立只靠 shell env（推荐）**

- 所有会话用同一 `CLAUDE_CONFIG_DIR`（指向一个含完整 `skills/`、`projects/<path>/memory/` 的目录）。
- memory / skill / history 天然共享，无需各塞一份。
- 会话独立性别名靠 shell env（启动快照、冻结、互不干扰，§5.4）。
- 职责分离：config dir 管"共享"，shell env 管"会话独立别名"。最干净。

**路 B：每会话独立 config dir + env/参数把 memory/skill 指回共享源**

- 每会话独立 `CLAUDE_CONFIG_DIR`（连 settings、history 都各会话独立）。
- 用 `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 把 memory 指回共享位置；用 `--add-dir` 把 skill 指回共享 `.claude/skills/`。
- 隔离更彻底，但启动参数更繁、需维护共享源路径。

**选定路 A**：会话真正需要"独立"的只有模型别名（靠 shell env 冻结），其余共享更省事。`CLAUDE_CONFIG_DIR` 共享一份，alias 靠 env 分会话。§5.5 的会话级注入表不变，仅明确 config dir 不按会话区分。

### 5.9 启动规格汇总（路 A）

launcher 启动一个会话时注入的 env（`createTerminal` 的 `env` 选项）：

| 环境变量 | 值 | 说明 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `<共享 config dir>` | 所有会话共用，含 skills / memory |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `ccp-haiku-<sessionId>` | 本会话专属别名，走 shell env（冻结） |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `ccp-sonnet-<sessionId>` | 本会话专属别名，走 shell env（冻结） |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `ccp-opus-<sessionId>` | 本会话专属别名，走 shell env（冻结） |

**三档别名走 shell env**（§5.4 冻结前提）。**`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 走 settings.json env**（沿用 `synthesizeProxySettings`），不进 shell env——避免 token 出现在进程列表（安全），且 settings.env 不含三档别名同名 key，不影响别名冻结（§6.6 P4 修订）。`ANTHROPIC_MODEL` 留给 `/model`（§3.3）。

> 注：本节是会话级 env 注入的规格骨架，实际启动流程见 §6.5 `launchDerived`（继承父上游快照 + 别名 env + BASE_URL/token 走 settings.env）。

---

## 6. UI 与实现设计：派生虚拟配置节点

### 6.1 概念

在 `workspace_local_llm_config` 下，每条 local 配置可派生出若干**虚拟配置节点**（derived node）。派生节点：

- **继承**父 local 配置（复用其上游 baseUrl/token/timeout/proxy 设置），只覆盖"三档模型映射"。
- 拥有**专属编号** `N`（全局唯一递增），对应别名 `ccp-haiku-N` / `ccp-sonnet-N` / `ccp-opus-N`。
- 有自己的 webview 配置页，可配置三档别名 → 真实模型。
- 节点上有"启动 terminal"按钮；在该节点启动的 CLI 会话受该节点的别名映射控制。

派生节点是"会话配置"的一等公民：可命名、可留存、可重开。一个父配置下可挂多个派生节点（对应多个并行会话）。

### 6.2 数据模型扩展

`src/types.ts` 的 `LLMConfig` 增加可选字段：

```typescript
export interface ModelAliasMapping {
    haiku?: string;   // ccp-haiku-N → 真实模型名（如 'claude-haiku-4-5-20251001'）
    sonnet?: string;  // ccp-sonnet-N → 真实模型名
    opus?: string;    // ccp-opus-N → 真实模型名
}

/** 派生节点创建时存的父上游快照（防继承断链，§6.5 P1） */
export interface DerivedSnapshot {
    baseUrl: string;
    token: string;
    timeoutSec?: number;
    mode: ConfigMode;
}

export interface LLMConfig {
    id: string;
    name: string;
    content: string;
    mode?: ConfigMode;
    updatedAt: string;
    // —— 派生节点字段（仅派生节点有）——
    derivedFrom?: string;          // 父 local 配置 id
    derivedIndex?: number;         // 专属编号 N（全局唯一，权威在代理 nextAliasId）
    modelAliases?: ModelAliasMapping;  // 三档别名 → 真实模型（本地缓存，权威在代理）
    derivedSnapshot?: DerivedSnapshot;  // 父上游快照（防父被删/改导致继承断链）
}
```

派生节点仍存进 `local-configs.json`（与父 local 配置同数组，靠 `derivedFrom` 区分）。`LocalConfigStore` 的 load/save/upsert/remove/get 无需改（新字段自然序列化）。新增方法：

- `getDerivedByParent(parentId): LLMConfig[]` — 取某父配置下所有派生节点。
- `nextDerivedIndex(): number` — 本地兜底（扫已存派生节点 derivedIndex 取 max+1），**权威编号向代理申请**（见下）。

**编号全局唯一性与持久化（修 P2）**：编号 N 必须跨窗口、跨代理重启全局唯一。代理进程**无法访问 VS Code globalStorage**（它是 ESM 模块，只接收 `startServer({configPath, logsDir, logsConfigPath})`），故计数器只能落代理已有的 `proxy-config.json`：

- 顶层新增字段 `nextAliasId: number`，`configStore.init`（`config-store.js:36-45`）时读出（老文件无此字段需兜底 `?? 0`）。
- `nextAliasId()`：`++config.nextAliasId` + `persist()`。
- **启动校正**：`init` 完成后扫 `config.modelAliases` 的 key（形如 `ccp-sonnet-N`）取 max N，若 `max ≥ nextAliasId` 则抬 `nextAliasId = max+1`（防御旧数据/手动编辑/代理重启后计数器与已存映射不一致）。
- webview 创建派生节点时 `POST /api/model-alias/next-id` 向代理申请，拿到 N 再本地落 `local-configs.json`。

这样代理重启（心跳接管 / `/api/kill` / EADDRINUSE）不丢计数器，不会重号覆盖旧会话映射。

### 6.3 树视图扩展

`src/treeProvider.ts`：

- 新增 `CV_DERIVED_CONFIG = 'derived-config'`。
- 父 local 配置节点 `collapsibleState` 改为 `Collapsed`/`Expanded`（有派生子节点时可展开）。
- `getChildren`：当展开一个 `local-config` 节点时，返回其下派生节点（`getDerivedByParent(cfg.id)`）。
- 新增 `buildDerivedNode(cfg)`：

```
workspace_local_llm_config
  ▼ glm-5.2 (Volc)  [直连 · local]  [+派生] [edit] [del]
      ▶ glm-5.2 #1   [派生 · S:sonnet-5]   [▶启动] [edit] [del]
      ▶ glm-5.2 #2   [派生 · S:opus-4]     [▶启动] [edit] [del]
  ▶ sonnet-4 (proxy) [代理 · local]  [+派生] [edit] [del]
```

派生节点 description 显示当前映射摘要 `S:sonnet-5 · H:haiku-4 · O:opus-4`；tooltip 显示继承自哪个父配置 + 完整别名串 `ccp-sonnet-1 / ccp-haiku-1 / ccp-opus-1`。icon 用 `symbol-runtime` 之类区分。单击命令绑 `launchDerivedClaude`（而非 switchLocalConfig）。**孤儿标记**：若 `derivedFrom` 指向的父配置已不存在，节点 description 前缀 `⚠ 孤儿` 并禁用启动按钮（见 §6.5 继承断链）。

`package.json` menus：新增 `viewItem == derived-config` 行内按钮（启动/edit/del），父 `local-config` 加 `+派生` 按钮（`newDerivedConfig`）。

### 6.4 后台通知与映射表存储（关键：不砸单例架构）

**问题**：webview 改映射要通知"多窗口共用"的代理进程，且多窗口状态需同步。

**选定方案：全局共享映射表 + 按会话分区 + webview 只看本窗口（不广播）**

- 映射表 `modelAliases` 存在**那一个共享代理进程**内存（`proxy-config.json` 持久化），所有 workspace 共用一份。统计信息照常聚合，不分散。
- 别名按会话编号 N 天然分区：workspace A 的会话 N=1、workspace B 的 N=2，别名 `ccp-sonnet-1` 与 `ccp-sonnet-2` 不撞，**无跨 workspace 冲突**。
- 每个 workspace 的 webview 只展示/编辑自己创建的派生节点映射，**不关心别的 workspace 的会话** → **不需要跨 workspace 广播**。workspace A 改 `ccp-sonnet-1`，workspace B 根本不显示 1，无需通知。
- 跨 workspace 编号唯一性：webview 创建派生节点时 `POST /api/model-alias/next-id` 向代理申请（计数器持久化见 §6.2），再本地落 `local-configs.json`。

**为什么不用每窗口独立代理**：会分散统计信息、推翻现有 EADDRINUSE 单例 + 心跳接管架构、端口分配复杂。本方案不动架构。

**代理侧改动**（`proxy/config-store.js` + `proxy/server.js`，照 `updateEffort`/`/api/effort` 模板）：

| 改动 | 文件:位置 | 说明 |
|---|---|---|
| `config.modelAliases` 字段 + `config.nextAliasId` | `proxy-config.json` 顶层（`effortLevel` 旁） | 别名字典 + 编号计数器；DEFAULT_PROXY_CONFIG（`proxyHost.ts:349-369`）补默认 `{}`/`0` |
| `getModelAliases()` / `updateModelAlias(alias, model)` / `removeModelAlias(alias)` / `nextAliasId()` | `config-store.js` L87 后（紧跟 `updateEffort`） | 照 `updateEffort`：校验 → 改 `config.modelAliases`/`nextAliasId` → `persist()`；`getModelAliases` 兜底 `config.modelAliases ?? {}` |
| `init` 读取 + 启动校正 | `config-store.js:36-45` | init 读 `modelAliases`/`nextAliasId`（兜底）；init 后扫 key max 校正 `nextAliasId`（§6.2） |
| `getView()` 加 `modelAliases` | `config-store.js:110-133` | 现有 getView 返回 `{effortLevel, proxy, upstream, listen}`，加 `modelAliases` 字段供前端拉取 |
| `POST /api/model-alias` | `server.js` L397 后（紧跟 `/api/effort`） | body `{alias, model}` → `updateModelAlias`；照 `/api/effort` |
| `POST /api/model-alias/delete` | 同上 | body `{alias}` → `removeModelAlias` |
| `GET /api/model-alias/next-id` | 同上 | 返回 `{id: N}`，调 `nextAliasId()` |
| `rewriteModel(body, aliases, reqId, contentType)` | `server.js` L99 后（紧跟 `rewriteEffort` 函数定义） | 照 `rewriteEffort`：parse → 若 `parsed.model` 命中 aliases 则替换 → 重新序列化。**不受 `isMessagesMain` 守卫**（见下） |
| 调用 `rewriteModel` | `server.js` L568-571 outBody 链 | 紧跟 `rewriteEffort` 之后追加一层 |

**rewriteModel 关键细节（修 P3/P8）**：

- **不受 `isMessagesMain` 守卫**：`rewriteEffort` 只对 `/v1/messages` 主路径生效（effort 仅主对话有意义），但 model 别名替换**必须覆盖所有带 `model` 字段的请求**，包括 `/v1/messages/count_tokens` 子路径——否则 count_tokens 请求带 `ccp-sonnet-N` 不被替换、原样打到上游报 model not found。故 `rewriteModel` 只要 JSON body 且 `parsed.model` 命中别名表即替换（白名单式，§3.6 已约束安全性）：
  ```js
  // 不加 isMessagesMain 守卫
  outBody = rewriteModel(outBody, modelAliasMap, id, req.headers['content-type']);
  ```
- **与 rewriteEffort 串联的重复 parse**：两层各 parse+stringify 一次，大请求体有开销。**推荐合并**成单次 `rewriteBody(body, {effortLevel, modelAliasMap}, ...)`：一次 parse、改 effort + 改 model、一次 stringify。若暂不合并，两层容错独立、`rewritten` 标志需分别记录 `[effort→X]`/`[model→Y]` 日志。
- **trace 的 model 字段**：`reqModel`（`server.js:554-562`）保留**原始别名**给 trace（改写前），trace 应补一个 `resolvedModel` 字段记替换后的真实模型，否则统计显示别名而非真实模型名。
- **content-length**：`forwardStreaming`（`server.js:153-156`）浅拷贝 outHeaders 后 `delete content-length`，`req.end(body)` 按实际 body 长度重算——替换后 body 变长不会出问题（非"Buffer 自然更新"，是 delete+重算）。

**扩展侧改动**（`src/proxyHost.ts`，照 `setUpstream` L211-238 模板）：

- 新增 `setModelAlias(alias, model)` / `removeModelAlias(alias)` / `nextAliasId()` — 各自手写 `http.request` POST 到对应 `/api/model-alias*`。
- `getView()` 返回 `modelAliases`，供 webview 拉取展示。

### 6.5 继承机制：派生节点如何复用父配置

派生节点本身不存完整 `content`，只存 `derivedFrom` + `modelAliases` + 一份**父上游快照**（见下 P1）。启动时 launcher 合成实际 settings：

`src/claudeLauncher.ts` 新增 `launchDerived(derivedCfg)` 流程：

1. 取父配置：`localStore.get(derivedCfg.derivedFrom)` → 父 `LLMConfig`。父已删则走快照（见下"继承断链"）。
2. **继承父配置的上游**：优先用派生节点存的父上游快照，无快照则用父 `content` 解出 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `API_TIMEOUT_MS`（同 `extractUpstream`）。
3. **proxy 模式**（父 mode=proxy）：`proxyHost.ensureRunning()` + `proxyHost.setUpstream(父上游)`（注入全局代理上游，与现有 `resolveSettingsContent` 一致）。
4. **别名注入走 shell env**（不走 settings.env，§5.4 约束）：把 `ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL` 三个**别名**（`ccp-*-N`）通过 `createTerminal` 的 `env` 注入，不写进 settings.json。
5. `ANTHROPIC_BASE_URL` 指代理 `http://127.0.0.1:<port>`（proxy 模式）；直连模式则用父 baseUrl。
6. **同步代理映射表**：确保 `ccp-haiku-N`/`ccp-sonnet-N`/`ccp-opus-N` 三条已在代理 `modelAliases` 里（启动时若缺则用派生节点的 `modelAliases` 调 `setModelAlias` 补上，默认值可取父配置 content 里的真实模型名）。

**继承断链处理（修 P1）**：派生节点不存 content、启动时从父配置合成，存在断链风险：

- 父配置被**删除** → `localStore.get(derivedFrom)` 返 undefined → 派生节点成孤儿。
- 父配置被**编辑**（token 轮换、换 baseUrl）→ 派生节点静默继承新上游，用户以为是"自己当时配的上游"。

处理策略：

1. **派生节点创建时存一份父上游快照**（`derivedSnapshot: {baseUrl, token, timeoutSec, mode}`）冗余进 `local-configs.json`。`launchDerived` 优先用快照、父配置仅作显示名。代价是父 token 轮换不自动同步到派生节点——但这恰是用户预期（"这条会话用当时配的上游"）。
2. **父配置 upsert/remove 时级联**（参照 `deleteLocalConfig` 删 active 清标记，`extension.ts:335-347`）：父 `remove` 时扫 `derivedFrom === parentId` 的派生节点，弹"是否一并删除 N 个派生节点"确认；父 `upsert` 时若有派生节点依赖，提示"上游已变，派生节点仍用旧快照，需手动重建"。
3. **孤儿标记**：父已删的派生节点树视图打 `⚠ 孤儿` 前缀、禁用启动按钮（§6.3），但保留可删/可重建（手动指回新父配置）。

继承关系图：

```
父 local 配置 (content: 上游 baseUrl/token/timeout)
        │ 创建派生节点时快照
        ▼
派生节点 (derivedFrom, derivedIndex=N, modelAliases, derivedSnapshot)
        │ 启动时合成（优先用快照）
        ▼
终端 env: CLAUDE_CONFIG_DIR + ANTHROPIC_DEFAULT_*_MODEL=ccp-*-N + ANTHROPIC_BASE_URL
        │
        ▼
代理映射表: ccp-sonnet-N → 真实模型（webview 可在线改）
```

### 6.6 启动参数规格

`launchDerived` 通过 `createTerminal` 注入的 env（在现有 `CLAUDE_CONFIG_DIR` + `CLAUDE_BIN` 基础上追加）：

| 环境变量 | 值 | 来源 | 传递方式 |
|---|---|---|---|
| `CLAUDE_CONFIG_DIR` | `<共享 config dir>` | §5.9 路A，共享 | shell env |
| `CLAUDE_BIN` | `<claude 二进制>` | 现有 | shell env |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `ccp-haiku-<N>` | 派生节点编号 | **shell env**（冻结，§5.4） |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `ccp-sonnet-<N>` | 派生节点编号 | **shell env**（冻结） |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `ccp-opus-<N>` | 派生节点编号 | **shell env**（冻结） |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` | proxy 模式；直连则父 baseUrl | **settings.json env**（沿用 `synthesizeProxySettings`） |
| `ANTHROPIC_AUTH_TOKEN` | `<父配置 token>` | 继承父配置 | **settings.json env**（不进 shell，防进程列表可见） |

**传递方式划分（修 P4）**：

- **三档别名走 shell env**——这是 §5.4 别名冻结的前提（settings.env 不含同名 key，CLI 运行中重读也读不到别名，别名稳如老狗）。
- **BASE_URL / token 走 settings.json env**——沿用现有 `synthesizeProxySettings`（`upstream.ts:19-25`）写进 `.claude_proxy/settings.json` 的 env 字段。token 进文件、不进进程 env，**不降级安全性**（shell env 会出现在 `ps e` / 进程列表）。
- proxy 模式下 token 虽由代理覆盖注入（`forwardStreaming` 的 `outHeaders['authorization']`），但 CLI 行为依赖 token 存在性，故**必传不可省**——删除原"proxy 模式可省代理注入"的含糊表述。

所以 settings.json 的 env 字段里**会有 BASE_URL + token，但没有三档别名**——满足 §5.4"settings.env 不含别名同名 key"的前提，逻辑自洽。settings.json 也可写非 env 字段（如 permissions）。

shellPath / sendText 沿用现有逻辑（Windows PowerShell `& $env:CLAUDE_BIN`，其他 `"$CLAUDE_BIN"`）。

### 6.7 webview 配置页 UI

派生节点的编辑器复用 `WebviewEditor`，scope 新增 `'derived'`。在现有表单（name / mode radio / import / content textarea）基础上，为 derived scope 增加一块"模型别名映射"区域。ASCII 草图：

```
┌─ Edit: glm-5.2 #1 (derived) ──────────────────────────────┐
│                                                            │
│  Name                                                      │
│  [glm-5.2 #1                                         ]     │
│                                                            │
│  继承自: glm-5.2 (Volc)   专属编号: #1                      │
│  别名: ccp-haiku-1 / ccp-sonnet-1 / ccp-opus-1             │
│                                                            │
│  ┌─ 模型别名映射（在线可改，下个请求生效）──────────────┐  │
│  │                                                        │  │
│  │  Haiku 档   ccp-haiku-1   →  [claude-haiku-4-5    ▾]  │  │
│  │  Sonnet 档  ccp-sonnet-1  →  [claude-sonnet-5     ▾]  │  │
│  │  Opus 档    ccp-opus-1    →  [claude-opus-5       ▾]  │  │
│  │                                                        │  │
│  │  (下拉候选来自全局模型清单；也可手输自定义模型名)        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                            │
│  连接模式                                                   │
│  ○ 直连   ● 通过代理连接（继承父配置）                       │
│                                                            │
│  settings.json content (只读·继承自父，自定义请建普通 local 配置)│
│  ┌────────────────────────────────────────────────────┐    │
│  │ { "env": { "ANTHROPIC_BASE_URL": "...", ... } }    │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  [Save]  [Save & 启动]  [Cancel]                            │
└────────────────────────────────────────────────────────────┘
```

**关键交互**：

- 三档映射各一行：左固定别名（只读，显示 `ccp-<档>-N`），右下拉选真实模型。
- **在线改映射（修 P7）**：改下拉值 → `postMessage({type:'setAlias', tier, model})` → 扩展侧 `proxyHost.setModelAlias(alias, model)` → 代理 `updateModelAlias` 改内存+persist → **下个请求即生效**，无需重启 CLI、无需关闭 webview。**且同步本地缓存 + 刷新树**：成功后 `localStore.upsert({...cfg, modelAliases: 更新后})` 写回 `local-configs.json`，并 `refresh()` 刷新派生节点 description（`S:sonnet-5 · ...`）——否则树看不出改了、重开编辑器显示旧值，本地缓存与代理权威数据脱节。
- **全局模型清单来源（修 P9）**：三档下拉候选从**所有已存配置（global + local + derived）的 `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL` 字段聚合去重**得来，外加用户手输历史（存 globalStorage）。纯前端聚合，无需代理改动。下拉支持手输自定义模型名（第三方上游模型名千差万别，硬编码官方列表无意义）。
- **content textarea（修 P11）**：derived scope 下 content **只读**（灰底显示父 content），避免用户改了之后继承语义混乱（改了若 `launchDerived` 仍用父 content 解上游则 textarea 是摆设；若改用派生 content 则继承断了）。若用户确需自定义 content，应另建普通 local 配置而非派生节点。
- `WebviewMessage` 扩展：

```typescript
type WebviewMessage =
    | { type: 'save' | 'saveAndSwitch'; name: string; content: string; mode: 'direct' | 'proxy' }
    | { type: 'import'; id: string }
    | { type: 'setAlias'; tier: 'haiku' | 'sonnet' | 'opus'; model: string }   // 新增
    | { type: 'cancel' };
```

- `onMessage` 新增 `setAlias` 分支：调 `proxyHost.setModelAlias` + `localStore.upsert` 同步缓存 + `refresh()` 刷新树，成功后 `postMessage({type:'aliasSaved', tier})` 让前端轻量确认（不关面板）。
- "Save & 启动" = 保存派生节点 + 立即 `launchDerived`。

**跨窗口缓存一致性**：`localStore` 的 cache 是实例级（`localConfigStore.ts:16`），两窗口改同一 `local-configs.json` 会 last-write-wins。`setAlias` 写本地缓存是为本窗口展示一致；权威数据在代理 `proxy-config.json`（§6.4）。跨窗口若需看别人的会话映射，走"全部会话"视图 GET 全表（§6.9）。

### 6.8 命令与流程清单

`src/extension.ts` 新增命令：

| 命令 | 作用 |
|---|---|
| `claude-code-proxy.newDerivedConfig` | 在某 local 配置下新建派生节点（向代理申请编号 N） |
| `claude-code-proxy.editDerivedConfig` | 打开派生节点配置页 |
| `claude-code-proxy.launchDerivedClaude` | 在派生节点上启动 terminal（受其别名控制） |
| `claude-code-proxy.deleteDerivedConfig` | 删派生节点 + 调 `removeModelAlias` 清代理映射表三条 + 关联处理活终端（见下） |

**与 `launchWorkspaceClaude` 的关系（修 P10）**：`launchDerivedClaude` 与现有 `launchWorkspaceClaude`（`extension.ts:537-540`、`claudeLauncher.ts:212-299`）**并存**。底层共用 `createTerminal` + env 注入逻辑，区别在：

- `launchWorkspaceClaude` 读 `localActiveState`（`local-active.json`）决定用哪条 local 配置——用于普通 local 配置的会话（无别名、无运行时切模型）。
- `launchDerivedClaude` 跳过 activeState，直接用传入的 `derivedCfg`（有别名、可运行时切模型）。

两者不冲突（不同命令、不同入口），维护上可抽公共方法 `launchClaude(cfg, opts)`，按 `cfg.derivedFrom` 有无分流到派生/普通分支。现有 `launchWorkspaceClaude` 保持不变，派生节点走新命令。

**`deleteDerivedConfig` 与活终端（修 P6）**：删派生节点调 `removeModelAlias` 清三条映射。但若该派生节点的终端还活着，CLI 仍用 `ccp-sonnet-N` 发请求——映射被清后 `rewriteModel` 命中失败、原样透传（§3.6 白名单），请求带别名打到真实上游 → 真实 LLM 不认识 `ccp-sonnet-N` 报 model not found，用户无法理解。

处理：`deleteDerivedConfig` 时遍历 `vscode.window.terminals`，按终端启动时注入的标记（如终端 name 含 `#N` 或 env 里带 `CCP_DERIVED_ID=N`）匹配该派生节点的活终端，弹"派生节点 #N 仍有终端在运行，是否一并关闭？"确认，一并 `terminal.dispose()`。若无活终端，直接删。

完整用户流程：

1. 在 `workspace_local_llm_config` 下某 local 配置点 `+派生` → 扩展向代理 `nextAliasId` 拿编号 N → 本地建派生节点（derivedFrom=父id, derivedIndex=N, derivedSnapshot=父上游快照）→ 打开配置页。
2. 配置页里三档下拉选真实模型 → Save → 派生节点落 `local-configs.json`，三条别名调 `setModelAlias` 写代理映射表。
3. 派生节点点 `▶启动` → `launchDerived`：继承父上游（优先快照）+ 注入别名 env + 起终端。
4. 运行中想换某档模型 → 打开派生节点配置页 → 改下拉 → setAlias 即时生效 + 同步本地缓存 + 刷树。
5. 并行：同一父配置再 `+派生` 得 N+1，独立别名、独立映射、互不干扰。
6. 删派生节点 → 弹"是否一并关闭活终端" → 清映射 + 删本地节点。

### 6.9 边界与注意

- **`ANTHROPIC_MODEL`（主对话）不纳入**：仍走 `/model`，派生节点只管三档（§3.3）。
- **派生节点的"独立"是有限独立（修 P5）**：模型别名映射独立（三档各自换、并行会话互不干扰），但**上游 baseUrl/token 仍全局共享**（`setUpstream` 全局 last-write-wins）。用户最易误解这点——以为建两个不同父上游的派生节点就能并行用不同上游，实际会串味。**处理**：`launchDerived` 时检测代理当前上游是否与父配置（或快照）上游一致，不一致则弹警告"代理当前上游是 X，本派生节点父上游是 Y，启动后会串味。是否继续？"（参照 `doSwitch` 的 Reload/Undo 交互），不硬阻断但让用户知情。树视图给"与当前代理上游不匹配"的派生节点打标记。
- **代理单例串味（pitfall 文档）**：即上条的根因。`setUpstream` 全局共享，详见 `docs/pitfall-proxy-shared-upstream.md`。
- **编号回收**：删派生节点清映射表三条，编号 N 不回收（避免复用导致旧会话残留映射命中），递增即可。计数器持久化与启动校正见 §6.2。
- **webview 状态同步**：本窗口改映射不需通知别窗口（§6.4 按会话分区）；若将来要全局总览所有会话映射，单独加一个"全部会话"视图 GET `/api/config` 读全表即可。

### 6.9.1 别名格式与 1M 上下文（源码调研）

**调研结论**（`D:\work_dir\Claude_Code-_Source_Code`）：

- **唯一合法长度标记是 `[1m]`**（`utils/context.ts:35-40` `has1mContext` 只匹配 `/\[1m\]/i`）。`[500k]`/`[200k]`/`[2m]` 不被识别，会被当模型名字面量原样传递——不报错但不生效。
- **`[1m]` 控制 CLI 本地三件事**：contextWindow 取 1,000,000（不带默认 200,000，`context.ts:51-98`）+ API 请求带 `context-1m-2025-08-07` beta header（`utils/betas.ts:254-256`）+ 真实模型名带 `[1m]`（发 API 时被 `normalizeModelStringForAPI` 剥离，靠 beta header 表达）。
- **`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 是对 contextWindow 的 `min` 钳制上限**（`services/compact/autoCompact.ts:33-49`），非独立阈值。触发阈值 = `min(contextWindow, AUTO_COMPACT_WINDOW) - maxOutputTokens - 13000`。故 200K 模型配 `AUTO_COMPACT_WINDOW=600000` → `min(20万,60万)=20万`，600K 不生效、不会"永远压不到"。

**关键坑（影响别名格式）**：CLI 的 `[1m]` 检测、contextWindow、beta header **全部读 CLI 本地的 model 字符串**，会话初始化时算好且 `getAllModelBetas` 被 memoize 缓存。**代理层在 HTTP 出口把 `ccp-sonnet-1` 替换成 `claude-sonnet-5[1m]`，影响不了 CLI 已缓存的本地决策**——CLI 仍按 200K autocompact、beta header 也不带 1M。代理改写发生在 CLI 之后，回溯不了。

**结论：长度标记必须放在 CLI 能看到的那一侧——别名侧。** 别名格式：

- 支持 1M 的会话，别名带 `[1m]` 后缀：`ccp-sonnet-1[1m]`。CLI 检测到 `[1m]` → 本地按 1M + beta header 带 1M + 请求 model 字段是 `ccp-sonnet-1[1m]`。
- 代理收到 `ccp-sonnet-1[1m]` → 剥离 `[1m]` → base `ccp-sonnet-1` 查映射表 → 真实模型名（如 `claude-sonnet-5`）→ 发上游（不带 `[1m]`，靠 beta header 表达 1M）。
- 不需要 1M 的会话别名不带后缀：`ccp-sonnet-1`，按 200K。

**`rewriteModel` 调整**：别名映射表的 key 是 base（`ccp-sonnet-1`），但请求 `model` 字段可能是 `ccp-sonnet-1[1m]`（带后缀）。`rewriteModel` 需先剥离 `[1m]` 再查表、命中后替换 base 为真实模型名（不带后缀，beta header 由 CLI 已带）。即 `rewriteModel` 的匹配规则是"剥离 `[1m]` 后白名单匹配"。

**保留词避让**：别名不得撞 CLI 保留 alias `opus`/`sonnet`/`haiku`/`opusplan`/`best`（`parseUserSpecifiedModel` 对这些有特殊分支，会把 `[1m]` 拼到 default model 上，`model.ts:456-470`）。`ccp-*-N` 不撞，安全。

**autocompact 阈值精算（校准前文估算）**：前文 §6.9.1 / mock 设计 §8 写的「无 `[1m]` + window=600000 → threshold≈187,000」是 reservedTokens=0 的粗估。照真 CLI 精算：`reservedTokens = min(maxOutputTokens, 20_000)`，自定义别名（`ccp-sonnet-N` 走不到已知档位）经 cap 后 maxOutputTokens=8,000（`context.ts:149-210` else 分支 + `CAPPED_DEFAULT_MAX_TOKENS=8_000`）。故：

- `[1m]` + `AUTO_COMPACT_WINDOW=600000`：`min(1_000_000, 600_000) - 8_000 - 13_000` = **579,000**
- 无 `[1m]` + `AUTO_COMPACT_WINDOW=600000`：`min(200_000, 600_000) - 8_000 - 13_000` = **179,000**

mock 测试断言用精算值（579,000 / 179,000），注释标注「校准了前文估算」。这是 mock 作为第二道闸的产出——把文档估算换成真 CLI 精确值。

### 6.10 衍生目标：重试记录按 session 过滤

**目标**：在代理的重试记录页面（`proxy/web/index.html`），能单独跟踪某一个 session 的所有请求记录——即按会话编号 N filter 出该会话的全部 trace。

**前提**：别名按会话唯一（`ccp-sonnet-N` / `ccp-haiku-N` / `ccp-opus-N`），每个请求的 `model` 字段都带会话编号。trace 记录（`proxy/trace-store.js`）已存 `reqModel`（§6.4 P3 修订后会存原始别名 + `resolvedModel` 真实模型）。所以**会话编号天然是 trace 的可过滤维度**——不用额外打 session 标记，从 `reqModel` 解析出 N 即可分组。

**实现方向**：

- trace 列表加一个"session filter"——按编号 N 过滤，展示该会话所有档位的全部请求（haiku/sonnet/opus 三档混在一起，按时间序）。
- 提取 N：从 `reqModel`（形如 `ccp-sonnet-3`）正则 `ccp-(haiku|sonnet|opus)-(\d+)` 取后缀数字。
- 这让用户能看"这个会话跑过哪些请求、各自走了哪个真实模型、重试了几次"——对调试运行时切换很有用。

**依赖**：本目标依赖 §6.4 P3 修订——trace 必须既存原始别名（含 N，用于 filter）又存 `resolvedModel`（真实模型，用于展示"实际走了哪个模型"）。若 trace 只存别名，filter 能做但看不出真实模型；若只存真实模型，则无法按 N filter。故 trace 字段补 `resolvedModel` 是本目标的前置。

> 这是别名唯一性的副产品收益：会话独立别名不仅用于运行时切换，还天然成了 trace 的会话标识，无需额外埋点。

### 6.11 审查修订记录

本节为独立子 agent 对照代码挑错后的修订记录（11 个问题）：

| 编号 | 严重度 | 问题 | 修订处 |
|---|---|---|---|
| P1 | 🔴 阻塞 | 继承断链：父配置被编辑/删除后派生节点无法合成 | §6.2 加 `derivedSnapshot` 字段；§6.5 加快照优先 + 级联处理 + 孤儿标记；§6.3 加孤儿节点标记 |
| P2 | 🔴 阻塞 | `nextAliasId` 计数器不持久化、代理重启后重号 | §6.2 计数器落 `proxy-config.json` + init 读取 + 启动扫 key 校正；§6.4 补 init/getView/persist 落点 |
| P3 | 🔴 阻塞 | rewriteModel 与 rewriteEffort 串联的重复 parse + isMessagesMain 守卫错配 | §6.4 补"不受 isMessagesMain 守卫""可合并单次 parse""trace 补 resolvedModel""content-length 是 delete+重算" |
| P4 | 🟡 缺口 | token 传递歧义：shell env 传 token 安全降级 | §6.6 表加"传递方式"列；明确别名走 shell env、BASE_URL/token 走 settings.env；删"可省"表述；§5.9 对齐 |
| P5 | 🟡 缺口 | 串味只给建议无拦截 | §6.9 补"独立是有限独立"+ launchDerived 上游一致性警告 + 树标记 |
| P6 | 🟡 缺口 | 删派生节点后活终端报 model not found | §6.8 补 deleteDerivedConfig 关联活终端处理 |
| P7 | 🟡 缺口 | setAlias 不刷树/不同步本地缓存 | §6.7 补 setAlias 同步 localStore + refresh；补跨窗口 cache 限制说明 |
| P8 | 🟡 缺口 | rewriteModel 受 isMessagesMain 守卫会漏 count_tokens | 并入 P3，§6.4 已修 |
| P9 | 🟢 细化 | 全局模型清单来源空白 | §6.7 补聚合来源 + 手输 |
| P10 | 🟢 细化 | launchDerived 与 launchWorkspaceClaude 关系未明 | §6.8 补两命令并存 + 公共方法分流 |
| P11 | 🟢 细化 | 派生节点 content textarea 改后继承是否成立 | §6.7 标注 derived scope 下 content 只读 + ASCII 图更新 |

自洽性修订：§3.2 加框标注"§6 落地后废弃"；§5.5 映射表生命周期改为"不回收"；§5.6 重写三套机制关系（§6 = §5.5 落地、§3 仅原理）；§5.9 对齐传递方式。

### 6.12 执行顺序

本方案的落地按下列阶段顺序推进，**每阶段闸住才进下一阶段**：

**阶段 0：Mock CLI 基础套件**（当前）

- 按 `docs/mock-cli-test-harness.md` 实现一个**基础 mock-cli**：只做"读 settings.json / 读 env / chokidar 重读 / applyConfigEnvironmentVariables / additive-only / `[1m]` 解析 / contextWindow / autocompact 阈值"的等价实现 + 探针 HTTP 端口。
- 不做与代理交互、不做派生节点、不做 rewriteModel。先最小可用。

**阶段 1：用 mock-cli 验证关键前提**

- 跑 mock-cli 的探针用例（mock-cli 设计 §8），对照真 CLI 行为，验证主方案赖以成立的核心假设是否正确：
  - shell env 别名运行中冻结（§5.4 TODO-1/2/3）
  - settings.env 覆盖优先级、additive-only（§5.3 结论 B/C）
  - `[1m]` 解析 + AUTO_COMPACT_WINDOW 钳制（§6.9.1）
- **若假设与真 CLI 不符**：回头改主方案文档的假设（mock 不动，除非真 CLI 代码变了），重验。
- **验证通过才进阶段 2**。这是整个方案的根基——前提假设错了，后面全白搭。

**阶段 2：详细实现 model 切换方案**

- 前提验证通过后，按 §6 落点实现派生节点 + 代理 rewriteModel + 别名映射表 + webview 配置页 + 命令。
- mock-cli 此时可作为回归测试基座，持续守护"配置加载行为"假设不被破坏。

**阶段 3（预留）：mock-cli 端到端**

- mock-cli 接真代理（`POST /probe/simulate-request` → 代理 → 上游），验证 rewriteModel 别名替换、effort 串联、trace 按 session 过滤等端到端链路。

> 这条顺序的核心思想：**先用 mock 把黑盒前提变成可验证/可回归的代码，确认前提无误，再投入主方案实现**。避免在错误假设上堆代码。



