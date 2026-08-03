// test/proxyHost/spawn-helpers.test.mjs — killChild / waitForPortReady / exit 注册时机 行为测试
//
// 直接 import 编译产物 out/proxySpawnController.js 的真函数（不内联复制源码），
// 避免源码改了测试不同步。proxySpawnController.ts 不 import vscode，纯 Node 可 require。
//
// 运行：node --test test/proxyHost/spawn-helpers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import * as http from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const OUT = join(process.cwd(), 'out', 'proxySpawnController.js');
if (!existsSync(OUT)) {
  console.error('out/proxySpawnController.js 不存在，请先 npm run compile');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const { healthz, waitForPortReady, killChild } = require(OUT);

/** 子进程是否已退出（Windows 上 kill 后 exitCode=null 但 signalCode='SIGTERM'）。 */
function isDead(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

// ── 怀疑点 3：spawn 后 child.on('exit') 注册前子进程就 exit ───────────────
// Node ChildProcess 的事件不会在同步代码执行期间触发（exit 由 libuv 在下个 tick 发）。
// spawn 同步返回 → 同步注册 exit handler → 事件不丢。验证这个不变量。
test('exit 注册时机：spawn 后立即 exit 的子进程，注册前不丢事件', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  // 不立即注册 exit，先让一个 microtask 跑（模拟 spawn 后到 on('exit') 之间有别的同步代码）
  let exited = false;
  // 注册在下一个 macrotask 之前（setTimeout 0 仍在同 tick 后）
  await new Promise(r => setImmediate(r));
  child.on('exit', () => { exited = true; });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(exited, true, 'exit 事件必须被收到（Node 缓冲了 exit 事件）');
  assert.equal(child.exitCode, 0);
});

test('exit 注册时机：spawn 后同步立即注册，极快 exit 也不丢', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(exited, true);
  assert.equal(exitCode, 1);
});

// ── 怀疑点 4：killChild 对正常子进程 ──────────────────────────────────
test('killChild：正常子进程 kill 后在 3s 内退出', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 100)); // 确保子进程已起来
  assert.ok(!isDead(child), '子进程应还活着');
  const t0 = Date.now();
  await killChild(child);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `killChild 应在 3s 内 resolve（实际 ${elapsed}ms）`);
  assert.ok(isDead(child), '子进程应已退出（exitCode 或 signalCode 非 null）');
});

test('killChild：对已退出的子进程立即 resolve', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 100));
  assert.ok(isDead(child), '子进程应已自行退出');
  const t0 = Date.now();
  await killChild(child);
  assert.ok(Date.now() - t0 < 50, '已退出子进程应立即 resolve');
});

// ── 怀疑点 5：killChild 兜底——子进程忽略 SIGTERM 时，SIGKILL 兜底强杀 ───
// 修复前：3s 兜底 resolve 但子进程仍活（泄漏）。
// 修复后：3s 后 SIGKILL 强杀，再等 1s exit 落地，子进程必死。
// POSIX 上验证；Windows 上 child.kill 走 TerminateProcess 不可忽略，跳过。
test('killChild 兜底：忽略 SIGTERM 的子进程，SIGKILL 强杀后退出（修复后不泄漏）', { skip: process.platform === 'win32' ? 'Windows child.kill 走 TerminateProcess 不可忽略' : undefined }, async () => {
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM', () => { /* 忽略 */ });
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!isDead(child), '子进程应还活着');
  const t0 = Date.now();
  await killChild(child);
  const elapsed = Date.now() - t0;
  // 3s SIGTERM 超时 + 1s SIGKILL 等待 ≈ 3-4.5s
  assert.ok(elapsed >= 2900 && elapsed < 5000, `应等 3s+1s 兜底（实际 ${elapsed}ms）`);
  assert.ok(isDead(child), '修复后：SIGKILL 强杀，子进程应已退出（不泄漏）');
});

// ── 怀疑点 6：waitForPortReady——端口起 healthz 通则立即返回 true ─────────
test('waitForPortReady：端口就绪后返回 true', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const t0 = Date.now();
    const ready = await waitForPortReady(port, 2000);
    assert.equal(ready, true);
    assert.ok(Date.now() - t0 < 500, '应快速返回 true');
  } finally {
    server.close();
  }
});

test('waitForPortReady：端口无监听，超时后返回 false', async () => {
  // 找一个肯定没监听的端口
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const freePort = probe.address().port;
  await new Promise(r => probe.close(r));
  const t0 = Date.now();
  const ready = await waitForPortReady(freePort, 400);
  assert.equal(ready, false);
  assert.ok(Date.now() - t0 >= 380, `应等满超时（实际 ${Date.now() - t0}ms）`);
});

// ── 怀疑点 7：waitForPortReady 用 Date.now()——纯函数行为正常 ────────────
test('waitForPortReady：Date.now() 在纯 Node 正常推进 deadline', async () => {
  // 用一个从不 listen 的端口，确认 deadline 能正常到期（不卡死）
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const freePort = probe.address().port;
  await new Promise(r => probe.close(r));
  const ready = await waitForPortReady(freePort, 300);
  assert.equal(ready, false, 'deadline 到期正常返回 false，无卡死');
});

// ── 怀疑点 8：killChild 与 exit 事件竞争——kill 触发 exit，onExit 先收到 ──
test('killChild：kill 触发的 exit，once handler 正常收到并 resolve', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 100));
  // 同时注册一个外部 exit 监听器（模拟 proxyHost 的 child.on('exit') 清 handle）
  let externalExitSeen = false;
  child.on('exit', () => { externalExitSeen = true; });
  await killChild(child);
  // killChild resolve 后，外部 exit 监听器也应已被触发（exit 事件广播给所有监听器）
  assert.equal(externalExitSeen, true, '外部 exit 监听器应同时收到事件');
  assert.ok(isDead(child));
});

// ── 怀疑点 9：killChild 多次调用幂等性 ─────────────────────────────────
test('killChild：多次调用不抛错', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 100));
  await killChild(child);
  // 第二次调用：已退出，立即 resolve
  await killChild(child);
  await killChild(child);
  assert.ok(isDead(child));
});
