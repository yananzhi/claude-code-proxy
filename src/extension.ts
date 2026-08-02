import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LLMConfig } from './types';
import { ConfigStore, newId } from './configStore';
import { ActiveStateStore } from './activeState';
import { ProxyToggleStore } from './proxyToggle';
import { ProxyHost } from './proxyHost';
import { ConfigTreeProvider, findActiveConfig, getOverridePath, getConfigFromNode } from './treeProvider';
import { WebviewEditor } from './webviewEditor';
import { backupSettings, detectPlatform, readSettings, writeSettings } from './claudeConfig';
import { extractUpstream, synthesizeProxySettings } from './upstream';
import { ClaudeLauncher } from './claudeLauncher';
import { migrateFromLegacy } from './migrate';
import { LocalConfigStore, LocalActiveStateStore } from './localConfigStore';

// 模块级，供 deactivate 停止代理
let proxyHost: ProxyHost | null = null;

export function activate(context: vscode.ExtensionContext): void {
    // VS Code 扩展宿主的 @vscode/proxy-agent 会劫持 http.get/request，把发往本地 127.0.0.1 的
    // 请求也可能走系统代理 / 改成绝对路径请求行，导致代理路由失配（返回 200 空 body）。
    // 显式声明 NO_PROXY 绕过本地回环，确保扩展调代理接口直连。
    // 必须在任何 http 调用之前执行（activate 最顶部）。
    const localBypass = '127.0.0.1,localhost';
    process.env.NO_PROXY = process.env.NO_PROXY ? `${process.env.NO_PROXY},${localBypass}` : localBypass;
    process.env.no_proxy = process.env.no_proxy ? `${process.env.no_proxy},${localBypass}` : localBypass;

    // 扩展改名 cc-switch → claude-code-proxy 后，旧 globalStorage 数据读不到。
    // 同步迁移：必须在 ConfigStore/ActiveStateStore 首次 load() 之前完成，否则 cache 读到空目录。
    const migrated = migrateFromLegacy(context.globalStorageUri);
    if (migrated) {
        console.log('[claude-code-proxy] 已从旧 cc-switch 命名空间迁移 configs.json + active.json');
    }

    const store = new ConfigStore(context.globalStorageUri);
    const activeState = new ActiveStateStore(context.globalStorageUri);
    const proxyToggle = new ProxyToggleStore();
    const output = vscode.window.createOutputChannel('Claude Code Proxy');
    context.subscriptions.push(output);
    proxyHost = new ProxyHost(context, output, proxyToggle);

    // workspace-local 存储随 workspace 切换重建；模块级引用供 launcher/editor 取当前实例
    let localStore: LocalConfigStore | null = null;
    let localActiveState: LocalActiveStateStore | null = null;

    function workspaceRoot(): string | null {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    }

    function applyWorkspace(): void {
        const root = workspaceRoot();
        if (root) {
            localStore = new LocalConfigStore(root);
            localActiveState = new LocalActiveStateStore(root);
        } else {
            localStore = null;
            localActiveState = null;
        }
        // treeProvider 与 webviewEditor/launcher 共享同一 local store 实例，保证 cache 一致
        treeProvider.setWorkspaceRoot(localStore, localActiveState);
    }

    const launcher = new ClaudeLauncher(
        () => localStore,
        () => localActiveState,
        proxyHost,
        output,
    );

    const treeProvider = new ConfigTreeProvider(store, activeState);
    applyWorkspace();

    const treeView = vscode.window.createTreeView('claude-code-proxy.configs', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // workspace 变化：重建 local store + 刷新树
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            applyWorkspace();
            void refresh();
        }),
    );

    const refresh = async (): Promise<void> => {
        treeProvider.refresh();
        await updateStatusBar();
    };

    const editor = new WebviewEditor(store, {
        onSaved: () => { void refresh(); },
        switchConfig: (cfg) => doSwitch(cfg),
        switchLocalConfig: (cfg) => doLocalSwitch(cfg),
        getLocalStore: () => localStore,
        loadGlobalConfigs: () => store.load(),
        launchDerived: (cfg) => launcher.launchDerived(cfg),
        getProxyHost: () => proxyHost,
        refresh: () => { void refresh(); },
    });

    // --- Status bar indicator ---
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusItem.command = 'claude-code-proxy.openView';
    statusItem.tooltip = 'Claude Code Proxy — click to open';
    context.subscriptions.push(statusItem);

    async function updateStatusBar(): Promise<void> {
        const configs = await store.load();
        const state = await activeState.load();
        let active: LLMConfig | undefined;
        if (state) {
            active = configs.find(c => c.id === state.id);
        }
        if (!active) {
            // 回退到 content 匹配（兼容老安装/直连）
            const platform = detectPlatform(getOverridePath());
            active = (await findActiveConfig(configs, platform.configPath)) ?? undefined;
        }
        const modeLabel = active?.mode === 'proxy' ? '代理' : '直连';
        statusItem.text = `$(arrow-swap) CC: ${active ? active.name : 'none'}${active ? ` (${modeLabel})` : ''}`;
        statusItem.show();
    }

    // --- Switch flow: read → backup → overwrite → toast(Reload + Undo) ---
    async function doSwitch(cfg: LLMConfig): Promise<void> {
        if (!cfg || typeof cfg.content !== 'string') {
            void vscode.window.showErrorMessage('Invalid config — missing content. Try editing and re-saving it.');
            return;
        }
        const platform = detectPlatform(getOverridePath());
        const configPath = platform.configPath;
        const mode = cfg.mode === 'proxy' ? 'proxy' : 'direct';

        // 代理模式：先确保代理在跑 + 注入上游
        let settingsContent = cfg.content;
        if (mode === 'proxy') {
            const upstream = extractUpstream(cfg.content);
            if (!upstream || !upstream.env.ANTHROPIC_BASE_URL || !upstream.env.ANTHROPIC_AUTH_TOKEN) {
                void vscode.window.showErrorMessage(`'${cfg.name}' 缺少 env.ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN，无法走代理。`);
                return;
            }
            if (!proxyHost) {
                void vscode.window.showErrorMessage('代理尚未初始化');
                return;
            }
            try {
                await proxyHost.ensureRunning();
                await proxyHost.setUpstream({
                    baseUrl: upstream.env.ANTHROPIC_BASE_URL,
                    token: upstream.env.ANTHROPIC_AUTH_TOKEN,
                    model: upstream.env.ANTHROPIC_MODEL,
                    smallFastModel: upstream.env.ANTHROPIC_SMALL_FAST_MODEL,
                    timeoutSec: upstream.env.API_TIMEOUT_MS ? Math.round(Number(upstream.env.API_TIMEOUT_MS) / 1000) : undefined,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`代理模式启动/注入失败: ${msg}`);
                return;
            }
            const port = proxyHost.getPort();
            const synthesized = synthesizeProxySettings(cfg.content, port);
            if (!synthesized) {
                void vscode.window.showErrorMessage(`'${cfg.name}' content 不是有效 JSON，无法合成代理 settings。`);
                return;
            }
            settingsContent = synthesized;
        }

        const previous = await readSettings(configPath);
        let backupPath: string | null = null;
        try {
            backupPath = await backupSettings(configPath);
            await writeSettings(configPath, settingsContent);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Failed to switch to '${cfg.name}': ${msg}`);
            return;
        }

        await activeState.write(cfg.id, mode);
        await refresh();

        const choice = await vscode.window.showInformationMessage(
            `Switched to '${cfg.name}' (${platform.label}${mode === 'proxy' ? ', 经代理' : ', 直连'}).`,
            'Reload Window',
            'Undo',
        );
        if (choice === 'Reload Window') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else if (choice === 'Undo') {
            await undoSwitch(configPath, previous, backupPath);
            await refresh();
        }
    }

    async function undoSwitch(
        configPath: string,
        previous: string | null,
        backupPath: string | null,
    ): Promise<void> {
        try {
            if (previous !== null) {
                await writeSettings(configPath, previous);
            } else {
                await fs.promises.unlink(configPath);
            }
            await activeState.clear();
            void vscode.window.showInformationMessage(
                `Reverted. Previous config restored${backupPath ? ` from ${backupPath}` : ''}.`,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showWarningMessage(`Undo failed: ${msg}${backupPath ? ` — backup at ${backupPath}` : ''}`);
        }
    }

    /**
     * workspace-local 配置切换：纯标记。
     * 只记 local-active.json（id+mode），不写任何 settings.json、不 reload。
     * launcher 启动时读此标记 → 取对应 local 配置 → 写 .claude_proxy/settings.json 再起 claude。
     * proxy 模式也只标记，注入上游推迟到 launcher 启动时。
     */
    async function doLocalSwitch(cfg: LLMConfig): Promise<void> {
        if (!cfg || typeof cfg.content !== 'string') {
            void vscode.window.showErrorMessage('Invalid local config — missing content.');
            return;
        }
        if (!localActiveState) {
            void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
            return;
        }
        const mode = cfg.mode === 'proxy' ? 'proxy' : 'direct';
        await localActiveState.write(cfg.id, mode);
        await refresh();
        const modeLabel = mode === 'proxy' ? '经代理' : '直连';
        void vscode.window.showInformationMessage(
            `Local active → '${cfg.name}' (${modeLabel})。下次启动 workspace Claude 会话时生效。`,
        );
    }

    /** Resolve the LLMConfig from a command argument.
     *  - Clicking a tree row passes the LLMConfig directly via arguments.
     *  - Inline/context menus pass the TreeItem itself, so we look it up.
     */
    function resolveConfig(arg: unknown): LLMConfig | undefined {
        if (!arg) { return undefined; }
        // Direct LLMConfig (from TreeItem.command.arguments)
        if (typeof arg === 'object' && 'id' in arg && 'name' in arg && 'content' in arg) {
            return arg as LLMConfig;
        }
        // TreeItem from context/inline menu
        if (arg instanceof vscode.TreeItem) {
            return getConfigFromNode(arg);
        }
        return undefined;
    }

    async function pickConfig(action: string): Promise<LLMConfig | undefined> {
        const configs = await store.load();
        if (configs.length === 0) {
            void vscode.window.showInformationMessage('No configs yet. Create one first.');
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            configs.map(c => ({ label: c.name, description: c.id, config: c })),
            { placeHolder: `Select a config to ${action}` },
        );
        return picked?.config;
    }

    async function pickLocalConfig(action: string): Promise<LLMConfig | undefined> {
        if (!localStore) {
            void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
            return undefined;
        }
        const configs = await localStore.load();
        if (configs.length === 0) {
            void vscode.window.showInformationMessage('No workspace-local configs yet. Create one first.');
            return undefined;
        }
        const picked = await vscode.window.showQuickPick(
            configs.map(c => ({ label: c.name, description: c.id, config: c })),
            { placeHolder: `Select a local config to ${action}` },
        );
        return picked?.config;
    }

    /**
     * 删派生节点 + 清代理映射表四条（main + 三档）+ 关联处理活终端（§6.8 P6 + 优化 2）。
     * - 清映射：调 removeModelAlias 删 ccp-{main,haiku,sonnet,opus}-N（缺则忽略）。
     * - 活终端：按终端 name 含 `#N` 或 env CCP_DERIVED_ID=N 匹配，弹确认一并关闭。
     *   匹配靠终端 name（createTerminal 的 name 含 #N），env 无法事后读，故以 name 为准。
     */
    async function deleteDerivedAndAliases(derivedCfg: LLMConfig): Promise<void> {
        if (!localStore) {
            return;
        }
        const idx = derivedCfg.derivedIndex;
        // 关联活终端：按终端 name 含 `#N` 匹配。
        // 用 `#N` 后非数字断言（?!\\d）避免 #2 误匹配 #20/#21 等（终端 name 形如 `Claude Code #2 (xxx)`）。
        if (idx != null) {
            const idxRe = new RegExp(`#${idx}(?![0-9])`);
            const liveTerminals = vscode.window.terminals.filter(t => idxRe.test(t.name));
            if (liveTerminals.length > 0) {
                const choice = await vscode.window.showWarningMessage(
                    `派生节点 #${idx} 仍有 ${liveTerminals.length} 个终端在运行，是否一并关闭？（不关闭的终端映射被清后会请求失败）`,
                    { modal: true },
                    '一并关闭终端',
                    '保留终端',
                );
                if (choice === '一并关闭终端') {
                    for (const t of liveTerminals) {
                        t.dispose();
                    }
                }
            }
        }
        // 清代理映射表四条（main + 三档，优化 2 main 档）
        if (idx != null && proxyHost) {
            for (const tier of ['main', 'haiku', 'sonnet', 'opus'] as const) {
                const alias = `ccp-${tier}-${idx}`;
                try {
                    await proxyHost.removeModelAlias(alias);
                } catch (err) {
                    // 代理未运行/别名不存在均忽略——删本地节点不应被代理状态阻断
                    const msg = err instanceof Error ? err.message : String(err);
                    output.appendLine(`[deleteDerived] 清除映射 ${alias} 失败（已忽略）: ${msg}`);
                }
            }
        }
        await localStore.remove(derivedCfg.id);
    }

    /** 取派生节点的父配置（用于 newDerivedConfig 选父）。 */
    async function pickLocalParentConfig(action: string): Promise<LLMConfig | undefined> {
        return pickLocalConfig(action);
    }

    // --- Commands: global configs ---
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.newConfig', () => {
            void editor.openNewGlobal();
        }),

        vscode.commands.registerCommand('claude-code-proxy.editConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickConfig('edit').then(c => { if (c) { void editor.openEditGlobal(c); } });
                return;
            }
            void editor.openEditGlobal(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.switchConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickConfig('switch to').then(c => { if (c) { void doSwitch(c); } });
                return;
            }
            void doSwitch(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.deleteConfig', async (arg?: LLMConfig | vscode.TreeItem) => {
            const target = resolveConfig(arg) ?? await pickConfig('delete');
            if (!target) {
                return;
            }
            await store.remove(target.id);
            await refresh();
        }),

        // --- Commands: workspace-local configs ---
        vscode.commands.registerCommand('claude-code-proxy.newLocalConfig', () => {
            void editor.openNewLocal();
        }),

        vscode.commands.registerCommand('claude-code-proxy.editLocalConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickLocalConfig('edit').then(c => { if (c) { void editor.openEditLocal(c); } });
                return;
            }
            void editor.openEditLocal(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.switchLocalConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void pickLocalConfig('switch to').then(c => { if (c) { void doLocalSwitch(c); } });
                return;
            }
            void doLocalSwitch(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.deleteLocalConfig', async (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg) ?? await pickLocalConfig('delete');
            if (!cfg || !localStore) {
                return;
            }
            // 父删级联（§6.5 P1）：扫派生节点，弹确认一并删 + 清代理映射表三条
            const derived = await localStore.getDerivedByParent(cfg.id);
            if (derived.length > 0) {
                const choice = await vscode.window.showWarningMessage(
                    `'${cfg.name}' 下有 ${derived.length} 个派生节点。删除父配置会使它们成为孤儿。是否一并删除这些派生节点？`,
                    { modal: true },
                    '一并删除',
                    '仅删父配置（派生留为孤儿）',
                );
                if (choice === '一并删除') {
                    for (const d of derived) {
                        await deleteDerivedAndAliases(d);
                    }
                }
            }
            await localStore.remove(cfg.id);
            // 删的若正是 active，清掉标记
            const state = await localActiveState?.load();
            if (state && state.id === cfg.id) {
                await localActiveState?.clear();
            }
            await refresh();
        }),

        // --- Commands: derived (派生虚拟配置节点) ---
        // 新建派生节点：选父 local 配置 → 向代理 nextAliasId 申请编号 N → 打开配置页
        vscode.commands.registerCommand('claude-code-proxy.newDerivedConfig', async (arg?: LLMConfig | vscode.TreeItem) => {
            if (!localStore) {
                void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
                return;
            }
            const parent = resolveConfig(arg) ?? await pickLocalParentConfig('作为派生节点的父配置');
            if (!parent) {
                return;
            }
            if (!proxyHost) {
                void vscode.window.showErrorMessage('代理尚未初始化，无法申请编号');
                return;
            }
            let idx: number;
            try {
                idx = await proxyHost.nextAliasId();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`向代理申请编号失败: ${msg}`);
                return;
            }
            const name = `${parent.name} #${idx}`;
            void editor.openNewDerived(parent, idx, name);
        }),

        vscode.commands.registerCommand('claude-code-proxy.editDerivedConfig', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void vscode.window.showWarningMessage('请从树视图的派生节点上打开编辑');
                return;
            }
            void editor.openEditDerived(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.launchDerivedClaude', (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg) {
                void vscode.window.showWarningMessage('请从树视图的派生节点上启动');
                return;
            }
            void launcher.launchDerived(cfg);
        }),

        vscode.commands.registerCommand('claude-code-proxy.deleteDerivedConfig', async (arg?: LLMConfig | vscode.TreeItem) => {
            const cfg = resolveConfig(arg);
            if (!cfg || !localStore) {
                return;
            }
            await deleteDerivedAndAliases(cfg);
            await refresh();
        }),

        // 一键导入所有 Global LLM Config 到 Workspace Local（跳过同名/同 id 重复项）
        vscode.commands.registerCommand('claude-code-proxy.importGlobalToLocal', async () => {
            if (!localStore) {
                void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
                return;
            }
            const globalConfigs = await store.load();
            if (globalConfigs.length === 0) {
                void vscode.window.showInformationMessage('Global 配置为空，没有可导入的项。');
                return;
            }
            const localConfigs = await localStore.load();
            const localIds = new Set(localConfigs.map(c => c.id));
            const localNames = new Set(localConfigs.map(c => c.name));
            let added = 0;
            let skipped = 0;
            for (const g of globalConfigs) {
                if (localIds.has(g.id) || localNames.has(g.name)) {
                    skipped++;
                    continue;
                }
                // 生成新 id 避免与 local 已有的冲突（即使 name 不重复，id 可能碰巧相同）
                const cfg: LLMConfig = {
                    ...g,
                    id: localIds.has(g.id) ? newId() : g.id,
                    updatedAt: new Date().toISOString(),
                };
                localConfigs.push(cfg);
                localIds.add(cfg.id);
                localNames.add(cfg.name);
                added++;
            }
            if (added === 0) {
                void vscode.window.showInformationMessage(
                    `所有 ${globalConfigs.length} 条 Global 配置已存在于 Workspace Local 中，无需导入。`,
                );
                return;
            }
            await localStore.save(localConfigs);
            await refresh();
            const parts = [`已导入 ${added} 条 Global 配置到 Workspace Local。`];
            if (skipped > 0) {
                parts.push(`${skipped} 条跳过（同名或同 id 重复）。`);
            }
            void vscode.window.showInformationMessage(parts.join(' '));
        }),

        vscode.commands.registerCommand('claude-code-proxy.refresh', () => {
            void refresh();
        }),

        vscode.commands.registerCommand('claude-code-proxy.openView', () => {
            void vscode.commands.executeCommand('claude-code-proxy.configs.focus');
        }),

        // --- Export all configs to a JSON file ---
        vscode.commands.registerCommand('claude-code-proxy.exportConfigs', async () => {
            const configs = await store.load();
            if (configs.length === 0) {
                void vscode.window.showInformationMessage('No configs to export.');
                return;
            }
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file('claude-code-proxy-configs.json'),
                filters: { 'JSON': ['json'] },
                title: 'Export Configs',
            });
            if (!uri) {
                return;
            }
            const payload = new TextEncoder().encode(JSON.stringify({ version: 1, configs }, null, 2));
            try {
                await vscode.workspace.fs.writeFile(uri, payload);
                void vscode.window.showInformationMessage(`Exported ${configs.length} config(s) to ${uri.fsPath || uri.toString()}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Export failed: ${msg}`);
            }
        }),

        // --- Import configs from a JSON file (skip duplicates by id) ---
        vscode.commands.registerCommand('claude-code-proxy.importConfigs', async () => {
            const uris = await vscode.window.showOpenDialog({
                filters: { 'JSON': ['json'] },
                title: 'Import Configs',
                canSelectMany: false,
            });
            if (!uris || uris.length === 0) {
                return;
            }
            let raw: string;
            try {
                // Use vscode.workspace.fs for cross-remote compatibility (WSL, SSH, etc.)
                const content = await vscode.workspace.fs.readFile(uris[0]);
                raw = new TextDecoder('utf8').decode(content);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Failed to read file: ${msg}`);
                return;
            }
            let data: unknown;
            try {
                data = JSON.parse(raw);
            } catch {
                void vscode.window.showErrorMessage('Invalid JSON file.');
                return;
            }
            // Accept both wrapped { version, configs } and bare LLMConfig[]
            let imported: LLMConfig[];
            if (Array.isArray(data)) {
                imported = data;
            } else if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).configs)) {
                imported = (data as { configs: LLMConfig[] }).configs;
            } else {
                void vscode.window.showErrorMessage('Unrecognized format. Expected { version, configs } or a JSON array.');
                return;
            }
            if (imported.length === 0) {
                void vscode.window.showInformationMessage('No configs found in the file.');
                return;
            }
            const existing = await store.load();
            const existingIds = new Set(existing.map(c => c.id));
            let added = 0;
            let skipped = 0;
            for (const cfg of imported) {
                if (!cfg || !cfg.id || !cfg.name || typeof cfg.content !== 'string') {
                    skipped++;
                    continue;
                }
                if (existingIds.has(cfg.id)) {
                    skipped++;
                    continue;
                }
                // Ensure updatedAt has a valid value
                if (!cfg.updatedAt) {
                    cfg.updatedAt = new Date().toISOString();
                }
                existing.push(cfg);
                existingIds.add(cfg.id);
                added++;
            }
            await store.save(existing);
            await refresh();
            const parts = [`Imported ${added} config(s).`];
            if (skipped > 0) {
                parts.push(`${skipped} skipped (duplicate or invalid).`);
            }
            void vscode.window.showInformationMessage(parts.join(' '));
        }),
    );

    // React to override-path setting changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('claude-code-proxy.configFilePath')) {
                void refresh();
            }
        }),
    );

    // 打开代理 Web 控制台（重试参数 + trace）
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.openProxyUI', async () => {
            const port = proxyHost?.getPort() ?? 11434;
            await vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port}/`));
        }),
    );

    // Kill 代理：任意窗口都能调，关闭 11434 上的代理监听，宿主心跳 2s 内自动重起
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.killProxy', async () => {
            if (!proxyHost) {
                void vscode.window.showWarningMessage('代理尚未初始化');
                return;
            }
            const result = await proxyHost.kill();
            if (result.ok) {
                void vscode.window.showInformationMessage(result.message);
            } else {
                void vscode.window.showWarningMessage(result.message);
            }
        }),
    );

    // 启动 workspace 独立 Claude CLI 会话：CLAUDE_CONFIG_DIR 指向 {workspace}/.claude_proxy/，
    // 继承当前激活配置（proxy 模式走本地代理）。工具栏按钮 + 快捷键 + 命令面板三入口。
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.launchWorkspaceClaude', () => {
            void launcher.launch();
        }),
    );

    // 同步「backup proxy 开关」上下文键，供树视图标题栏按钮用 when 子句切换开/关图标
    async function syncProxyToggleContext(): Promise<void> {
        const enabled = proxyToggle.isEnabled();
        await vscode.commands.executeCommand('setContext', 'claude-code-proxy.proxyToggleEnabled', enabled);
    }

    // backup proxy 本窗口开关（树视图标题栏按钮 + 命令面板）。只控本窗口，不管其他窗口是否接管。
    // 关：本窗口若是宿主则停进程，此后心跳不接管。开：复用其他窗口或自己起。
    context.subscriptions.push(
        vscode.commands.registerCommand('claude-code-proxy.toggleProxyBackup', async () => {
            if (!proxyHost) {
                void vscode.window.showWarningMessage('代理尚未初始化');
                return;
            }
            const next = !proxyHost.isToggleEnabled();
            const result = await proxyHost.setEnabled(next);
            await syncProxyToggleContext();
            if (result.enabled) {
                void vscode.window.showInformationMessage(result.message);
            } else {
                void vscode.window.showWarningMessage(result.message);
            }
        }),
        // 标题栏两个图标按钮各自指向同一 toggle 逻辑（按钮本身是开/关的视觉态）
        vscode.commands.registerCommand('claude-code-proxy.toggleProxyBackupOn', () => {
            void vscode.commands.executeCommand('claude-code-proxy.toggleProxyBackup');
        }),
        vscode.commands.registerCommand('claude-code-proxy.toggleProxyBackupOff', () => {
            void vscode.commands.executeCommand('claude-code-proxy.toggleProxyBackup');
        }),

        // 诊断：回归工具——怀疑代理接口拿空 body 时一键定位。
        // 真因已查清（2026-08-01）：扩展宿主 http 栈对 127.0.0.1 响应 body 一律吞（chunked/Content-Length 均不投递 data）；
        // 所有 wrapper 已改裸 socket（rawHttp），本命令验证 rawHttp 是否正常 + 对照 http 栈仍吞。
        vscode.commands.registerCommand('claude-code-proxy.diagProxyHttp', async () => {
            if (!proxyHost) {
                void vscode.window.showErrorMessage('代理尚未初始化');
                return;
            }
            try { await proxyHost.ensureRunning(); } catch (e) {
                void vscode.window.showErrorMessage(`代理未运行: ${(e as Error).message}`);
                return;
            }
            const port = proxyHost.getPort();
            const lines: string[] = [`=== 代理接口诊断 port=${port} ${new Date().toISOString()} ===`];
            const envSnapshot = {
                HTTP_PROXY: process.env.HTTP_PROXY ?? '(unset)',
                HTTPS_PROXY: process.env.HTTPS_PROXY ?? '(unset)',
                NO_PROXY: process.env.NO_PROXY ?? '(unset)',
            };
            lines.push(`env: ${JSON.stringify(envSnapshot)}`);

            // [1] getModelAliases wrapper（rawHttp，生产路径）—— 应拿到非空映射表
            lines.push('[1] getModelAliases() wrapper（rawHttp，生产路径）');
            try {
                const map = await proxyHost.getModelAliases();
                lines.push(`ok: ${Object.keys(map).length} 条映射, keys=${JSON.stringify(Object.keys(map).slice(0, 5))}`);
            } catch (e) {
                lines.push(`error: ${(e as Error).message}`);
            }
            // [2] nextAliasId wrapper（rawHttp）—— 应拿到数字
            lines.push('[2] nextAliasId() wrapper（rawHttp）');
            try {
                const id = await proxyHost.nextAliasId();
                lines.push(`ok: id=${id}`);
            } catch (e) {
                lines.push(`error: ${(e as Error).message}`);
            }
            // [3] http.get 对照（被测：扩展宿主 http 栈）—— 应 rawLen=0（吞 body），证明为何用裸 socket
            lines.push('[3] http.get 对照（扩展宿主 http 栈，应 rawLen=0）');
            lines.push(await proxyHost.diagHttpGet('/api/config', { withNoProxy: true }));
            // [4] setModelAlias + 读回（rawHttp 全链路）—— 应写入并读回
            const diagAlias = `ccp-diag-test-${port}`;
            lines.push(`[4] setModelAlias(${diagAlias}) + getModelAliases 读回`);
            try {
                await proxyHost.setModelAlias(diagAlias, 'diag-model');
                const map = await proxyHost.getModelAliases();
                const hit = map[diagAlias];
                lines.push(`ok: 写入=${hit === 'diag-model' ? '是' : '否'}（map[${diagAlias}]=${JSON.stringify(hit)}）`);
            } catch (e) {
                lines.push(`error: ${(e as Error).message}`);
            }
            // 清理测试映射
            try { await proxyHost.removeModelAlias(diagAlias); } catch { /* 诊断清理，忽略 */ }

            const report = lines.join('\n');
            output.appendLine(report);
            void vscode.window.showInformationMessage(
                '代理接口诊断完成，详见 Claude Code Proxy output 面板。' +
                ' 判读：[1][2][4]ok + [3]http.get rawLen=0 = 裸 socket 全链路正常、http 栈仍吞（预期）。',
            );
        }),

        // V1 探针（临时验证用，验证完删除）：在扩展宿主里 spawn 独立 server.js 子进程，
        // 验证 process.execPath 身份 + ESM 加载 + 裸 socket 拿 body。详见 docs/server独立进程化调研.md。
        // 命令 + activate 自动跑 两条路都指向 runV1Probe，结果落盘 v1-probe-result.txt。
        vscode.commands.registerCommand('claude-code-proxy.probeSpawnServer', () => {
            void runV1Probe(context);
        }),
    );
    void syncProxyToggleContext();
    void proxyHost?.activate();

    void refresh();

    // activate 末尾自动跑 V1 探针，结果落盘 v1-probe-result.txt（不依赖命令面板/Output/Console）。
    void runV1Probe(context);
}

/**
 * V1 探针（临时，验证完删除）：在扩展宿主里 spawn 独立 server.js 子进程。
 * 验证：process.execPath 身份（Electron/纯Node）+ ESM 加载 + 裸 socket 拿 body（不被宿主http栈吞）。
 * 结果写到 {workspaceRoot}/v1-probe-result.txt，同时在 Output 面板打印。
 * 全程 try/catch，任何异常都落盘，绝不影响扩展正常激活。
 */
async function runV1Probe(context: vscode.ExtensionContext): Promise<void> {
    const reportPath = path.join(context.extensionPath, 'v1-probe-result.txt');
    const lines: string[] = [`=== V1 spawn 探针 ${new Date().toISOString()} ===`];
    const flush = (extra?: string) => {
        if (extra) lines.push(extra);
        try {
            const fs = require('fs') as typeof import('fs');
            fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
        } catch (e) {
            // 落盘都失败的话，至少往 Output 写
            try { (require('vscode')).window.showErrorMessage(`V1探针落盘失败: ${(e as Error).message}`); } catch {}
        }
    };

    try {
        const { spawn } = require('child_process') as typeof import('child_process');
        const net = require('net') as typeof import('net');
        const fs = require('fs') as typeof import('fs');
        const nodePath = require('path') as typeof import('path');
        const os = require('os') as typeof import('os');

        // [1] process.execPath 身份
        lines.push('[1] process.execPath 身份');
        lines.push(`  execPath: ${process.execPath}`);
        lines.push(`  versions.electron: ${process.versions.electron ?? '(none)'}`);
        lines.push(`  versions.node: ${process.versions.node}`);
        lines.push(`  versions.electron exists → ${process.versions.electron ? '是 Electron 宿主' : '是纯 Node 宿主'}`);
        flush();

        // [2] 准备临时 config + logs 目录，用独立端口 11499 避开真实代理
        const PROBE_PORT = 11499;
        const tmpDir = nodePath.join(os.tmpdir(), `ccp-v1-probe-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        const logsDir = nodePath.join(tmpDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const configPath = nodePath.join(tmpDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({
            env: { ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '' },
            effortLevel: '',
            proxy: { listenHost: '127.0.0.1', listenPort: PROBE_PORT, passthrough: true },
        }), 'utf8');

        const serverPath = nodePath.join(context.extensionPath, 'proxy', 'server.js');
        lines.push(`[2] 准备临时配置`);
        lines.push(`  serverPath: ${serverPath}`);
        lines.push(`  configPath: ${configPath}`);
        lines.push(`  port: ${PROBE_PORT}`);
        lines.push(`  serverPath exists: ${fs.existsSync(serverPath)}`);
        flush();

        // [3] 启动尝试 —— 净化 env 是零依赖关键（Gemini 根因1 + knowledge_map 经验指向 NODE_OPTIONS/VSCODE_* 注入死锁）
        //   mode='spawn-clean'   : spawn + 净化 env（删 NODE_OPTIONS/VSCODE_*/ELECTRON_* 等注入）+ ELECTRON_RUN_AS_NODE=1 —— V1-f 核心
        //   mode='spawn-raw-ran' : spawn + 原样 env + ELECTRON_RUN_AS_NODE=1（对照，预期死锁）
        //   mode='fork'          : fork + 原样 env（对照，已知卡死）
        // 每个尝试用独立端口。
        const cp = require('child_process') as typeof import('child_process');
        // 净化 env：从 process.env 删 VS Code/Electron 注入的私货，只保留系统必需（PATH/系统变量）+ 显式注入我们要的。
        const cleanEnv = (): Record<string, string> => {
            const env: Record<string, string> = {};
            for (const [k, v] of Object.entries(process.env)) {
                if (v === undefined) continue;
                // 删 VS Code 注入（NODE_OPTIONS / VSCODE_* / ELECTRON_* / CHROME_* / 各种 IPC pipe）
                if (/^NODE_OPTIONS$/i.test(k)) continue;
                if (/^VSCODE_/i.test(k)) continue;
                if (/^ELECTRON_/i.test(k)) continue;
                if (/^CHROME_/i.test(k)) continue;
                if (/^PIPE$/i.test(k)) continue;
                env[k] = v;
            }
            env.ELECTRON_RUN_AS_NODE = '1';
            env.CONFIG_PATH = configPath;
            env.CCP_LOGS_DIR = logsDir;
            return env;
        };
        const baseEnv = (): Record<string, string> => {
            const env: Record<string, string> = { ...process.env as Record<string, string> };
            env.CONFIG_PATH = configPath;
            env.CCP_LOGS_DIR = logsDir;
            return env;
        };
        type LaunchResult = { child: any; getStdout: () => string; getStderr: () => string; getExitCode: () => number | null; childExitPromise: Promise<number | null> };
        const launch = (mode: string): LaunchResult => {
            let stdout = '';
            let stderr = '';
            let exitCode: number | null = null;
            let child: any;
            if (mode === 'spawn-clean') {
                // V1-f 核心：净化 env + 显式 ELECTRON_RUN_AS_NODE=1
                const env = cleanEnv();
                child = cp.spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            } else if (mode === 'spawn-raw-ran') {
                const env = baseEnv();
                env.ELECTRON_RUN_AS_NODE = '1';
                child = cp.spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            } else { // fork
                const env = baseEnv();
                delete env.ELECTRON_RUN_AS_NODE;
                child = cp.fork(serverPath, [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
            }
            child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
            child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
            child.on('exit', (code: number | null) => { exitCode = code; });
            const childExitPromise = new Promise<number | null>((resolve) => {
                child.on('exit', (code: number | null) => resolve(code));
            });
            return { child, getStdout: () => stdout, getStderr: () => stderr, getExitCode: () => exitCode, childExitPromise };
        };

        const healthz = (port: number): Promise<boolean> => new Promise((resolve) => {
            let done = false;
            const fin = (v: boolean) => { if (!done) { done = true; resolve(v); } };
            const sock = net.connect(port, '127.0.0.1', () => {
                sock.write(`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
            });
            sock.on('data', () => { try { sock.destroy(); } catch {} });
            sock.on('end', () => fin(true));
            sock.on('error', () => fin(false));
            sock.setTimeout(500, () => { try { sock.destroy(); } catch {} fin(false); });
        });
        const rawGet = (port: number, reqPath: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
            const sock = net.connect(port, '127.0.0.1', () => {
                sock.write(`GET ${reqPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
            });
            let buf = Buffer.alloc(0);
            sock.on('data', (c) => { buf = Buffer.concat([buf, c]); });
            sock.on('end', () => {
                const text = buf.toString('utf8');
                const sep = text.indexOf('\r\n\r\n');
                if (sep < 0) { reject(new Error('无分隔')); return; }
                const statusLine = text.slice(0, text.indexOf('\r\n'));
                const status = Number(statusLine.split(' ')[1]);
                resolve({ status, body: text.slice(sep + 4) });
            });
            sock.on('error', reject);
            sock.setTimeout(3000, () => { try { sock.destroy(); } catch {} reject(new Error('超时')); });
        });

        // 尝试顺序：spawn-clean 优先（V1-f 核心），后两个留对照。每个独立端口。
        // 关键：之前探针卡在 [3] 后无后续，是 launch() 后的 await 卡住（事件循环被阻塞）。
        // 改测法：spawn 后立即 flush「已spawn」，再 await 一个固定延时看事件循环是否还活，
        // 然后探测端口。全程多 flush，卡哪都能看到。
        const attempts: Array<{ mode: string; label: string; port: number }> = [
            { mode: 'spawn-clean', label: 'spawn + 净化env + ELECTRON_RUN_AS_NODE=1（V1-f 核心）', port: 11491 },
            { mode: 'spawn-raw-ran', label: 'spawn + 原样env + ELECTRON_RUN_AS_NODE=1（对照）', port: 11492 },
            { mode: 'spawn-clean-ignore', label: 'spawn + 净化env + stdio全ignore（隔离 stdio pipe 是否阻塞）', port: 11493 },
        ];

        let success = false;
        for (const att of attempts) {
            fs.writeFileSync(configPath, JSON.stringify({
                env: { ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '' },
                effortLevel: '',
                proxy: { listenHost: '127.0.0.1', listenPort: att.port, passthrough: true },
            }), 'utf8');
            lines.push(`[3] 尝试: ${att.label}  (port=${att.port})`);
            flush();

            // spawn-clean-ignore: stdio 全 ignore，不 pipe，看事件循环是否还卡
            let stdout = '';
            let stderr = '';
            let exitCode: number | null = null;
            let child: any;
            try {
                if (att.mode === 'spawn-clean-ignore') {
                    const env = cleanEnv();
                    child = cp.spawn(process.execPath, [serverPath], { env, stdio: 'ignore', windowsHide: true });
                } else if (att.mode === 'spawn-clean') {
                    const env = cleanEnv();
                    child = cp.spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
                } else { // spawn-raw-ran
                    const env = baseEnv();
                    env.ELECTRON_RUN_AS_NODE = '1';
                    child = cp.spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
                }
                child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
                child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
                child.on('exit', (code: number | null) => { exitCode = code; });
                lines.push(`  spawn 返回，child.pid=${child.pid}`);
                flush();
            } catch (e) {
                lines.push(`  spawn 同步抛异常: ${(e as Error).message}`);
                flush();
                continue;
            }

            // 关键诊断：await 一个固定延时，看事件循环是否还活着
            lines.push(`  等待 1s（测事件循环）...`);
            flush();
            await new Promise(res => setTimeout(res, 1000));
            lines.push(`  事件循环存活 ✓（1s 后回来了），exitCode=${exitCode}`);
            flush();

            // 探测端口
            let up = false;
            for (let i = 0; i < 8; i++) {
                if (exitCode !== null) break;
                if (await healthz(att.port)) { up = true; break; }
                await new Promise(res => setTimeout(res, 300));
            }
            if (up) {
                lines.push(`  healthz 通 ✓`);
                try {
                    const { status, body } = await rawGet(att.port, '/api/config');
                    lines.push(`  rawGet /api/config → status=${status} bodyLen=${body.length} bodyHead=${body.slice(0, 120)}`);
                    if (status === 200 && body.length > 0) {
                        lines.push(`  ✓✓✓ 通过：${att.mode} + ESM + 裸 socket 拿到非空 body`);
                        success = true;
                    }
                } catch (e) {
                    lines.push(`  rawGet 失败: ${(e as Error).message}`);
                }
            } else {
                lines.push(`  healthz 不通 ✗ exitCode=${exitCode}`);
                if (stdout) lines.push(`  stdout: ${stdout.slice(0, 500)}`);
                if (stderr) lines.push(`  stderr: ${stderr.slice(0, 500)}`);
            }
            try { child.kill(); } catch {}
            await new Promise(res => setTimeout(res, 300));
            flush();
            if (success) break;
        }

        lines.push(`[结论] ${success ? 'V1 验证通过 ✅' : 'V1 验证未通过 ❌'}`);
        flush();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    } catch (e) {
        lines.push(`[探针异常] ${(e as Error).message}`);
        lines.push((e as Error).stack ?? '');
        flush();
    }
}

export async function deactivate(): Promise<void> {
    // 停止本窗口代理（其他窗口心跳会接管）
    if (proxyHost) {
        await proxyHost.deactivate();
        proxyHost = null;
    }
}
