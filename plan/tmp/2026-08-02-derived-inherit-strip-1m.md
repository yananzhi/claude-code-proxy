# 2026-08-02 派生节点三档继承 [1m] 后缀剥离修复

## Bug 现象

派生节点新建时，`modelAliases` 的 haiku/sonnet/opus 三档 value 带了 `[1m]` 后缀
（如 `xopglm52[1m]`），而 value 应是真实模型名、不该带 `[1m]`。
main 档已正确剥离，三档漏剥。

## 根因

`webviewEditor.ts inheritAliasesFromParent`（line 121-136）：
- main 档：`m.replace(/\[1m\]/gi, '').trim()` ✅ 剥了
- 三档（haiku/sonnet/opus）：原样赋值 `aliases.haiku = h` ❌ 没剥

父配置 `ANTHROPIC_DEFAULT_*_MODEL` 若带 `[1m]`（用户为开 1M 给三档加后缀），
继承进 `modelAliases` value 就带 `[1m]`，再经 `computeAliasSyncActions`（line 223 `raw.trim()`
原样用）设进代理映射表 → OCR 看到的 `xopglm52[1m]`。

约束 3：映射别名 **key** 一律不带 `[1m]`（`rewriteModel` 剥后缀查表）。
而 value 是真实模型名，同样不该带 `[1m]`——`[1m]` 只是 CLI 侧 contextWindow 档位标记，
不是模型名一部分；带后缀的真实模型名发到上游会 model not found。

## 修复策略

把 `inheritAliasesFromParent` 的纯逻辑抽到 `derivedLogic.ts`（可单测，符合 CLAUDE.md
"纯逻辑抽 out 可单测"哲学），**四档统一剥 `[1m]`**；`webviewEditor.ts` 改调纯函数。

## 正交维度

| 维度 | 取值 | 说明 |
|---|---|---|
| D1 档位 | main / haiku / sonnet / opus | 四档都剥，不止 main |
| D2 后缀形态 | `[1m]` 小写 / `[1M]` 大写 / `[1m]` 出现多次 | 与 CLI `has1mContext` 的 `/\[1m\]/i` 一致，大小写不敏感；多次出现全剥 |
| D3 后缀位置 | 模型名末尾 / 中间 / 开头 | `replace(/\[1m\]/gi,'')` 全局剥，不限位置（与 main 档现状一致） |
| D4 父 content 有效性 | 合法 JSON / 非法 JSON / 空 env | 非法 → 返回 `{}`（与现状一致） |
| D5 各档缺失 | 四档全有 / 部分缺 / 全缺 | 缺的档不进结果（与现状一致） |
| D6 值类型 | 字符串 / 非字符串（数字/对象/null） | 非字符串视为缺失（与 main 档现状一致，类型守卫） |
| D7 空白 | 值带首尾空格 / 纯空白 | trim 后空则视为未配 |
| D8 非 [1m] 后缀 | `[2m]` / `[500k]` / 无后缀 | 只剥 `[1m]`，其他后缀原样保留（与 main 档 + CLI 一致） |

## 高风险维度

- **D2 大小写**：CLI 用 `/\[1m\]/i`，剥也要 `/\[1m\]/gi`（g+i），否则 `[1M]` 漏剥。
- **D3 位置/多次**：`x[1m]glm[1m]` 应剥成 `xglm`（与 main 档 `replace` 行为一致）。
- **D6 类型守卫**：env 值可能是数字（extractUpstream 强转 Record<string,string> 但实际值非字符串），
  非字符串 `.replace` 会崩 → 必须类型守卫。
- **D7 空白**：剥后缀后还要 trim（main 档现状是 `.replace(...).trim()`，三档对齐）。
- **D8 只剥 [1m]**：`[2m]` 等 CLI 不识别的后缀不能误剥（保留原样，与 main 档一致）。

## 与现有约束的一致性

- main 档已剥 `[1m]`（line 131），三档对齐 → 全函数四档同逻辑。
- `computeAliasSyncActions`（line 223）用 `raw.trim()` 原样设代理表，故剥后缀必须在
  `inheritAliasesFromParent` 出口完成（上游剥干净，下游原样透传）。
- `aggregateModelCatalog`（line 244）也读 `modelAliases` 候选，剥干净后候选清单也不带 `[1m]`。
