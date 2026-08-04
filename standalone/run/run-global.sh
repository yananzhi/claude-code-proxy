#!/usr/bin/env bash
# standalone/run/run-global.sh — 方式 B：npm 全局安装后跑（验证发布形态）
#
# 先 npm install -g .（让 bin 生效），再起 claude-code-proxy 命令。
# 用 standalone/run/ 作为 CCP_HOME，端口 11444（不撞插件 11434）。
#
# 用法：
#   bash standalone/run/run-global.sh          # 安装 + 前台跑
#   bash standalone/run/run-global.sh --bg     # 安装 + 后台跑
#   bash standalone/run/run-global.sh --uninstall  # 卸载全局包
#
# 跨平台：Linux/Mac 原生 bash；Windows 用 git bash 或 WSL。
# 前置：npm run compile（编译 TS → out/）

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

if [ "$1" = "--uninstall" ]; then
    echo "[run-global] 卸载全局包 claude-code-proxy"
    npm uninstall -g claude-code-proxy
    exit 0
fi

# 检查 out/ 编译产物（npm install -g . 不编译，需先 compile）
if [ ! -f out/cleanEnv.js ]; then
    echo "[run-global] out/ 不存在，先 npm run compile"
    npm run compile
fi

# 全局安装（package.json 的 bin/files 生效）
if ! command -v claude-code-proxy >/dev/null 2>&1; then
    echo "[run-global] 全局安装 claude-code-proxy（npm install -g .）"
    npm install -g .
else
    echo "[run-global] claude-code-proxy 已全局安装，跳过（如需重装先 npm uninstall -g .）"
fi

# CCP_HOME = standalone/run/（端口 11444）
export CCP_HOME="$SCRIPT_DIR"

# 若 proxy-config.json 不存在，从 example 模板复制
if [ ! -f "$SCRIPT_DIR/proxy-config.json" ]; then
    cp "$SCRIPT_DIR/proxy-config.example.json" "$SCRIPT_DIR/proxy-config.json"
    echo "[run-global] 已从 example 复制 proxy-config.json（请编辑填真实 upstream 后重启）"
fi

echo "[run-global] CCP_HOME=$CCP_HOME"
echo "[run-global] 代理转发 → http://127.0.0.1:11444/"
echo "[run-global] management 网页 → http://127.0.0.1:11544/"
echo "[run-global] Ctrl+C 优雅关闭"
echo ""

if [ "$1" = "--bg" ]; then
    nohup claude-code-proxy > "$SCRIPT_DIR/run-global.log" 2>&1 &
    echo $! > "$SCRIPT_DIR/run-global.pid"
    echo "[run-global] 后台启动，PID=$!，日志：$SCRIPT_DIR/run-global.log"
    echo "[run-global] PID 文件：$SCRIPT_DIR/run-global.pid"
    echo "[run-global] 停止：bash standalone/run/stop.sh"
else
    exec claude-code-proxy
fi
