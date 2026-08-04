#!/usr/bin/env bash
# standalone/run/stop.sh — 停止后台跑的独立后端
#
# 用法：bash standalone/run/stop.sh
# 原理：优先读 run-dev.pid / run-global.pid 杀 cli.js 父进程
# （父进程的 SIGTERM 处理会优雅停掉 spawn 的 proxy 子进程 + PTY 会话）。
# pid 文件不在时回退到端口探测（杀监听 11444 的进程）。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=11444

stop_pid_file() {
    local pidfile="$1"
    local label="$2"
    if [ -f "$pidfile" ]; then
        local PID=$(cat "$pidfile" 2>/dev/null || true)
        if [ -n "$PID" ]; then
            echo "[stop] $label: kill 父进程 PID=$PID（SIGTERM，让其优雅停 proxy 子进程）"
            kill "$PID" 2>/dev/null || true
            # 等优雅关闭（SIGINT 处理器停 proxy + PTY + mgmt）
            for i in 1 2 3 4 5; do
                sleep 0.5
                if ! kill -0 "$PID" 2>/dev/null; then
                    echo "[stop] $label 已退出"
                    rm -f "$pidfile"
                    return 0
                fi
            done
            # 5s 没退，强杀父进程
            echo "[stop] $label 5s 未退，SIGKILL"
            kill -9 "$PID" 2>/dev/null || true
            rm -f "$pidfile"
            return 0
        fi
        rm -f "$pidfile"
    fi
    return 1
}

stopped_any=false
stop_pid_file "$SCRIPT_DIR/run-dev.pid" "run-dev" && stopped_any=true
stop_pid_file "$SCRIPT_DIR/run-global.pid" "run-global" && stopped_any=true

if [ "$stopped_any" = "false" ]; then
    # 无 pid 文件，回退端口探测
    PID=""
    if command -v lsof >/dev/null 2>&1; then
        PID=$(lsof -ti tcp:$PORT 2>/dev/null || true)
    elif command -v netstat >/dev/null 2>&1; then
        PID=$(netstat -ano 2>/dev/null | grep ":$PORT " | grep -i LISTENING | awk '{print $NF}' | head -1 || true)
    fi
    if [ -n "$PID" ]; then
        echo "[stop] 无 pid 文件，端口探测：kill 监听 $PORT 的进程 PID=$PID"
        kill "$PID" 2>/dev/null || true
        sleep 1
        kill -9 "$PID" 2>/dev/null || true
        echo "[stop] 已停（仅 proxy 子进程，cli.js 父进程若在需手动找）"
    else
        echo "[stop] 无 pid 文件且无监听 $PORT 的进程"
    fi
fi

echo "[stop] 完成"
