#!/usr/bin/env bash
# standalone/run/run-dev.sh — 方式 A：直接 node 跑独立后端（开发自测）
#
# 用 standalone/run/ 作为 CCP_HOME，预设端口 11444（management 11544），
# 避免和你正在跑的 VS Code 插件代理（默认 11434）冲突。
#
# 用法：
#   bash standalone/run/run-dev.sh          # 前台跑，Ctrl+C 退出
#   bash standalone/run/run-dev.sh --bg    # 后台跑，日志写 run/run-dev.log
#
# 跨平台：Linux/Mac 原生 bash；Windows 用 git bash 或 WSL。
# 前置：npm run compile（编译 TS → out/）

set -e

# 定位工程根（脚本在 standalone/run/ 下）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

# 检查 out/ 编译产物
if [ ! -f out/cleanEnv.js ]; then
    echo "[run-dev] out/ 不存在，先 npm run compile"
    npm run compile
fi

# CCP_HOME = standalone/run/（预设了端口 11444 的 proxy-config.json）
export CCP_HOME="$SCRIPT_DIR"

# 检查 node-pty/ws
if ! node -e "require('node-pty'); require('ws')" 2>/dev/null; then
    echo "[run-dev] node-pty/ws 缺失，npm install"
    npm install
fi

echo "[run-dev] CCP_HOME=$CCP_HOME"
echo "[run-dev] 代理转发 → http://127.0.0.1:11444/"
echo "[run-dev] management 网页 → http://127.0.0.1:11544/（workspace 管理 + 配置编辑 + CLI 终端）"
echo "[run-dev] 控制台（trace/统计） → http://127.0.0.1:11444/"
echo "[run-dev] Ctrl+C 优雅关闭"
echo ""

if [ "$1" = "--bg" ]; then
    nohup node standalone/cli.js > "$SCRIPT_DIR/run-dev.log" 2>&1 &
    echo $! > "$SCRIPT_DIR/run-dev.pid"
    echo "[run-dev] 后台启动，PID=$!，日志：$SCRIPT_DIR/run-dev.log"
    echo "[run-dev] PID 文件：$SCRIPT_DIR/run-dev.pid"
    echo "[run-dev] 停止：bash standalone/run/stop.sh"
else
    exec node standalone/cli.js
fi
