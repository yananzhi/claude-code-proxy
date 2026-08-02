// config-store.js — 配置读写 + 热重载 + 持久化
//
// 两类配置都支持热重载：
//   proxy.*（重试参数）  — 纯内存改，下个请求即生效
//   env.*（上游/token/model/超时）— 改了要重新派生 upstream URL/lib，下个请求即生效
// 都写回 config.json 持久化。listenHost/listenPort 改了要重启（监听 socket 不能热换）。
//
// 注意：时间相关参数对外用「秒」，内部转成 ms 存储/使用。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { concise } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  listenHost: '0.0.0.0',
  listenPort: 11434,
  maxAttempts: 5,
  backoffSec: 1, // 秒
  backoffMaxSec: 16, // 秒
  passthrough: false, // 透传模式：true=不重试原样转发，false=拦截重试
  // 可配置重试规则：每条 = { status, code }。
  //   status: HTTP 状态码（100..599）| '*'（任意状态码通配）
  //   code:   body error.code 数字 | 'all'（任意 body code，响应头即决断重试）
  // 命中语义：响应 status 匹配规则 status，且 body code 满足规则 code 要求 → 缓冲重试。
  // 默认等价原写死行为：503+10310（讯飞 system busy）、200+10310（假成功 200+10310）。
  // 用户可自加如 429+11210（讯飞网关 authorization failed）或 503+all（所有 503 都重试）。
  // 其余状态码（408/500/502/504 等）默认不在规则里 → 透传交给 Claude Code 自己处理。
  // 网络错误（status=0：超时、连接断、流中断）仍兜底重试，否则断网/抖动直接崩给用户。
  retryRules: [
    { status: 503, code: 10310 },
    { status: 200, code: 10310 },
  ],
};

let configPath;
let config; // 全量配置对象（含 env + effortLevel + proxy）
let proxy; // proxy 段的运行时副本（热重载改这里）

export function init(configPathArg) {
  configPath = configPathArg;
  config = JSON.parse(readFileSync(configPath, 'utf8'));
  // 兼容旧字段：backoffMs/backoffMaxMs → backoffSec/backoffMaxSec
  const p = { ...(config.proxy ?? {}) };
  if (p.backoffMs !== undefined && p.backoffSec === undefined) p.backoffSec = p.backoffMs / 1000;
  if (p.backoffMaxMs !== undefined && p.backoffMaxSec === undefined) p.backoffMaxSec = p.backoffMaxMs / 1000;
  proxy = { ...DEFAULTS, ...p };
  // 向后兼容：老 config.json 用 retryOnStatus / retryOnBodyErrorCode 两个独立字段，
  // 新模型统一成 retryRules（组合规则）。迁移规则：
  //   retryOnStatus:[503]            → {status:503, code:'all'}（任意 body code 都重试）
  //   retryOnBodyErrorCode:[10310]   → {status:'*', code:10310}（任意状态码 + 该 code）
  // 判定看原始 p 是否有 retryRules：有则尊重（可能用户显式写了 []）；无且无旧字段则用默认。
  if (!Object.prototype.hasOwnProperty.call(p, 'retryRules')) {
    const migrated = [];
    const oldStatuses = Array.isArray(p.retryOnStatus) ? p.retryOnStatus : [];
    const oldBodyCodes = Array.isArray(p.retryOnBodyErrorCode) ? p.retryOnBodyErrorCode : [];
    for (const s of oldStatuses) {
      const n = Number(s);
      if (Number.isFinite(n)) migrated.push({ status: n, code: 'all' });
    }
    for (const c of oldBodyCodes) {
      const n = Number(c);
      if (Number.isFinite(n)) migrated.push({ status: '*', code: n });
    }
    // 有旧字段就迁移（哪怕迁移后为空，也尊重"用户清空了"）；无任何旧字段才用默认
    proxy.retryRules = (oldStatuses.length || oldBodyCodes.length) ? migrated : [...DEFAULTS.retryRules];
  } else if (!Array.isArray(proxy.retryRules)) {
    // 用户显式写了 retryRules 但不是数组（脏数据）→ 兜底默认
    proxy.retryRules = [...DEFAULTS.retryRules];
  }
  // model aliasing：兜底老配置无 modelAliases / nextAliasId
  // 注意 typeof [] === 'object'，须用 Array.isArray 排除数组（防手动编辑成数组被当字典）
  if (!config.modelAliases || typeof config.modelAliases !== 'object' || Array.isArray(config.modelAliases)) config.modelAliases = {};
  // 兜底：非数字 / NaN/Infinity / 小数 → 0。小数编号会产出 ccp-sonnet-1.5 之类非法别名，
  // 且空表时校正（maxN=0 > 小数? false）救不了 0~1 之间的小数，故须 Number.isInteger 拦截。
  if (typeof config.nextAliasId !== 'number' || !Number.isFinite(config.nextAliasId) || !Number.isInteger(config.nextAliasId)) config.nextAliasId = 0;
  // 启动校正：扫已存别名 key 的 max 编号，若 > nextAliasId 抬到 max+1
  // （防旧数据/手动编辑/代理重启后重号）。严格大于：空表 maxN=0 时若 nextAliasId=0 不抬。
  // 语义：nextAliasId = 已发出的最大编号；nextAliasId() 返回 ++n（下一个新编号）。
  let maxN = 0;
  for (const alias of Object.keys(config.modelAliases)) {
    const m = /-(\d+)$/.exec(alias);  // ccp-sonnet-N 形式
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  if (maxN > config.nextAliasId) config.nextAliasId = maxN;
  return { config, proxy };
}

// ── env 派生（每次请求读，支持热重载）────────────────────────
export function getEnv() {
  const env = config.env ?? {};
  const base = env.ANTHROPIC_BASE_URL;
  let upstream = null;
  if (base) {
    try { upstream = new URL(base); } catch {}
  }
  return {
    upstreamBase: base,
    upstream,
    token: env.ANTHROPIC_AUTH_TOKEN,
    model: env.ANTHROPIC_MODEL,
    smallFastModel: env.ANTHROPIC_SMALL_FAST_MODEL,
    // 超时：env.API_TIMEOUT_MS 是毫秒；前端用秒展示/编辑，内部仍按 ms 用
    upstreamTimeoutMs: Number(env.API_TIMEOUT_MS) || 600000,
  };
}

// ── 运行时重试参数（每次请求读这个）──────────────────────────
export function getProxy() {
  return { ...proxy };
}

// effortLevel：强制改写 output_config.effort 的目标值（每次请求读，支持热重载）。
// 合法取值：low | medium | high | xhigh | max（max 是 Opus 专属档）；空串 '' = 不改写原样透传。
// 字段缺失（undefined，老配置文件）回退 'max'，保持旧行为；显式空串 = 用户选了"不改写"。
export function getEffortLevel() {
  return config.effortLevel === undefined ? 'max' : config.effortLevel;
}

// 热重载：更新 effortLevel。level ∈ {'', 'low', 'medium', 'high', 'xhigh', 'max'}。
// '' / null = 不改写。非法值抛错。写回 config.effortLevel + persist（下个请求即生效）。
export function updateEffort(level) {
  const ALLOWED = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
  const v = level === null || level === undefined ? '' : String(level);
  if (!ALLOWED.includes(v)) throw new Error(`effortLevel 必须是 ${ALLOWED.join('/')} 之一`);
  config.effortLevel = v;
  persist();
  return getEffortLevel();
}

// ── model aliasing：别名 → 真实模型映射表（热重载）────────────
// config.modelAliases: { "ccp-sonnet-1": "claude-sonnet-5", ... }
// config.nextAliasId: 全局递增编号计数器（持久化，跨重启不重号）
// 启动校正见 init。照 updateEffort 模式：校验 → 改内存 → persist。
export function getModelAliases() {
  return { ...(config.modelAliases ?? {}) };
}

export function updateModelAlias(alias, model) {
  if (typeof alias !== 'string' || !alias.trim()) throw new Error('alias 不能为空');
  if (typeof model !== 'string' || !model.trim()) throw new Error('model 不能为空');
  config.modelAliases = { ...(config.modelAliases ?? {}), [alias]: model };
  persist();
  return { alias, model };
}

export function removeModelAlias(alias) {
  if (typeof alias !== 'string' || !alias.trim()) throw new Error('alias 不能为空');
  const next = { ...(config.modelAliases ?? {}) };
  delete next[alias];
  config.modelAliases = next;
  persist();
  return { alias, removed: true };
}

// nextAliasId：全局递增编号，持久化（防重启重号）。
export function nextAliasId() {
  const n = config.nextAliasId ?? 0;
  config.nextAliasId = n + 1;
  persist();
  return n + 1;
}

// rewriteModel：把请求体里的 model 字段（别名）替换为映射表里的真实模型名。
// 照 server.js rewriteEffort 模式：parse → 命中则替换 → 重新序列化；任何异常原样返回 body。
// 不受 isMessagesMain 守卫（区别于 rewriteEffort）——所有带 model 字段的 JSON 请求都替换
// （含 /v1/messages/count_tokens 子路径）。
// 别名可能带 [1m] 后缀（如 ccp-sonnet-1[1m]）：先剥离 [1m] 再查表，命中替换 base（不带后缀，
// beta header 由 CLI 已带）；不命中原样透传。
export function rewriteModel(body, reqId, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (!ct.includes('json')) return { body, rewritten: false, resolvedModel: undefined };
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { body, rewritten: false, resolvedModel: undefined };
  }
  if (!parsed || typeof parsed !== 'object') return { body, rewritten: false, resolvedModel: undefined };
  const rawModel = parsed.model;
  if (typeof rawModel !== 'string' || !rawModel) return { body, rewritten: false, resolvedModel: rawModel ?? undefined };
  // 剥离 [1m] 后查表（CLI 唯一识别的长度标记是 [1m]，见设计文档 §6.9.1；
  // [2m] 等不被 CLI 识别、是模型名字面量，代理也不剥，保持与 CLI 一致）
  const base = rawModel.replace(/\[1m\]/gi, '');
  const aliases = config.modelAliases ?? {};
  if (!(base in aliases)) {
    // 不命中：原样透传（保留原始 rawModel，含 [1m]）
    return { body, rewritten: false, resolvedModel: rawModel };
  }
  const realModel = aliases[base];
  // 类型守卫：映射值若被手动编辑成非字符串/空串（数字/null/布尔/对象），视为未命中原样透传，
  // 避免把数字/null/对象赋给 parsed.model 发往上游（上游必 400 或行为未定义）。
  if (typeof realModel !== 'string' || !realModel) {
    return { body, rewritten: false, resolvedModel: rawModel };
  }
  if (rawModel === realModel) {
    return { body, rewritten: false, resolvedModel: realModel };
  }
  parsed.model = realModel;
  let rewritten;
  try {
    rewritten = Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return { body, rewritten: false, resolvedModel: rawModel };
  }
  if (reqId) {
    concise(`MODEL REWRITE #${reqId}: ${rawModel} → ${realModel} (${body.length} → ${rewritten.length} bytes)`);
  }
  return { body: rewritten, rewritten: true, resolvedModel: realModel };
}

// 监听配置（启动时用，之后不改）
export function getListen() {
  return { listenHost: proxy.listenHost, listenPort: proxy.listenPort };
}

// 改监听端口：写回 config.json + 改运行时 proxy.listenPort。
// 注意：运行中已 listen 的 socket 不能热换，扩展侧改完要 /api/kill 让心跳重启才生效。
// 这里只负责持久化 + 内存更新，不重启 server。
export function updateListenPort(port) {
  const n = Number(port);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error('端口必须是 1024..65535 的整数');
  }
  proxy.listenPort = n;
  // persist() 会把 proxy.listenPort 写进 config.json
  persist();
  return getListen();
}

// ── 给前端的配置视图 ───────────────────────────────────────
// 时间用秒展示；token 掩码（但返回 tokenPlain 供前端编辑框，前端不公开展示）
export function getView() {
  const env = getEnv();
  return {
    effortLevel: config.effortLevel === undefined ? 'max' : config.effortLevel,
    proxy: {
      maxAttempts: proxy.maxAttempts,
      backoffSec: proxy.backoffSec,
      backoffMaxSec: proxy.backoffMaxSec,
      passthrough: proxy.passthrough,
      retryRules: proxy.retryRules,
    },
    upstream: {
      baseUrl: env.upstreamBase ?? '',
      model: env.model ?? '',
      smallFastModel: env.smallFastModel ?? '',
      timeoutSec: Math.round(env.upstreamTimeoutMs / 1000),
      tokenMasked: mask(env.token),
      // 不返回明文 token；前端 token 输入框留空表示不修改
    },
    // 监听信息只读展示（改了要重启）
    listen: { host: proxy.listenHost, port: proxy.listenPort },
    // model alias 映射表 + 编号计数器（供前端展示/编辑）
    modelAliases: { ...(config.modelAliases ?? {}) },
    nextAliasId: config.nextAliasId ?? 0,
  };
}

// ── 热重载：更新重试参数 ────────────────────────────────────
const PROXY_UPDATABLE = [
  'maxAttempts',
  'backoffSec',
  'backoffMaxSec',
  'passthrough',
  'retryRules',
];

// 校验单条 retryRule：{ status: number(100..599) | '*', code: number | 'all' }。
// 抛错带字段名，供前端定位。status='*' 通配任意状态码；code='all' 通配任意 body code。
function validateRetryRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error('retryRules 每条必须是对象 {status, code}');
  }
  const { status, code } = rule;
  if (status === '*') {
    // 任意状态码通配，合法
  } else {
    const sn = Number(status);
    if (!Number.isFinite(sn) || !Number.isInteger(sn) || sn < 100 || sn > 599) {
      throw new Error('retryRules.status 必须是 100..599 的整数或 "*"');
    }
  }
  if (code === 'all') {
    // 任意 body code 通配，合法
  } else {
    const cn = Number(code);
    if (!Number.isFinite(cn) || !Number.isInteger(cn)) {
      throw new Error('retryRules.code 必须是整数或 "all"');
    }
  }
}

export function updateProxy(partial) {
  const next = { ...proxy };
  for (const k of PROXY_UPDATABLE) {
    if (partial[k] === undefined) continue;
    const v = partial[k];
    if (k === 'passthrough') {
      next[k] = !!v; // 强制布尔
    } else if (k === 'retryRules') {
      if (!Array.isArray(v)) throw new Error('retryRules 必须是数组');
      // 逐条校验 + 规范化（status 数字化、code 数字化或保留 'all'/'*'）
      next[k] = v.map((rule) => {
        validateRetryRule(rule);
        const { status, code } = rule;
        return {
          status: status === '*' ? '*' : Number(status),
          code: code === 'all' ? 'all' : Number(code),
        };
      });
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${k} 必须是数字`);
      if (n < 0) throw new Error(`${k} 必须 >= 0`);
      next[k] = k === 'maxAttempts' ? Math.floor(n) : n;
    }
  }
  if (next.maxAttempts < 1 || next.maxAttempts > 1000) throw new Error('最大重试次数必须在 1..1000');
  if (next.backoffSec < 0) throw new Error('退避起始值必须 >= 0');
  if (next.backoffMaxSec < next.backoffSec) throw new Error('最终退避上限必须 >= 退避起始值');

  const prevPassthrough = proxy.passthrough;
  proxy = next;
  persist();
  // 透传模式切换要专门记日志（诊断关键事件）
  if (next.passthrough !== prevPassthrough) {
    concise(`MODE changed → passthrough=${next.passthrough ? 'ON (透传：不重试，原样转发)' : 'OFF (拦截重试)'}`);
  }
  return getProxy();
}

// ── 热重载：更新上游配置 ────────────────────────────────────
export function updateUpstream(partial) {
  const env = { ...(config.env ?? {}) };
  if (partial.baseUrl !== undefined) {
    if (!partial.baseUrl) throw new Error('Base URL 不能为空');
    try { new URL(partial.baseUrl); } catch { throw new Error('Base URL 格式错误'); }
    env.ANTHROPIC_BASE_URL = partial.baseUrl;
  }
  if (partial.token !== undefined && partial.token !== '') {
    // 空字符串视为"不改"（前端没改 token 时传空或掩码值）
    env.ANTHROPIC_AUTH_TOKEN = partial.token;
  }
  if (partial.model !== undefined) env.ANTHROPIC_MODEL = partial.model || undefined;
  if (partial.smallFastModel !== undefined) env.ANTHROPIC_SMALL_FAST_MODEL = partial.smallFastModel || undefined;
  if (partial.timeoutSec !== undefined) {
    const n = Number(partial.timeoutSec);
    if (!Number.isFinite(n) || n <= 0) throw new Error('上游超时必须 > 0 秒');
    env.API_TIMEOUT_MS = String(Math.round(n * 1000));
  }
  config.env = env;
  persist();
  return getView().upstream;
}

// ── 持久化写回 config.json ──────────────────────────────────
// proxy 段用秒字段存（不再写 backoffMs）；env 段原样写
function persist() {
  config.proxy = {
    listenHost: proxy.listenHost,
    listenPort: proxy.listenPort,
    maxAttempts: proxy.maxAttempts,
    backoffSec: proxy.backoffSec,
    backoffMaxSec: proxy.backoffMaxSec,
    passthrough: proxy.passthrough,
    retryRules: proxy.retryRules,
  };
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error(`[config-store] persist failed (runtime still updated): ${e.message}`);
  }
}

function mask(v) {
  const s = String(v ?? '');
  if (s.length <= 12) return '***';
  return s.slice(0, 6) + `…(${s.length} chars)…` + s.slice(-4);
}
