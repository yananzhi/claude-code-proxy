export type ConfigMode = 'direct' | 'proxy';

/** 派生节点四档别名 → 真实模型映射（§6.2 + 优化 2 main 档）。本地缓存，权威在代理 modelAliases。
 *  main 走 ANTHROPIC_MODEL（主对话），三档走 ANTHROPIC_DEFAULT_*（子 agent alias 解析）。 */
export interface ModelAliasMapping {
    main?: string;    // ccp-main-N → 真实模型名（主对话模型，优化 2）
    haiku?: string;   // ccp-haiku-N → 真实模型名
    sonnet?: string;  // ccp-sonnet-N → 真实模型名
    opus?: string;    // ccp-opus-N → 真实模型名
}

/** 派生节点创建时存的父上游快照（防父删/改导致继承断链，§6.5 P1）。 */
export interface DerivedSnapshot {
    baseUrl: string;
    token: string;
    timeoutSec?: number;
    mode: ConfigMode;
}

/** 派生节点每档会话档位（per-tier contextWindow）。
 *  true=该档别名带 [1m]、CLI 按 1M 算 contextWindow；false/undefined=标准 200K（约束 3）。
 *  四档各自独立，默认从父 ANTHROPIC_MODEL 是否带 [1m] 继承（inheritSessionContext1m 返四档同值）。 */
export interface PerTier1m {
    main?: boolean;
    haiku?: boolean;
    sonnet?: boolean;
    opus?: boolean;
}

export interface LLMConfig {
    /** Stable unique id (uuid-ish). */
    id: string;
    /** Human-friendly name shown in the tree. */
    name: string;
    /** Full settings.json content to be written on switch. */
    content: string;
    /** 连接模式：direct=直连上游（默认），proxy=经本地代理（代理用此配置的上游） */
    mode?: ConfigMode;
    /** ISO timestamp of last modification. */
    updatedAt: string;
    // —— 派生节点字段（仅派生节点有，§6.2）——
    /** 父 local 配置 id。有此字段即为派生节点。 */
    derivedFrom?: string;
    /** 专属编号 N（全局唯一，权威在代理 nextAliasId）。 */
    derivedIndex?: number;
    /** 三档别名 → 真实模型（本地缓存，权威在代理）。 */
    modelAliases?: ModelAliasMapping;
    /** 每档会话档位（per-tier contextWindow）：true=该档别名带 [1m]、CLI 按 1M 算 contextWindow；
     *  false/undefined=标准 200K（约束 3）。四档各自独立，默认从父 ANTHROPIC_MODEL 继承。
     *  老数据可能是布尔（整体一个档位）→ 读取时 normalizeSessionContext1m 迁移成四档同值。 */
    sessionContext1m?: PerTier1m;
    /** 父上游快照（防父被删/改导致继承断链）。 */
    derivedSnapshot?: DerivedSnapshot;
}

/** 激活态记录：当前激活了哪条配置、什么模式。 */
export interface ActiveState {
    id: string;
    mode: ConfigMode;
}

export interface PlatformInfo {
    /** Raw process.platform value: 'win32' | 'darwin' | 'linux'. */
    platform: NodeJS.Platform;
    /** Friendly label, e.g. "Windows", "macOS", "Linux (WSL: Ubuntu)". */
    label: string;
    /** Resolved path to ~/.claude/settings.json (or override). */
    configPath: string;
}

/** Result of a switch operation, enough to offer an undo. */
export interface SwitchResult {
    /** The config that was activated. */
    config: LLMConfig;
    /** Path that was overwritten. */
    configPath: string;
    /** Backup file path holding the previous content (for undo). */
    backupPath: string;
    /** Content that was replaced, in case backup file is missing. */
    previousContent: string | null;
}
