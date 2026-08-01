import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LLMConfig } from './types';
import type { LocalConfigStore, LocalActiveStateStore } from './localConfigStore';
import { ProxyHost, UpstreamEnv } from './proxyHost';
import { writeSettings } from './claudeConfig';
import { extractUpstream, synthesizeProxySettings } from './upstream';
import { resolveDerivedUpstream, computeAliasSyncActions, buildAliasEnv } from './derivedLogic';

/** 官方 Claude Code 扩展 ID（publisher.name，不含版本号，升级后仍有效）。 */
const OFFICIAL_EXTENSION_ID = 'anthropic.claude-code';
/** 扩展安装目录下二进制的相对子路径（各平台一致）。 */
const NATIVE_BINARY_SUBDIR = path.join('resources', 'native-binary');
/** workspace 下独立配置目录名。 */
const WORKSPACE_CONFIG_DIR = '.claude_proxy';

/**
 * 在 VS Code 集成终端里启动一个 workspace 独立的 Claude Code CLI 会话。
 *
 * 通过 `CLAUDE_CONFIG_DIR` 环境变量把会话配置目录指向 `{workspace}/.claude_proxy/`，
 * 使该 workspace 的 Claude 状态独立于全局 `~/.claude/`。启动前把当前 workspace-local
 * active 配置写进该目录的 settings.json（proxy 模式走本地代理合成，与全局 doSwitch 一致）；
 * 无 local active 则不写 settings.json，claude 用默认。不再读取 global activeState。
 *
 * 硬约束：
 * - shell：Windows 强制 PowerShell——启动命令用 PowerShell 调用操作符 `& "path"`，
 *   若默认终端是 Git Bash 会因不认 `&` 报错；统一 PowerShell 保证命令语法正确解析。
 *   （路径转义不是问题：env 进程级注入、settings.json 由扩展写、二进制路径用引号包。）
 *   Linux/macOS 不传 shellPath，用平台默认 shell。
 * - env 用 createTerminal 的 env 选项进程级注入，跨 shell 无需区分语法。
 * - 二进制用完整绝对路径调用，不依赖 PATH。
 */
export class ClaudeLauncher {
    constructor(
        private readonly getLocalStore: () => LocalConfigStore | null,
        private readonly getLocalActiveState: () => LocalActiveStateStore | null,
        private readonly proxyHost: ProxyHost | null,
        private readonly output: vscode.OutputChannel,
    ) {}

    /** 解析 claude 二进制完整路径：用户设置覆盖 → 官方扩展自动探测。失败返回 null。 */
    private resolveBinaryPath(): string | null {
        // 1) 用户设置覆盖
        const override = vscode.workspace
            .getConfiguration('claude-code-proxy')
            .get<string>('claudeBinaryPath') ?? '';
        if (override.trim()) {
            if (fs.existsSync(override)) {
                return override;
            }
            this.output.appendLine(`[launcher] 设置的 claudeBinaryPath 不存在: ${override}`);
        }

        // 2) 官方扩展自动探测
        const ext = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
        if (!ext) {
            this.output.appendLine('[launcher] 未找到官方 anthropic.claude-code 扩展');
            return null;
        }
        const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
        const candidate = path.join(ext.extensionPath, NATIVE_BINARY_SUBDIR, binaryName);
        if (!fs.existsSync(candidate)) {
            this.output.appendLine(`[launcher] 官方扩展已装但二进制缺失: ${candidate}`);
            return null;
        }
        return candidate;
    }

    /**
     * 合成要写入 `.claude_proxy/settings.json` 的内容。
     * - 直连模式：原样使用 cfg.content。
     * - proxy 模式：确保本地代理在跑 + 注入上游 + 合成指向 localhost 的 settings（与 doSwitch 一致）。
     * 返回 null 表示因配置/代理问题应中止（已向用户报错）。
     */
    private async resolveSettingsContent(cfg: LLMConfig): Promise<string | null> {
        const mode = cfg.mode === 'proxy' ? 'proxy' : 'direct';
        if (mode === 'direct') {
            return cfg.content;
        }

        // proxy 模式：复用 doSwitch 的代理注入 + 合成逻辑
        const upstream = extractUpstream(cfg.content);
        if (!upstream || !upstream.env.ANTHROPIC_BASE_URL || !upstream.env.ANTHROPIC_AUTH_TOKEN) {
            void vscode.window.showErrorMessage(
                `'${cfg.name}' 缺少 env.ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN，无法走代理。`,
            );
            return null;
        }
        if (!this.proxyHost) {
            void vscode.window.showErrorMessage('代理尚未初始化');
            return null;
        }
        try {
            await this.proxyHost.ensureRunning();
            const upstreamEnv: UpstreamEnv = {
                baseUrl: upstream.env.ANTHROPIC_BASE_URL,
                token: upstream.env.ANTHROPIC_AUTH_TOKEN,
                model: upstream.env.ANTHROPIC_MODEL,
                smallFastModel: upstream.env.ANTHROPIC_SMALL_FAST_MODEL,
                timeoutSec: upstream.env.API_TIMEOUT_MS
                    ? Math.round(Number(upstream.env.API_TIMEOUT_MS) / 1000)
                    : undefined,
            };
            await this.proxyHost.setUpstream(upstreamEnv);
            // ⚠️ 代理上游是全局共享单例（见 docs/pitfall-proxy-shared-upstream.md）：
            // 若同时有别的 proxy 会话用了不同上游，此处会把全局上游改成本配置的上游，
            // 导致旧会话的请求被转发到错误后端（静默串味，无报错）。记日志便于事后排查。
            this.output.appendLine(
                `[launcher] 已注入全局代理上游: baseUrl=${upstreamEnv.baseUrl} model=${upstreamEnv.model ?? '(unset)'}（来自 local 配置 '${cfg.name}'）。` +
                `注意：代理进程全局共享，若并发的其它 proxy 会话用不同上游，会互相串味。`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`代理模式启动/注入失败: ${msg}`);
            return null;
        }
        const port = this.proxyHost.getPort();
        const synthesized = synthesizeProxySettings(cfg.content, port);
        if (!synthesized) {
            void vscode.window.showErrorMessage(
                `'${cfg.name}' content 不是有效 JSON，无法合成代理 settings。`,
            );
            return null;
        }
        return synthesized;
    }

    /**
     * 往项目级 `.claude/settings.local.json` 合并 `permissions.defaultMode = bypassPermissions`。
     * - 读已有内容 parse（不存在/损坏则从 `{}` 开始），仅当 defaultMode 未设置时写入，保留其余字段。
     * - 已显式设置别的 defaultMode（如 acceptEdits / plan / default）则不覆盖——那是用户为安全
     *   刻意选的，静默降级到 bypassPermissions 会扩大权限且无提示。记日志提示用户自行决定。
     * - 项目级文件跟 workspace 绑定，不污染全局；claude 自动会创建 `.claude/`，这里只补 permissions。
     */
    private async ensureProjectPermissions(workspaceRoot: string): Promise<void> {
        const projectClaudeDir = path.join(workspaceRoot, '.claude');
        const localSettingsPath = path.join(projectClaudeDir, 'settings.local.json');
        let obj: Record<string, unknown> = {};
        try {
            const raw = await fs.promises.readFile(localSettingsPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                obj = parsed as Record<string, unknown>;
            }
        } catch (err: unknown) {
            if (!isENOENT(err)) {
                // 损坏文件：不覆盖用户数据，记日志后跳过 permissions 写入
                this.output.appendLine(`[launcher] ${localSettingsPath} 解析失败，跳过 permissions 写入: ${err instanceof Error ? err.message : String(err)}`);
                return;
            }
            // ENOENT 正常，从空对象开始
        }
        const perms = (obj.permissions && typeof obj.permissions === 'object' && !Array.isArray(obj.permissions)
            ? obj.permissions : {}) as Record<string, unknown>;
        if (perms.defaultMode === 'bypassPermissions') {
            return; // 已经是目标值，不必写
        }
        if (perms.defaultMode !== undefined) {
            // 用户已显式选了别的模式（acceptEdits/plan/default…）——尊重它，不静默降权。
            this.output.appendLine(
                `[launcher] ${localSettingsPath} 已设 permissions.defaultMode=${perms.defaultMode}，保留用户选择，未覆盖为 bypassPermissions。`,
            );
            return;
        }
        perms.defaultMode = 'bypassPermissions';
        obj.permissions = perms;
        await fs.promises.mkdir(projectClaudeDir, { recursive: true });
        await fs.promises.writeFile(localSettingsPath, JSON.stringify(obj, null, 2), 'utf8');
        this.output.appendLine(`[launcher] 已写入项目级 permissions: ${localSettingsPath}`);
    }

    /**
     * 若 workspace 是 git 仓库（检测 .git 目录存在，不依赖 git 命令，跨平台可靠），
     * 且 .gitignore 未忽略 `.claude_proxy`，则追加一行 `.claude_proxy/`。非 git 仓库跳过，
     * 不创建 .gitignore。换行用 LF（跨平台一致），已忽略则不重复追加。
     *
     * 去重判定归一化尾斜杠：`.claude_proxy/` 与 `.claude_proxy` 都算已忽略该目录，
     * 避免用户写了无斜杠版时仍被追加一条重复行。
     */
    private async ensureGitignore(workspaceRoot: string): Promise<void> {
        try {
            const gitDir = path.join(workspaceRoot, '.git');
            if (!fs.existsSync(gitDir)) {
                return; // 非 git 仓库，跳过
            }
            const gitignorePath = path.join(workspaceRoot, '.gitignore');
            let existing = '';
            try {
                existing = await fs.promises.readFile(gitignorePath, 'utf8');
            } catch (err: unknown) {
                if (!isENOENT(err)) { throw err; }
                // 不存在视为空，下面会创建
            }
            // 归一化：去首尾空白 + 去尾斜杠，`./.claude_proxy/` 之类也算同一规则
            const normalize = (s: string) => s.trim().replace(/\/+$/, '').replace(/^\.\//, '');
            const target = normalize('.claude_proxy/');
            const present = existing.split(/\r?\n/).some(l => normalize(l) === target);
            if (present) {
                return; // 已忽略，不重复追加
            }
            const prefix = (existing.length > 0 && !existing.endsWith('\n')) ? '\n' : '';
            const next = `${existing}${prefix}.claude_proxy/\n`;
            await fs.promises.writeFile(gitignorePath, next, 'utf8');
            this.output.appendLine(`[launcher] 已将 .claude_proxy/ 加入 ${gitignorePath}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[launcher] 写 .gitignore 失败（忽略）: ${msg}`);
        }
    }

    /** 启动 workspace 独立 Claude 会话。内部吞掉所有错误并 showErrorMessage，不向调用方抛。 */
    async launch(): Promise<void> {
        try {
            // a. workspace
            const workspace = vscode.workspace.workspaceFolders?.[0];
            if (!workspace) {
                void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
                return;
            }

            // b. 二进制路径
            const binaryPath = this.resolveBinaryPath();
            if (!binaryPath) {
                void vscode.window.showErrorMessage(
                    '未找到 Claude Code CLI。请安装官方 Claude Code 扩展，或在设置 claude-code-proxy.claudeBinaryPath 中指定路径。',
                );
                return;
            }

            // c. 独立配置目录 + gitignore（首次建时若是 git 仓库则把 .claude_proxy/ 加进 .gitignore）
            const workspaceRoot = workspace.uri.fsPath;
            const configDir = path.join(workspaceRoot, WORKSPACE_CONFIG_DIR);
            await this.ensureGitignore(workspaceRoot);
            await fs.promises.mkdir(configDir, { recursive: true });

            // d. 只用 workspace-local active（不再碰 global activeState）
            const localStore = this.getLocalStore();
            const localActiveState = this.getLocalActiveState();
            if (!localStore || !localActiveState) {
                void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
                return;
            }
            const state = await localActiveState.load();
            if (state) {
                const cfg = await localStore.get(state.id);
                if (cfg) {
                    const settingsContent = await this.resolveSettingsContent(cfg);
                    if (settingsContent === null) {
                        return; // 配置/代理问题已报错，中止
                    }
                    const settingsPath = path.join(configDir, 'settings.json');
                    await writeSettings(settingsPath, settingsContent);
                    this.output.appendLine(
                        `[launcher] 已写入 workspace 独立配置: ${settingsPath} (mode=${cfg.mode ?? 'direct'})`,
                    );
                } else {
                    this.output.appendLine(`[launcher] local active id=${state.id} 已不存在，跳过写 settings`);
                }
            } else {
                this.output.appendLine('[launcher] 无 workspace-local active 配置，不写 settings.json，claude 用默认设置');
            }

            // d2. 项目级 permissions：往 {workspace}/.claude/settings.local.json 合并 bypassPermissions
            await this.ensureProjectPermissions(workspace.uri.fsPath);

            // e. 建终端：env 用 createTerminal 的 env 选项进程级注入 CLAUDE_CONFIG_DIR，
            //    跨 shell 无需区分语法、也不经过 shell 解析（路径里的反斜杠/空格不会出转义问题）。
            // Windows 强制 PowerShell：下方 invoke 用 PowerShell 调用操作符 `& $env:CLAUDE_BIN` 启动二进制，
            //   若用户 VS Code 默认终端是 Git Bash，bash 不认 `&` 作调用符会报错；统一 PowerShell 保证
            //   命令语法被正确解析。Linux/macOS 不传 shellPath，用平台默认 shell（bash 直接引号路径即可）。
            //
            // 二进制路径通过 env 注入（CLAUDE_BIN），终端命令只引用环境变量而不内嵌长路径——
            //   避免长路径被 sendText 逐字符发送时终端视觉折行，导致上键历史不完整。
            const isWin = process.platform === 'win32';
            const terminalOptions: vscode.TerminalOptions = {
                name: 'Claude Code (Workspace)',
                cwd: workspace.uri.fsPath,
                env: {
                    CLAUDE_CONFIG_DIR: configDir,
                    CLAUDE_BIN: binaryPath,
                },
            };
            if (isWin) {
                terminalOptions.shellPath = 'powershell.exe';
            }
            const terminal = vscode.window.createTerminal(terminalOptions);
            terminal.show();
            // 命令只引用环境变量，短小精悍，保证终端历史一行完整。
            // PowerShell: & $env:CLAUDE_BIN  |  bash: "$CLAUDE_BIN"
            const invoke = isWin ? '& $env:CLAUDE_BIN' : '"$CLAUDE_BIN"';
            terminal.sendText(invoke, true);

            this.output.appendLine(`[launcher] 已启动 workspace 独立 Claude 会话: ${binaryPath} (shell=${isWin ? 'powershell' : 'default'})`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[launcher] 启动失败: ${msg}`);
            void vscode.window.showErrorMessage(`启动 workspace Claude 会话失败: ${msg}`);
        }
    }

    /**
     * 启动派生节点绑定的 Claude 会话（§6.5 launchDerived）。
     *
     * 与 launch() 区别：跳过 localActiveState，直接用传入的 derivedCfg；继承父上游
     * （快照优先）；三档别名走 shell env（冻结，§5.4）；BASE_URL/token 走 settings.env
     * （沿用 synthesizeProxySettings，不降级安全，§6.6 P4）；启动前同步代理映射表（缺则补）。
     *
     * 终端 name 带 `#N` 标记，供 deleteDerivedConfig 匹配活终端（§6.8 P6）。
     * 内部吞掉所有错误并 showErrorMessage，不向调用方抛。
     */
    async launchDerived(derivedCfg: LLMConfig): Promise<void> {
        try {
            if (!derivedCfg.derivedFrom) {
                void vscode.window.showErrorMessage('该节点不是派生配置（缺少 derivedFrom）');
                return;
            }
            if (derivedCfg.derivedIndex == null) {
                void vscode.window.showErrorMessage('派生节点缺少专属编号，无法构造别名');
                return;
            }

            const localStore = this.getLocalStore();
            if (!localStore) {
                void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
                return;
            }

            // a. 取父配置 + 解上游（快照优先）
            const parentCfg = await localStore.get(derivedCfg.derivedFrom);
            const upstream = resolveDerivedUpstream(derivedCfg, parentCfg ?? null);
            if (!upstream) {
                void vscode.window.showErrorMessage(
                    `派生节点 '${derivedCfg.name}' 无法解析上游：父配置已删且无快照，或父 content 无效。` +
                    `请在派生节点配置页重建，或手动指回有效父配置。`,
                );
                return;
            }

            if (!this.proxyHost) {
                void vscode.window.showErrorMessage('代理尚未初始化');
                return;
            }

            const port = this.proxyHost.getPort();

            // b. 派生节点强制走代理（V7 修复）：别名 ccp-*-N 只有经代理才会被 rewriteModel 重写为
            //    真实模型名。直连模式下别名原样打到上游 → 真实 LLM 不认识 → model not found。
            //    故不论父 mode，launchDerived 一律 ensureRunning + 注入父上游 + BASE_URL 指代理。
            //    direct 父的派生节点也经代理（代理 passthrough=false 时仍只重试 503+10310，
            //    其余透传，行为近乎直连但多了别名重写这一层）。
            await this.proxyHost.ensureRunning();
            await this.proxyHost.setUpstream({
                baseUrl: upstream.baseUrl,
                token: upstream.token,
                timeoutSec: upstream.timeoutSec,
            } as UpstreamEnv);
            // 上游一致性警告：代理上游全局共享 last-write-wins，并发不同上游会串味（§6.9 P5）
            this.output.appendLine(
                `[launcher] 派生节点 '${derivedCfg.name}' 已注入全局代理上游: ${upstream.baseUrl}。` +
                `注意：代理进程全局共享，若并发的其它 proxy 会话用不同上游，会互相串味。`,
            );

            // c. 同步代理映射表：缺则补（§6.5 步骤6）。权威在代理，本地 modelAliases 只是缓存。
            try {
                const proxyAliases = await this.proxyHost.getModelAliases();
                const actions = computeAliasSyncActions(derivedCfg, proxyAliases);
                for (const a of actions.toSet) {
                    await this.proxyHost.setModelAlias(a.alias, a.model);
                }
                if (actions.toSet.length > 0) {
                    this.output.appendLine(`[launcher] 已补 ${actions.toSet.length} 条别名映射到代理表`);
                }
            } catch (err) {
                // 同步失败不阻断启动——别名未补的档会原样透传（§3.6），用户可后续在配置页补
                const msg = err instanceof Error ? err.message : String(err);
                this.output.appendLine(`[launcher] 同步代理映射表失败（已忽略，继续启动）: ${msg}`);
            }

            // d. 合成 settings.json：BASE_URL 恒指代理（派生节点强制 proxy），token 走 settings.env，
            //    三档别名走 shell env（不进 settings，§5.4 冻结前提）
            const settingsContent = this.synthesizeDerivedSettings(derivedCfg, parentCfg, upstream, port);
            if (settingsContent === null) {
                void vscode.window.showErrorMessage(
                    `派生节点 '${derivedCfg.name}' 无法合成 settings：父 content 不是有效 JSON。`,
                );
                return;
            }

            // e. workspace + 二进制 + 独立配置目录
            const workspace = vscode.workspace.workspaceFolders?.[0];
            if (!workspace) {
                void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
                return;
            }
            const binaryPath = this.resolveBinaryPath();
            if (!binaryPath) {
                void vscode.window.showErrorMessage(
                    '未找到 Claude Code CLI。请安装官方 Claude Code 扩展，或在设置 claude-code-proxy.claudeBinaryPath 中指定路径。',
                );
                return;
            }
            const workspaceRoot = workspace.uri.fsPath;
            const configDir = path.join(workspaceRoot, WORKSPACE_CONFIG_DIR);
            await this.ensureGitignore(workspaceRoot);
            await fs.promises.mkdir(configDir, { recursive: true });
            const settingsPath = path.join(configDir, 'settings.json');
            await writeSettings(settingsPath, settingsContent);
            await this.ensureProjectPermissions(workspaceRoot);
            this.output.appendLine(`[launcher] 已写入派生节点 settings: ${settingsPath}`);

            // f. 起终端：三档别名走 shell env（冻结），CLAUDE_CONFIG_DIR/CLAUDE_BIN 同 launch()
            //    终端 name 带 #N 供 deleteDerivedConfig 匹配活终端
            const isWin = process.platform === 'win32';
            const idx = derivedCfg.derivedIndex;
            // 别名是否带 [1m]：派生节点存了 sessionContext1m 则用之，否则默认不带（200K，约束 3）。
            // 该标志决定 CLI 按 1M 还是 200K 算 contextWindow（[1m] 是 CLI 识别档位的唯一信号）。
            const with1m = derivedCfg.sessionContext1m === true;
            const aliasEnv = buildAliasEnv(idx, { with1m });
            const terminalOptions: vscode.TerminalOptions = {
                name: `Claude Code #${idx} (${derivedCfg.name})`,
                cwd: workspaceRoot,
                env: {
                    CLAUDE_CONFIG_DIR: configDir,
                    CLAUDE_BIN: binaryPath,
                    CCP_DERIVED_ID: String(idx),
                    ...aliasEnv,
                },
            };
            if (isWin) {
                terminalOptions.shellPath = 'powershell.exe';
            }
            const terminal = vscode.window.createTerminal(terminalOptions);
            terminal.show();
            const invoke = isWin ? '& $env:CLAUDE_BIN' : '"$CLAUDE_BIN"';
            terminal.sendText(invoke, true);

            this.output.appendLine(
                `[launcher] 已启动派生节点 Claude 会话: ${derivedCfg.name} #${idx} (mode=proxy·forced, aliases=${Object.values(aliasEnv).join(',')})`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[launcher] 派生节点启动失败: ${msg}`);
            void vscode.window.showErrorMessage(`派生节点启动失败: ${msg}`);
        }
    }

    /**
     * 合成派生节点的 settings.json 内容（§6.6）。
     * - 以父 content 为基底（保留 permissions 等非 env 字段）。
     * - 覆盖 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 为 resolveDerivedUpstream 的结果
     *   （快照优先，故父 token 轮换不污染派生节点）。
     * - BASE_URL 恒指代理 http://127.0.0.1:<port>（派生节点强制 proxy，V7 修复——
     *   别名只有经代理 rewriteModel 才会被重写为真实模型名）。
     * - **不写入三档别名**（别名走 shell env，settings.env 不含同名 key 是 §5.4 冻结前提）。
     * - 父 content 无效 JSON 且无快照 → null（调用方报错）。
     */
    private synthesizeDerivedSettings(
        derivedCfg: LLMConfig,
        parentCfg: LLMConfig | undefined,
        upstream: { baseUrl: string; token: string; timeoutSec?: number; mode: string },
        port: number,
    ): string | null {
        // 优先用父 content 作基底；父缺/父 content 无效则从最小骨架起（upstream 已由 resolveDerivedUpstream
        // 解析——快照存在时不依赖父 content，故父 content 无效不应阻断合成）。
        let obj: Record<string, unknown>;
        if (parentCfg) {
            const parsed = extractUpstream(parentCfg.content);
            obj = parsed ? parsed.obj : {};
        } else {
            obj = {};
        }
        const env = { ...((obj.env as Record<string, string> | undefined) ?? {}) };
        env.ANTHROPIC_AUTH_TOKEN = upstream.token;
        env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
        if (upstream.timeoutSec != null) {
            env.API_TIMEOUT_MS = String(Math.round(upstream.timeoutSec * 1000));
        }
        // 显式删除可能残留的别名 key（防父 content 恰好带同名 key 破坏 §5.4 冻结前提）。
        // 四档别名均走 shell env（buildAliasEnv），settings.env 不能含同名 key，否则 shell env 被覆盖、
        // 别名失效。ANTHROPIC_MODEL 尤其要删：父 content 的真名若留在 settings.env，会覆盖 shell env 的
        // ccp-main-N 别名，导致主对话模型不经代理重写（约束 4/§5.4）。
        delete env.ANTHROPIC_MODEL;
        delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
        obj.env = env;
        return JSON.stringify(obj, null, 2);
    }
}

function isENOENT(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
