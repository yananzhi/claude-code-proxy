// standalone/workspaceManager.js — workspace 管理（ESM JS）
//
// 职责（阶段 2）：
//   - workspace = 磁盘目录 + .claude_proxy/（CLI 配置隔离层）
//   - 索引存 {home}/workspaces.json：{ workspaces: [{id, name, dir, createdAt}] }
//   - create/list/remove，dir↔id 一对一（路径归一化比对）
//   - 复用 src/localConfigStore.ts 的 LocalConfigStore/LocalActiveStateStore（从 out/ 加载）
//
// 设计依据：docs/standalone-backend-plan.md 阶段 2
// 正交设计：plan/tmp/2026-08-03-stage2-workspace-manager.md
//
// 删除 workspace 不删磁盘文件（只移除索引记录）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 从 out/ 加载编译后的 LocalConfigStore/LocalActiveStateStore（CJS）
const require = createRequire(import.meta.url);
let LocalConfigStore, LocalActiveStateStore;
try {
    ({ LocalConfigStore, LocalActiveStateStore } = require(path.join(PROJECT_ROOT, 'out', 'localConfigStore.js')));
} catch (e) {
    console.error('[workspaceManager] 加载 out/localConfigStore.js 失败，请先 npm run compile:', e.message);
    process.exit(1);
}

/** workspace 下独立配置目录名（与 localConfigStore/launcher 一致）。 */
const WORKSPACE_CONFIG_DIR = '.claude_proxy';

/**
 * 路径归一化：resolve + 统一分隔符 + 去尾斜杠 + Windows 小写化。
 * 用于 dir↔id 一对一比对，避免 D:\a\b vs D:/a/b/ 被当成不同目录。
 */
export function normalizeDir(dir) {
    let p = path.resolve(dir);
    // 统一为 POSIX 分隔符做比对
    p = p.split(path.sep).join('/');
    // 去尾斜杠（根目录如 / 除外，但 workspace dir 不会是根）
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    // Windows 文件系统不区分大小写，小写化比对
    if (process.platform === 'win32') p = p.toLowerCase();
    return p;
}

/** 生成 workspace id：ws_ + 8 位 hex。 */
export function generateWorkspaceId() {
    return 'ws_' + randomBytes(4).toString('hex');
}

/**
 * 解析 home 目录（与 main.js resolvePaths 一致）。
 */
export function resolveHome(homeDir) {
    return homeDir || process.env.CCP_HOME || path.join(os.homedir(), '.claude-code-proxy');
}

/**
 * WorkspaceManager：管 workspaces.json 索引 + 创建 .claude_proxy/。
 *
 * 索引读写用"读-改-写 + 临时文件 rename"保证原子性（防并发写丢记录）。
 */
export class WorkspaceManager {
    constructor(opts = {}) {
        this.homeDir = resolveHome(opts.homeDir);
        this.indexFile = path.join(this.homeDir, 'workspaces.json');
        this.log = opts.log || (() => {});
        // saveIndex 串行化队列：Windows 上 rename 到已存在目标文件被占用会 EPERM，
        // 并发 saveIndex 会互踩。用 Promise 链串行化写，保证一次只一个写完成。
        this._saveChain = Promise.resolve();
    }

    /** 读索引文件。不存在/损坏 → 返回 { workspaces: [] }（不崩）。 */
    async loadIndex() {
        try {
            const raw = await fs.promises.readFile(this.indexFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.workspaces)) {
                // 过滤 null/非对象元素，防 list/create 遍历时 NPE
                const workspaces = parsed.workspaces.filter(
                    w => w && typeof w === 'object' && !Array.isArray(w),
                );
                return { workspaces };
            }
            this.log('workspaces.json 结构异常（无 workspaces 数组），视为空索引');
            return { workspaces: [] };
        } catch (err) {
            if (err.code === 'ENOENT') return { workspaces: [] };
            this.log('workspaces.json 解析失败，视为空索引:', err.message);
            return { workspaces: [] };
        }
    }

    /**
     * 原子写索引：写临时文件 + rename（防半写）。串行化避免并发 rename 互踩（Windows EPERM）。
     *
     * 链断裂防护：与 _transaction 同理，_doSave 失败时错误冒泡给调用方，
     * 但 _saveChain 保持 resolved（不 reject），否则后续 _transaction 链断裂。
     * 失败时清理临时文件（防残留）。
     */
    async saveIndex(index) {
        let saveError;
        this._saveChain = this._saveChain.then(async () => {
            try {
                await this._doSave(index);
            } catch (e) {
                saveError = e;
            }
        });
        return this._saveChain.then(() => {
            if (saveError) throw saveError;
        });
    }

    async _doSave(index) {
        await fs.promises.mkdir(this.homeDir, { recursive: true });
        const tmp = this.indexFile + '.tmp.' + randomBytes(4).toString('hex');
        await fs.promises.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
        try {
            // rename 原子替换（POSIX 原子；Windows 同卷文件原子替换）
            // Windows 上 rename 到已存在目标偶尔 EPERM（文件被占用），重试一次
            try {
                await fs.promises.rename(tmp, this.indexFile);
            } catch (e) {
                if (e.code === 'EPERM') {
                    await fs.promises.rename(tmp, this.indexFile);
                } else {
                    throw e;
                }
            }
        } catch (e) {
            // 清理临时文件（防残留）
            try { await fs.promises.unlink(tmp); } catch {}
            throw e;
        }
    }

    /**
     * 串行化执行读-改-写事务：防并发 create/remove 各自读旧索引互踩丢记录。
     * fn 接收当前索引，返回新索引（或抛错）。
     *
     * 链断裂防护：fn 抛错时，错误冒泡给调用方（调用方 await 会看到），
     * 但 _saveChain 本身保持 resolved（不 reject），否则后续 _transaction 的
     * .then 回调会被跳过 → 链断裂 → 所有后续 create/remove 静默失败。
     * 做法：链内 try/catch 吞错保链继续，单独的 reject promise 返回给调用方。
     */
    async _transaction(fn) {
        let transactionError;
        this._saveChain = this._saveChain.then(async () => {
            const idx = await this.loadIndex();
            try {
                const next = await fn(idx);
                if (next) await this._doSave(next);
            } catch (e) {
                // 吞错保链继续，但记录给调用方
                transactionError = e;
            }
        });
        // 返回的 promise：等链跑完后，若有错则 reject（调用方 await 能看到），否则 resolve
        return this._saveChain.then(() => {
            if (transactionError) throw transactionError;
        });
    }

    /** 列出所有 workspace（按 createdAt 升序，稳定展示）。 */
    async list() {
        const idx = await this.loadIndex();
        return [...idx.workspaces].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    }

    /**
     * 创建 workspace。
     * @param {string} name workspace 名字（必填，非空）
     * @param {string} dir 磁盘目录（必须已存在；归一化后不能与已有 workspace 重复）
     * @returns {Promise<{workspace, created: boolean}>} created=true 新建了 .claude_proxy
     * @throws {Error} dir 不存在 / 已注册 / name 缺失
     */
    async create(name, dir) {
        if (!name || !String(name).trim()) {
            throw new Error('name 不能为空');
        }
        if (!dir || !String(dir).trim()) {
            throw new Error('dir 不能为空');
        }
        const absDir = path.resolve(dir);
        if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
            throw new Error(`目录不存在或不是目录: ${absDir}`);
        }
        const norm = normalizeDir(absDir);

        // 建 .claude_proxy/（已存在则复用，不报错）—— 事务外做，不影响索引
        const configDir = path.join(absDir, WORKSPACE_CONFIG_DIR);
        let created = false;
        if (!fs.existsSync(configDir)) {
            await fs.promises.mkdir(configDir, { recursive: true });
            created = true;
        }

        // 读-改-写事务（串行化，防并发互踩）
        let workspace = null;
        await this._transaction(async (idx) => {
            // dir↔id 一对一：归一化后比对
            if (idx.workspaces.some(w => normalizeDir(w.dir) === norm)) {
                throw new Error(`目录已注册为 workspace: ${absDir}`);
            }
            // id 查重兜底
            let id = generateWorkspaceId();
            while (idx.workspaces.some(w => w.id === id)) {
                id = generateWorkspaceId();
            }
            workspace = {
                id,
                name: String(name).trim(),
                dir: absDir,
                createdAt: new Date().toISOString(),
            };
            idx.workspaces.push(workspace);
            return idx;
        });
        return { workspace, created };
    }

    /**
     * 删除 workspace（只移除索引，不删磁盘文件）。
     * @throws {Error} id 不存在
     */
    async remove(id) {
        let found = false;
        await this._transaction(async (idx) => {
            const before = idx.workspaces.length;
            idx.workspaces = idx.workspaces.filter(w => w.id !== id);
            if (idx.workspaces.length === before) {
                throw new Error(`workspace 不存在: ${id}`);
            }
            found = true;
            return idx;
        });
        return found;
    }

    /** 查单个 workspace（按 id）。不存在返回 null。 */
    async get(id) {
        const idx = await this.loadIndex();
        return idx.workspaces.find(w => w.id === id) || null;
    }

    /**
     * 取某 workspace 的 local 配置列表（复用 LocalConfigStore.load）。
     * @returns {Promise<LLMConfig[]>} 不存在/空 → []
     */
    async getLocalConfigs(id) {
        const ws = await this.get(id);
        if (!ws) return [];
        const store = new LocalConfigStore(ws.dir);
        return store.load();
    }
}
