# 阶段 0 正交场景设计 — 共享核心下沉（不改行为）

> 日期：2026-08-03
> 任务：阶段 0，共享核心下沉
> 硬约束：VS Code 形态行为零变化，352 用例不破

## 改动清单（三块独立）

### A. `src/configStore.ts` / `src/activeState.ts`：Uri → string

- 构造参数 `storageDir: vscode.Uri` → `storageDir: string`
- `path.join(storageDir.fsPath, 'configs.json')` → `path.join(storageDir, 'configs.json')`
- 删 `import * as vscode from 'vscode'`
- 调用处 `extension.ts` 传 `context.globalStorageUri.fsPath`（字符串）

### B. `src/claudeLauncher.ts`：抽 `resolveClaudeBinary()` 纯函数

- 把 `resolveBinaryPath()` 的核心逻辑抽成模块级纯函数 `resolveClaudeBinary(opts)`
- 接口：`resolveClaudeBinary({ userOverride?: string; vscodeExtensionPath?: string; platform?: NodeJS.Platform; log?: (m: string) => void }): string | null`
- 探测顺序：① 用户覆盖路径（存在则用）→ ② VS Code 扩展目录 `resources/native-binary/claude[.exe]`（存在则用）→ ③ null
- VS Code 形态的 `resolveBinaryPath()` 改成调它：传 `{ userOverride: 设置值, vscodeExtensionPath: ext?.extensionPath, platform: process.platform, log: this.output.appendLine }`
- **行为零变化**：探测顺序、日志文案、返回值都和现在一致

### C. `src/proxyToggle.ts`：删死 import

- 删 `import * as vscode from 'vscode'`（类体零引用）

## 正交维度分析

### 块 A（Uri → string）

只有一个维度：**构造参数类型变化后路径拼接是否正确**。

- 维度 A1：`storageDir` 字符串直接作为目录，`path.join` 拼出正确文件路径
- 无状态机、无并发、无边界外的复杂逻辑。这是纯机械的类型替换。

### 块 B（resolveClaudeBinary 纯函数）— 主要复杂度在这

独立维度：

- **B1 探测来源优先级**：用户覆盖 > VS Code 扩展 > null。三来源两两组合的优先级。
- **B2 平台二进制名**：win32 → `claude.exe`，其他 → `claude`。
- **B3 路径存在性**：用户覆盖路径不存在时降级到下一来源（不报错中断，记日志继续）；扩展目录下二进制不存在时返回 null。
- **B4 用户覆盖为空/空白**：空字符串、纯空白、undefined 都视为"未设置"，跳过来源①。
- **B5 vscodeExtensionPath 未提供（undefined）**：独立形态未来会用，阶段 0 VS Code 形态传的是 `ext?.extensionPath`（ext 不存在时 undefined）。undefined 时跳过来源②。
- **B6 log 回调可选**：不传 log 时不崩（独立形态/测试可能不传）。

### 块 C（删 import）

无维度。纯删除未使用 import，编译通过即可。

## 高风险维度对照

| 高风险类别 | 是否适用 | 说明 |
|---|---|---|
| 状态转换 | 否 | 无状态机 |
| 异常/错误路径 | 是（B3） | 路径不存在的降级 |
| 时序/竞态 | 否 | 纯同步函数 |
| 空/null/初始态 | 是（B4/B5） | 空覆盖、undefined 扩展路径 |
| 幂等性 | 否 | 无重复事件 |
| 边界输入 | 是（B2/B3） | 平台边界、路径存在性边界 |

## 用例选取（Step 3 依据）

按维度覆盖，每个独立维度 ≥1 用例，高风险维度加边界/非法用例：

- A1：configStore/activeState 用 string 路径构造，load/save 路径正确（其实现有测试已覆盖行为，改类型后跑通即验证）
- B1 优先级：三来源全在 → 用用户覆盖；用户覆盖不存在、扩展在 → 用扩展；都不在 → null
- B2 平台：win32 拼 `claude.exe`，linux/mac 拼 `claude`
- B3 降级：用户覆盖路径不存在 → 记日志 + 降级到扩展；扩展二进制不存在 → null
- B4 空覆盖：空串/纯空白/undefined → 跳过来源①
- B5 undefined 扩展路径：跳过来源② → null
- B6 无 log 回调：不崩

## 范围收缩说明

原设计阶段 0 含"CLI 启动核心 spawn 化"。读 `claudeLauncher.ts` 全文后发现 `createTerminal` 与配置准备逻辑交织，抽 spawn 化会动 `launch()` 主干，超出"不改行为"边界。故阶段 0 的 `claudeLauncher` 部分收缩为**只抽 `resolveClaudeBinary` 纯函数**，CLI 启动 spawn 化推迟到阶段 3（阶段 3 本就是 CLI 会话 spawn）。
