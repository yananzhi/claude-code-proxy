// 占位脚本：占用 11434 端口，用于验证插件在端口被非插件进程占用时的行为（EADDRINUSE 退化）。
// 跑：node plan/tmp/hold-port-11434.mjs
// 停：Ctrl+C（或任务管理器结束 node 进程）。
import net from 'node:net';

const PORT = 11434;
const server = net.createServer((sock) => {
    // 收到连接啥也不做，不响应，纯占端口
    sock.on('data', () => {});
    sock.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[hold] 端口 ${PORT} 已占用，PID=${process.pid}。Ctrl+C 释放。`);
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`[hold] 端口 ${PORT} 已被占用，无法占位。先关掉占用它的进程。`);
    } else {
        console.log(`[hold] 错误: ${e.message}`);
    }
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log(`[hold] 释放端口 ${PORT}，退出。`);
    server.close(() => process.exit(0));
});
