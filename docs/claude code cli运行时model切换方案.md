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

### 5.5 定案：纯 shell env 每会话专属别名

基于 §5.3 / §5.4，并行会话独立切换采用下列方案，替代 §3 的"别名写进 Workspace Local LLM Config"路径。

**机制**：每个 CLI 会话启动时，经 shell 环境变量注入**该会话专属且唯一**的别名；别名运行中冻结；切换模型只动代理映射表，不动 CLI 侧。

**会话级注入**（launcher `createTerminal` 的 `env` 选项，进程级）：

| 环境变量 | 会话 A 值 | 会话 B 值 |
|---|---|---|
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `ccp-haiku-<idA>` | `ccp-haiku-<idB>` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `ccp-sonnet-<idA>` | `ccp-sonnet-<idB>` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `ccp-opus-<idA>` | `ccp-opus-<idB>` |

`<id>` 为会话唯一标识（递增序号 / uuid 前缀）。会话 A、B 各持独立别名，代理映射表各持独立条目。

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

**映射表生命周期**：会话关闭后其专属别名条目可回收（或保留供同名复用）。代理需能区分按会话的映射条目与全局共享条目。

### 5.6 与 §3 方案的关系

§3（别名写 Workspace Local LLM Config、全局共享一套）适用于**单会话或同上游并发**场景；§5.5（纯 shell env 每会话专属别名）适用于**并行 CLI 会话各自独立切换**场景。二者在代理层是同一套替换机制（白名单命中即替换），区别仅在别名是否按会话区分。实现时可先落 §3，再扩展到 §5.5 的会话级别名。

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
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `ccp-haiku-<sessionId>` | 本会话专属别名 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `ccp-sonnet-<sessionId>` | 本会话专属别名 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `ccp-opus-<sessionId>` | 本会话专属别名 |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<proxyPort>` | 走代理（proxy 模式） |

不写 `settings.json` 的 env 字段（§5.4 约束）。`ANTHROPIC_MODEL` 留给 `/model`（§3.3）。

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

export interface LLMConfig {
    id: string;
    name: string;
    content: string;
    mode?: ConfigMode;
    updatedAt: string;
    // —— 派生节点字段（仅派生节点有）——
    derivedFrom?: string;          // 父 local 配置 id
    derivedIndex?: number;         // 专属编号 N（全局唯一）
    modelAliases?: ModelAliasMapping;  // 三档别名 → 真实模型（本地缓存，权威在代理）
}
```

派生节点仍存进 `local-configs.json`（与父 local 配置同数组，靠 `derivedFrom` 区分）。`LocalConfigStore` 的 load/save/upsert/remove/get 无需改（新字段自然序列化）。新增方法：

- `getDerivedByParent(parentId): LLMConfig[]` — 取某父配置下所有派生节点。
- `nextDerivedIndex(): number` — 生成下一个全局唯一编号 N。

`nextDerivedIndex` 的全局唯一性：扫所有已存派生节点的 `derivedIndex` 取 max+1。跨窗口唯一性由"代理进程内存维护一个递增计数器"兜底（见 §6.4），webview 创建派生节点时先向代理申请编号，避免两窗口撞号。

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

派生节点 description 显示当前映射摘要 `S:sonnet-5 · H:haiku-4 · O:opus-4`；tooltip 显示继承自哪个父配置 + 完整别名串 `ccp-sonnet-1 / ccp-haiku-1 / ccp-opus-1`。icon 用 `symbol-runtime` 之类区分。单击命令绑 `launchDerivedClaude`（而非 switchLocalConfig）。

`package.json` menus：新增 `viewItem == derived-config` 行内按钮（启动/edit/del），父 `local-config` 加 `+派生` 按钮（`newDerivedConfig`）。

### 6.4 后台通知与映射表存储（关键：不砸单例架构）

**问题**：webview 改映射要通知"多窗口共用"的代理进程，且多窗口状态需同步。

**选定方案：全局共享映射表 + 按会话分区 + webview 只看本窗口（不广播）**

- 映射表 `modelAliases` 存在**那一个共享代理进程**内存（`proxy-config.json` 持久化），所有窗口共用一份。统计信息照常聚合，不分散。
- 别名按会话编号 N 天然分区：窗口 A 的派生节点 N=1、窗口 B 的 N=2，别名 `ccp-sonnet-1` 与 `ccp-sonnet-2` 不撞，**无跨窗口冲突**。
- 每个窗口 webview 只展示/编辑自己窗口创建的派生节点映射，**不关心别的窗口的会话** → **不需要跨窗口广播**。窗口 A 改 `ccp-sonnet-1`，窗口 B 根本不显示 1，无需通知。
- 跨窗口编号唯一性：webview 创建派生节点时，先 `POST /api/model-alias/next-id` 向代理申请编号（代理进程维护递增计数器，全局唯一），再本地落 `local-configs.json`。

**为什么不用每窗口独立代理**：会分散统计信息、推翻现有 EADDRINUSE 单例 + 心跳接管架构、端口分配复杂。本方案不动架构。

**代理侧改动**（`proxy/config-store.js` + `proxy/server.js`，照 `updateEffort`/`/api/effort` 模板）：

| 改动 | 文件:位置 | 说明 |
|---|---|---|
| `config.modelAliases` 字段 | `proxy-config.json` 顶层（`effortLevel` 旁） | `{ "ccp-sonnet-1": "claude-sonnet-5", ... }` 扁平字典 |
| `getModelAliases()` / `updateModelAlias(alias, model)` / `removeModelAlias(alias)` / `nextAliasId()` | `config-store.js` L87 后 | 照 `updateEffort`：校验 → 改 `config.modelAliases` → `persist()` |
| `POST /api/model-alias` | `server.js` L397 后 | body `{alias, model}` → `updateModelAlias`；照 `/api/effort` |
| `POST /api/model-alias/delete` | 同上 | body `{alias}` → `removeModelAlias` |
| `GET /api/model-alias/next-id` | 同上 | 返回 `{id: N}`，递增计数器 |
| `rewriteModel(body, aliases, reqId, contentType)` | `server.js` L99 后 | 照 `rewriteEffort`：parse → 若 `parsed.model` 命中 aliases 则替换 → 重新序列化 |
| 调用 `rewriteModel` | `server.js` L568-571 outBody 链 | 紧跟 `rewriteEffort` 之后追加一层 |

**扩展侧改动**（`src/proxyHost.ts`，照 `setUpstream` L211-238 模板）：

- 新增 `setModelAlias(alias, model)` / `removeModelAlias(alias)` / `nextAliasId()` — 各自手写 `http.request` POST 到对应 `/api/model-alias*`。
- `getView()` 返回 `modelAliases`，供 webview 拉取展示。

**rewriteModel 关键细节**（照抄 `rewriteEffort`）：
- `reqModel`（server.js L555-562）保留**原始 model** 给 trace。
- `rewriteModel` 在 `reqModel` 提取后、`outBody` 构造前执行；命中则替换 `parsed.model` 为真实模型，未命中原样返回。
- content-length 由重新序列化的 Buffer 自然更新（同 `rewriteEffort`）。

### 6.5 继承机制：派生节点如何复用父配置

派生节点本身不存完整 `content`，只存 `derivedFrom` + `modelAliases`。启动时 launcher 合成实际 settings：

`src/claudeLauncher.ts` 新增 `launchDerived(derivedCfg)` 流程：

1. 取父配置：`localStore.get(derivedCfg.derivedFrom)` → 父 `LLMConfig`。
2. **继承父配置的上游**：用父 `content` 解出 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `API_TIMEOUT_MS`（同 `extractUpstream`）。
3. **proxy 模式**（父 mode=proxy）：`proxyHost.ensureRunning()` + `proxyHost.setUpstream(父上游)`（注入全局代理上游，与现有 `resolveSettingsContent` 一致）。
4. **别名注入走 shell env**（不走 settings.env，§5.4 约束）：把 `ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL` 三个**别名**（`ccp-*-N`）通过 `createTerminal` 的 `env` 注入，不写进 settings.json。
5. `ANTHROPIC_BASE_URL` 指代理 `http://127.0.0.1:<port>`（proxy 模式）；直连模式则用父 baseUrl。
6. **同步代理映射表**：确保 `ccp-haiku-N`/`ccp-sonnet-N`/`ccp-opus-N` 三条已在代理 `modelAliases` 里（启动时若缺则用派生节点的 `modelAliases` 调 `setModelAlias` 补上，默认值可取父配置 content 里的真实模型名）。

继承关系图：

```
父 local 配置 (content: 上游 baseUrl/token/timeout)
        │ 继承
        ▼
派生节点 (derivedFrom, derivedIndex=N, modelAliases)
        │ 启动时合成
        ▼
终端 env: CLAUDE_CONFIG_DIR + ANTHROPIC_DEFAULT_*_MODEL=ccp-*-N + ANTHROPIC_BASE_URL
        │
        ▼
代理映射表: ccp-sonnet-N → 真实模型（webview 可在线改）
```

### 6.6 启动参数规格

`launchDerived` 通过 `createTerminal` 注入的 env（在现有 `CLAUDE_CONFIG_DIR` + `CLAUDE_BIN` 基础上追加）：

| 环境变量 | 值 | 来源 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `<共享 config dir>` | §5.9 路A，共享 |
| `CLAUDE_BIN` | `<claude 二进制>` | 现有 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `ccp-haiku-<N>` | 派生节点编号 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `ccp-sonnet-<N>` | 派生节点编号 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `ccp-opus-<N>` | 派生节点编号 |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` | proxy 模式；直连则父 baseUrl |
| `ANTHROPIC_AUTH_TOKEN` | `<父配置 token>` | 继承父配置（proxy 模式可省，代理注入） |

**不写 settings.json 的 env**（§5.4：别名走 shell env 才能运行中冻结）。proxy 模式下 settings.json 可只写非 env 字段（如 permissions），或不写（CLI 纯 env 启动，§5.3 结论D 可行）。

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
│  settings.json content (继承自父，通常无需改)                │
│  ┌────────────────────────────────────────────────────┐    │
│  │ { "env": { "ANTHROPIC_BASE_URL": "...", ... } }    │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  [Save]  [Save & 启动]  [Cancel]                            │
└────────────────────────────────────────────────────────────┘
```

**关键交互**：

- 三档映射各一行：左固定别名（只读，显示 `ccp-<档>-N`），右下拉选真实模型。
- **在线改映射**：改下拉值 → `postMessage({type:'setAlias', tier, model})` → 扩展侧 `proxyHost.setModelAlias(alias, model)` → 代理 `updateModelAlias` 改内存+persist → **下个请求即生效**，无需重启 CLI、无需关闭 webview。
- `WebviewMessage` 扩展：

```typescript
type WebviewMessage =
    | { type: 'save' | 'saveAndSwitch'; name: string; content: string; mode: 'direct' | 'proxy' }
    | { type: 'import'; id: string }
    | { type: 'setAlias'; tier: 'haiku' | 'sonnet' | 'opus'; model: string }   // 新增
    | { type: 'cancel' };
```

- `onMessage` 新增 `setAlias` 分支：不关面板、不刷新树，仅调 `proxyHost.setModelAlias`，成功后 `postMessage({type:'aliasSaved', tier})` 让前端轻量确认。
- "Save & 启动" = 保存派生节点 + 立即 `launchDerived`。

### 6.8 命令与流程清单

`src/extension.ts` 新增命令：

| 命令 | 作用 |
|---|---|
| `claude-code-proxy.newDerivedConfig` | 在某 local 配置下新建派生节点（向代理申请编号 N） |
| `claude-code-proxy.editDerivedConfig` | 打开派生节点配置页 |
| `claude-code-proxy.launchDerivedClaude` | 在派生节点上启动 terminal（受其别名控制） |
| `claude-code-proxy.deleteDerivedConfig` | 删派生节点 + 调 `removeModelAlias` 清代理映射表三条 |

完整用户流程：

1. 在 `workspace_local_llm_config` 下某 local 配置点 `+派生` → 扩展向代理 `nextAliasId` 拿编号 N → 本地建派生节点（derivedFrom=父id, derivedIndex=N）→ 打开配置页。
2. 配置页里三档下拉选真实模型 → Save → 派生节点落 `local-configs.json`，三条别名调 `setModelAlias` 写代理映射表。
3. 派生节点点 `▶启动` → `launchDerived`：继承父上游 + 注入别名 env + 起终端。
4. 运行中想换某档模型 → 打开派生节点配置页 → 改下拉 → setAlias 即时生效。
5. 并行：同一父配置再 `+派生` 得 N+1，独立别名、独立映射、互不干扰。

### 6.9 边界与注意

- **`ANTHROPIC_MODEL`（主对话）不纳入**：仍走 `/model`，派生节点只管三档（§3.3）。
- **代理单例串味（pitfall 文档）**：`setUpstream` 仍是全局共享，多个派生节点若用不同父上游会串味——这是已知限制，本方案不解决；建议同一 workspace 的派生节点共用同一父上游。
- **编号回收**：删派生节点清映射表三条，编号 N 不回收（避免复用导致旧会话残留映射命中），递增即可。
- **webview 状态同步**：本窗口改映射不需通知别窗口（§6.4 按会话分区）；若将来要全局总览所有会话映射，单独加一个"全部会话"视图 GET `/api/config` 读全表即可。



