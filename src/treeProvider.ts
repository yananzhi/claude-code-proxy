import * as vscode from 'vscode';
import type { LLMConfig, PlatformInfo, ConfigMode } from './types';
import { ConfigStore } from './configStore';
import { ActiveStateStore } from './activeState';
import { LocalConfigStore, LocalActiveStateStore } from './localConfigStore';
import { detectPlatform, readSettings } from './claudeConfig';
import { summarizeAliases, isOrphan, filterParentConfigs } from './derivedLogic';

/** A row in the sidebar tree — info, group header, or a config (global/local). */
export type ConfigNode = vscode.TreeItem;

/**
 * Maps TreeItem instances back to their LLMConfig data.
 * TreeItem.command.arguments only works for single-click; context/inline
 * menus receive the TreeItem itself, so we need this side-channel lookup.
 */
const itemToConfig = new WeakMap<vscode.TreeItem, LLMConfig>();

/** Retrieve the LLMConfig associated with a TreeItem (global or local). */
export function getConfigFromNode(node: vscode.TreeItem): LLMConfig | undefined {
    return itemToConfig.get(node);
}

/** contextValue 标记，用于 when 子句区分节点类型。 */
export const CV_INFO = 'info';
export const CV_GROUP_GLOBAL = 'group-global';
export const CV_GROUP_LOCAL = 'group-local';
export const CV_CONFIG = 'config';
export const CV_LOCAL_CONFIG = 'local-config';
/** 派生节点（§6.3）。 */
export const CV_DERIVED_CONFIG = 'derived-config';

/** workspace_local_llm_config 分组节点的提示语。 */
const LOCAL_GROUP_TOOLTIP =
    '**workspace-local configs（仅对终端启动的 Claude CLI 生效）**\n\n' +
    '这些配置只在用本扩展的启动按钮（或快捷键）打开的终端 Claude Code CLI 会话中生效——' +
    '启动时会把当前 active 的 local 配置写入 `{workspace}/.claude_proxy/settings.json`，' +
    '该会话通过 `CLAUDE_CONFIG_DIR` 指向此独立目录。\n\n' +
    '⚠️ **对本扩展内的视图及其他 Claude Code 会话不生效**：它不写全局 `~/.claude/settings.json`，' +
    '不影响插件内视图，也不会改变已打开的其他终端会话。\n\n' +
    'active 标记也仅决定下次终端启动用哪条配置，切换它不触发 reload window。';

export class ConfigTreeProvider implements vscode.TreeDataProvider<ConfigNode> {
    private readonly _onDidChange = new vscode.EventEmitter<ConfigNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    /** workspace-local 存储实例，随 workspace 切换重建（可能为 null：无 workspace）。 */
    private localStore: LocalConfigStore | null = null;
    private localActiveState: LocalActiveStateStore | null = null;

    constructor(
        private readonly store: ConfigStore,
        private readonly activeState: ActiveStateStore,
    ) {}

    /**
     * 切换 workspace 时由 extension.ts 调用：接收 extension 统一创建的 local 存储实例
     * （与 webviewEditor/launcher 共享同一实例，保证 cache 一致）。传 null 表示无 workspace。
     */
    setWorkspaceRoot(store: LocalConfigStore | null, activeState: LocalActiveStateStore | null): void {
        this.localStore = store;
        this.localActiveState = activeState;
    }

    refresh(): void {
        this._onDidChange.fire(undefined);
    }

    getTreeItem(node: ConfigNode): ConfigNode {
        return node;
    }

    async getChildren(element?: ConfigNode): Promise<ConfigNode[]> {
        const platform = detectPlatform(getOverridePath());

        // 根级：info + 两个分组标题
        if (!element) {
            return [
                this.buildInfoNode(platform),
                this.buildGroupNode('global_llm_config', CV_GROUP_GLOBAL, vscode.TreeItemCollapsibleState.Expanded),
                this.buildGroupNode('workspace_local_llm_config', CV_GROUP_LOCAL,
                    this.localStore ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
                    LOCAL_GROUP_TOOLTIP),
            ];
        }

        // 分组下的配置列表
        if (element.contextValue === CV_GROUP_GLOBAL) {
            const configs = await this.store.load();
            const stateId = (await this.activeState.load())?.id;
            let activeConfigId: string | undefined = stateId;
            if (!activeConfigId) {
                // 回退到 content 匹配（兼容老安装/直连）
                const matched = await findActiveConfig(configs, platform.configPath);
                activeConfigId = matched?.id;
            }
            return configs.map(cfg => this.buildConfigNode(cfg, activeConfigId === cfg.id, false));
        }

        if (element.contextValue === CV_GROUP_LOCAL) {
            if (!this.localStore || !this.localActiveState) {
                return [this.buildHintNode('no workspace folder')];
            }
            const configs = await this.localStore.load();
            const activeConfigId = (await this.localActiveState.load())?.id;
            // 派生节点（derivedFrom 非空）不作为普通 local 配置渲染——它们挂在父节点下或作孤儿。
            // 否则会在 local 分组下出现重复项（派生节点既在父下、又作为普通 local 项）。
            const parentConfigs = filterParentConfigs(configs);
            if (configs.length === 0) {
                return [this.buildHintNode('no local configs — click + to create')];
            }
            const configIds = new Set(configs.map(c => c.id));
            // 并发查每条 local 配置的派生节点数，决定是否可展开
            const withDerived = await Promise.all(
                parentConfigs.map(async cfg => {
                    const derived = await this.localStore!.getDerivedByParent(cfg.id);
                    return { cfg, derivedCount: derived.length };
                }),
            );
            const nodes = withDerived.map(({ cfg, derivedCount }) =>
                this.buildConfigNode(cfg, activeConfigId === cfg.id, true, derivedCount),
            );
            // 孤儿派生节点（父配置已删）：直接挂在 local 组下，标 ⚠ 可删可重建（§6.3/§6.5 P1）。
            // 否则它们无父可展开，会从树中消失，用户无法删/重建，违背"保留可删/可重建"设计。
            const orphans = configs.filter(c => c.derivedFrom && !configIds.has(c.derivedFrom));
            for (const orphan of orphans) {
                nodes.push(this.buildDerivedNode(orphan, false));
            }
            return nodes;
        }

        // 展开 local-config 节点 → 返回其下派生节点（§6.3）
        if (element.contextValue === CV_LOCAL_CONFIG) {
            if (!this.localStore) {
                return [];
            }
            const parentCfg = getConfigFromNode(element);
            if (!parentCfg) {
                return [];
            }
            const derived = await this.localStore.getDerivedByParent(parentCfg.id);
            // 全部 local 配置用于孤儿判定（查父是否还在）
            const allLocal = await this.localStore.load();
            return derived.map(d => {
                const parentExists = allLocal.some(c => c.id === d.derivedFrom);
                return this.buildDerivedNode(d, parentExists);
            });
        }

        return [];
    }

    private buildInfoNode(platform: PlatformInfo): ConfigNode {
        const item = new vscode.TreeItem(`Detected: ${platform.label}`);
        item.description = platform.configPath;
        item.tooltip = new vscode.MarkdownString(
            `**Claude Code Proxy — target**\n\nDetected environment: \`${platform.label}\`\n\nClaude Code config path:\n\`${platform.configPath}\``
        );
        item.iconPath = new vscode.ThemeIcon('vm-connect');
        item.contextValue = CV_INFO;
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        return item;
    }

    private buildGroupNode(label: string, contextValue: string, state: vscode.TreeItemCollapsibleState, tooltip?: string): ConfigNode {
        const item = new vscode.TreeItem(label, state);
        item.iconPath = new vscode.ThemeIcon(contextValue === CV_GROUP_GLOBAL ? 'folder' : 'symbol-folder');
        item.contextValue = contextValue;
        if (tooltip) {
            item.tooltip = new vscode.MarkdownString(tooltip);
        }
        return item;
    }

    private buildHintNode(text: string): ConfigNode {
        const item = new vscode.TreeItem(text);
        item.iconPath = new vscode.ThemeIcon('info');
        item.contextValue = 'hint';
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        return item;
    }

    /**
     * @param isLocal true=workspace-local 配置（contextValue=local-config，单击走 switchLocalConfig）
     * @param derivedCount 派生节点数（仅 local 有意义，>0 时父节点可展开）
     */
    private buildConfigNode(cfg: LLMConfig, active: boolean, isLocal: boolean, derivedCount = 0): ConfigNode {
        const mode: ConfigMode = cfg.mode === 'proxy' ? 'proxy' : 'direct';
        const modeLabel = mode === 'proxy' ? '代理' : '直连';
        const item = new vscode.TreeItem(cfg.name);
        const parts: string[] = [];
        if (active) parts.push('active');
        parts.push(modeLabel);
        if (isLocal) parts.push('local');
        item.description = parts.join(' · ');
        item.tooltip = new vscode.MarkdownString(
            `**${cfg.name}**${active ? ' — active' : ''}\n\n` +
            `模式: ${mode === 'proxy' ? '通过代理连接' : '直连'}\n\n` +
            `作用域: ${isLocal ? 'workspace-local' : 'global'}\n\n` +
            `Click to switch to this config. Updated ${cfg.updatedAt}.\n\n` +
            '```\n' + previewContent(cfg.content) + '\n```'
        );
        const icon = mode === 'proxy' ? 'cloud' : (active ? 'circle-filled' : 'circle-outline');
        item.iconPath = new vscode.ThemeIcon(icon);
        item.contextValue = isLocal ? CV_LOCAL_CONFIG : CV_CONFIG;
        // local 配置有派生子节点时可展开；global 永不展开
        item.collapsibleState = isLocal && derivedCount > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        itemToConfig.set(item, cfg);
        item.command = {
            command: isLocal ? 'claude-code-proxy.switchLocalConfig' : 'claude-code-proxy.switchConfig',
            title: 'Switch to This Config',
            arguments: [cfg],
        };
        return item;
    }

    /**
     * 构建派生节点（§6.3）。
     * - description：映射摘要 `S:.. · H:.. · O:..`；孤儿前缀 ⚠。
     * - 单击绑 launchDerivedClaude（非 switchLocalConfig）。
     * - 孤儿（父已删）也建节点，但 description 标 ⚠，启动命令侧自行禁用/警告。
     */
    private buildDerivedNode(cfg: LLMConfig, parentExists: boolean): ConfigNode {
        const orphan = isOrphan(cfg, parentExists ? { id: cfg.derivedFrom ?? '' } : null);
        const summary = summarizeAliases(cfg.modelAliases);
        const idxLabel = cfg.derivedIndex != null ? `#${cfg.derivedIndex}` : '#?';
        const item = new vscode.TreeItem(`${orphan ? '⚠ ' : ''}${cfg.name} ${idxLabel}`);
        const descParts: string[] = ['派生'];
        if (summary) descParts.push(summary);
        if (orphan) descParts.push('孤儿');
        item.description = descParts.join(' · ');
        const aliasStr = cfg.derivedIndex != null
            ? `ccp-haiku-${cfg.derivedIndex} / ccp-sonnet-${cfg.derivedIndex} / ccp-opus-${cfg.derivedIndex}`
            : '(编号缺失)';
        item.tooltip = new vscode.MarkdownString(
            `**${cfg.name}** ${idxLabel} (derived)${orphan ? ' — ⚠ 孤儿（父配置已删）' : ''}\n\n` +
            `继承自: ${cfg.derivedFrom ?? '(未知)'}\n\n` +
            `别名: ${aliasStr}\n\n` +
            `映射: ${summary || '(未配置)'}\n\n` +
            `Click to launch a Claude session bound to this node's aliases.`
        );
        item.iconPath = new vscode.ThemeIcon(orphan ? 'warning' : 'symbol-runtime');
        item.contextValue = CV_DERIVED_CONFIG;
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        itemToConfig.set(item, cfg);
        item.command = {
            command: 'claude-code-proxy.launchDerivedClaude',
            title: 'Launch Derived Claude',
            arguments: [cfg],
        };
        return item;
    }
}

/** The config whose content matches the live settings.json, or null. */
export async function findActiveConfig(
    configs: LLMConfig[],
    configPath: string,
): Promise<LLMConfig | null> {
    const live = await readSettings(configPath);
    if (live === null) {
        return null;
    }
    const liveNorm = normalizeJson(live);
    if (liveNorm === null) {
        return null;
    }
    for (const cfg of configs) {
        const cfgNorm = normalizeJson(cfg.content);
        if (cfgNorm !== null && cfgNorm === liveNorm) {
            return cfg;
        }
    }
    return null;
}

function previewContent(content: string, max = 400): string {
    const trimmed = content.trim();
    return trimmed.length > max ? trimmed.slice(0, max) + '\n…' : trimmed;
}

/** Parse + re-stringify so cosmetic whitespace doesn't defeat active detection. */
function normalizeJson(raw: string): string | null {
    try {
        return JSON.stringify(JSON.parse(raw));
    } catch {
        return null;
    }
}

export function getOverridePath(): string {
    return vscode.workspace.getConfiguration('claude-code-proxy').get<string>('configFilePath') || '';
}
