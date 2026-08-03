import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import {
  concise,
  detail,
  maskValue,
  renderHeaders,
  formatBody,
  setLogDir as loggerSetLogDir,
} from './logger.js';
import * as configStore from './config-store.js';
import * as traceStore from './trace-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, 'web');

// ── 小工具 ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.random().toString(16).slice(2, 6).toUpperCase();
const nowIso = () => new Date().toISOString();

// 按平台给默认端口，避免 Windows + WSL 同机抢同一 localhost（WSL2 转发会串味）。
// 与扩展侧 proxyHost.defaultPortForPlatform 保持一致。
function defaultPortForPlatform() {
  switch (process.platform) {
    case 'win32': return 11434;
    case 'darwin': return 11436;
    case 'linux': return 11435; // 含 WSL，不区分
    default: return 11435;
  }
}
function clientIp(req) {
  const a = req.socket?.remoteAddress || '';
  return a.replace(/^::ffff:/, '');
}
function runtimeParams() {
  const p = configStore.getProxy();
  const env = configStore.getEnv();
  return {
    maxAttempts: p.maxAttempts,
    backoffSec: p.backoffSec,
    backoffMaxSec: p.backoffMaxSec,
    passthrough: p.passthrough,
    retryRules: p.retryRules,
    upstreamTimeoutMs: env.upstreamTimeoutMs,
    upstream: env.upstream,
    upstreamBase: env.upstreamBase,
    token: env.token,
  };
}
const backoffForMs = (attempt, backoffSec, backoffMaxSec) =>
  Math.min(backoffSec * 1000 * 2 ** (attempt - 1), backoffMaxSec * 1000);

function lanIpv4s() {
  const out = [];
  try {
    for (const [, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) out.push(a.address);
      }
    }
  } catch {}
  return out;
}

// ── effort 改写：把请求体里的 output_config.effort 强制改写为目标值 ──
// 只改写已有 output_config.effort 的 /v1/messages JSON 请求；不凭空给无 effort 的
// 请求注入 output_config（避免改变 Claude Code 本没设 effort 的请求行为）。
// 任何异常都原样返回 body，绝不因改写失败阻断转发。
function rewriteEffort(body, effortLevel, reqId, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (!ct.includes('json')) return body;
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body; // 非 JSON body（如 event-stream 响应、空 body），原样转发
  }
  if (!parsed || typeof parsed !== 'object') return body;
  const oc = parsed.output_config;
  if (typeof oc !== 'object' || oc === null || !('effort' in oc)) return body;
  const prev = oc.effort;
  if (prev === effortLevel) return body; // 已经是目标值，免去一次 stringify + body 长度变化
  oc.effort = effortLevel;
  let rewritten;
  try {
    rewritten = Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return body;
  }
  detail(reqId, 'EFFORT REWRITE', `output_config.effort: ${String(prev)} → ${effortLevel} (${body.length} → ${rewritten.length} bytes)`);
  return rewritten;
}

// ── 响应首段 body 错误探测（流式版 inspectBody）────────────────
// 作用在「已收到的部分 body」上 + 已知 status，判是否命中 retryRules 的某条规则。
// 返回：
//   'retryable'  — 命中某条规则：status 匹配（含 '*' 通配）且 body code 满足规则 code 要求
//                  （code='all' 不依赖 body；具体 code 需 parse 出 {type:error, error.code} 匹配）
//   'not-error'  — parse 成功但不是命中的 error 结构（正常 JSON 响应 / 非规则 error）
//   'incomplete' — 当前 buffer 还不是合法 JSON（成功 SSE 首 chunk 是 `event:...\ndata:...`，
//                  parse 必然失败；或 error JSON 被切片尚未到齐）
// 关键：成功响应（含 SSE）首 chunk 永远不是合法 JSON → 返回 incomplete → 调用方继续攒到上限
// 后仍判不出 → 当成功转发。故成功响应绝不误判为错误。
// code='all' 规则的特殊性：不依赖 body parse，只要 status 匹配就 retryable（哪怕 buf 为空）。
// 这使"所有 503 都重试"在响应头一到即决断，不会因等 body 而被流式提前交付（修复核心 bug）。
const FIRST_BODY_INSPECT_LIMIT = 8 * 1024; // 攒到 8KB 仍 parse 不出就当成功转发
function inspectFirstBody(buf, status, retryRules) {
  if (!retryRules || retryRules.length === 0) return 'not-error';
  // 先按 status 筛出可能命中的规则（status === '*' 通配任意）
  const candidates = retryRules.filter((r) => r.status === '*' || r.status === status);
  if (candidates.length === 0) return 'not-error';
  // 含 code='all' 的规则 → 不依赖 body，直接 retryable（响应头即决断）
  if (candidates.some((r) => r.code === 'all')) return 'retryable';
  // 其余规则需 parse body 取 error.code 比对
  if (buf.length === 0) return 'incomplete';
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return 'incomplete';
  }
  if (!parsed || typeof parsed !== 'object') return 'not-error';
  if (parsed.type === 'error' && parsed.error) {
    const code = parsed.error.code;
    if (code != null && candidates.some((r) => r.code === Number(code))) return 'retryable';
    return 'not-error';
  }
  return 'not-error';
}

// 命中规则的描述（供 trace verdict.reason 用），返回首条命中规则的 "status+code" 字符串。
// 与 inspectFirstBody 同语义：先 status 筛，all 优先；否则 parse body 取 code。
function describeHitRule(status, buf, retryRules) {
  if (!retryRules || retryRules.length === 0) return null;
  const candidates = retryRules.filter((r) => r.status === '*' || r.status === status);
  if (candidates.length === 0) return null;
  const allRule = candidates.find((r) => r.code === 'all');
  if (allRule) return `rule ${allRule.status}+all`;
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed && parsed.type === 'error' && parsed.error) {
      const code = parsed.error.code;
      const hit = candidates.find((r) => r.code === Number(code));
      if (hit) return `rule ${hit.status}+${hit.code}`;
    }
  } catch {}
  return null;
}

// ── 转发一次请求到上游，成功响应即时流式回推客户端 ──────────────
// 收到上游响应头 + 首个 data chunk 即按 retryRules 决断：
//   - 命中 retryRules（status 匹配 + code 满足；code='all' 不依赖 body）→ 不转发，
//     全量缓冲返回（供上层丢弃 + 重试）。streamed: false + bodyErrReason 标记命中规则。
//   - 否则（未命中：parse 失败 = 成功 SSE 首 chunk 不是合法 JSON；或非 error 结构；
//     或 status/code 不在规则里）→ 立刻 writeHead + 把已攒 chunk flush 出去 +
//     后续边收边 write。streamed: true。
// 关键不变量：成功响应（含 SSE）的首个 chunk 永远不是合法 JSON（是
// `event: ...\ndata: ...`），parse 必然失败 → 必走转发分支，绝不误判成功为错误。
// 实测（trace 日志）：讯飞 system-busy 错误 body 仅 ~132 字节、合法 JSON、必然落在
// 首个 chunk，故首段判断充分；极罕见的 error JSON 被切片时攒够再判，仍判不出则当成功转发。
// code='all' 规则不依赖 body parse：响应头一到（status 已知）即决断 retryable，
// 哪怕 buf 为空。这使"所有 503 都重试"在 writeHead 之前决断，修复了旧 retryOnStatus
// 因等 body 而被流式提前交付、verdict 阶段才判状态码（已不可回滚）的 bug。
function forwardStreaming({ method, path, reqHeaders, body, reqId, attempt, timeoutMs, upstream, token, clientRes, retryRules }) {
  return new Promise((resolve) => {
    if (!upstream || !upstream.protocol) {
      detail(reqId, `attempt ${attempt} → NO UPSTREAM`, '代理尚未注入上游配置（请在 claude-code-proxy 激活一条"通过代理"配置）');
      resolve({ status: 0, headers: {}, body: Buffer.alloc(0), networkError: 'no upstream configured', streamed: false, firstChunkAt: null });
      return;
    }
    const upstreamLib = upstream.protocol === 'https:' ? https : http;
    const upstreamDefaultPort = upstream.protocol === 'https:' ? 443 : 80;
    const upstreamPathPrefix = upstream.pathname.replace(/\/$/, '');
    const reqPath = path.startsWith('/') ? path : '/' + path;
    const target = new URL(upstreamPathPrefix + reqPath, upstream.origin);

    const outHeaders = { ...reqHeaders };
    outHeaders['host'] = target.host;
    outHeaders['authorization'] = `Bearer ${token}`;
    delete outHeaders['content-length'];
    delete outHeaders['content-encoding'];
    delete outHeaders['connection'];

    detail(reqId, `attempt ${attempt} → UPSTREAM REQUEST`, [
      `${method} ${target.href}`,
      'Headers:',
      renderHeaders(outHeaders),
      `Body: identical to client request (${body.length} bytes)`,
    ].join('\n'));

    let settled = false;
    const settle = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    const req = upstreamLib.request(
      {
        method,
        hostname: target.hostname,
        port: target.port || upstreamDefaultPort,
        path: target.pathname + target.search,
        headers: outHeaders,
        timeout: timeoutMs,
      },
      (resp) => {
        const status = resp.statusCode ?? 0;
        const chunks = [];
        let ended = false;
        // streaming 三态：'pending'（还在攒首段判错）、'stream'（已开始转发）、'buffer'（判为重试错误，全量缓冲丢弃）
        let mode = 'pending';
        let bodyErrReason = null; // 判定为 retryable error 时的原因，供上层 verdict
        // 首个有效 chunk 到达时刻（mode 首次 pending→stream）。失败的 attempt 走 buffer 分支，
        // 不会置 stream，故 firstChunkAt 保持 null —— 天然满足「前 N 次失败不计入」。
        let firstChunkAt = null;
        const markFirstChunk = () => { if (firstChunkAt === null) firstChunkAt = new Date().toISOString(); };

        // 在「还没开始转发」时，攒到的 chunk 试判是否命中 retryRules。返回 true 表示已决断。
        const tryDecide = () => {
          if (mode !== 'pending') return;
          const buf = Buffer.concat(chunks);
          // status 已知（响应头已到）。inspectFirstBody 先按 status 筛规则：
          //   - code='all' 规则：不依赖 body，buf 为空也能判 retryable（响应头即决断）
          //   - 具体 code 规则：parse body 取 error.code 比对
          // 这使非 2xx 状态码规则在 writeHead 之前即决断，不会被流式提前交付（修复核心 bug）。
          const inspected = inspectFirstBody(buf, status, retryRules);
          if (inspected === 'retryable') {
            // 命中规则 → 全量缓冲丢弃，不转发
            mode = 'buffer';
            bodyErrReason = describeHitRule(status, buf, retryRules) || 'retry rule hit';
            return;
          }
          if (inspected === 'incomplete') {
            // 首段还不是合法 JSON（可能 error 被切片，也可能是成功 SSE 首 chunk）
            // → 攒到上限仍判不出，就当成功转发（成功 SSE 首 chunk 本就 parse 失败）
            if (buf.length < FIRST_BODY_INSPECT_LIMIT) return; // 继续攒
            // 攒到上限仍 parse 不出 → 视为成功，立即转发
          }
          // inspected === 'not-error' 或 攒到上限 → 立即开始转发
          mode = 'stream';
          markFirstChunk();
          if (clientRes && !clientRes.headersSent) {
            const h = { ...resp.headers };
            delete h['content-encoding'];
            delete h['connection'];
            // 保留 transfer-encoding/content-type，让客户端按 chunked 增量接收
            clientRes.writeHead(status, h);
            // flush 已攒的 chunk
            clientRes.write(buf);
          }
        };

        resp.on('data', (c) => {
          chunks.push(c);
          if (mode === 'pending') tryDecide();
          else if (mode === 'stream' && clientRes.writableEnded === false) clientRes.write(c);
        });
        resp.on('end', () => {
          ended = true;
          // 兜底决断：空 body 的非 2xx（如 503 Content-Length:0）data 事件不触发，
          // tryDecide 从未被调用。但 code='all' 规则不依赖 body，本应响应头即决断重试。
          // 故 end 时若仍 pending，用已攒的（可能为空）buffer 再试判一次，覆盖空 body + all 规则。
          if (mode === 'pending') tryDecide();
          const wasPending = mode === 'pending';
          // 仍 pending（上游 body 全到齐仍判不出，或空 body 200 且无 all 规则）→ 当成功转发。
          // 必须先 flush 攒到的 chunk 再 end，否则客户端只收到头、body 丢空。
          if (wasPending) {
            mode = 'stream';
            markFirstChunk();
            if (clientRes && !clientRes.headersSent) {
              const h = { ...resp.headers };
              delete h['content-encoding'];
              delete h['connection'];
              clientRes.writeHead(status, h);
            }
          }
          const buf = Buffer.concat(chunks);
          const streamed = mode === 'stream';
          if (streamed) {
            // 仅 pending→stream 转换路径下有未 flush 的 chunk（tryDecide 期间攒的）；
            // 正常流式路径每个 chunk 已在 data 事件里 write 过，这里不重写避免重复。
            if (wasPending && !clientRes.writableEnded && buf.length > 0) {
              try { clientRes.write(buf); } catch {}
            }
            try { clientRes.end(); } catch {}
          }
          const r = { status, headers: resp.headers, body: buf, networkError: null, streamed, bodyErrReason, firstChunkAt };
          detail(reqId, `attempt ${attempt} → UPSTREAM RESPONSE`, [
            `Status: ${r.status}${streamed ? ' (streamed to client)' : ' (buffered' + (bodyErrReason ? `: ${bodyErrReason}` : '') + ')'}`,
            'Headers:',
            renderHeaders(r.headers),
            `Body (${r.body.length} bytes):`,
            formatBody(r.body, r.headers['content-type']),
          ].join('\n'));
          settle(r);
        });
        resp.on('error', (e) => {
          // 若已开始流式写头，客户端已收到状态行 + 部分 body；上游此时断流属「截断的响应」，
          // 不能再合成 502（会 ERR_HTTP_HEADERS_SENT）。streamed=true 告知上层「已交付」。
          const alreadyStreamed = mode === 'stream' && clientRes.headersSent;
          if (mode === 'stream' && !ended) {
            try { clientRes.end(); } catch {}
          }
          settle({ status: alreadyStreamed ? status : 0, headers: {}, body: Buffer.concat(chunks), networkError: `response stream error: ${e.message}`, streamed: alreadyStreamed, bodyErrReason: null, firstChunkAt });
        });
        resp.on('close', () => {
          if (!ended) {
            const alreadyStreamed = mode === 'stream' && clientRes.headersSent;
            if (mode === 'stream') {
              try { clientRes.end(); } catch {}
            }
            // 已流式交付时保留 status（客户端已收到），streamed=true 阻止上层再写；
            // networkError 保留原因供 trace，但不影响交付决策。
            settle({ status: alreadyStreamed ? status : 0, headers: {}, body: Buffer.concat(chunks), networkError: alreadyStreamed ? `stream truncated (already delivered ${status})` : 'response stream closed prematurely', streamed: alreadyStreamed, bodyErrReason: null, firstChunkAt });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      settle({ status: 0, headers: {}, body: Buffer.alloc(0), networkError: `timeout (${timeoutMs}ms)`, streamed: false, bodyErrReason: null, firstChunkAt: null });
    });
    req.on('error', (e) => {
      settle({ status: 0, headers: {}, body: Buffer.alloc(0), networkError: e.message, streamed: false, bodyErrReason: null, firstChunkAt: null });
    });

    req.end(body);
  });
}

// ── 末次响应一次性回推客户端（重试失败/非 2xx passthrough 用，body 已全量缓冲）──
// 删 transfer-encoding/content-length：body 已是完整 Buffer，用默认写法一次性吐。
function reply(clientRes, r) {
  const h = { ...r.headers };
  delete h['content-encoding'];
  delete h['transfer-encoding'];
  delete h['content-length'];
  clientRes.writeHead(r.status, h);
  clientRes.end(r.body);
}


// ── 控制面 API ──────────────────────────────────────────────
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    throw new Error('invalid JSON body');
  }
}
function sendJson(res, status, obj) {
  // 必须显式写 Content-Length：不写时 Node http server 对 res.end(string) 会自动改用
  // Transfer-Encoding: chunked 分块发送（HTTP/1.1 无 Content-Length 就得分块）。
  // 扩展宿主（Electron）的 http 客户端不解码 chunked → data 事件不投递 → 客户端拿到 status 200 + 空 body
  //（详见 CLAUDE.md「扩展宿主调本地 HTTP 服务的空 body 坑」，实测确认与 proxy-agent 无关，
  //  真因是 chunked 未被客户端解码）。显式 Content-Length 让服务端发完整 body，客户端正常收。
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.includes('..')) {
    sendJson(res, 400, { error: 'bad path' });
    return;
  }
  const abs = join(WEB_DIR, rel);
  if (!abs.startsWith(WEB_DIR) || !existsSync(abs)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const mime = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
  const data = readFileSync(abs);
  // 显式 Content-Length（同 sendJson 理由：避免 chunked 被扩展宿主 http 客户端吞 body）
  res.writeHead(200, { 'content-type': mime, 'content-length': data.length });
  res.end(data);
}

async function handleApi(req, res, urlPath) {
  if (req.method === 'GET' && urlPath === '/api/config') {
    sendJson(res, 200, configStore.getView());
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/config') {
    try {
      const body = await readJsonBody(req);
      const updated = configStore.updateProxy(body.proxy ?? body);
      concise(`CONFIG updated → maxAttempts=${updated.maxAttempts} backoffSec=${updated.backoffSec} backoffMaxSec=${updated.backoffMaxSec}`);
      sendJson(res, 200, { ok: true, proxy: updated });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/upstream') {
    try {
      const body = await readJsonBody(req);
      const updated = configStore.updateUpstream(body.upstream ?? body);
      const env = configStore.getEnv();
      concise(`UPSTREAM updated → baseUrl=${env.upstreamBase} model=${env.model ?? '(unset)'} timeout=${env.upstreamTimeoutMs}ms`);
      sendJson(res, 200, { ok: true, upstream: updated });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }
  // 热改 effortLevel：下个请求即生效。level ∈ {'', low, medium, high, xhigh, max}；'' = 不改写原样透传。
  if (req.method === 'POST' && urlPath === '/api/effort') {
    try {
      const body = await readJsonBody(req);
      const level = body.level;
      const updated = configStore.updateEffort(level);
      concise(`EFFORT updated → ${updated || '(不改写，原样透传)'}`);
      sendJson(res, 200, { ok: true, effortLevel: updated });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }
  // model alias 热更新：加/改一条别名→真实模型映射，下个请求即生效。
  if (req.method === 'POST' && urlPath === '/api/model-alias') {
    try {
      const body = await readJsonBody(req);
      const { alias, model } = body;
      if (typeof alias !== 'string' || !alias || typeof model !== 'string' || !model) {
        throw new Error('需要 {alias, model} 两个非空字符串');
      }
      const result = configStore.updateModelAlias(alias, model);
      concise(`MODEL-ALIAS updated → ${alias}=${model}`);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }
  // model alias 删除：删一条映射，下个请求即生效。
  if (req.method === 'POST' && urlPath === '/api/model-alias/delete') {
    try {
      const body = await readJsonBody(req);
      const { alias } = body;
      if (typeof alias !== 'string' || !alias) {
        throw new Error('需要 {alias} 非空字符串');
      }
      const result = configStore.removeModelAlias(alias);
      concise(`MODEL-ALIAS removed → ${alias}`);
      sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }
  // 申请下一个会话编号（全局递增、持久化、跨重启不重号）。
  if (req.method === 'GET' && urlPath === '/api/model-alias/next-id') {
    try {
      const id = configStore.nextAliasId();
      sendJson(res, 200, { id });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/traces') {
    const u = new URL('http://x' + req.url);
    const since = u.searchParams.get('since') || undefined;
    // mode: all | retried | failed | llm-error（默认 all）
    // 旧参数 onlyRetries=1 等价于 mode=retried（向后兼容）
    let mode = u.searchParams.get('mode') || 'all';
    if (u.searchParams.get('onlyRetries') === '1') mode = 'retried';
    const limit = Number(u.searchParams.get('limit')) || 200;
    sendJson(res, 200, await traceStore.list({ since, mode, limit }));
    return;
  }
  // 时间窗口成功统计：windows=1,5,24 → 最近1h/5h/1天的成功命令数。
  // 前端可自定义窗口（逗号分隔的小时数）。成功=finalStatus 2xx。
  if (req.method === 'GET' && urlPath === '/api/stats') {
    const u = new URL('http://x' + req.url);
    const wRaw = u.searchParams.get('windows') || '1,5,24';
    // 上限 168h（7天）= trace 保留期，超过的数据已被 cleanupOld 删掉，统计无意义且会撑爆 days 扫描循环
    const MAX_HOURS = 168;
    const windows = String(wRaw)
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_HOURS)
      .slice(0, 12); // 防止前端塞几百个窗口拖垮扫描
    const ws = windows.length ? windows : [1, 5, 24];
    sendJson(res, 200, await traceStore.stats({ windows: ws }));
    return;
  }
  const m = urlPath.match(/^\/api\/traces\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const r = await traceStore.getById(m[1]);
    sendJson(res, r ? 200 : 404, r ?? { error: 'trace not found' });
    return;
  }
  // 返回 logs 目录绝对路径（前端展示 + 决定是否可打开）
  if (req.method === 'GET' && urlPath === '/api/logs-dir') {
    sendJson(res, 200, { dir: traceStore.getLogDir(), configured: traceStore.isLogsDirConfigured() });
    return;
  }
  // 改 logs 目录：写回 logs-config.json + 改运行时 LOG_DIR + mkdir。
  // 立即生效（下一条 trace 写新目录），历史日志留在原地不迁移。
  if (req.method === 'POST' && urlPath === '/api/logs-dir') {
    try {
      const body = await readJsonBody(req);
      const dir = body.dir;
      // dir 必须是字符串；空字符串 = 恢复默认（合法）。只拒绝 undefined/非字符串。
      if (typeof dir !== 'string') {
        sendJson(res, 400, { error: '缺少 dir 字段（string，空串=恢复默认）' });
        return;
      }
      const newDir = traceStore.setLogsDir(dir.trim());
      // logger 的 LOG_DIR 也要跟着改，否则 trace 文件去了新目录、详细日志还留在旧目录
      loggerSetLogDir(newDir);
      concise(`LOGS_DIR changed → ${newDir}`);
      sendJson(res, 200, { ok: true, dir: newDir, configured: traceStore.isLogsDirConfigured() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }
  // 在系统文件管理器里打开 logs 目录并定位（跨平台）
  if (req.method === 'POST' && urlPath === '/api/open-logs') {
    const dir = traceStore.getLogDir();
    try {
      openInFileManager(dir);
      concise(`OPEN logs dir: ${dir}`);
      sendJson(res, 200, { ok: true, dir });
    } catch (e) {
      sendJson(res, 500, { error: e.message, dir });
    }
    return;
  }
  // kill 代理：关掉监听句柄。任意窗口都可调（不限于宿主）。
  // 关掉后宿主窗口心跳会在 ≤2s 内发现 healthz 不通，tryBecomeHost 重起一个。
  // 注意：重起的是宿主内存里已缓存的 proxyModule —— 改了 proxy 代码不会因此重新加载，
  // 要加载新代码得 Reload Window（且 Reload 的是宿主那个窗口）。
  // 代理监听端口：GET 返回当前端口 + 平台默认；POST 改端口（写 config + kill 让心跳重启）
  if (req.method === 'GET' && urlPath === '/api/port') {
    const listen = configStore.getListen();
    sendJson(res, 200, { port: listen.listenPort, defaultPort: defaultPortForPlatform() });
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/port') {
    try {
      const body = await readJsonBody(req);
      const updated = configStore.updateListenPort(body.port);
      concise(`PORT changed → ${updated.listenPort}（需重启生效，将关闭监听让心跳重起）`);
      // 先回响应，再 kill 监听（和 /api/kill 同样套路）
      sendJson(res, 200, { ok: true, port: updated.listenPort });
      setImmediate(() => {
        // 子进程模式：exit(0) 让宿主 re-spawn 新端口进程；in-proc：只关监听
        // exit 分支不 close——process.exit 立即终止，close 来不及生效（评审观察：死代码）
        if (exitOnKill) { process.exit(0); }
        try { runningServer?.close?.(); } catch {}
      });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/kill') {
    concise('KILL 收到请求，关闭代理监听（宿主心跳将自动重起）');
    sendJson(res, 200, { ok: true });
    // 先回响应再关，避免连接复位导致前端拿不到 200
    setImmediate(() => {
      // 子进程模式：exit(0) 让宿主心跳探测不通不了后 re-spawn；in-proc：只关监听（进程空转无妨）
      if (exitOnKill) { process.exit(0); }
      try { runningServer?.close?.(); } catch {}
    });
    return;
  }
  sendJson(res, 404, { error: 'unknown api' });
}

// 在系统文件管理器里打开目录（跨平台）。Windows 用 explorer，macOS 用 open，Linux 用 xdg-open。
function openInFileManager(dir) {
  const platform = process.platform;
  let cmd, args;
  if (platform === 'win32') {
    cmd = 'explorer'; args = [dir];
  } else if (platform === 'darwin') {
    cmd = 'open'; args = [dir];
  } else {
    cmd = 'xdg-open'; args = [dir];
  }
  // detached + stdio ignore：子进程不挂到代理生命周期上，关代理不影响已打开的资源管理器
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// ── 请求处理（模块级，依赖 configStore/traceStore，由 startServer 先 init）──
async function handleRequest(req, res) {
  // 规范化 urlPath：用 URL 解析，丢弃可能的绝对路径前缀。
  // VS Code 扩展宿主的 @vscode/proxy-agent 会劫持 http.get，把请求行改成绝对路径
  // （GET http://127.0.0.1:11434/api/...），导致 req.url 是绝对路径、字面匹配失败、
  // fall-through 到代理转发。用 new URL 规范化拿 pathname，免疫绝对路径。
  let urlPath;
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    urlPath = parsed.pathname;
  } catch {
    urlPath = req.url.split('?')[0];
  }

  if (req.method === 'GET' && urlPath === '/healthz') {
    sendJson(res, 200, { ok: true, upstream: configStore.getEnv().upstreamBase, ts: nowIso() });
    return;
  }
  if (urlPath.startsWith('/api/')) {
    try {
      await handleApi(req, res, urlPath);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  if (req.method === 'GET' && (urlPath === '/' || urlPath.startsWith('/assets/'))) {
    serveStatic(req, res, urlPath);
    return;
  }

  // ── 代理转发 ──────────────────────────────────────────
  const startedAt = nowIso();
  const t0 = Date.now();
  const ip = clientIp(req);

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const id = rid();

  // 从请求 body 提取 model 字段（Claude API /v1/messages 请求体含 model）
  let reqModel = '';
  try {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('json') && body.length > 0) {
      const parsed = JSON.parse(body.toString('utf8'));
      reqModel = parsed.model || '';
    }
  } catch { /* 非 JSON 或解析失败，忽略 */ }

  // effort 改写：仅对 /v1/messages 主路径（不含 count_tokens/batches 等子路径）的 JSON 请求改写。
  // effortLevel 为空串（用户选"不改写"）时原样透传；无 output_config 或 effort 缺失也不改；改写失败也原样透传。
  const effortLevel = configStore.getEffortLevel();
  const isMessagesMain = /^\/v1\/messages(?:\?|$)/.test(req.url);
  let outBody = (effortLevel && isMessagesMain)
    ? rewriteEffort(body, effortLevel, id, req.headers['content-type'])
    : body;
  const effortRewritten = outBody !== body;
  // model 别名替换：不受 isMessagesMain 守卫，所有带 model 字段的 JSON 请求都查表
  // （含 /v1/messages/count_tokens 子路径）。返回 resolvedModel 供 trace 记真实模型。
  const modelResult = configStore.rewriteModel(outBody, id, req.headers['content-type']);
  outBody = modelResult.body;
  const resolvedModel = modelResult.resolvedModel;
  const rewritten = outBody !== body;
  const modelTag = (resolvedModel && resolvedModel !== reqModel) ? ` [model→${resolvedModel}]` : '';

  const params = runtimeParams();
  const { maxAttempts, backoffSec, backoffMaxSec, passthrough, retryRules, upstreamTimeoutMs, upstream, upstreamBase, token } = params;
  const modeTag = passthrough ? '透传' : '重试';

  concise(`REQ  #${id} ${req.method} ${req.url} (body ${body.length} bytes) from ${ip} [${modeTag}]${effortRewritten ? ` [effort→${effortLevel}]` : ''}${modelTag}`);
  detail(id, 'CLIENT → PROXY REQUEST', [
    `${req.method} ${req.url}`,
    `mode: ${modeTag}`,
    'Headers:',
    renderHeaders(req.headers),
    `Body (${body.length} bytes):`,
    formatBody(body, req.headers['content-type']),
  ].join('\n'));

  const attempts = [];
  let attempt = 0;
  let finalDelivered = null;
  let outcome = 'failed';
  // 最终成功交付那次的首字节到达时刻 / 首字节耗时 / 末次 attempt 耗时。全失败时保持 null。
  let finalFirstChunkAt = null;
  let finalFirstChunkMs = null;
  let finalLastAttemptMs = null;

  if (passthrough) {
    attempt = 1;
    const attStart = nowIso();
    const attT0 = Date.now();
    const r = await forwardStreaming({ method: req.method, path: req.url, reqHeaders: req.headers, body: outBody, reqId: id, attempt, timeoutMs: upstreamTimeoutMs, upstream, token, clientRes: res, retryRules });
    const attMs = Date.now() - attT0;
    concise(`     #${id} attempt 1/1 → ${r.status || 'NETERR'} (${attMs}ms) [透传，不重试${r.streamed ? '，流式' : ''}]`);
    const firstChunkMs = r.firstChunkAt ? Date.parse(r.firstChunkAt) - attT0 : null;
    attempts.push({ attempt: 1, status: r.status, networkError: r.networkError ?? null, startedAt: attStart, endedAt: nowIso(), elapsedMs: attMs, firstChunkAt: r.firstChunkAt ?? null, firstChunkMs, verdict: 'passthrough', reason: 'passthrough mode (no retry)', backoffMs: null, upstreamRequestBody: outBody.toString('utf8'), upstreamResponseBody: r.body.toString('utf8') });
    finalFirstChunkAt = r.firstChunkAt ?? null;
    finalFirstChunkMs = firstChunkMs;
    finalLastAttemptMs = attMs;
    if (r.status === 0) {
      const errBody = JSON.stringify({ type: 'error', error: { type: 'upstream_unreachable', message: `upstream ${upstreamBase ?? ''} unreachable (passthrough): ${r.networkError}` } });
      res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(errBody) });
      res.end(errBody);
      finalDelivered = { status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(errBody) };
      outcome = 'passed-to-client';
    } else if (r.streamed) {
      // 2xx 已流式回推客户端，无需再 reply
      finalDelivered = r;
      outcome = 'passthrough';
    } else {
      // 非 2xx（passthrough 不重试），一次性转发
      reply(res, r);
      finalDelivered = r;
      outcome = 'passthrough';
    }
    concise(`REQ  #${id} delivered to client (passthrough), total ${Date.now() - t0}ms, status ${finalDelivered.status}`);
  } else {
    while (attempt < maxAttempts) {
      attempt++;
      const attStart = nowIso();
      const attT0 = Date.now();
      const r = await forwardStreaming({ method: req.method, path: req.url, reqHeaders: req.headers, body: outBody, reqId: id, attempt, timeoutMs: upstreamTimeoutMs, upstream, token, clientRes: res, retryRules });
      const attMs = Date.now() - attT0;
      concise(`     #${id} attempt ${attempt}/${maxAttempts} → ${r.status || 'NETERR'} (${attMs}ms${r.networkError ? ` ${r.networkError}` : ''}${r.streamed ? ' [流式]' : ''})`);

      let verdict;
      // 原则：代理只重试 Claude Code 处理不了的——命中 retryRules 的响应。
      //   forwardStreaming 在首段即按 retryRules 决断：命中 → 缓冲不转发（streamed=false +
      //   bodyErrReason 标记命中规则）。code='all' 规则响应头一到即决断（不等 body），
      //   故非 2xx 状态码规则不会被流式提前交付（修复了旧 retryOnStatus 被流式吞掉的 bug）。
      // 其余全部透传交给 Claude Code 自己处理：
      //   - 429/500/502/504 等：Claude Code 的 shouldRetry 会当 5xx/限流重试
      //   - 网络错误（超时/断连/流中断）：Claude Code 会当 APIConnectionError 重试
      //     代理无法原样转 socket 错误，合成 502 回客户端，Claude Code 仍当 5xx 重试，语义等价。
      // 唯一例外：上游未注入（no upstream configured）——代理没配好，不是网络问题，
      // 包 502 提示用户去激活配置，这个不交给 Claude Code。
      if (r.status === 0) {
        verdict = { retryable: false, reason: `network error, pass to Claude Code (${r.networkError})` };
      } else if (r.streamed) {
        // 已流式回推客户端（成功响应，或未命中规则的非 2xx 透传）→ 终态，不再重试。
        verdict = null;
      } else if (r.bodyErrReason) {
        // 缓冲未转发 + 命中 retryRules → 重试
        verdict = { retryable: true, reason: `${r.status} + ${r.bodyErrReason}` };
      } else {
        // 缓冲未转发但未命中规则（理论上不应到此：未命中必 streamed）→ 防御性透传
        verdict = { retryable: false, reason: `status ${r.status} not hit any retry rule` };
      }

      detail(id, `attempt ${attempt}/${maxAttempts} → VERDICT`, [
        `status: ${r.status || 'NETERR'}`,
        `verdict: ${verdict === null ? 'SUCCESS' : verdict.retryable ? 'RETRYABLE' : 'NOT-RETRYABLE'}`,
        `reason: ${verdict === null ? '(real success)' : verdict.reason}`,
        `elapsed: ${attMs}ms`,
      ].join('\n'));

      let waitMs = null;
      if (verdict !== null && verdict.retryable && attempt < maxAttempts) {
        waitMs = backoffForMs(attempt, backoffSec, backoffMaxSec);
      }
      const is2xx = r.status >= 200 && r.status < 300;
      const firstChunkMs = r.firstChunkAt ? Date.parse(r.firstChunkAt) - attT0 : null;
      attempts.push({ attempt, status: r.status, networkError: r.networkError ?? null, startedAt: attStart, endedAt: nowIso(), elapsedMs: attMs, firstChunkAt: r.firstChunkAt ?? null, firstChunkMs, verdict: verdict === null ? (is2xx ? 'success' : 'pass-through') : verdict.retryable ? 'retryable' : 'not-retryable', reason: verdict === null ? (r.networkError ? `${is2xx ? 'success' : 'delivered'} (truncated: ${r.networkError})` : (is2xx ? '(real success)' : `(delivered ${r.status} as-is)`)) : verdict.reason, backoffMs: waitMs, upstreamRequestBody: outBody.toString('utf8'), upstreamResponseBody: r.body.toString('utf8') });

      if (verdict === null) {
        // 已流式回推客户端。2xx 是真成功；非 2xx（如 503-other，body 非 retryable）是
        // 原样透传——客户端已收到该状态码，无法回滚，按交付处理。若 r.networkError 非空，
        // 说明是「已交付后上游断流」的截断，trace 记原因。
        const truncReason = r.networkError ? ` (truncated: ${r.networkError})` : '';
        concise(`     #${id} DONE${truncReason}`);
        detail(id, 'DELIVER TO CLIENT', `${is2xx ? 'real success' : `delivered ${r.status} as-is`}, already streamed upstream response${truncReason}`);
        finalDelivered = r;
        // 成功交付：取本次首字节时刻/耗时与末次耗时。前 N 次失败 attempt 的 firstChunkAt 为 null，不会覆盖。
        finalFirstChunkAt = r.firstChunkAt ?? null;
        finalFirstChunkMs = firstChunkMs;
        finalLastAttemptMs = attMs;
        if (!is2xx) {
          outcome = 'pass-through';
        } else {
          outcome = attempt === 1 ? 'success-direct' : 'success-after-retry';
        }
        break;
      }
      if (verdict.retryable && attempt < maxAttempts) {
        concise(`     #${id} RETRY (${verdict.reason}) → waiting ${waitMs}ms`);
        detail(id, `attempt ${attempt}/${maxAttempts} → BACKOFF`, `waiting ${waitMs}ms before next attempt`);
        await sleep(waitMs);
        continue;
      }
      if (verdict.retryable) {
        concise(`     #${id} retry budget exhausted (${verdict.reason})`);
      } else {
        concise(`     #${id} PASS-THROUGH (${verdict.reason})`);
      }
      detail(id, 'DELIVER TO CLIENT', [verdict.retryable ? 'retry budget exhausted' : 'not retryable, pass-through', `forwarding last upstream response (status ${r.status || 'NETERR'})`].join('\n'));
      // 末次 attempt 未产生有效首字节（buffer 重试耗尽 / 上游不可达），首字节保持 null。
      finalLastAttemptMs = attMs;
      if (r.status === 0) {
        const errBody = JSON.stringify({ type: 'error', error: { type: 'upstream_unreachable', message: `upstream ${upstreamBase ?? ''} unreachable (${r.networkError})` } });
        res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(errBody) });
        res.end(errBody);
        finalDelivered = { status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(errBody) };
        outcome = 'passed-to-client';
      } else {
        finalDelivered = r;
        outcome = verdict.retryable ? 'failed' : 'pass-through';
        reply(res, r);
      }
      break;
    }
  }

  // ── 写 trace ─────────────────────────────────────────
  const endedAt = nowIso();
  const totalMs = Date.now() - t0;
  concise(`REQ  #${id} delivered to client, total ${totalMs}ms, ${attempt} attempt(s), outcome=${outcome}`);
  traceStore.append({
    id, sourceIp: ip, method: req.method, path: req.url, startedAt, endedAt, totalMs,
    finalStatus: finalDelivered?.status ?? 0, outcome, model: reqModel,
    resolvedModel: resolvedModel ?? '',
    firstChunkAt: finalFirstChunkAt,
    firstChunkMs: finalFirstChunkMs,
    lastAttemptMs: finalLastAttemptMs,
    requestBody: outBody.toString('utf8'),
    responseBody: finalDelivered ? finalDelivered.body.toString('utf8') : '',
    responseHeaders: finalDelivered?.headers ?? {},
    attempts,
    configSnapshot: { maxAttempts, backoffSec, backoffMaxSec, passthrough, retryRules },
  });
}

// ── 启动服务（扩展和 CLI 共用）──────────────────────────────
// 返回 { server, stop, port }；端口占用等 listen 错误时 reject（不 process.exit）
// runningServer 模块级持有，供 /api/kill 关闭监听用
// exitOnKill：子进程模式（isMainModule 入口）传 true，/api/kill 与 /api/port POST
//   触发 process.exit(0) 让宿主 re-spawn；in-proc 测试不传，只 server.close 不退出进程。
let runningServer = null;
let exitOnKill = false;
export async function startServer({ configPath, logsDir, logsConfigPath, exitOnKill: exitOnKillOpt } = {}) {
  exitOnKill = !!exitOnKillOpt;
  configStore.init(configPath);
  if (logsDir) {
    loggerSetLogDir(logsDir);
    traceStore.setLogDir(logsDir);
  }
  // 注入 logs-config.json 路径：若用户配过 logsDir，会覆盖上面的默认 LOG_DIR
  if (logsConfigPath) {
    traceStore.setLogsConfigPath(logsConfigPath);
  }

  const { listenHost, listenPort } = configStore.getListen();
  const server = http.createServer(handleRequest);
  runningServer = server;

  return new Promise((resolve, reject) => {
    server.on('error', reject); // EADDRINUSE 等交给调用方
    server.listen(listenPort, listenHost, () => {
      const allIps = listenHost === '0.0.0.0' || listenHost === '::' ? ['127.0.0.1', ...lanIpv4s()] : [listenHost];
      const urls = allIps.map((ip) => `http://${ip}:${listenPort}`).join('  |  ');
      const env0 = configStore.getEnv();
      const p = configStore.getProxy();
      concise(`proxy listening on ${urls}`);
      concise(`  web UI     : ${allIps.map((ip) => `http://${ip}:${listenPort}/`).join('  |  ')}`);
      concise(`  upstream   : ${env0.upstreamBase} (${env0.upstream?.protocol === 'https:' ? 'https' : 'http'})`);
      concise(`  model      : ${env0.model ?? '(unset)'}`);
      concise(`  token      : ${maskValue(env0.token)}`);
      concise(`  retry      : maxAttempts=${p.maxAttempts} backoffSec=${p.backoffSec} backoffMaxSec=${p.backoffMaxSec} rules=${JSON.stringify(p.retryRules)}`);
      concise(`  mode       : ${p.passthrough ? '透传（不重试，原样转发）' : '拦截重试（流式转发 + 首段 body 判错）'}`);
      concise(`  timeout    : ${env0.upstreamTimeoutMs}ms`);
      concise(`  detail log : ${logsDir ?? '<default>'}  (时间均为中国时间 +08:00)`);
      traceStore.cleanupOld();
      resolve({
        server,
        port: listenPort,
        host: listenHost,
        stop: () => new Promise((r) => {
          server.close(() => {
            if (runningServer === server) runningServer = null;
            r();
          });
        }),
      });
    });
  });
}

// ── CLI 模式：直接 node server.js 时启动 ────────────────────
// env 命名空间统一 CCP_*（扩展子进程用）；旧 CONFIG_PATH 仍认（mock 测试向后兼容）。
// exitOnKill=true：子进程模式下 /api/kill 与 /api/port POST 触发 process.exit(0)，
//   让宿主心跳探测不通后 re-spawn 新进程（而非 server.close 后进程空转成僵尸）。
//   in-proc 调用方（测试 import startServer）不传此选项，kill 只关监听、不退出测试进程。
const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  const cfgPath = process.env.CCP_CONFIG_PATH || process.env.CONFIG_PATH || new URL('./config.json', import.meta.url);
  startServer({
    configPath: typeof cfgPath === 'string' ? cfgPath : fileURLToPath(cfgPath),
    logsDir: process.env.CCP_LOGS_DIR || undefined,
    logsConfigPath: process.env.CCP_LOGS_CONFIG_PATH || undefined,
    exitOnKill: true,
  }).catch((e) => {
    concise(`FATAL: ${e.message}`);
    if (e.code === 'EADDRINUSE') concise(`  port already in use — change proxy.listenPort in config.json`);
    process.exit(1);
  });
}
