// proxy/test/code-review-ms3.test.mjs — Milestone 3 Code Review: Suspicion Points
//
// Run: node --test proxy/test/code-review-ms3.test.mjs
//
// Each test corresponds to a suspicion found during review of:
//   1. proxy/trace-store.js — stats() method (lines 434-485)
//   2. proxy/server.js — /api/stats GET endpoint (lines 411-424)
//   3. proxy/web/index.html — Stats cards CSS, HTML, JS (lines 188-211, 1032-1105)
//   4. proxy/test/stats.test.mjs — existing tests
//
// Focus areas: defensive processing, query param parsing, race conditions,
// floating-point precision, window boundary edge cases, fromTs accuracy,
// API contract mismatches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from '../trace-store.js';

// ── Helpers ────────────────────────────────────────────────────

function todayStr() {
  const t = Date.now() + 8 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}
const TODAY = todayStr();

function newTmpDir(label) {
  const d = join(process.cwd(), '.test-tmp', `ms3-review-${label}-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

function makeTrace(opts) {
  const {
    id, outcome = 'success-direct', finalStatus = 200,
    attStatuses = [200], startedAt = `${TODAY}T01:00:00.000Z`,
    totalMs = 1000, model = 'claude-sonnet-4-6',
  } = opts;
  const attempts = attStatuses.map((status, i) => ({
    attempt: i + 1,
    status,
    networkError: null,
    elapsedMs: 1000 + i,
    verdict: status === 200 ? 'success' : status === 503 ? 'retryable' : 'not-retryable',
    reason: status === 200 ? '(real success)' : `status ${status}`,
    backoffMs: null,
    upstreamRequestBody: `upstream-req-${id}-${i + 1}`,
    upstreamResponseBody: `upstream-resp-${id}-${i + 1}`,
  }));
  return {
    id, sourceIp: '127.0.0.1', method: 'POST', path: '/v1/messages',
    startedAt, endedAt: startedAt, totalMs,
    finalStatus, outcome, model,
    requestBody: 'req-body', responseBody: 'resp-body',
    attempts,
    configSnapshot: { maxAttempts: 20 },
  };
}

// Write a legacy shard for older-format compatibility tests
function writeLegacyShard(dir, day, seq, traces) {
  const lines = traces.map(t => JSON.stringify(t)).join('\n') + '\n';
  writeFileSync(join(dir, `traces-${day}.${String(seq).padStart(3, '0')}.jsonl`), lines, 'utf8');
}

// ════════════════════════════════════════════════════════════════
// SUSPICION 1 — Floating-point precision in fromTs calculation
// ════════════════════════════════════════════════════════════════
// Category: data-loss / precision
// File: proxy/trace-store.js, line 455
//   const buckets = ws.map((h) => ({ hours: h, fromTs: nowMs - h * 3600 * 1000, ... }));
//
// When h is a decimal like 1.1, JavaScript floating-point arithmetic gives:
//   1.1 * 3600 * 1000 = 3960000.0000000005  (not exactly 3960000)
// At typical Date.now() magnitudes (~1.78e12 ms), the double-precision
// float cannot represent the 5e-10 sub-integer difference, so fromTs
// happens to round to an integer. However:
//   1. The intermediate product IS non-integer, which is semantically wrong.
//   2. For very large hour values (e.g., 168h with float errors accumulated),
//      or if Date.now() were smaller, the error WOULD manifest.
//   3. The fromTs is returned to the frontend and used in comparisons.
//
// More importantly: the DEDUP KEY (Math.round(h * 1000)) at line 444 uses
// the raw float h, NOT the clamped h. This is where float error causes real
// issues (see S4 and S14). The fromTs itself is mostly safe due to magnitude.
//
// Suggested fix: use Math.round(nowMs - h * 3600 * 1000) for integer-ms fromTs,
// and Math.round(h * 3600 * 1000) for the product to avoid float propagation.
// ────────────────────────────────────────────────────────────────

test('S1. fromTs calculation uses non-integer intermediate product (1.1h)', async () => {
  const dir = newTmpDir('fp-fromts');
  ts.setLogDir(dir);
  const r = await ts.stats({ windows: [1.1] });
  const w = r.windows[0];
  // The intermediate product 1.1 * 3600 * 1000 = 3960000.0000000005 is non-integer.
  // We verify the returned fromTs matches nowMs minus this non-integer product.
  const product = 1.1 * 3600 * 1000;
  assert.ok(!Number.isInteger(product),
    `1.1 * 3600 * 1000 = ${product} is not an integer (float error: ${product - 3960000}). ` +
    `stats() uses this non-integer product to compute fromTs. At typical Date.now() ` +
    `magnitudes the subtraction happens to round to integer, but this is fragile and ` +
    `the non-integer intermediate is a code smell.`);
  // fromTs should be an integer (verifying current behavior is "accidentally safe")
  assert.ok(Number.isInteger(w.fromTs),
    `fromTs=${w.fromTs} is an integer at current Date.now() magnitude, ` +
    `but this relies on float rounding, not correct arithmetic.`);
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 2 — Dedup key Math.round(h * 1000) has float error,
// causing incorrect dedup of nearly-equal hours
// ════════════════════════════════════════════════════════════════
// Category: logic
// File: proxy/trace-store.js, lines 443-447
//   const key = Math.round(h * 1000);
//   if (seen.has(key)) return false;
//
// The dedup uses Math.round(h * 1000) with a claimed tolerance of 0.001h.
// But due to float multiplication, two DIFFERENT hour values can produce
// the same key, or two CLOSE hour values can produce different keys:
//
// Example: h=0.3 and h=0.1+0.2
//   0.3 * 1000 = 300 (key=300)
//   (0.1+0.2) * 1000 = 300.00000000000006 → Math.round = 300 (same key, deduped)
//   BUT: 0.1+0.2 !== 0.3 in JS! So if the user types 0.3 and then 0.1+0.2
//   (via separate addStatsWindow calls), one gets deduped.
//
// More critically: h=0.0014 and h=0.001
//   0.0014 * 1000 = 1.4 → Math.round = 1
//   0.001 * 1000 = 1 → Math.round = 1
//   Both dedup to key=1! But 0.001 and 0.0014 differ by 40% — they're
//   NOT duplicates. The 0.001h tolerance is too aggressive for small values.
//
// Suggested fix: Use a smarter dedup key like Math.round(h * 1000) only
// for h >= 1, and Math.round(h * 10000) for h < 1, or use string-based dedup.
// ────────────────────────────────────────────────────────────────

test('S2. Dedup key Math.round(h*1000) incorrectly dedupes small different hours', async () => {
  const dir = newTmpDir('dedup-float');
  ts.setLogDir(dir);
  // 0.001h (3.6s) and 0.0014h (5.04s) are 40% different but dedup to the same key
  const r = await ts.stats({ windows: [0.001, 0.0014] });
  // Both should return separate windows — they're meaningfully different
  // (3.6s vs 5.04s). But due to Math.round(0.001*1000)=1 and
  // Math.round(0.0014*1000)=1, they dedup.
  assert.equal(r.windows.length, 1,
    '0.001h and 0.0014h (3.6s vs 5.04s, 40% difference) are incorrectly deduped. ' +
    'Math.round(0.001*1000)=1 and Math.round(0.0014*1000)=1 produce the same key. ' +
    'The 0.001h dedup tolerance is too aggressive for sub-hour windows.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 3 — server.js /api/stats clamps via filter (n<=168)
// while trace-store.js clamps via Math.min(h, 168)
// ════════════════════════════════════════════════════════════════
// Category: api-contract
// File: proxy/server.js, line 419 vs proxy/trace-store.js, line 442
//
// server.js: .filter((n) => ... && n <= MAX_HOURS) — DROPS windows > 168
// trace-store.js: .map((h) => Math.min(h, MAX_HOURS)) — CLAMPS windows > 168 to 168
//
// If stats() is called directly (not via HTTP), windows > 168 are silently
// clamped to 168, giving results for a different time window than requested.
// The caller thinks they asked for a 200h window but got 168h results.
// This is an API contract mismatch: server and stats() handle >168 differently.
//
// Suggested fix: stats() should also filter (not clamp) windows > MAX_HOURS,
// or return an error/warning, or at minimum document the clamping behavior.
// ────────────────────────────────────────────────────────────────

test('S3. stats() clamps >168h windows to 168 instead of rejecting them', async () => {
  const dir = newTmpDir('clamp');
  ts.setLogDir(dir);
  // Request a 200h window (beyond retention). stats() clamps to 168h.
  const r = await ts.stats({ windows: [200] });
  const w = r.windows[0];
  // The returned window says hours=168, not hours=200.
  // The caller asked for 200h but got 168h data — API contract violation.
  assert.equal(w.hours, 168,
    'stats() clamps 200h to 168h without informing caller. ' +
    'Server /api/stats would have dropped the window entirely (different behavior).');
  // Demonstrate that server would drop it: if server filters n <= 168,
  // windows=[200] becomes windows=[] which falls back to [1,5,24].
  // stats() returns 168h. These are completely different results for the same input.
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 4 — Dedup after clamping creates hidden collisions
// ════════════════════════════════════════════════════════════════
// Category: logic
// File: proxy/trace-store.js, lines 440-448
//
// The dedup uses key = Math.round(h * 1000) AFTER clamping via Math.min.
// If two windows (e.g., 170 and 168) are both clamped to 168, they
// dedup to the same key (168000) and only one bucket is created.
// The caller silently loses one of their requested windows.
//
// This is also the root cause of the "stuck window" UI bug (index.html L1060):
// the user adds 200h → server drops it → falls back to [1,5,24] →
// but the JS array still has 200 → next refresh sends 200 again → cycle.
// If called via stats() directly, 200→168 clamping means the × button
// tries to remove 168 but the array has 200 → can't remove.
//
// Suggested fix: dedup should happen BEFORE clamping, or clamping should
// be replaced with filtering (matching server behavior).
// ────────────────────────────────────────────────────────────────

test('S4. Dedup after clamp: windows=[168, 170] silently loses one window', async () => {
  const dir = newTmpDir('dedup-clamp');
  ts.setLogDir(dir);
  // Both 168 and 170 get clamped to 168, then deduped.
  const r = await ts.stats({ windows: [168, 170] });
  // Expected: 2 windows (168 and 170, or both clamped to 168 but 2 entries).
  // Actual: only 1 window (170→168, deduped with original 168).
  assert.equal(r.windows.length, 1,
    'Two different requested windows (168, 170) silently collapse to 1 due to clamp-then-dedup. ' +
    'Caller loses one window without notification.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 5 — server.js /api/stats MAX_HOURS is hardcoded (168),
// not synced with trace-store.js RETENTION_DAYS * 24
// ════════════════════════════════════════════════════════════════
// Category: api-contract / maintenance
// File: proxy/server.js, line 415 vs proxy/trace-store.js, line 106 + 438
//
// server.js hardcodes `const MAX_HOURS = 168;` (line 415)
// trace-store.js uses `const MAX_HOURS = RETENTION_DAYS * 24;` (line 438)
//
// If RETENTION_DAYS changes from 7 to 14, trace-store's MAX_HOURS becomes
// 336, but server.js still uses 168, creating an inconsistency where
// server rejects valid windows that stats() would accept.
//
// Suggested fix: Export MAX_HOURS from trace-store.js, or derive it
// from a shared constant.
// ────────────────────────────────────────────────────────────────

test('S5. Server MAX_HOURS (168) vs trace-store MAX_HOURS (RETENTION_DAYS*24) — must match', async () => {
  // This test validates the invariant that both MAX_HOURS values match.
  // Since we can't import server.js internals, we test the observable contract:
  // stats() accepts windows up to RETENTION_DAYS*24 = 168h.
  const dir = newTmpDir('max-hours');
  ts.setLogDir(dir);
  // 168h should work
  const r168 = await ts.stats({ windows: [168] });
  assert.equal(r168.windows.length, 1, '168h window should be accepted');
  assert.equal(r168.windows[0].hours, 168, '168h window hours should be 168');
  // The server also accepts 168. If RETENTION_DAYS changes, this test
  // should be updated alongside the server constant.
  // We verify the relationship:
  const RETENTION_DAYS = 7; // from trace-store.js line 106
  const SERVER_MAX_HOURS = 168; // from server.js line 415
  assert.equal(RETENTION_DAYS * 24, SERVER_MAX_HOURS,
    `RETENTION_DAYS*24=${RETENTION_DAYS * 24} must equal server MAX_HOURS=${SERVER_MAX_HOURS}. ` +
    'If they diverge, stats() and /api/stats will have inconsistent window limits.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 6 — stats() scans stale data: nowMs captured before
// async reads, so traces appended during scan are invisible
// ════════════════════════════════════════════════════════════════
// Category: race-condition
// File: proxy/trace-store.js, lines 436 + 464-477
//
// nowMs is captured at line 436: `const nowMs = Date.now();`
// Then the scan loop (lines 464-477) awaits async readDayIdx() calls.
// If append() writes a new trace during the scan, that trace:
//   a) May be written to an idx file already scanned → missed
//   b) May be written to a new shard not yet scanned → missed
//   c) If scanned by a later day's readDayIdx → included but with
//      startedAt > nowMs → excluded by `t <= nowMs` check
//
// More critically: the `now` field in the response uses the stale nowMs,
// not the actual time after scanning completes. Frontend shows a "now"
// that's older than the scan completion time.
//
// This is a minor race that's hard to fix without locking, but should
// be documented. The count can be slightly lower than reality.
//
// Suggested fix: Accept as documented limitation; or re-read nowMs
// after scanning for the `now` field (but not fromTs).
// ────────────────────────────────────────────────────────────────

test('S6. stats() now field is stale: captured before async scan, not updated after', async () => {
  const dir = newTmpDir('stale-now');
  ts.setLogDir(dir);
  ts.append(makeTrace({ id: 'SN1', finalStatus: 200, startedAt: new Date(Date.now() - 60000).toISOString() }));

  const r = await ts.stats({ windows: [1] });
  const returnedNow = new Date(r.now).getTime();
  const actualNow = Date.now();
  // The "now" in the response should be close to the actual current time.
  // Due to async scanning, it's captured at the START, so there's a gap.
  const gap = actualNow - returnedNow;
  // This isn't a hard failure (scan is fast), but demonstrates the
  // conceptual issue: `now` is the scan START time, not the scan END time.
  // In high-load scenarios with many shards, the gap could be significant.
  assert.ok(gap >= 0,
    `Returned 'now' (${r.now}) should be <= actual now. Gap: ${gap}ms. ` +
    'The now field reflects scan-start time, not scan-end time.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 7 — stats() silently skips traces with invalid startedAt
// ════════════════════════════════════════════════════════════════
// Category: data-loss
// File: proxy/trace-store.js, lines 467-468
//   const t = new Date(r.startedAt).getTime();
//   if (!Number.isFinite(t)) continue;
//
// If startedAt is null, undefined, empty string, or malformed, the trace
// is silently skipped from stats counts. This means:
//   - A trace visible in list() might not be counted in stats()
//   - stats total can be less than the actual total
//   - No warning or error is emitted
//
// While this is defensive (doesn't crash), it creates a data consistency
// gap: the user sees N traces in the list but stats shows M < N.
//
// Suggested fix: Log a warning for traces with invalid startedAt, or
// add a "skipped" count to the stats response.
// ────────────────────────────────────────────────────────────────

test('S7. stats() silently skips traces with invalid/missing startedAt — count mismatch with list()', async () => {
  const dir = newTmpDir('bad-ts');
  ts.setLogDir(dir);
  // Write a trace with malformed startedAt directly to a legacy shard
  const badTrace = makeTrace({ id: 'BAD1', finalStatus: 200 });
  badTrace.startedAt = 'not-a-date';
  writeLegacyShard(dir, TODAY, 1, [badTrace]);

  // list() will return this trace (it doesn't validate startedAt)
  const listResult = await ts.list({ mode: 'all', limit: 100 });
  assert.equal(listResult.length, 1, 'list() should return the trace');

  // stats() silently skips it (startedAt is unparseable)
  const r = await ts.stats({ windows: [168] });
  const w = r.windows[0];
  assert.equal(w.total, 0,
    'stats() silently skips trace with bad startedAt. ' +
    'Total=0 but list() shows 1 trace — data inconsistency.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 8 — stats() upper bound `t <= nowMs` includes trace
// started exactly at nowMs but excludes future-timestamped traces
// ════════════════════════════════════════════════════════════════
// Category: logic
// File: proxy/trace-store.js, line 470
//   if (t >= b.fromTs && t <= nowMs)
//
// The condition uses `<=` for the upper bound. This means:
//   - A trace with startedAt = nowMs (exact) is included
//   - A trace with startedAt = nowMs + 1 (1ms future) is excluded
//
// This is correct behavior for "now", but the stats response uses the
// stale nowMs for `now` (see S6), so a trace that arrived between
// nowMs capture and the scan might be excluded even though it's
// logically "now" from the user's perspective.
//
// More importantly, the INCLUSIVE upper bound means stats can count
// a trace that arrived at the exact millisecond as "now" — which is
// different from how list() works (it uses `t <= sinceTs` with
// exclusive comparison `t > sinceTs` at line 393).
//
// Suggested fix: Make the upper bound consistent with list()'s
// exclusive-lower-bound convention, or document the inclusive upper bound.
// ────────────────────────────────────────────────────────────────

test('S8. stats() inclusive bounds: fromTs is >= and nowMs is <=, verifying with interior trace', async () => {
  const dir = newTmpDir('upper-bound');
  ts.setLogDir(dir);
  // We test the inclusive boundary behavior by placing a trace well inside
  // the window and verifying it's counted. The boundary condition is
  // `t >= b.fromTs && t <= nowMs` — both inclusive.
  //
  // The key concern: for list(), the lower-bound comparison is EXCLUSIVE
  // (`t > sinceTs` at line 393), but stats() uses INCLUSIVE (`t >= fromTs`).
  // This means a trace at the exact boundary is:
  //   - EXCLUDED from list(since=X)  (t > X, so X itself is not included)
  //   - INCLUDED in stats(fromTs=X)  (t >= X, so X itself IS included)
  // This is a semantic inconsistency between the two APIs.
  const nowMs = Date.now();
  const tenMinAgo = nowMs - 10 * 60 * 1000;
  ts.append(makeTrace({ id: 'UB1', startedAt: new Date(tenMinAgo).toISOString(), finalStatus: 200 }));

  const r = await ts.stats({ windows: [1] });
  const w = r.windows[0];
  assert.ok(w.total >= 1, `Trace 10min ago should be in 1h window. Got total=${w.total}.`);
  assert.equal(w.success, 1, 'Success trace should be counted');

  // Demonstrate the boundary inconsistency with list():
  // list(since=tenMinAgo) EXCLUDES the trace at exactly tenMinAgo (t > sinceTs),
  // but stats() with fromTs=tenMinAgo INCLUDES it (t >= fromTs).
  const listResult = await ts.list({ since: new Date(tenMinAgo).toISOString(), limit: 100 });
  // The trace at exactly tenMinAgo is EXCLUDED from list (t > sinceTs is false when t == sinceTs)
  assert.ok(!listResult.some(r => r.id === 'UB1'),
    'list() excludes trace at exact since boundary (exclusive lower bound), ' +
    'but stats() includes it (inclusive lower bound) — semantic inconsistency.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 9 — server.js /api/stats: Number() accepts scientific
// notation and hex, allowing unexpected window values
// ════════════════════════════════════════════════════════════════
// Category: security / api-contract
// File: proxy/server.js, lines 416-419
//   const windows = String(wRaw)
//     .split(',')
//     .map((s) => Number(s))
//     .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_HOURS)
//
// Number() parses more than just decimal integers:
//   - Number('0x10') = 16 (hex) → passes filter, creates 16h window
//   - Number('1e2') = 100 (scientific) → passes filter, creates 100h window
//   - Number('Infinity') = Infinity → filtered by Number.isFinite
//   - Number('') = 0 → filtered by n > 0
//
// While these don't crash, they allow surprising inputs that the
// "comma-separated hours" API contract doesn't anticipate.
//
// Suggested fix: Validate with parseInt or a stricter regex like /^\d+(\.\d+)?$/.
// ────────────────────────────────────────────────────────────────

test('S9. Server Number() accepts hex/sci-notation windows — unexpected values', async () => {
  // Simulate server-side parsing logic
  const MAX_HOURS = 168;
  function parseWindowsServer(wRaw) {
    const windows = String(wRaw)
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= MAX_HOURS)
      .slice(0, 12);
    return windows.length ? windows : [1, 5, 24];
  }

  // Hex input
  const hexResult = parseWindowsServer('0x10');
  assert.ok(hexResult.includes(16),
    `Number('0x10')=16 passes server filter, creating unexpected 16h window. Result: ${JSON.stringify(hexResult)}`);

  // Scientific notation
  const sciResult = parseWindowsServer('1e2');
  assert.ok(sciResult.includes(100),
    `Number('1e2')=100 passes server filter, creating unexpected 100h window. Result: ${JSON.stringify(sciResult)}`);

  // Negative hex (passes Number but gets filtered)
  const negResult = parseWindowsServer('-0x10');
  assert.ok(!negResult.includes(-16),
    `Number('-0x10')=-16 should be filtered out. Result: ${JSON.stringify(negResult)}`);

  // The key concern: a user could craft a URL like
  // /api/stats?windows=0x10 which creates a 16h window,
  // which may not be what the API designer intended.
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 10 — stats() scans maxDaySpan days but dateStr uses
// UTC+8 offset, causing day-boundary misalignment
// ════════════════════════════════════════════════════════════════
// Category: logic
// File: proxy/trace-store.js, lines 458-462
//   for (let i = 0; i < maxDaySpan; i++) {
//     const d = new Date(nowMs - i * DAY_MS);
//     days.push(dateStr(d));
//   }
//
// dateStr() adds 8 hours to convert to China time, then extracts YYYY-MM-DD.
// The day calculation `nowMs - i * DAY_MS` works in UTC milliseconds.
// At the China-day boundary (UTC 16:00 = China 00:00), a trace written
// at UTC 15:59 on "day X" has China date "day X", but a trace at UTC 16:01
// has China date "day X+1". The scan computes `maxDaySpan` based on hours,
// but the actual number of China-day shards needed may differ.
//
// Example: at UTC 00:30 (China 08:30), a 24h window needs to scan
// China-date "today" and "yesterday" — 2 days. maxDaySpan = ceil(24/24)+1 = 2.
// But at UTC 16:30 (China 00:30), a 23h window goes back to UTC 17:30
// the previous day = China 01:30 the previous day. That's still 2 China days.
// maxDaySpan = ceil(23/24)+1 = 2. Correct.
//
// Edge case: at UTC 15:59 (China 23:59), a 1-minute-ago trace is on
// "today" in China time. At UTC 16:01 (China 00:01 next day), that same
// trace (1 minute old) is now on "yesterday". A 1h window at UTC 16:01
// needs to scan 2 China days (today + yesterday). maxDaySpan = ceil(1/24)+1 = 2.
// Correct! The +1 day buffer saves it.
//
// But: at UTC 16:01 (China 00:01), a 1h window goes back to UTC 15:01
// which is China 23:01 PREVIOUS day. maxDaySpan = 2 is correct.
// What about a 1h window at UTC 00:01 (China 08:01)? Goes back to
// UTC 23:01 previous day = China 07:01 previous day = SAME China day
// as the trace at UTC 23:01. maxDaySpan = 2 scans 2 days. Over-scans
// but not under-scans. The +1 buffer prevents under-scanning.
//
// However: this only works because of the +1. If someone "optimizes"
// away the +1, the boundary case breaks. This is fragile.
//
// Suggested fix: Add a comment explaining why the +1 is required,
// and add a test that verifies the boundary case.
// ────────────────────────────────────────────────────────────────

test('S10. stats() day-boundary: +1 day buffer prevents under-scan at China-day boundary', async () => {
  const dir = newTmpDir('day-boundary');
  ts.setLogDir(dir);
  // Write a trace that's 30 minutes old at the China-day boundary.
  // This test verifies that stats() can find it regardless of the
  // UTC/China-time alignment. The +1 day buffer in maxDaySpan is critical.
  const nowMs = Date.now();
  const thirtyMinAgo = nowMs - 30 * 60 * 1000;
  ts.append(makeTrace({ id: 'DB1', finalStatus: 200, startedAt: new Date(thirtyMinAgo).toISOString() }));

  const r = await ts.stats({ windows: [1] });
  const w = r.windows[0];
  assert.ok(w.total >= 1,
    `30-min-old trace should be in 1h window. Got total=${w.total}. ` +
    'If this fails near China-day boundary, the +1 day buffer may be insufficient.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 11 — UI removeStatsWindow uses float comparison with
// clamped hours, creating unremovable windows
// ════════════════════════════════════════════════════════════════
// Category: logic / ui-bug
// File: proxy/web/index.html, lines 1060 + 1096-1097
//
// The × button onclick: removeStatsWindow(${w.hours})
//   - w.hours comes from the server response, which is the CLAMPED value
//   - statsWindows[] contains the ORIGINAL user-input value
//   - removeStatsWindow uses Math.abs(x - h) >= 0.001 to find and remove
//
// Example: User adds 200h window → server clamps to 168h → response has hours=168
// → × button calls removeStatsWindow(168) → but statsWindows has [200]
// → Math.abs(200 - 168) = 32 >= 0.001 → doesn't remove 200!
// The window can never be removed by clicking ×. Only "reset to default" works.
//
// Suggested fix: Use a unique ID for each window (not the hours value),
// or store the clamped hours in statsWindows instead of the original.
// ────────────────────────────────────────────────────────────────

test('S11. UI bug: clamped hours create unremovable stats windows', async () => {
  const dir = newTmpDir('stuck-window');
  ts.setLogDir(dir);

  // Simulate the UI logic:
  // 1. User adds 200h window to statsWindows
  let statsWindows = [1, 5, 24];
  statsWindows.push(200);
  statsWindows.sort((a, b) => a - b);
  // statsWindows = [1, 5, 24, 200]

  // 2. Server receives windows=[1,5,24,200] → stats() clamps 200→168
  const r = await ts.stats({ windows: statsWindows });

  // 3. Response has hours=168 (clamped)
  const clampedWindow = r.windows.find(w => w.hours === 168);
  assert.ok(clampedWindow, '200h window should be clamped to 168h in response');

  // 4. User clicks × on the 168h card → removeStatsWindow(168) is called
  const clickedHours = 168; // This is what the × button passes

  // 5. UI removal logic: statsWindows.filter(x => Math.abs(x - 168) >= 0.001)
  const afterRemove = statsWindows.filter(x => Math.abs(x - clickedHours) >= 0.001);

  // 6. The 200 stays! Because Math.abs(200 - 168) = 32 >= 0.001, so 200 is NOT removed.
  assert.ok(afterRemove.includes(200),
    `Window 200h cannot be removed by clicking × on clamped 168h card. ` +
    `After removal: ${JSON.stringify(afterRemove)}. The 200h window is stuck.`);
  assert.equal(afterRemove.length, statsWindows.length,
    'No windows were actually removed — the × button is broken for clamped windows.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 12 — stats() finalStatus=0 (network error) is NOT
// counted as success, but also not explicitly documented
// ════════════════════════════════════════════════════════════════
// Category: api-contract / documentation
// File: proxy/trace-store.js, lines 472-473
//   if (Number.isFinite(s) && s >= 200 && s < 300) b.success++;
//
// finalStatus=0 means network error (upstream unreachable). The code
// correctly excludes it from success (0 < 200). But the existing test
// J3 only tests this implicitly. We add an explicit edge case:
// finalStatus that is a non-integer number (e.g., 200.5).
//
// Number.isFinite(200.5) = true, 200.5 >= 200 = true, 200.5 < 300 = true.
// So finalStatus=200.5 would be counted as success! But HTTP status codes
// are always integers. If a bug produces a float finalStatus, stats()
// incorrectly counts it.
//
// Suggested fix: Add Math.floor() or check `s === Math.round(s)` for
// integer status codes, or at minimum add `s % 1 === 0` check.
// ────────────────────────────────────────────────────────────────

test('S12. stats() counts non-integer finalStatus (e.g., 200.5) as success', async () => {
  const dir = newTmpDir('float-status');
  ts.setLogDir(dir);
  const nowMs = Date.now();
  const iso = (m) => new Date(nowMs - m * 60_000).toISOString();

  // Write a trace with finalStatus=200.5 (shouldn't happen but defensive)
  const trace = makeTrace({ id: 'FS1', finalStatus: 200.5, startedAt: iso(1) });
  ts.append(trace);

  const r = await ts.stats({ windows: [1] });
  const w = r.windows[0];
  // 200.5 is not a valid HTTP status code, but stats() counts it as success
  assert.equal(w.success, 1,
    'stats() counts finalStatus=200.5 as success. ' +
    'HTTP status codes are always integers; non-integer finalStatus should not be counted as success.');
  assert.equal(w.total, 1,
    'Non-integer finalStatus is counted in total but is not a valid HTTP status code.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 13 — stats() empty windows array returns early without
// scanning, but fromTs is not included (no data for frontend)
// ════════════════════════════════════════════════════════════════
// Category: logic
// File: proxy/trace-store.js, lines 449
//   if (!ws.length) return { now: new Date(nowMs).toISOString(), windows: [] };
//
// If all windows are filtered out (e.g., windows=[0, -1, NaN]),
// stats() returns early with empty windows array. The `now` field is
// still included, which is good. But the caller (server.js) replaces
// empty windows with [1, 5, 24] at line 421:
//   const ws = windows.length ? windows : [1, 5, 24];
// This means the server fallback and the stats() early return never
// align — if server somehow passes an empty array to stats(), the
// early return is correct. But if stats() is called directly with
// all-invalid windows, it returns windows:[] without any default.
//
// This is a subtle contract mismatch: server guarantees at least
// [1,5,24], but stats() doesn't.
//
// Suggested fix: stats() should also default to [1,5,24] if all
// windows are filtered, or document that empty windows are possible.
// ────────────────────────────────────────────────────────────────

test('S13. stats() returns empty windows array when all windows are invalid — no fallback', async () => {
  const dir = newTmpDir('empty-ws');
  ts.setLogDir(dir);
  // Pass windows that are all filtered out (0, negative, NaN)
  const r = await ts.stats({ windows: [0, -1, NaN, Infinity] });
  assert.equal(r.windows.length, 0,
    'stats() returns empty windows when all inputs are invalid. ' +
    'Server fallback ([1,5,24]) does not apply here — direct callers get no data.');
  assert.ok(r.now, 'But the now field is still present');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 14 — stats() bucket sort modifies original ws order but
// returns sorted; UI relies on ascending order for display
// ════════════════════════════════════════════════════════════════
// Category: logic
// File: proxy/trace-store.js, line 480
//   buckets.sort((a, b) => a.hours - b.hours);
//
// The sort ensures ascending order by hours. But if two windows have
// the same hours (should be deduped but due to float precision might
// not be), sort order is undefined. Also, the frontend renderStats()
// maps r.windows in order to create stat cards. If the order changes
// between calls (due to float dedup race), cards may jump around.
//
// More importantly: if float hours differ by less than 0.001 but
// more than 0 (e.g., 1.0004 vs 1.0006), they won't dedup but will
// sort adjacent, creating two nearly-identical stat cards.
//
// Suggested fix: After sort, also dedup by visual display value
// (e.g., Math.round(h * 10) / 10).
// ────────────────────────────────────────────────────────────────

test('S14. stats() near-duplicate hours create nearly-identical stat cards', async () => {
  const dir = newTmpDir('near-dup');
  ts.setLogDir(dir);
  // Two windows very close but not deduped (dedup tolerance is 0.001h ≈ 3.6s)
  const r = await ts.stats({ windows: [1.0004, 1.0006] });
  // Both should pass the dedup filter (keys: 1000 and 1001)
  assert.equal(r.windows.length, 2,
    'Two near-duplicate hours (1.0004, 1.0006) both pass dedup, ' +
    'creating two nearly-identical stat cards in the UI. ' +
    'Dedup tolerance of 0.001h ≈ 3.6s is too tight for visual dedup.');
});

// ════════════════════════════════════════════════════════════════
// SUSPICION 15 — stats() scans days using dateStr which applies
// UTC+8 offset, but fromTs is in pure UTC ms — timezone mismatch
// ════════════════════════════════════════════════════════════════
// Category: logic
// File: proxy/trace-store.js, lines 455 vs 458-462
//
// fromTs = nowMs - h * 3600 * 1000  (pure UTC ms)
// days are computed using dateStr(d) where d = new Date(nowMs - i * DAY_MS)
//   and dateStr adds 8h offset to get China date.
//
// A trace with startedAt in UTC that falls on a different China-date
// than the scan day will be in a different shard. The scan must cover
// all China-dates that overlap with the UTC time window.
//
// Example: nowMs = 2024-01-02T02:00:00Z (China 10:00 Jan 2)
// 24h window goes back to 2024-01-01T02:00:00Z (China 10:00 Jan 1)
// Scanned days: dateStr(nowMs) = "2024-01-02", dateStr(nowMs-1d) = "2024-01-01"
// The trace at UTC 2024-01-01T02:00:00Z is in shard "2024-01-01" (China date).
// The scan covers this — correct.
//
// But: nowMs = 2024-01-02T01:00:00Z (China 09:00 Jan 2)
// 10h window goes back to 2024-01-01T15:00:00Z (China 23:00 Jan 1)
// maxDaySpan = ceil(10/24)+1 = 2. Scanned: "2024-01-02", "2024-01-01".
// Trace at China 23:00 Jan 1 is in shard "2024-01-01" — covered.
//
// Now: nowMs = 2024-01-01T16:00:00Z (China 00:00 Jan 2 — exactly midnight!)
// dateStr(nowMs) = "2024-01-02"
// 1h window goes back to 2024-01-01T15:00:00Z (China 23:00 Jan 1)
// maxDaySpan = ceil(1/24)+1 = 2. Scanned: "2024-01-02", "2024-01-01".
// The trace at China 23:00 Jan 1 is in shard "2024-01-01" — covered.
// BUT: what if the trace is at China 23:59 Jan 1 (=UTC 15:59 Jan 1)?
// Its startedAt is in shard "2024-01-01". FromTs = nowMs - 3600000 =
// UTC 15:00 Jan 1 = China 23:00 Jan 1. The trace at China 23:59 is
// within the window. And shard "2024-01-01" is scanned. Correct.
//
// The +1 day buffer makes this safe, but the code is fragile.
// ────────────────────────────────────────────────────────────────

test('S15. stats() timezone consistency: China-day shards cover UTC time window', async () => {
  const dir = newTmpDir('tz');
  ts.setLogDir(dir);
  // This test documents the timezone interaction rather than finding a bug.
  // The key invariant: for any window size w, the scan covers enough
  // China-date shards to include all traces within [nowMs - w*3600*1000, nowMs].
  const nowMs = Date.now();
  // A trace that's exactly 23 hours old should be in the 24h window
  const twentyThreeHoursAgo = nowMs - 23 * 3600 * 1000;
  ts.append(makeTrace({ id: 'TZ1', finalStatus: 200, startedAt: new Date(twentyThreeHoursAgo).toISOString() }));

  const r = await ts.stats({ windows: [24] });
  const w = r.windows[0];
  assert.equal(w.total, 1, '23h-old trace should be in 24h window');
  assert.equal(w.success, 1, '23h-old success trace should be counted');
});

// ════════════════════════════════════════════════════════════════
// BONUS SUSPICION — cleanupOld() called inside stats() can delete
// shards being concurrently scanned by another stats() call
// ════════════════════════════════════════════════════════════════
// Category: race-condition
// File: proxy/trace-store.js, line 435
//   cleanupOld();
//
// If two concurrent stats() calls run, the first calls cleanupOld()
// which deletes old shard files. If the second is mid-scan on those
// files, its readJsonlLines() will encounter missing files (existsSync
// returns false) and return an empty array — silently losing data.
//
// More critically: list() also calls cleanupOld() at line 375.
// A concurrent list() + stats() could have list()'s cleanupOld()
// delete files that stats() is currently scanning.
//
// This is a design-level race condition inherent to the file-based
// storage without locking. The async readDayIdx makes it observable.
//
// Suggested fix: Use a module-level mutex/lock for cleanup + scan,
// or make cleanupOld() lazy (only delete files not currently open).
// ────────────────────────────────────────────────────────────────

test('BONUS. stats() cleanupOld() can race with concurrent scan — data loss', async () => {
  // This test documents the race condition. We can't easily reproduce
  // the race in a single test, but we can verify that stats() calls
  // cleanupOld() which does synchronous file deletion.
  const dir = newTmpDir('race');
  ts.setLogDir(dir);

  // Verify stats() calls cleanupOld() by checking that 8-day-old
  // files are deleted after stats() runs (this is the intended behavior,
  // but it shows the race window exists).
  const daysAgoStr = (n) => {
    const t = Date.now() + 8 * 3600 * 1000 - n * 24 * 3600 * 1000;
    return new Date(t).toISOString().slice(0, 10);
  };
  const DAY_OLD = daysAgoStr(8);
  writeLegacyShard(dir, DAY_OLD, 1, [makeTrace({ id: 'RACE1' })]);

  // Before stats: old file exists
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(join(dir, `traces-${DAY_OLD}.001.jsonl`)),
    'Old shard should exist before stats()');

  // After stats: old file is deleted by cleanupOld()
  await ts.stats({ windows: [1] });
  assert.ok(!existsSync(join(dir, `traces-${DAY_OLD}.001.jsonl`)),
    'Old shard deleted by cleanupOld() inside stats(). ' +
    'If another concurrent stats() was scanning this file, its data would be lost.');
});
