#!/usr/bin/env node
// standalone/cli.js — npm bin 入口（独立后端命令）
//
// 全局安装（npm install -g claude-code-proxy）后，`claude-code-proxy` 命令执行本文件。
// 职责：import main.js 调 launchStandalone，起独立后端（proxy spawn + management API + 网页）。
//
// 设计依据：docs/standalone-backend-plan.md 阶段 5
// 环境变量：CCP_HOME（根目录，默认 ~/.claude-code-proxy/）

import { launchStandalone } from './main.js';

launchStandalone().catch((e) => {
    console.error('[standalone] 启动失败:', e);
    process.exit(1);
});
