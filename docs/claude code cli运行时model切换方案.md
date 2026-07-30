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
