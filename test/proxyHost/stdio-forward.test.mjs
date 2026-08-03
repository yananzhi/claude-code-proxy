// test/proxyHost/stdio-forward.test.mjs — M2: stdout/stderr 行缓冲转发测试
//
// 验证 proxyHost.ts tryBecomeHost 里 forward() 的行为：
//   1. stdout/stderr 独立 lineBuf，不混合（修复共享 lineBuf 缺陷）
//   2. 残行（无换行结尾）在 stream end/close 时 flush，带正确前缀
//   3. FATAL + 立即 exit 的残行能被捕获
//
// proxyHost.ts import vscode 无法直接 require，这里内联 forward 的修复后实现 +
// 用真子进程的 stdout/stderr 验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

/** 内联修复后的 forward 实现（与 src/proxyHost.ts 逐字一致）。log 收到数组供断言。 */
function makeForward(log) {
  const forward = (stream, prefix) => {
    if (!stream) return () => {};
    let lineBuf = '';
    const flush = () => { if (lineBuf.length) { log(`${prefix}${lineBuf}`); lineBuf = ''; } };
    stream.on('data', (c) => {
      lineBuf += c.toString('utf8');
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.length) log(`${prefix}${line}`);
      }
    });
    stream.on('end', flush);
    stream.on('close', flush);
    return flush;
  };
  return forward;
}

test('stdout/stderr 独立 lineBuf：半行不混合', async () => {
  const logs = [];
  const forward = makeForward((s) => logs.push(s));
  // 子进程：stdout 写半行，stderr 写整行 + 换行，stdout 再写剩半行 + 换行
  const child = spawn(process.execPath, ['-e', `
    process.stdout.write('stdout-half');
    process.stderr.write('stderr-line\\n');
    process.stdout.write('-rest\\n');
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  forward(child.stdout, '');
  forward(child.stderr, '[stderr] ');
  await new Promise(r => child.on('exit', r));
  await new Promise(r => setTimeout(r, 50)); // 等 end/close flush
  // 期望：stderr 整行带 [stderr] 前缀，stdout 两段拼成一行不带前缀
  assert.ok(logs.includes('[stderr] stderr-line'), `stderr 行应带前缀，实际 logs=${JSON.stringify(logs)}`);
  assert.ok(logs.includes('stdout-half-rest'), `stdout 半行应拼成完整行，实际 logs=${JSON.stringify(logs)}`);
  // 不应有混合行
  assert.ok(!logs.some(l => l.includes('stdout-half') && l.includes('stderr')), `不应混合，logs=${JSON.stringify(logs)}`);
});

test('残行 flush：FATAL + 立即 exit，无换行结尾的残行被 flush', async () => {
  const logs = [];
  const forward = makeForward((s) => logs.push(s));
  // 子进程：stderr 写 FATAL 无换行，立即 exit(1)
  const child = spawn(process.execPath, ['-e', `
    process.stderr.write('FATAL: boom');
    process.exit(1);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  forward(child.stdout, '');
  forward(child.stderr, '[stderr] ');
  await new Promise(r => child.on('exit', r));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(logs.some(l => l === '[stderr] FATAL: boom'), `FATAL 残行应被 flush 带前缀，logs=${JSON.stringify(logs)}`);
});

test('残行 flush：stdout 持续输出无换行结尾，exit 后 flush', async () => {
  const logs = [];
  const forward = makeForward((s) => logs.push(s));
  const child = spawn(process.execPath, ['-e', `
    process.stdout.write('line1\\n');
    process.stdout.write('line2\\n');
    process.stdout.write('partial-no-newline');
    process.exit(0);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  forward(child.stdout, '');
  forward(child.stderr, '[stderr] ');
  await new Promise(r => child.on('exit', r));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(logs.includes('line1'), `logs=${JSON.stringify(logs)}`);
  assert.ok(logs.includes('line2'), `logs=${JSON.stringify(logs)}`);
  assert.ok(logs.includes('partial-no-newline'), `残行应被 flush，logs=${JSON.stringify(logs)}`);
});

test('多行 + 残行：完整行即时输出，残行延迟 flush', async () => {
  const logs = [];
  const forward = makeForward((s) => logs.push(s));
  const child = spawn(process.execPath, ['-e', `
    process.stdout.write('a\\nb\\nc');
    process.exit(0);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  forward(child.stdout, '');
  forward(child.stderr, '[stderr] ');
  await new Promise(r => child.on('exit', r));
  await new Promise(r => setTimeout(r, 50));
  // a, b 即时输出，c 残行 flush
  assert.ok(logs.includes('a') && logs.includes('b'), `完整行应即时，logs=${JSON.stringify(logs)}`);
  assert.ok(logs.includes('c'), `残行 c 应 flush，logs=${JSON.stringify(logs)}`);
});
