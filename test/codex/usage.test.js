// 使用量読取器（src/codex/usage.js）のテスト。
// 使用量の読取は、Codex CLI が使用量を読むのと同じ固定 URL（`GET {base}/wham/usage`）へ送る。
// その送り方・安全境界・応答の正規化・失敗の分類を、Codex CLI の応答の形に合わせた合成の値で確かめる。
//
// 絶対条件: chatgpt.com / openai.com への実接続は行わない。fetch はすべて fetchImpl
// の差し替えで、時刻は固定の now で決定的に再現する。~/.codex は読まない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCodexUsage,
  CODEX_USAGE_URL,
  MAX_USAGE_BODY_BYTES,
  RESET_SKEW_TOLERANCE_MS,
} from '../../src/codex/usage.js';

const NOW_MS = 1800000000000; // 固定時刻。unix 秒では 1800000000。
const NOW_SEC = NOW_MS / 1000;
const now = () => NOW_MS;
const credentials = { accessToken: 'synthetic-access-token', accountId: 'synthetic-account-id' };
// User-Agent と originator は呼び出し側が実行時に組み立てて渡す値。テストでは実物と見分けが
// つく合成の値を使う（製品名の部分を zz-fake- で始める決まり）。
const fakeUserAgent = 'zz-fake-usage-reader/0.0.0 (zz-fake-test)';
const fakeOriginator = 'zz-fake-originator';
const identity = { userAgent: fakeUserAgent, originator: fakeOriginator };

/** Codex CLI の実装で確かめた窓スナップショット形（used_percent は i32、reset_at は絶対 unix 秒）。 */
const window_ = (overrides = {}) => ({
  used_percent: 74, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: NOW_SEC + 3600, ...overrides,
});

/**
 * Codex CLI の実装で確かめた応答形。`primary`/`secondary` に `undefined` を明示するとそのキーごと欠測させ、
 * `null` を渡すと JSON の null として載せる（欠測と不在を区別するため）。
 */
function payload({ allowed = true, ...overrides } = {}) {
  const { primary: _p, secondary: _s, ...rest } = overrides;
  const primary = 'primary' in overrides ? overrides.primary : window_();
  const secondary = overrides.secondary;
  return {
    plan_type: 'pro',
    rate_limit: {
      allowed, limit_reached: false,
      ...(primary === undefined ? {} : { primary_window: primary }),
      ...(secondary === undefined ? {} : { secondary_window: secondary }),
    },
    ...rest,
  };
}

const jsonResponse = (body, { status = 200, headers = {} } = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json', ...headers } });

function recorder(responder) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return typeof responder === 'function' ? responder(url, init) : responder;
    },
  };
}

const read = (fetchImpl, options = {}) => readCodexUsage({ credentials, ...identity, fetchImpl, now, ...options });

/**
 * 期限タイマーは unref されている（本番では上流ソケットのハンドルが event loop を
 * 保つ）。偽 fetch にはハンドルが無いので、待っている間だけ生きたハンドルを置く。
 */
async function withLiveEventLoop(run) {
  const keepAlive = setInterval(() => {}, 1);
  try { return await run(); } finally { clearInterval(keepAlive); }
}

// --- 送信の形（安全境界） -------------------------------------------------

test('usage: targets the fixed /wham/usage URL that the Codex CLI reads usage from', () => {
  assert.equal(CODEX_USAGE_URL, 'https://chatgpt.com/backend-api/wham/usage');
});

test('usage: sends exactly one GET with no body and without following redirects', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(payload()));
  await read(fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CODEX_USAGE_URL);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.body, undefined);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('usage: sends only the fixed header set and forwards no caller or opt-in headers', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(payload()));
  // 利用者由来のヘッダを渡そうとしても、読取器には受け取る口が無い。
  await read(fetchImpl, { headers: { 'x-openai-codex-luna-reserve': '1', 'x-forwarded-for': '203.0.113.1' } });
  const { headers } = calls[0].init;
  assert.deepEqual(Object.keys(headers).sort(),
    ['Accept', 'Authorization', 'ChatGPT-Account-ID', 'User-Agent', 'originator']);
  assert.equal(headers.Authorization, `Bearer ${credentials.accessToken}`);
  assert.equal(headers['ChatGPT-Account-ID'], credentials.accountId);
  assert.equal(headers['User-Agent'], fakeUserAgent);
  assert.equal(headers.originator, fakeOriginator);
  assert.equal(headers.Accept, 'application/json');
  const lowered = Object.keys(headers).map(name => name.toLowerCase());
  assert.ok(!lowered.includes('x-openai-codex-luna-reserve'));
  assert.ok(!lowered.includes('x-openai-internal-codex-responses-lite'));
  assert.ok(!lowered.includes('x-forwarded-for'));
});

test('usage: refuses to read without an account id and sends nothing', async () => {
  // ChatGPT-Account-ID は必須ヘッダ。`readCodexSendSnapshot()` は口座 ID を必ず返す
  // 契約なので、欠けた入力は正規のスナップショットではない。口座を指定しない照会は送らない。
  for (const accountId of [undefined, null, '', '   ', 42]) {
    const { calls, fetchImpl } = recorder(() => jsonResponse(payload()));
    await assert.rejects(
      readCodexUsage({ credentials: { accessToken: 'only-token', accountId }, ...identity, fetchImpl, now }),
      error => error instanceof TypeError);
    assert.equal(calls.length, 0);
  }
});

test('usage: refuses to read without an access token and sends nothing', async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(payload()));
  await assert.rejects(readCodexUsage({ credentials: { accountId: 'a' }, ...identity, fetchImpl, now }),
    error => error instanceof TypeError);
  assert.equal(calls.length, 0);
});

test('usage: refuses to read without a caller-supplied User-Agent or originator and sends nothing', async () => {
  // 既定値へ落ちないこと。引数ごと省いた場合も、無い・空・文字列でない値も、送信せずに拒否する。
  const omitted = recorder(() => jsonResponse(payload()));
  await assert.rejects(readCodexUsage({ credentials, fetchImpl: omitted.fetchImpl, now }),
    error => error instanceof TypeError && /user agent required/.test(error.message));
  assert.equal(omitted.calls.length, 0);
  for (const [field, message] of [['userAgent', /user agent required/], ['originator', /originator required/]]) {
    for (const value of [undefined, null, '', '   ', 42]) {
      const { calls, fetchImpl } = recorder(() => jsonResponse(payload()));
      await assert.rejects(read(fetchImpl, { [field]: value }),
        error => error instanceof TypeError && message.test(error.message), `${field}=${String(value)}`);
      assert.equal(calls.length, 0, `${field}=${String(value)} must send nothing`);
    }
  }
});

// --- 応答の写像（応答の写像・観測源の分離） --------------------------

test('usage: maps allowed and both windows from the Codex CLI usage response shape', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(payload({
    primary: window_({ used_percent: 74 }),
    secondary: window_({ used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 7200, reset_at: NOW_SEC + 7200 }),
    rate_limit_reached_type: 'primary_window',
  })));
  const result = await read(fetchImpl);
  assert.equal(result.classification, 'success');
  assert.equal(result.status, 200);
  assert.equal(result.failure, null);
  assert.equal(result.receivedAt, NOW_MS);
  assert.equal(result.observation.ordinaryUsageAllowed, true);
  assert.equal(result.observation.rateLimitReachedType, 'primary_window');
  assert.deepEqual(result.observation.primary, {
    usedPercent: 74, usedPercentIssue: null, windowResetAt: (NOW_SEC + 3600) * 1000,
    resetAfterSeconds: 3600, limitWindowSeconds: 18000, complete: true, incompleteReason: null,
  });
  assert.deepEqual(result.observation.secondary, {
    usedPercent: 12, usedPercentIssue: null, windowResetAt: (NOW_SEC + 7200) * 1000,
    resetAfterSeconds: 7200, limitWindowSeconds: 604800, complete: true, incompleteReason: null,
  });
  assert.equal(result.observation.complete, true);
});

test('usage: keeps used_percent exactly as received for integers and decimals', async () => {
  for (const value of [0, 74, 75, 99, 100, 74.99]) {
    const { fetchImpl } = recorder(() => jsonResponse(payload({ primary: window_({ used_percent: value }) })));
    const result = await read(fetchImpl);
    assert.equal(result.classification, 'success');
    assert.equal(result.observation.primary.usedPercent, value);
    assert.equal(result.observation.primary.complete, true);
  }
});

test('usage: treats a null or missing window as absent rather than as zero', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(payload({ secondary: null })));
  const withNull = await read(fetchImpl);
  assert.equal(withNull.observation.secondary, null);
  assert.equal(withNull.observation.primary.usedPercent, 74);

  const missing = recorder(() => jsonResponse(payload({ secondary: undefined })));
  const withMissing = await read(missing.fetchImpl);
  assert.equal(withMissing.observation.secondary, null);

  const noWindows = recorder(() => jsonResponse(payload({ primary: undefined, secondary: undefined })));
  const empty = await read(noWindows.fetchImpl);
  assert.equal(empty.classification, 'success');
  assert.equal(empty.observation.primary, null);
  assert.equal(empty.observation.complete, false);
});

test('usage: never adopts a missing, invalid or out-of-range used_percent as 0', async () => {
  // JSON は NaN/Infinity を運べないため、非有限値は「欠測」として届く。
  for (const [used, issue] of [[undefined, 'missing'], [null, 'missing'], [Number.NaN, 'missing'],
    ['74', 'invalid'], [true, 'invalid'], [{}, 'invalid'], [101, 'out-of-range'], [-1, 'out-of-range']]) {
    const { fetchImpl } = recorder(() => jsonResponse(payload({ primary: window_({ used_percent: used }) })));
    const result = await read(fetchImpl);
    assert.equal(result.classification, 'success');
    assert.equal(result.observation.primary.usedPercent, null);
    assert.equal(result.observation.primary.usedPercentIssue, issue);
    assert.equal(result.observation.primary.complete, false);
    assert.equal(result.observation.primary.incompleteReason, 'used-percent-unusable');
    assert.equal(result.observation.complete, false);
  }
});

test('usage: treats a window that is not an object as unusable, not as absent', async () => {
  for (const shape of [74, 'busy', []]) {
    const { fetchImpl } = recorder(() => jsonResponse(payload({ primary: shape })));
    const result = await read(fetchImpl);
    assert.equal(result.classification, 'success');
    assert.notEqual(result.observation.primary, null);
    assert.equal(result.observation.primary.usedPercent, null);
    assert.equal(result.observation.primary.usedPercentIssue, 'invalid');
    assert.equal(result.observation.complete, false);
  }
});

test('usage: keeps used_percent but marks the window incomplete when reset fields are present yet unusable', async () => {
  // 値を null へ落として通すと、矛盾した応答が「完全観測」として復帰の判定の根拠になり、
  // 停止ラッチを解除できてしまう。使用率は停止判定に使えるので残す。
  for (const [overrides, reason] of [
    [{ reset_at: 'later' }, 'reset-unusable'],
    [{ reset_at: -1 }, 'reset-unusable'],
    [{ reset_at: 1.5 }, 'reset-unusable'],
    [{ reset_at: 1e15 }, 'reset-unusable'],
    [{ reset_after_seconds: -5 }, 'reset-unusable'],
    [{ reset_after_seconds: '3600' }, 'reset-unusable'],
    [{ limit_window_seconds: 0 }, 'window-length-unusable'],
    [{ limit_window_seconds: -18000 }, 'window-length-unusable'],
  ]) {
    const { fetchImpl } = recorder(() => jsonResponse(payload({ primary: window_(overrides) })));
    const result = await read(fetchImpl);
    const label = JSON.stringify(overrides);
    assert.equal(result.classification, 'success', label);
    assert.equal(result.observation.primary.usedPercent, 74, label);
    assert.equal(result.observation.primary.complete, false, label);
    assert.equal(result.observation.primary.incompleteReason, reason, label);
    assert.equal(result.observation.complete, false, label);
  }
  // 読めなかったフィールドは推測で埋めず null のまま返す。
  const { fetchImpl } = recorder(() => jsonResponse(payload({
    primary: window_({ limit_window_seconds: 0, reset_after_seconds: -5, reset_at: 'later' }),
  })));
  const result = await read(fetchImpl);
  assert.equal(result.observation.primary.limitWindowSeconds, null);
  assert.equal(result.observation.primary.resetAfterSeconds, null);
  assert.equal(result.observation.primary.windowResetAt, null);
  assert.equal(result.observation.primary.usedPercent, 74);
  assert.equal(result.observation.primary.complete, false);
});

test('usage: treats reset fields the upstream did not send as absent, not as contradictory', async () => {
  // 欠測（キー無し・null）は「上流が返さなかった」だけで矛盾ではない（欠測を補完しない）。
  for (const overrides of [
    { reset_at: undefined, reset_after_seconds: undefined, limit_window_seconds: undefined },
    { reset_at: null, reset_after_seconds: null, limit_window_seconds: null },
  ]) {
    const { fetchImpl } = recorder(() => jsonResponse(payload({ primary: window_(overrides) })));
    const result = await read(fetchImpl);
    assert.equal(result.observation.primary.usedPercent, 74);
    assert.equal(result.observation.primary.windowResetAt, null);
    assert.equal(result.observation.primary.resetAfterSeconds, null);
    assert.equal(result.observation.primary.limitWindowSeconds, null);
    assert.equal(result.observation.primary.complete, true);
    assert.equal(result.observation.primary.incompleteReason, null);
    assert.equal(result.observation.complete, true);
  }
});

test('usage: marks a window incomplete when reset_at contradicts reset_after_seconds', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(payload({
    primary: window_({ reset_after_seconds: 60, reset_at: NOW_SEC + 3600 }),
  })));
  const result = await read(fetchImpl);
  assert.equal(result.observation.primary.complete, false);
  assert.equal(result.observation.primary.incompleteReason, 'reset-mismatch');
  assert.equal(result.observation.complete, false);
  // 突合の許容幅の内側なら完全なまま。
  const inside = recorder(() => jsonResponse(payload({
    primary: window_({ reset_after_seconds: 3600 + (RESET_SKEW_TOLERANCE_MS / 1000) - 1, reset_at: NOW_SEC + 3600 }),
  })));
  assert.equal((await read(inside.fetchImpl)).observation.primary.complete, true);
});

test('usage: marks a window incomplete when its reset time has already passed', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(payload({
    primary: window_({ reset_after_seconds: undefined, reset_at: NOW_SEC - 1 }),
  })));
  const result = await read(fetchImpl);
  assert.equal(result.observation.primary.usedPercent, 74);
  assert.equal(result.observation.primary.complete, false);
  assert.equal(result.observation.primary.incompleteReason, 'reset-in-past');
});

test('usage: reports an incomplete observation when allowed is absent', async () => {
  const { fetchImpl } = recorder(() => jsonResponse({ rate_limit: { primary_window: window_() } }));
  const result = await read(fetchImpl);
  assert.equal(result.classification, 'success');
  assert.equal(result.observation.ordinaryUsageAllowed, null);
  assert.equal(result.observation.primary.complete, true);
  assert.equal(result.observation.complete, false);
});

test('usage: keeps allowed=false and records credits as presence only, never amounts', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(payload({
    allowed: false,
    primary: window_({ used_percent: 100 }),
    rate_limit_reached_type: 'primary_window',
    credits: { balance: 12345 },
    rate_limit_reset_credits: { available_count: 7 },
    additional_rate_limits: [{ name: 'burst', used_percent: 3 }],
  })));
  const result = await read(fetchImpl);
  assert.equal(result.observation.ordinaryUsageAllowed, false);
  assert.deepEqual(result.observation.debug,
    { creditsPresent: true, resetCreditsPresent: true, additionalRateLimitsPresent: true });
  const serialized = JSON.stringify(result);
  for (const leaked of ['available_count', 'balance', '12345', 'additional_rate_limits', 'burst']) {
    assert.ok(!serialized.includes(leaked), `result must not carry ${leaked}`);
  }
});

test('usage: rejects an unusable rate_limit_reached_type instead of passing it to logs', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(payload({ rate_limit_reached_type: 'primary window\nlog injection' })));
  assert.equal((await read(fetchImpl)).observation.rateLimitReachedType, null);
});

test('usage: never returns the raw body, account_id or user_id', async () => {
  const { fetchImpl } = recorder(() => jsonResponse(payload({
    account_id: 'acct-must-not-leak', user_id: 'user-must-not-leak', rate_limit_upsell: { copy: 'upgrade-now' },
  })));
  const serialized = JSON.stringify(await read(fetchImpl));
  for (const leaked of ['acct-must-not-leak', 'user-must-not-leak', 'upgrade-now', 'plan_type',
    credentials.accessToken, credentials.accountId]) {
    assert.ok(!serialized.includes(leaked), `result must not carry ${leaked}`);
  }
});

// --- 失敗の分類 -------------------------------------------

for (const [status, failure] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'],
  [418, 'client-error'], [500, 'server-error'], [503, 'server-error']]) {
  test(`usage: classifies HTTP ${status} as ${failure} without reading or echoing the body`, async () => {
    const { calls, fetchImpl } = recorder(() => new Response('<html>cloudflare-challenge-marker</html>',
      { status, headers: { 'content-type': 'text/html' } }));
    const result = await read(fetchImpl);
    assert.equal(result.classification, 'http-error');
    assert.equal(result.failure, failure);
    assert.equal(result.status, status);
    assert.equal(result.observation, null);
    assert.equal(result.retryAfter, null);
    assert.ok(!JSON.stringify(result).includes('cloudflare-challenge-marker'));
    assert.equal(calls.length, 1); // 読取器は再試行しない。
  });
}

test('usage: keeps Retry-After from a 429 as read-side evidence only', async () => {
  const { fetchImpl } = recorder(() => jsonResponse({ detail: 'slow down' }, { status: 429, headers: { 'retry-after': '30' } }));
  const result = await read(fetchImpl);
  assert.equal(result.classification, 'http-error');
  assert.equal(result.failure, 'rate-limited');
  assert.equal(result.retryAfter, '30');
  assert.equal(result.observation, null);
  assert.ok(!JSON.stringify(result).includes('slow down'));
});

test('usage: does not follow a redirect and never records its target', async () => {
  const { calls, fetchImpl } = recorder(() => new Response('moved',
    { status: 302, headers: { location: 'https://credential-thief.example/usage' } }));
  const result = await read(fetchImpl);
  assert.equal(result.classification, 'invalid-response');
  assert.equal(result.failure, 'redirect');
  assert.equal(result.status, 302);
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(result).includes('credential-thief.example'));
});

test('usage: classifies a non-JSON 200 body as a transport failure without recording it', async () => {
  const { fetchImpl } = recorder(() => new Response('<html>cloudflare-challenge-marker</html>',
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const result = await read(fetchImpl);
  assert.equal(result.classification, 'invalid-response');
  assert.equal(result.failure, 'non-json');
  assert.equal(result.status, 200);
  assert.equal(result.observation, null);
  assert.ok(!JSON.stringify(result).includes('cloudflare-challenge-marker'));
});

test('usage: classifies unparsable and empty JSON bodies as non-json', async () => {
  const broken = recorder(() => jsonResponse('{"rate_limit":'));
  assert.equal((await read(broken.fetchImpl)).failure, 'non-json');
  const empty = recorder(() => new Response(null, { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal((await read(empty.fetchImpl)).failure, 'non-json');
});

test('usage: stops reading a body beyond the 64KB limit and keeps none of it', async () => {
  const oversize = JSON.stringify({ ...payload(), pad: 'oversize-marker'.repeat(MAX_USAGE_BODY_BYTES / 8) });
  assert.ok(Buffer.byteLength(oversize) > MAX_USAGE_BODY_BYTES);
  const { fetchImpl } = recorder(() => jsonResponse(oversize));
  const result = await read(fetchImpl);
  assert.equal(result.classification, 'invalid-response');
  assert.equal(result.failure, 'body-too-large');
  assert.equal(result.observation, null);
  assert.ok(!JSON.stringify(result).includes('oversize-marker'));
});

test('usage: treats a changed response shape as a transport failure, not as 0% usage', async () => {
  for (const body of [{ usage: { primary: 74 } }, { rate_limit: null }, { rate_limit: [] }, [], 'null']) {
    const { fetchImpl } = recorder(() => jsonResponse(body));
    const result = await read(fetchImpl);
    assert.equal(result.classification, 'invalid-response');
    assert.equal(result.failure, 'malformed-shape');
    assert.equal(result.observation, null);
  }
});

test('usage: classifies an expired deadline as a timeout and sends only once', async () => {
  const { calls, fetchImpl } = recorder((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  const result = await withLiveEventLoop(() => read(fetchImpl, { timeoutMs: 5 }));
  assert.equal(result.classification, 'network-error');
  assert.equal(result.failure, 'timeout');
  assert.equal(result.status, null);
  assert.equal(result.observation, null);
  assert.equal(calls.length, 1);
});

test('usage: applies the same deadline to a body that never finishes', async () => {
  // undici と同じく、要求の signal が中断されたら本文ストリームも失敗する形を模す。
  const { calls, fetchImpl } = recorder((url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"rate_limit":'));
      init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const result = await withLiveEventLoop(() => read(fetchImpl, { timeoutMs: 5 }));
  assert.equal(result.classification, 'network-error');
  assert.equal(result.failure, 'timeout');
  assert.equal(result.observation, null);
  assert.equal(calls.length, 1);
});

test('usage: reports a transport failure with an allow-listed code only', async () => {
  const refused = recorder(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  const result = await read(refused.fetchImpl);
  assert.equal(result.classification, 'network-error');
  assert.equal(result.failure, 'network');
  assert.equal(result.errorCode, 'ECONNREFUSED');
  const opaque = recorder(() => { throw new Error('upstream said secret-token-abc'); });
  const other = await read(opaque.fetchImpl);
  assert.equal(other.failure, 'network');
  assert.equal(other.errorCode, null);
  assert.ok(!JSON.stringify(other).includes('secret-token-abc'));
});

test('usage: reports an aborted read without sending when the caller signal is already aborted', async () => {
  const caller = new AbortController();
  caller.abort();
  const { calls, fetchImpl } = recorder(() => jsonResponse(payload()));
  const result = await read(fetchImpl, { signal: caller.signal });
  assert.equal(result.classification, 'aborted');
  assert.equal(result.observation, null);
  assert.equal(calls.length, 0);
});

test('usage: distinguishes a caller abort in flight from a deadline timeout', async () => {
  const caller = new AbortController();
  const { fetchImpl } = recorder((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    caller.abort();
  }));
  const result = await read(fetchImpl, { signal: caller.signal, timeoutMs: 60000 });
  assert.equal(result.classification, 'aborted');
  assert.equal(result.failure, null);
});

test('usage: measures the read against the injected clock without touching pool state', async () => {
  let clock = 1000;
  const { fetchImpl } = recorder(() => { clock += 250; return jsonResponse(payload()); });
  const result = await readCodexUsage({ credentials, ...identity, fetchImpl, now: () => clock });
  assert.equal(result.startedAt, 1000);
  assert.equal(result.receivedAt, 1250);
  assert.equal(result.durationMs, 250);
  // 返すのは事実だけ。口座選択・状態遷移に関わるキーを持たない。
  assert.deepEqual(Object.keys(result).sort(), ['classification', 'durationMs', 'errorCode', 'failure',
    'observation', 'receivedAt', 'retryAfter', 'startedAt', 'status']);
});
