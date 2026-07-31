// test/mock-cli/src/configHome.mjs — 等价真 CLI getClaudeConfigHomeDir。
// 真 CLI: utils/envUtils.ts:7-14
//   process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
//   .normalize('NFC')
// memoize key 是 process.env.CLAUDE_CONFIG_DIR（动态 key，env 变了能拿新值）。
import { homedir } from 'os';
import { join } from 'path';
import { memoize } from './memoize.mjs';

export const getClaudeConfigHomeDir = memoize(
    () => {
        const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
        return dir.normalize('NFC');
    },
    // 动态 key：env 变了能拿新值（真 CLI 同样以 env 为 memoize key）
    () => process.env.CLAUDE_CONFIG_DIR,
);
