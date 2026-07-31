import * as vscode from 'vscode';
import type { LLMConfig, ModelAliasMapping } from './types';
import { ConfigStore, newId } from './configStore';
import { LocalConfigStore } from './localConfigStore';
import { detectPlatform, readSettings } from './claudeConfig';
import { ProxyHost } from './proxyHost';
import { extractUpstream } from './upstream';
import { aggregateModelCatalog, aliasName } from './derivedLogic';

interface EditorHandlers {
    onSaved: () => void;
    /** global 配置：写 ~/.claude/settings.json + Reload。 */
    switchConfig: (cfg: LLMConfig) => Promise<void>;
    /** workspace-local 配置：纯标记，不写 settings、不 reload。 */
    switchLocalConfig: (cfg: LLMConfig) => Promise<void>;
    /** 当前 workspace 的 local store（无 workspace 时 null）。 */
    getLocalStore: () => LocalConfigStore | null;
    /** global 配置列表，供 local 编辑器的"从 global 导入"下拉用。 */
    loadGlobalConfigs: () => Promise<LLMConfig[]>;
    /** 派生节点：保存后立即启动（Save & 启动）。 */
    launchDerived: (cfg: LLMConfig) => Promise<void>;
    /** 代理 host（派生节点 setAlias 用，无代理时 null）。 */
    getProxyHost: () => ProxyHost | null;
    /** 刷新树（setAlias 后刷派生节点 description）。 */
    refresh: () => void;
}

type Scope = 'global' | 'local' | 'derived';

/**
 * Webview panel for creating/editing a single LLM config (name + a textarea
 * holding the full settings.json content). 支持 global 与 workspace-local 两种
 * 作用域：local 模式额外显示"从 global 导入"下拉，选中即把某 global 配置的
 * content 填入文本框（可再编辑）。复用同一 LLMConfig shape，不另建 webview。
 */
export class WebviewEditor {
    /** Track open panels by key (scope+id 或 'new:scope') to avoid duplicates. */
    private readonly panels = new Map<string, vscode.WebviewPanel>();

    constructor(
        private readonly store: ConfigStore,
        private readonly handlers: EditorHandlers,
    ) {}

    async openNewGlobal(): Promise<void> {
        const live = await readSettings(detectPlatform().configPath);
        const content = live ?? TEMPLATE;
        await this.open('new:global', undefined, 'New LLM Config (global)', '', content, 'direct', 'global', []);
    }

    async openNewLocal(): Promise<void> {
        const localStore = this.handlers.getLocalStore();
        if (!localStore) {
            void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹再创建 workspace-local 配置');
            return;
        }
        const globalConfigs = await this.handlers.loadGlobalConfigs();
        await this.open('new:local', undefined, 'New LLM Config (workspace-local)', '', TEMPLATE, 'direct', 'local', globalConfigs);
    }

    async openEditGlobal(cfg: LLMConfig): Promise<void> {
        await this.open(`edit:global:${cfg.id}`, cfg.id, `Edit: ${cfg.name}`, cfg.name, cfg.content,
            cfg.mode === 'proxy' ? 'proxy' : 'direct', 'global', []);
    }

    async openEditLocal(cfg: LLMConfig): Promise<void> {
        const globalConfigs = await this.handlers.loadGlobalConfigs();
        await this.open(`edit:local:${cfg.id}`, cfg.id, `Edit: ${cfg.name}`, cfg.name, cfg.content,
            cfg.mode === 'proxy' ? 'proxy' : 'direct', 'local', globalConfigs);
    }

    /** 新建派生节点：已有编号 N 与父配置，打开配置页让用户配三档映射。 */
    async openNewDerived(parentCfg: LLMConfig, derivedIndex: number, name: string): Promise<void> {
        const localStore = this.handlers.getLocalStore();
        if (!localStore) {
            void vscode.window.showErrorMessage('请先打开一个 workspace 文件夹');
            return;
        }
        const catalog = await this.loadModelCatalog();
        const snapshot = this.snapshotFromParent(parentCfg);
        if (!snapshot) {
            // 父 content 无效或缺 baseUrl/token：快照无法生成，派生节点将无法独立启动（父删/改后断链）。
            // 提示用户但不阻断——用户可能只是想先建节点再修父配置。
            void vscode.window.showWarningMessage(
                `父配置 '${parentCfg.name}' 的 content 无法解析出 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN，` +
                `派生节点未存上游快照。若父配置后续被删或改坏，此派生节点将无法启动。`,
            );
        }
        const cfg: LLMConfig = {
            id: newId(),
            name,
            content: parentCfg.content, // 派生节点 content 只读展示用，启动时以父 content + 快照合成
            mode: parentCfg.mode,
            updatedAt: new Date().toISOString(),
            derivedFrom: parentCfg.id,
            derivedIndex,
            modelAliases: {},
            derivedSnapshot: snapshot,
        };
        await this.open(`new:derived:${cfg.id}`, undefined, `New Derived: ${name}`, name, parentCfg.content,
            cfg.mode === 'proxy' ? 'proxy' : 'direct', 'derived', [], { cfg, catalog });
    }

    /** 编辑派生节点：打开配置页改三档映射（在线改即时生效，不关面板）。 */
    async openEditDerived(cfg: LLMConfig): Promise<void> {
        const catalog = await this.loadModelCatalog();
        await this.open(`edit:derived:${cfg.id}`, cfg.id, `Edit: ${cfg.name}`, cfg.name, cfg.content,
            cfg.mode === 'proxy' ? 'proxy' : 'direct', 'derived', [], { cfg, catalog });
    }

    /** 从父配置提取上游快照（§6.5 P1，防父删/改断链）。 */
    private snapshotFromParent(parent: LLMConfig): { baseUrl: string; token: string; timeoutSec?: number; mode: 'direct' | 'proxy' } | undefined {
        const parsed = extractUpstream(parent.content);
        if (!parsed) return undefined;
        const baseUrl = parsed.env.ANTHROPIC_BASE_URL;
        const token = parsed.env.ANTHROPIC_AUTH_TOKEN;
        if (!baseUrl || !token) return undefined;
        const timeoutSec = parsed.env.API_TIMEOUT_MS ? Math.round(Number(parsed.env.API_TIMEOUT_MS) / 1000) : undefined;
        return { baseUrl, token, timeoutSec, mode: parent.mode === 'proxy' ? 'proxy' : 'direct' };
    }

    /** 聚合全局模型清单（global + local + derived，§6.7 P9）。 */
    private async loadModelCatalog(): Promise<string[]> {
        const globalConfigs = await this.handlers.loadGlobalConfigs();
        const localStore = this.handlers.getLocalStore();
        const localConfigs = localStore ? await localStore.load() : [];
        return aggregateModelCatalog([...globalConfigs, ...localConfigs]);
    }

    private async open(
        key: string,
        existingId: string | undefined,
        title: string,
        name: string,
        content: string,
        mode: 'direct' | 'proxy',
        scope: Scope,
        globalConfigs: LLMConfig[],
        derivedExtra?: { cfg: LLMConfig; catalog: string[] },
    ): Promise<void> {
        const existing = this.panels.get(key);
        if (existing) {
            existing.reveal(vscode.ViewColumn.Active, false);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'claude-code-proxy.editor',
            title,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );
        panel.webview.html = this.buildHtml(title, name, content, mode, scope, globalConfigs, derivedExtra);

        panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this.onMessage(panel, key, existingId, scope, msg, globalConfigs, derivedExtra),
            undefined,
            [],
        );

        panel.onDidDispose(() => this.panels.delete(key));
        this.panels.set(key, panel);
    }

    private async onMessage(
        panel: vscode.WebviewPanel,
        key: string,
        existingId: string | undefined,
        scope: Scope,
        msg: WebviewMessage,
        globalConfigs: LLMConfig[],
        derivedExtra?: { cfg: LLMConfig; catalog: string[] },
    ): Promise<void> {
        if (msg.type === 'cancel') {
            panel.dispose();
            return;
        }

        if (msg.type === 'import') {
            // 从 global 导入：把选中 global 配置的 name/content 回填给前端
            const g = globalConfigs.find(c => c.id === msg.id);
            if (g) {
                panel.webview.postMessage({ type: 'import', name: g.name, content: g.content, mode: g.mode === 'proxy' ? 'proxy' : 'direct' });
            }
            return;
        }

        // 派生节点：在线改单档别名映射（§6.7 P7），即时生效 + 同步本地缓存 + 刷树 + 不关面板
        if (msg.type === 'setAlias' && scope === 'derived' && derivedExtra) {
            await this.handleSetAlias(panel, derivedExtra.cfg, msg.tier, msg.model, existingId);
            return;
        }

        if (msg.type !== 'save' && msg.type !== 'saveAndSwitch') {
            return;
        }

        const name = msg.name.trim();
        const content = msg.content.trim();

        if (!name) {
            panel.webview.postMessage({ type: 'error', message: 'Name is required.' });
            return;
        }
        // derived scope 的 content 只读，不校验/不保存用户编辑（继承自父）
        if (scope !== 'derived') {
            try {
                JSON.parse(content); // validate JSON before persisting
            } catch (e) {
                panel.webview.postMessage({ type: 'error', message: `Invalid JSON: ${(e as Error).message}` });
                return;
            }
        }

        if (scope === 'global') {
            const cfg: LLMConfig = {
                id: existingId ?? newId(),
                name,
                content,
                mode: msg.mode === 'proxy' ? 'proxy' : 'direct',
                updatedAt: new Date().toISOString(),
            };
            await this.store.upsert(cfg);
            this.handlers.onSaved();
            panel.webview.postMessage({ type: 'saved' });
            if (msg.type === 'saveAndSwitch') {
                await this.handlers.switchConfig(cfg);
            }
            panel.dispose();
            return;
        }

        if (scope === 'local') {
            const localStore = this.handlers.getLocalStore();
            if (!localStore) {
                panel.webview.postMessage({ type: 'error', message: 'workspace 不可用' });
                return;
            }
            const cfg: LLMConfig = {
                id: existingId ?? newId(),
                name,
                content,
                mode: msg.mode === 'proxy' ? 'proxy' : 'direct',
                updatedAt: new Date().toISOString(),
            };
            await localStore.upsert(cfg);
            this.handlers.onSaved();
            panel.webview.postMessage({ type: 'saved' });
            if (msg.type === 'saveAndSwitch') {
                await this.handlers.switchLocalConfig(cfg);
            }
            panel.dispose();
            return;
        }

        // scope === 'derived'
        const localStore = this.handlers.getLocalStore();
        if (!localStore) {
            panel.webview.postMessage({ type: 'error', message: 'workspace 不可用' });
            return;
        }
        const base = derivedExtra?.cfg;
        if (!base) {
            panel.webview.postMessage({ type: 'error', message: '派生节点数据缺失' });
            return;
        }
        // 派生节点只存 name + modelAliases（content/mode/snapshot/derivedFrom/index 沿用 base）
        const cfg: LLMConfig = {
            ...base,
            name,
            updatedAt: new Date().toISOString(),
        };
        await localStore.upsert(cfg);
        this.handlers.onSaved();
        panel.webview.postMessage({ type: 'saved' });
        if (msg.type === 'saveAndSwitch') {
            // 派生节点的 "Save & 启动" = 保存后立即 launchDerived
            await this.handlers.launchDerived(cfg);
        }
        panel.dispose();
    }

    /**
     * 处理 setAlias：调 proxyHost.setModelAlias + 同步本地缓存 + 刷树 + 不关面板（§6.7 P7）。
     * 权威在代理；本地 upsert 是为本窗口展示一致（重开编辑器显示新值、树 description 刷新）。
     * 新建（未保存）派生节点：existingId===undefined，跳过本地 upsert（节点尚未持久化，
     * 用户可能取消），但仍更新代理表 + 内存 cfg.modelAliases（供后续保存时带上）。
     */
    private async handleSetAlias(
        panel: vscode.WebviewPanel,
        cfg: LLMConfig,
        tier: 'haiku' | 'sonnet' | 'opus',
        model: string,
        existingId: string | undefined,
    ): Promise<void> {
        if (cfg.derivedIndex == null) {
            panel.webview.postMessage({ type: 'error', message: '派生节点缺少编号，无法设置别名' });
            return;
        }
        const proxyHost = this.handlers.getProxyHost();
        if (!proxyHost) {
            panel.webview.postMessage({ type: 'error', message: '代理尚未初始化' });
            return;
        }
        const alias = aliasName(tier, cfg.derivedIndex);
        try {
            await proxyHost.setModelAlias(alias, model);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            panel.webview.postMessage({ type: 'error', message: `设置别名失败: ${msg}` });
            return;
        }
        // 同步本地缓存（仅已持久化的派生节点；新建未保存的跳过，避免取消后留孤儿节点）
        const localStore = this.handlers.getLocalStore();
        if (localStore && existingId !== undefined) {
            const updated: LLMConfig = {
                ...cfg,
                modelAliases: { ...(cfg.modelAliases ?? {}), [tier]: model },
                updatedAt: new Date().toISOString(),
            };
            await localStore.upsert(updated);
        }
        // 无论是否 upsert，都更新内存 cfg.modelAliases 供后续 setAlias 基于最新值（避免连续改多档时丢档）
        cfg.modelAliases = { ...(cfg.modelAliases ?? {}), [tier]: model };
        this.handlers.refresh();
        panel.webview.postMessage({ type: 'aliasSaved', tier });
    }

    private buildHtml(
        title: string,
        name: string,
        content: string,
        mode: 'direct' | 'proxy',
        scope: Scope,
        globalConfigs: LLMConfig[],
        derivedExtra?: { cfg: LLMConfig; catalog: string[] },
    ): string {
        const nonce = getNonce();
        const escapedName = escapeHtml(name);
        const escapedContent = escapeHtml(content);
        const directChecked = mode === 'direct' ? 'checked' : '';
        const proxyChecked = mode === 'proxy' ? 'checked' : '';
        const isLocal = scope === 'local';
        const isDerived = scope === 'derived';

        // "从 global 导入"下拉（仅 local 模式渲染）
        const importOptions = globalConfigs
            .map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
            .join('');
        const importBlock = isLocal ? /* html */ `
  <div class="row">
    <label for="import">从 global 导入</label>
    <select id="import">
      <option value="">— 选择一条 global 配置 —</option>
      ${importOptions}
    </select>
    <div class="hint">选中后把该 global 配置的 name/content 填入下方，可再编辑。仅用于初始化，不影响 global 配置本身。</div>
  </div>` : '';

        // 派生节点：三档别名映射区域（§6.7）。左固定别名只读，右下拉选真实模型（候选来自全局清单，可手输）。
        let derivedBlock = '';
        let contentReadOnly = '';
        let modeDisabled = '';
        let saveSwitchLabel = 'Save &amp; Switch';
        if (isDerived && derivedExtra) {
            const idx = derivedExtra.cfg.derivedIndex ?? 0;
            const aliases = derivedExtra.cfg.modelAliases ?? {};
            const catalogOpts = (['', ...derivedExtra.catalog])
                .map(m => `<option value="${escapeHtml(m)}">${m ? escapeHtml(m) : '— 不设置（原样透传） —'}</option>`)
                .join('');
            const tierRow = (tier: 'haiku' | 'sonnet' | 'opus', label: string) => {
                const alias = aliasName(tier, idx);
                const cur = aliases[tier] ?? '';
                return /* html */ `
    <div class="alias-row">
      <span class="alias-label">${label} 档</span>
      <code class="alias-name">${escapeHtml(alias)}</code>
      <span class="alias-arrow">→</span>
      <input type="text" list="model-catalog" class="alias-model" data-tier="${tier}" value="${escapeHtml(cur)}" placeholder="真实模型名" />
    </div>`;
            };
            derivedBlock = /* html */ `
  <div class="row">
    <label>模型别名映射（在线可改，下个请求生效）</label>
    <div class="hint">继承自: ${escapeHtml(derivedExtra.cfg.derivedFrom ?? '(未知)')} · 专属编号: #${idx} · 别名: ${escapeHtml(aliasName('haiku', idx))} / ${escapeHtml(aliasName('sonnet', idx))} / ${escapeHtml(aliasName('opus', idx))}</div>
    <datalist id="model-catalog">${catalogOpts}</datalist>
    ${tierRow('haiku', 'Haiku')}
    ${tierRow('sonnet', 'Sonnet')}
    ${tierRow('opus', 'Opus')}
    <div class="hint">改下拉值会即时同步到代理映射表并刷新树，无需重启 CLI、无需关闭本面板。</div>
  </div>`;
            contentReadOnly = 'readonly';
            modeDisabled = 'disabled';
            saveSwitchLabel = 'Save &amp; 启动';
        }

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 20px;
    box-sizing: border-box;
  }
  label { display: block; margin: 0 0 6px; font-weight: 600; }
  .row { margin-bottom: 16px; }
  input[type="text"], select {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    color: var(--vscode-input-foreground);
    border-radius: 2px;
    font-size: 13px;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 380px;
    resize: vertical;
    padding: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    color: var(--vscode-input-foreground);
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    line-height: 1.4;
    white-space: pre;
    overflow-wrap: normal;
    overflow: auto;
  }
  #error {
    margin: 8px 0;
    min-height: 18px;
    color: var(--vscode-errorForeground, #f48771);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
  .actions { margin-top: 12px; display: flex; gap: 8px; }
  button {
    padding: 6px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .alias-row {
    display: grid;
    grid-template-columns: 80px 160px 16px 1fr;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
  }
  .alias-label { font-weight: 600; font-size: 13px; }
  .alias-name {
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    background: var(--vscode-textBlockQuote-background);
    padding: 4px 6px;
    border-radius: 2px;
  }
  .alias-arrow { text-align: center; color: var(--vscode-descriptionForeground); }
  .alias-model { width: 100%; box-sizing: border-box; padding: 6px 8px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); border-radius: 2px; font-size: 13px; }
  textarea[readonly] { opacity: 0.7; cursor: default; }
</style>
</head>
<body>
  <div class="row">
    <label for="name">Name</label>
    <input type="text" id="name" value="${escapedName}" placeholder="e.g. glm-5.2 (Volc)" />
  </div>
  <div class="row">
    <label>连接模式</label>
    <label style="font-weight:normal; margin-bottom:4px"><input type="radio" name="mode" value="direct" ${directChecked} ${modeDisabled} /> 直连 — Claude Code 直接连此上游（默认）</label>
    <label style="font-weight:normal; margin-bottom:0"><input type="radio" name="mode" value="proxy" ${proxyChecked} ${modeDisabled} /> 通过代理连接 — 代理用此上游重试 503，Claude Code 经代理连接</label>
  </div>
  ${importBlock}
  ${derivedBlock}
  <div class="row">
    <label for="content">settings.json content${isDerived ? ' (只读·继承自父)' : ''}</label>
    <textarea id="content" spellcheck="false" ${contentReadOnly}>${escapedContent}</textarea>
    <div class="hint">${isDerived
        ? '派生节点继承父配置的上游，content 不可编辑。如需自定义 content，请另建普通 workspace-local 配置。'
        : 'This is the full content written to Claude Code\'s settings.json when you switch (direct), or used as the proxy\'s upstream (proxy mode).'}</div>
  </div>
  <div id="error" aria-live="polite"></div>
  <div class="actions">
    <button id="save" type="button">Save</button>
    <button id="saveSwitch" type="button">${saveSwitchLabel}</button>
    <button id="cancel" class="secondary" type="button">Cancel</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const nameEl = document.getElementById('name');
    const contentEl = document.getElementById('content');
    const errorEl = document.getElementById('error');
    const saveBtn = document.getElementById('save');
    const saveSwitchBtn = document.getElementById('saveSwitch');
    const importSel = document.getElementById('import');
    const isDerived = ${isDerived ? 'true' : 'false'};

    function validate() {
      const nameOk = nameEl.value.trim().length > 0;
      // derived: content 只读继承自父，不校验 JSON；只要求 name 非空
      if (isDerived) {
        saveBtn.disabled = !nameOk;
        saveSwitchBtn.disabled = !nameOk;
        return;
      }
      const text = contentEl.value.trim();
      let ok = nameOk && text.length > 0;
      if (ok) {
        try { JSON.parse(text); errorEl.textContent = ''; }
        catch (e) { ok = false; errorEl.textContent = 'Invalid JSON: ' + e.message; }
      } else {
        errorEl.textContent = '';
      }
      saveBtn.disabled = !ok;
      saveSwitchBtn.disabled = !ok;
    }

    nameEl.addEventListener('input', validate);
    if (!isDerived) { contentEl.addEventListener('input', validate); }

    function selectedMode() {
      const checked = document.querySelector('input[name="mode"]:checked');
      return checked ? checked.value : 'direct';
    }
    function setMode(mode) {
      const radio = document.querySelector('input[name="mode"][value="' + mode + '"]');
      if (radio) { radio.checked = true; }
    }

    if (importSel) {
      importSel.addEventListener('change', () => {
        const id = importSel.value;
        if (!id) { return; }
        vscode.postMessage({ type: 'import', id });
      });
    }

    // 派生节点：别名映射 input 改动 → setAlias 即时生效（不关面板）
    document.querySelectorAll('.alias-model').forEach(el => {
      el.addEventListener('change', () => {
        const tier = el.getAttribute('data-tier');
        const model = el.value.trim();
        if (!tier) { return; }
        vscode.postMessage({ type: 'setAlias', tier, model });
      });
    });

    saveBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'save', name: nameEl.value, content: contentEl.value, mode: selectedMode() });
    });
    saveSwitchBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'saveAndSwitch', name: nameEl.value, content: contentEl.value, mode: selectedMode() });
    });
    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'error') { errorEl.textContent = msg.message; }
      else if (msg.type === 'import') {
        // 回填从 global 导入的内容（用户可再编辑）
        nameEl.value = msg.name;
        contentEl.value = msg.content;
        setMode(msg.mode);
        validate();
      }
      else if (msg.type === 'aliasSaved') {
        // 轻量确认：不关面板，不清空 input（用户可能连改多档）
        errorEl.textContent = msg.tier + ' 档已同步到代理（下个请求生效）';
      }
      else if (msg.type === 'saved') { /* host will close panel */ }
    });

    validate();
    nameEl.focus();
  </script>
</body>
</html>`;
    }
}

type WebviewMessage =
    | { type: 'save' | 'saveAndSwitch'; name: string; content: string; mode: 'direct' | 'proxy' }
    | { type: 'import'; id: string }
    | { type: 'setAlias'; tier: 'haiku' | 'sonnet' | 'opus'; model: string }
    | { type: 'cancel' };

const TEMPLATE = `{
  "env": {
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_MODEL": ""
  }
}`;

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getNonce(): string {
    let nonce = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        nonce += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return nonce;
}
