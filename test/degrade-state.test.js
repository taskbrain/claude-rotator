import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBridgeLogMeta,
  buildDegradeBody,
  claudeAllUnusable,
  claudeEarliestResetAt,
  createGptPoolState,
  decideBridgeResponse,
  formatLogMeta,
  mapClaudeExhaustion,
  parseBridgeContract,
  sanitizeAccountLabel,
} from '../src/degrade-state.js';

// 設計書 §11.1 R3-1 / 契約 v1.3 §C3・§C10 の純関数群。
// すべて副作用なし・時刻注入で決定的に検証する（HTTP も fs も使わない）。

const RESET_AT = '2026-09-08T13:00:00Z';
const LATER_RESET_AT = '2026-09-08T14:00:00Z';

function headers(overrides = {}) {
  return {
    'x-ombr-contract': '1',
    'x-ombr-degrade-reason': 'codex_pool_exhausted',
    'x-ombr-degrade-scope': 'pool',
    'x-ombr-pool-state': 'exhausted',
    'x-ombr-upstream-status': '429',
    'x-ombr-upstream-sent': 'yes',
    'x-ombr-reset-at': RESET_AT,
    ...overrides,
  };
}

// accountManager は .accounts と .isAvailable() しか使わない（設計書 §4.2）。
function fakeAccountManager(states, expectFamily) {
  const accounts = states.map((available, index) => ({ id: `acct-${index}`, available }));
  return {
    accounts,
    isAvailable(account, modelFamily = null) {
      if (expectFamily !== undefined) assert.equal(modelFamily, expectFamily);
      return account.available;
    },
  };
}

function clockAt(startMs) {
  const clock = { ms: startMs };
  return { clock, now: () => clock.ms };
}

// ---------------------------------------------------------------------------
// sanitizeAccountLabel（設計書 §6.6 規律1）
// ---------------------------------------------------------------------------

describe('sanitizeAccountLabel', () => {
  it('keeps labels that match ^[a-z0-9][a-z0-9_-]{0,31}$', () => {
    for (const label of ['pro-a', 'a', 'acct_1', '0', 'a'.repeat(32)]) {
      assert.equal(sanitizeAccountLabel(label), label);
    }
  });

  it('replaces an email address with <invalid> (メールアドレスはログへ落とさない)', () => {
    assert.equal(sanitizeAccountLabel('user-a@example.com'), '<invalid>');
  });

  it('replaces uppercase, leading separators, spaces and over-long values with <invalid>', () => {
    for (const label of ['Pro-A', '-pro', '_pro', 'pro a', 'a'.repeat(33), 'pro.a']) {
      assert.equal(sanitizeAccountLabel(label), '<invalid>', label);
    }
  });

  it('returns null when the header is absent or not a string', () => {
    assert.equal(sanitizeAccountLabel(undefined), null);
    assert.equal(sanitizeAccountLabel(''), null);
    assert.equal(sanitizeAccountLabel(42), null);
  });
});

// ---------------------------------------------------------------------------
// parseBridgeContract（設計書 §6.2・§6.5、契約 §C3）
// ---------------------------------------------------------------------------

describe('parseBridgeContract', () => {
  it('reads every documented header', () => {
    const parsed = parseBridgeContract(headers({
      'x-ombr-cached': 'yes',
      'x-ombr-account': 'pro-b',
      'x-ombr-primary-used-percent': '97.0',
      'x-ombr-secondary-used-percent': '12.5',
    }));
    assert.equal(parsed.present, true);
    assert.equal(parsed.contract, 1);
    assert.equal(parsed.reason, 'codex_pool_exhausted');
    assert.equal(parsed.rawScope, 'pool');
    assert.equal(parsed.effectiveScope, 'pool');
    assert.equal(parsed.poolState, 'exhausted');
    assert.equal(parsed.upstreamStatus, 429);
    assert.equal(parsed.upstreamSent, 'yes');
    assert.equal(parsed.cached, 'yes');
    assert.equal(parsed.accountLabel, 'pro-b');
    assert.equal(parsed.resetAt, RESET_AT);
    assert.equal(parsed.primaryUsedPercent, 97);
    assert.equal(parsed.secondaryUsedPercent, 12.5);
  });

  it('reports present=false and no learning input when no x-ombr-* header exists', () => {
    const parsed = parseBridgeContract({ 'content-type': 'application/json' });
    assert.equal(parsed.present, false);
    assert.equal(parsed.contract, null);
    assert.equal(parsed.reason, null);
    assert.equal(parsed.poolState, null);
    assert.equal(parsed.rawScope, null);
    assert.equal(parsed.effectiveScope, 'model', 'どちらとも導けないときは (pool) を汚さない model 扱い');
  });

  it('infers-known-reason-but-requires-explicit-scope-for-gpt-map', () => {
    // 設計書 §6.5: 学習には effectiveScope を使い、403 書換には rawScope しか使わない。
    const parsed = parseBridgeContract({
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_pool_exhausted',
      'x-ombr-pool-state': 'exhausted',
    });
    assert.equal(parsed.rawScope, null, 'scope ヘッダが無い以上 403 書換の根拠にはできない');
    assert.equal(parsed.effectiveScope, 'pool', '学習は reason の既定 scope に従う');

    const decision = decideBridgeResponse(parsed, {
      enabled: true, upstreamStatus: 529, claudeAllUnusable: true, gptPoolState: 'unusable',
    });
    assert.equal(decision.rewrite, false);
    assert.equal(decision.reason, 'scope-not-explicit-pool');
  });

  it('derives the default scope of each documented reason', () => {
    const cases = [
      ['codex_pool_exhausted', 'pool'],
      ['codex_pool_mixed', 'pool'],
      ['codex_needs_login', 'pool'],
      ['codex_attempt_limit', 'pool'],
      ['codex_no_account_for_model', 'model'],
      ['codex_account_exhausted', 'account'],
      ['request_invalid', 'model'],
      ['bridge_internal_error', 'model'],
    ];
    for (const [reason, scope] of cases) {
      const parsed = parseBridgeContract({ 'x-ombr-degrade-reason': reason });
      assert.equal(parsed.effectiveScope, scope, reason);
    }
  });

  it('normalises an unknown reason to "unknown" and never invents a scope for it', () => {
    // 指摘4: 原文を持ち回るとログへ識別子が混入しうるため、列挙値以外は保持しない。
    const parsed = parseBridgeContract({ 'x-ombr-degrade-reason': 'codex_brand_new_reason' });
    assert.equal(parsed.reason, 'unknown');
    assert.equal(parsed.effectiveScope, 'model', '挙動は変えない＝(pool) を汚さない側へ倒す');
  });

  it('treats out-of-range and malformed values as unknown (安全側)', () => {
    const parsed = parseBridgeContract(headers({
      'x-ombr-contract': 'zero',
      'x-ombr-degrade-scope': 'universe',
      'x-ombr-pool-state': 'melted',
      'x-ombr-upstream-status': '999',
      'x-ombr-upstream-sent': 'maybe',
      'x-ombr-reset-at': '2026-09-08 13:00:00',
      'x-ombr-primary-used-percent': '250',
    }));
    assert.equal(parsed.contract, null);
    assert.equal(parsed.rawScope, null);
    assert.equal(parsed.poolState, null);
    assert.equal(parsed.upstreamStatus, null);
    assert.equal(parsed.upstreamSent, null);
    assert.equal(parsed.resetAt, null);
    assert.equal(parsed.primaryUsedPercent, null);
    assert.equal(parsed.present, true, '未知の値でもエラーにせず、既知のヘッダだけを解釈する');
  });

  it('accepts upstream-status "none" and a fractional RFC3339 reset-at', () => {
    const parsed = parseBridgeContract({
      'x-ombr-upstream-status': 'none',
      'x-ombr-reset-at': '2026-09-08T13:00:00.500Z',
    });
    assert.equal(parsed.upstreamStatus, 'none');
    assert.equal(parsed.resetAt, '2026-09-08T13:00:00.500Z');
  });

  it('takes the first value when a header arrives as an array and tolerates null input', () => {
    const parsed = parseBridgeContract({ 'x-ombr-pool-state': ['exhausted', 'ok'] });
    assert.equal(parsed.poolState, 'exhausted');
    assert.equal(parseBridgeContract(null).present, false);
  });

  it('marks an email-shaped x-ombr-account as <invalid>', () => {
    const parsed = parseBridgeContract({ 'x-ombr-account': 'user-a@example.com' });
    assert.equal(parsed.accountLabel, '<invalid>');
  });
});

// ---------------------------------------------------------------------------
// createGptPoolState（契約 §C10.3 の遷移表 T1〜T10）
// ---------------------------------------------------------------------------

describe('createGptPoolState transitions (契約 §C10.3)', () => {
  it('T1: starts unknown for both keys', () => {
    const state = createGptPoolState({ now: () => 0 });
    const view = state.read('gpt-6-astra');
    assert.equal(view.pool.state, 'unknown');
    assert.equal(view.model.state, 'unknown');
  });

  it('T2: HTTP 200 with pool-state ok/degraded moves both keys to available and clears reason', () => {
    for (const poolState of ['ok', 'degraded']) {
      const state = createGptPoolState({ now: () => 1000 });
      state.observe(parseBridgeContract(headers()), 529, 'gpt-6-astra');
      assert.equal(state.read().pool.state, 'unusable');
      const result = state.observe(
        parseBridgeContract({ 'x-ombr-contract': '1', 'x-ombr-pool-state': poolState }),
        200,
        'gpt-6-astra',
      );
      assert.equal(result.transition, 'T2', poolState);
      const view = state.read('gpt-6-astra');
      assert.equal(view.pool.state, 'available');
      assert.equal(view.pool.reason, null);
      assert.equal(view.pool.resetAt, null);
      assert.equal(view.model.state, 'available');
    }
  });

  it('T3: an error with scope=pool and exhausted/needs-login/mixed makes (pool) unusable and keeps reason/resetAt', () => {
    for (const [poolState, reason] of [['exhausted', 'codex_pool_exhausted'], ['needs-login', 'codex_needs_login'], ['mixed', 'codex_pool_mixed']]) {
      const state = createGptPoolState({ now: () => 1000 });
      const result = state.observe(
        parseBridgeContract(headers({ 'x-ombr-pool-state': poolState, 'x-ombr-degrade-reason': reason })),
        poolState === 'needs-login' ? 403 : 529,
        'gpt-6-astra',
      );
      assert.equal(result.transition, 'T3', poolState);
      const view = state.read('gpt-6-astra');
      assert.equal(view.pool.state, 'unusable');
      assert.equal(view.pool.reason, reason);
      assert.equal(view.pool.resetAt, RESET_AT);
      assert.equal(view.model.state, 'unknown', '(pool, model) は変えない');
    }
  });

  it('T4: an error with scope=model and no-account-for-model touches only (pool, model)', () => {
    const state = createGptPoolState({ now: () => 1000 });
    const result = state.observe(
      parseBridgeContract({
        'x-ombr-contract': '1',
        'x-ombr-degrade-reason': 'codex_no_account_for_model',
        'x-ombr-degrade-scope': 'model',
        'x-ombr-pool-state': 'no-account-for-model',
      }),
      403,
      'gpt-6-astra',
    );
    assert.equal(result.transition, 'T4');
    assert.equal(state.read('gpt-6-astra').pool.state, 'unknown');
    assert.equal(state.read('gpt-6-astra').model.state, 'unusable');
    assert.equal(state.read('gpt-5.6-sol').model.state, 'unknown', '他モデルには波及しない');
  });

  it('T5: codex_attempt_limit (pool-state degraded) changes nothing and never extends an existing unusable', () => {
    const { clock, now } = clockAt(1000);
    const state = createGptPoolState({ now, unusableTtlMs: 60000 });
    state.observe(parseBridgeContract(headers({ 'x-ombr-reset-at': RESET_AT })), 529, 'gpt-6-astra');
    const before = state.read('gpt-6-astra').pool;

    clock.ms = 30000;
    const result = state.observe(
      parseBridgeContract({
        'x-ombr-contract': '1',
        'x-ombr-degrade-reason': 'codex_attempt_limit',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'degraded',
        'x-ombr-reset-at': LATER_RESET_AT,
      }),
      529,
      'gpt-6-astra',
    );
    assert.equal(result.transition, 'T5');
    const after = state.read('gpt-6-astra').pool;
    assert.equal(after.state, 'unusable');
    assert.equal(after.reason, before.reason);
    assert.equal(after.resetAt, RESET_AT, 'resetAt を更新しない＝unusable を延命しない');
    assert.equal(after.learnedAt, before.learnedAt);
  });

  it('T6: unusable returns to unknown once resetAt has passed', () => {
    const { clock, now } = clockAt(Date.parse(RESET_AT) - 1000);
    const state = createGptPoolState({ now });
    state.observe(parseBridgeContract(headers()), 529, 'gpt-6-astra');
    assert.equal(state.read().pool.state, 'unusable');

    clock.ms = Date.parse(RESET_AT);
    assert.equal(state.read().pool.state, 'unknown');
    assert.equal(state.read().pool.reason, null);
  });

  it('T7: an unusable without resetAt returns to unknown after the 60s default', () => {
    const { clock, now } = clockAt(1000);
    const state = createGptPoolState({ now });
    state.observe(parseBridgeContract(headers({ 'x-ombr-reset-at': undefined })), 529, 'gpt-6-astra');
    assert.equal(state.read().pool.state, 'unusable');

    clock.ms = 1000 + 59999;
    assert.equal(state.read().pool.state, 'unusable');
    clock.ms = 1000 + 60000;
    assert.equal(state.read().pool.state, 'unknown', '既定 TTL は 60,000ms（契約 §C10.3 T7）');
  });

  it('T7: unusableTtlMs is configurable and also expires the (pool, model) key', () => {
    const { clock, now } = clockAt(0);
    const state = createGptPoolState({ now, unusableTtlMs: 5000 });
    state.observe(
      parseBridgeContract({
        'x-ombr-contract': '1',
        'x-ombr-degrade-reason': 'codex_no_account_for_model',
        'x-ombr-degrade-scope': 'model',
        'x-ombr-pool-state': 'no-account-for-model',
      }),
      403,
      'gpt-6-astra',
    );
    assert.equal(state.read('gpt-6-astra').model.state, 'unusable');
    clock.ms = 5000;
    assert.equal(state.read('gpt-6-astra').model.state, 'unknown');
  });

  it('T8: bridge unreachable (no response at all) leaves both keys untouched', () => {
    const state = createGptPoolState({ now: () => 1000 });
    state.observe(parseBridgeContract(headers()), 529, 'gpt-6-astra');
    const result = state.observe(parseBridgeContract({}), null, 'gpt-6-astra');
    assert.equal(result.transition, null);
    assert.equal(state.read('gpt-6-astra').pool.state, 'unusable', '不達は GPT 側の情報を1ビットも与えない');
  });

  it('T9: a response without x-ombr-pool-state never teaches anything (HTTP 200 を含む)', () => {
    const state = createGptPoolState({ now: () => 1000 });
    for (const status of [200, 429, 529]) {
      const parsed = parseBridgeContract({ 'x-ombr-contract': '1', 'x-ombr-upstream-sent': 'yes' });
      const result = state.observe(parsed, status, 'gpt-6-astra');
      assert.equal(result.transition, null, String(status));
      assert.equal(state.read('gpt-6-astra').pool.state, 'unknown');
      assert.equal(state.read('gpt-6-astra').model.state, 'unknown');
    }
  });

  it('T10: scope=account (codex_account_exhausted) changes neither key', () => {
    const state = createGptPoolState({ now: () => 1000 });
    const result = state.observe(
      parseBridgeContract({
        'x-ombr-contract': '1',
        'x-ombr-degrade-reason': 'codex_account_exhausted',
        'x-ombr-degrade-scope': 'account',
        'x-ombr-pool-state': 'exhausted',
        'x-ombr-reset-at': RESET_AT,
      }),
      529,
      'gpt-6-astra',
    );
    assert.equal(result.transition, 'T10');
    assert.equal(state.read('gpt-6-astra').pool.state, 'unknown', '1口座の事情はプールの可否を意味しない');
    assert.equal(state.read('gpt-6-astra').model.state, 'unknown');
  });

  it('never moves to available on an error response (原則)', () => {
    const state = createGptPoolState({ now: () => 1000 });
    const parsed = parseBridgeContract({ 'x-ombr-contract': '1', 'x-ombr-pool-state': 'ok' });
    const result = state.observe(parsed, 529, 'gpt-6-astra');
    assert.equal(result.transition, null);
    assert.equal(state.read().pool.state, 'unknown');
  });

  it('learns nothing about (pool, model) when the model name is unknown', () => {
    const state = createGptPoolState({ now: () => 1000 });
    state.observe(
      parseBridgeContract({
        'x-ombr-contract': '1',
        'x-ombr-degrade-reason': 'codex_no_account_for_model',
        'x-ombr-degrade-scope': 'model',
        'x-ombr-pool-state': 'no-account-for-model',
      }),
      403,
    );
    assert.deepEqual(state.snapshot().models, {});
  });

  it('snapshot() exposes both keys without leaking internal references', () => {
    const state = createGptPoolState({ now: () => 1000 });
    state.observe(parseBridgeContract(headers()), 529, 'gpt-6-astra');
    const snapshot = state.snapshot();
    assert.equal(snapshot.pool.state, 'unusable');
    assert.equal(snapshot.pool.resetAt, RESET_AT);
    snapshot.pool.state = 'tampered';
    assert.equal(state.read().pool.state, 'unusable');
  });
});

// ---------------------------------------------------------------------------
// claudeAllUnusable（設計書 §4.2）
// ---------------------------------------------------------------------------

describe('claudeAllUnusable', () => {
  it('is true only when no account is available for the model family', () => {
    assert.equal(claudeAllUnusable(fakeAccountManager([false, false]), null), true);
  });

  it('does-not-map-one-account-throttle-with-available-peer', () => {
    assert.equal(claudeAllUnusable(fakeAccountManager([false, true]), null), false);
  });

  it('returns false when the ledger has no account at all (インストール直後)', () => {
    assert.equal(claudeAllUnusable(fakeAccountManager([]), null), false);
  });

  it('passes the model family through to isAvailable and tolerates a missing manager', () => {
    assert.equal(claudeAllUnusable(fakeAccountManager([false], 'opus'), 'opus'), true);
    assert.equal(claudeAllUnusable(null, null), false);
    assert.equal(claudeAllUnusable({}, null), false);
  });
});

// ---------------------------------------------------------------------------
// mapClaudeExhaustion（設計書 §4.2・§8.6・§8.7、契約 §C10.4）
// ---------------------------------------------------------------------------

function candidate429() {
  return {
    statusCode: 429,
    headers: { 'content-type': 'application/json', 'content-length': '999', 'content-encoding': 'gzip', 'x-keep': 'me' },
    body: Buffer.from(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'quota' } })),
  };
}

describe('mapClaudeExhaustion', () => {
  it('returns the very same object when degradeMapping is disabled', () => {
    const input = candidate429();
    const output = mapClaudeExhaustion(input, { enabled: false, claudeAllUnusable: true, gptPoolState: 'unusable', mapPath: 'a' });
    assert.equal(output, input, '無効時は現行と1バイトも変えない');
  });

  it('maps 429 to 529 overloaded_error while Claude is exhausted and GPT is unknown or available', () => {
    for (const gptPoolState of ['unknown', 'available']) {
      const output = mapClaudeExhaustion(candidate429(), {
        enabled: true, claudeAllUnusable: true, gptPoolState, mapPath: 'a',
      });
      assert.equal(output.statusCode, 529, gptPoolState);
      const body = JSON.parse(output.body.toString('utf8'));
      assert.equal(body.error.type, 'overloaded_error');
      assert.equal(output.degradeLog.mappedFrom, 429);
      assert.equal(output.degradeLog.mappedFromType, 'rate_limit_error');
      assert.equal(output.degradeLog.mappedTo, 529);
      assert.equal(output.degradeLog.mapReason, 'all_claude_accounts_exhausted');
      assert.equal(output.degradeLog.mapPath, 'a');
      assert.equal(output.degradeLog.claudePoolState, 'all-exhausted');
      assert.equal(output.degradeLog.gptPoolState, gptPoolState);
    }
  });

  it('maps 429 to 403 permission_error with the earliest recovery time when both pools are unusable', () => {
    const output = mapClaudeExhaustion(candidate429(), {
      enabled: true,
      claudeAllUnusable: true,
      gptPoolState: 'unusable',
      gptResetAt: LATER_RESET_AT,
      claudeResetAt: RESET_AT,
      mapPath: 'd',
    });
    assert.equal(output.statusCode, 403);
    const body = JSON.parse(output.body.toString('utf8'));
    assert.equal(body.error.type, 'permission_error');
    assert.equal(
      body.error.message,
      `All Claude accounts and the Codex pool are unavailable. Earliest recovery: ${RESET_AT}.`,
    );
    assert.equal(output.degradeLog.mapReason, 'both_pools_unusable');
    assert.equal(output.degradeLog.mapPath, 'd');
    // R4-5: 403 で止めた行から回復時刻を本文を開かずに読めるようにする（設計書 §9.3 resetAt）。
    assert.equal(output.degradeLog.resetAt, RESET_AT);
  });

  it('leaves resetAt out of the trace when only Claude is exhausted (529 は回復時刻を持たない)', () => {
    const output = mapClaudeExhaustion(candidate429(), {
      enabled: true,
      claudeAllUnusable: true,
      gptPoolState: 'unknown',
      claudeResetAt: RESET_AT,
      mapPath: 'a',
    });
    assert.equal(output.statusCode, 529);
    assert.equal(output.degradeLog.resetAt, undefined, '値の無いキーはログ行に出さない（§9.2）');
  });

  it('rewrites content-length, drops content-encoding and keeps the other headers', () => {
    const output = mapClaudeExhaustion(candidate429(), {
      enabled: true, claudeAllUnusable: true, gptPoolState: 'unknown', mapPath: 'b',
    });
    assert.equal(output.headers['content-length'], String(output.body.length));
    assert.equal('content-encoding' in output.headers, false);
    assert.equal(output.headers['content-type'], 'application/json');
    assert.equal(output.headers['x-keep'], 'me');
  });

  it('honours bothUnusableStatus=529 (止めずに待つ設定)', () => {
    const output = mapClaudeExhaustion(candidate429(), {
      enabled: true, claudeAllUnusable: true, gptPoolState: 'unusable', bothUnusableStatus: 529, mapPath: 'a',
    });
    assert.equal(output.statusCode, 529);
    assert.equal(JSON.parse(output.body.toString('utf8')).error.type, 'overloaded_error');
    assert.equal(output.degradeLog.mapReason, 'both_pools_unusable');
  });

  it('never maps when Claude still has an available account, when the status is not 429, or after headers were sent', () => {
    const base = { enabled: true, gptPoolState: 'unusable', mapPath: 'c' };
    const notExhausted = mapClaudeExhaustion(candidate429(), { ...base, claudeAllUnusable: false });
    assert.equal(notExhausted.statusCode, 429);
    assert.equal(notExhausted.degradeLog.mappedTo, undefined);
    assert.equal(notExhausted.degradeLog.mapPath, 'c', '写像しなくても痕跡は残す（契約 §C10.4 補足③）');

    for (const statusCode of [200, 503, 500]) {
      const other = mapClaudeExhaustion({ ...candidate429(), statusCode }, { ...base, claudeAllUnusable: true });
      assert.equal(other.statusCode, statusCode, String(statusCode));
      assert.equal(other.degradeLog.mappedTo, undefined);
    }

    const sent = mapClaudeExhaustion(candidate429(), { ...base, claudeAllUnusable: true, headersSent: true });
    assert.equal(sent.statusCode, 429, '応答ヘッダ送出後は書き換えられない');
  });

  it('tolerates a missing candidate and an unparsable body', () => {
    assert.equal(mapClaudeExhaustion(null, { enabled: true, claudeAllUnusable: true }), null);
    const output = mapClaudeExhaustion(
      { statusCode: 429, headers: {}, body: Buffer.from('<<not json>>') },
      { enabled: true, claudeAllUnusable: true, gptPoolState: 'unknown', mapPath: 'e' },
    );
    assert.equal(output.statusCode, 529);
    assert.equal(output.degradeLog.mappedFromType, undefined);
  });
});

// ---------------------------------------------------------------------------
// decideBridgeResponse（設計書 §8.7 の4条件）
// ---------------------------------------------------------------------------

function bridgeCtx(overrides = {}) {
  return { enabled: true, upstreamStatus: 529, claudeAllUnusable: true, gptPoolState: 'unusable', ...overrides };
}

describe('decideBridgeResponse (設計書 §8.7 の4条件)', () => {
  it('rewrites 529 to 403 only when all four conditions hold', () => {
    const decision = decideBridgeResponse(parseBridgeContract(headers()), bridgeCtx({ gptResetAt: RESET_AT }));
    assert.equal(decision.rewrite, true);
    assert.equal(decision.status, 403);
    const body = JSON.parse(decision.body);
    assert.equal(body.error.type, 'permission_error');
    assert.equal(body.error.message, `All Claude accounts and the Codex pool are unavailable. Earliest recovery: ${RESET_AT}.`);
    assert.equal(decision.meta.mappedFrom, 529);
    assert.equal(decision.meta.mappedTo, 403);
    assert.equal(decision.meta.mapReason, 'both_pools_unusable');
  });

  it('also rewrites when pool-state is mixed (境界の反対側)', () => {
    const parsed = parseBridgeContract(headers({ 'x-ombr-pool-state': 'mixed', 'x-ombr-degrade-reason': 'codex_pool_mixed' }));
    assert.equal(decideBridgeResponse(parsed, bridgeCtx()).rewrite, true);
  });

  it('does not rewrite when the current response is not a 529', () => {
    const decision = decideBridgeResponse(parseBridgeContract(headers()), bridgeCtx({ upstreamStatus: 403 }));
    assert.equal(decision.rewrite, false);
    assert.equal(decision.reason, 'status-not-529');
  });

  it('does not rewrite when pool-state is degraded, missing or unknown', () => {
    for (const overrides of [{ 'x-ombr-pool-state': 'degraded' }, { 'x-ombr-pool-state': undefined }, { 'x-ombr-pool-state': 'melted' }]) {
      const decision = decideBridgeResponse(parseBridgeContract(headers(overrides)), bridgeCtx());
      assert.equal(decision.rewrite, false, JSON.stringify(overrides));
      assert.equal(decision.reason, 'pool-state-not-exhausted-or-mixed');
    }
  });

  it('does not rewrite when scope is model, account or absent (不確かなら退避を試みる側へ倒す)', () => {
    for (const scope of ['model', 'account', undefined]) {
      const decision = decideBridgeResponse(parseBridgeContract(headers({ 'x-ombr-degrade-scope': scope })), bridgeCtx());
      assert.equal(decision.rewrite, false, String(scope));
      assert.equal(decision.reason, 'scope-not-explicit-pool');
    }
  });

  it('does not rewrite while any Claude account is still usable', () => {
    const decision = decideBridgeResponse(parseBridgeContract(headers()), bridgeCtx({ claudeAllUnusable: false }));
    assert.equal(decision.rewrite, false);
    assert.equal(decision.reason, 'claude-not-exhausted');
  });

  it('does not rewrite while the learned (pool) key is unknown or available', () => {
    for (const gptPoolState of ['unknown', 'available']) {
      const decision = decideBridgeResponse(parseBridgeContract(headers()), bridgeCtx({ gptPoolState }));
      assert.equal(decision.rewrite, false, gptPoolState);
      assert.equal(decision.reason, 'gpt-pool-not-unusable');
    }
  });

  it('does not rewrite when degradeMapping is disabled or bothUnusableStatus is 529', () => {
    assert.equal(decideBridgeResponse(parseBridgeContract(headers()), bridgeCtx({ enabled: false })).rewrite, false);
    const kept = decideBridgeResponse(parseBridgeContract(headers()), bridgeCtx({ bothUnusableStatus: 529 }));
    assert.equal(kept.rewrite, false);
    assert.equal(kept.reason, 'both-unusable-status-is-not-403');
  });

  it('does not rewrite a 529 whose reason carries no pool-state (例: codex_upstream_overloaded)', () => {
    // 設計書 §8.7 条件①: 過去に学習した (pool)=unusable だけを根拠に書き換えない。
    const parsed = parseBridgeContract({
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_upstream_overloaded',
      'x-ombr-degrade-scope': 'pool',
    });
    const decision = decideBridgeResponse(parsed, bridgeCtx());
    assert.equal(decision.rewrite, false);
    assert.equal(decision.reason, 'pool-state-not-exhausted-or-mixed');
  });

  it('tolerates a null contract (x-ombr-* が1つも無い応答)', () => {
    const decision = decideBridgeResponse(parseBridgeContract({}), bridgeCtx());
    assert.equal(decision.rewrite, false);
  });
});

// ---------------------------------------------------------------------------
// buildDegradeBody
// ---------------------------------------------------------------------------

describe('buildDegradeBody', () => {
  it('omits the recovery sentence when no reset time is known', () => {
    const body = JSON.parse(buildDegradeBody(403, {}));
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'permission_error');
    assert.equal(body.error.message, 'All Claude accounts and the Codex pool are unavailable.');
  });

  it('picks the earliest valid RFC3339 reset time and ignores malformed ones', () => {
    const body = JSON.parse(buildDegradeBody(529, { resetAts: ['not-a-time', LATER_RESET_AT, RESET_AT] }));
    assert.equal(body.error.type, 'overloaded_error');
    assert.equal(body.error.message, `All Claude accounts are exhausted. Earliest recovery: ${RESET_AT}.`);
  });
});

// ---------------------------------------------------------------------------
// buildBridgeLogMeta / formatLogMeta（設計書 §9.3）
// ---------------------------------------------------------------------------

describe('buildBridgeLogMeta', () => {
  it('emits every documented field in the documented order', () => {
    const parsed = parseBridgeContract(headers({
      'x-ombr-cached': 'no',
      'x-ombr-account': 'pro-b',
      'x-ombr-primary-used-percent': '97.0',
    }));
    const meta = buildBridgeLogMeta(parsed, {
      gptPoolState: 'unusable', gptModelState: 'unknown', claudePoolState: 'all-exhausted',
      mappedFrom: 529, mappedFromType: 'overloaded_error', mappedTo: 403,
      mapReason: 'both_pools_unusable', mapPath: 'a',
    });
    assert.deepEqual(Object.keys(meta), [
      'bridgeContract', 'degradeReason', 'poolState', 'degradeScope',
      'upstreamStatus', 'upstreamSent', 'bridgeCached', 'accountLabel', 'resetAt',
      'primaryUsedPercent', 'gptPoolState', 'gptModelState', 'claudePoolState',
      'mappedFrom', 'mappedFromType', 'mappedTo', 'mapReason', 'mapPath',
    ]);
    assert.equal(meta.degradeScope, 'pool', 'degradeScope は rawScope を書く（設計書 §9.3）');
    assert.equal(meta.accountLabel, 'pro-b');
  });

  it('produces an empty object (and an empty suffix) when the bridge sent no x-ombr-* header', () => {
    const meta = buildBridgeLogMeta(parseBridgeContract({ 'content-type': 'application/json' }), {});
    assert.deepEqual(meta, {});
    assert.equal(formatLogMeta(meta), '', '値が1つも無ければログ行は現行とバイト単位で同一になる');
  });

  it('writes <invalid> instead of an email-shaped account label', () => {
    const meta = buildBridgeLogMeta(parseBridgeContract({ 'x-ombr-account': 'user-a@example.com' }), {});
    assert.equal(meta.accountLabel, '<invalid>');
  });

  it('never emits a value containing whitespace (ログ行は空白区切りの key=value)', () => {
    const meta = buildBridgeLogMeta(parseBridgeContract({ 'x-ombr-degrade-reason': 'weird reason\nwith breaks' }), {
      mapReason: 'both pools\nunusable',
    });
    assert.equal(meta.degradeReason, 'unknown', '列挙値以外の reason は原文を残さない（指摘4）');
    assert.equal(formatLogMeta(meta), ' degradeReason=unknown mapReason=both_pools_unusable');
  });

  it('formats key=value pairs with a single leading space', () => {
    assert.equal(formatLogMeta({ upstreamStatus: 429, upstreamSent: 'yes' }), ' upstreamStatus=429 upstreamSent=yes');
    assert.equal(formatLogMeta(null), '');
  });
});

// ---------------------------------------------------------------------------
// astra-reviewer 指摘1〜4 の回帰（2026-09-08）
// 契約 §C3.2（値域）・§C3.7（契約前 bridge）・§C10.3（学習対象）に合わせる。
// ---------------------------------------------------------------------------

function withoutContract(source) {
  const next = { ...source };
  delete next['x-ombr-contract'];
  return next;
}

describe('指摘1: x-ombr-contract の無い応答からは学習しない（契約 §C3.7-1）', () => {
  it('契約前 bridge の 429/529/403 を何度観測しても両鍵とも unknown のまま', () => {
    const state = createGptPoolState({ now: () => 1000 });
    const parsed = parseBridgeContract(withoutContract(headers()));
    assert.equal(parsed.contract, null);
    assert.equal(parsed.poolState, 'exhausted', 'ヘッダ自体は解釈する（無視するのは学習だけ）');

    for (const status of [429, 529, 403, 500, 503]) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = state.observe(parsed, status, 'gpt-6-astra');
        assert.equal(result.transition, null, `${status} #${attempt}`);
      }
    }
    const view = state.read('gpt-6-astra');
    assert.equal(view.pool.state, 'unknown', '契約前 bridge から (pool) を学習しない');
    assert.equal(view.model.state, 'unknown');
  });

  it('契約前 bridge の HTTP 200 でも available へ動かさず、(pool, model) の鍵も作らない', () => {
    const state = createGptPoolState({ now: () => 1000 });
    const result = state.observe(
      parseBridgeContract({ 'x-ombr-pool-state': 'ok' }),
      200,
      'gpt-6-astra',
    );
    assert.equal(result.transition, null);
    assert.equal(state.read().pool.state, 'unknown');
    assert.deepEqual(state.snapshot().models, {}, '観測しただけでモデル鍵を作らない');
  });

  it('学習済みの unusable は契約前 bridge の応答で解除も延命もされない', () => {
    const { clock, now } = clockAt(1000);
    const state = createGptPoolState({ now, unusableTtlMs: 60000 });
    state.observe(parseBridgeContract(headers({ 'x-ombr-reset-at': undefined })), 529, 'gpt-6-astra');
    const before = state.read().pool;
    assert.equal(before.state, 'unusable');

    clock.ms = 1000 + 30000;
    state.observe(parseBridgeContract(withoutContract(headers({ 'x-ombr-pool-state': 'ok' }))), 200, 'gpt-6-astra');
    const middle = state.read().pool;
    assert.equal(middle.state, 'unusable', '契約前 bridge の 200 では解除しない');
    assert.equal(middle.learnedAt, before.learnedAt, '延命もしない');

    clock.ms = 1000 + 60000;
    assert.equal(state.read().pool.state, 'unknown', 'TTL による解除（T7）は従来どおり効く');
  });

  it('null / 非オブジェクトの解析結果でも例外にならない', () => {
    const state = createGptPoolState({ now: () => 1000 });
    assert.equal(state.observe(null, 529, 'gpt-6-astra').transition, null);
    assert.equal(state.observe(undefined, 529, 'gpt-6-astra').transition, null);
    assert.deepEqual(state.snapshot().models, {});
  });
});

describe('指摘2: 学習対象は 4xx/5xx と HTTP 200 だけ（契約 §C10.3 T2・T8・T9）', () => {
  it('201・302・null・非整数のステータスからは枯渇を学習しない', () => {
    for (const status of [201, 204, 302, 304, null, undefined, '429', 429.5, NaN]) {
      const state = createGptPoolState({ now: () => 1000 });
      const result = state.observe(parseBridgeContract(headers()), status, 'gpt-6-astra');
      assert.equal(result.transition, null, String(status));
      assert.equal(state.read('gpt-6-astra').pool.state, 'unknown', String(status));
    }
  });

  it('200 以外の 2xx は available にもしない（契約 T2 は HTTP 200 に限定）', () => {
    for (const status of [201, 202, 204]) {
      const state = createGptPoolState({ now: () => 1000 });
      const parsed = parseBridgeContract({ 'x-ombr-contract': '1', 'x-ombr-pool-state': 'ok' });
      assert.equal(state.observe(parsed, status, 'gpt-6-astra').transition, null, String(status));
      assert.equal(state.read('gpt-6-astra').pool.state, 'unknown', String(status));
    }
  });

  it('4xx/5xx の境界（400・499・500・599）は従来どおり学習する', () => {
    for (const status of [400, 403, 429, 499, 500, 529, 599]) {
      const state = createGptPoolState({ now: () => 1000 });
      const result = state.observe(parseBridgeContract(headers()), status, 'gpt-6-astra');
      assert.equal(result.transition, 'T3', String(status));
      assert.equal(state.read().pool.state, 'unusable', String(status));
    }
  });

  it('600 以上・399 以下のエラーでない応答は無視する', () => {
    for (const status of [100, 399, 600, 999]) {
      const state = createGptPoolState({ now: () => 1000 });
      assert.equal(state.observe(parseBridgeContract(headers()), status, 'gpt-6-astra').transition, null, String(status));
      assert.equal(state.read().pool.state, 'unknown', String(status));
    }
  });
});

describe('指摘3: 値域検証（契約 §C3.2）', () => {
  it('実在しない日付の reset-at を受理しない（Date.parse の繰り上げに頼らない）', () => {
    const invalid = [
      '2028-02-30T00:00:00Z', // 繰り上げで 3/1 になる
      '2026-02-29T00:00:00Z', // 2026 は閏年ではない
      '2026-04-31T00:00:00Z',
      '2026-00-08T13:00:00Z',
      '2026-13-08T13:00:00Z',
      '2026-09-00T13:00:00Z',
      '2026-09-08T24:00:00Z',
      '2026-09-08T13:60:00Z',
      '2026-09-08T13:00:60Z',
      '2026-09-08T13:00:00+09:00', // UTC 表記のみ
      '2026-09-08 13:00:00Z',
      '20260908T130000Z',
    ];
    for (const value of invalid) {
      assert.equal(parseBridgeContract({ 'x-ombr-reset-at': value }).resetAt, null, value);
    }
  });

  it('実在する日付は受理する（閏日・小数秒を含む）', () => {
    for (const value of ['2026-09-08T13:00:00Z', '2028-02-29T00:00:00Z', '2026-12-31T23:59:59Z', '2026-09-08T13:00:00.500Z']) {
      assert.equal(parseBridgeContract({ 'x-ombr-reset-at': value }).resetAt, value, value);
    }
  });

  it('不正な reset-at を持つ枯渇は resetAt=null として TTL(60秒) で解除される', () => {
    // 指摘3 の実害: 2028-02-30 を受理すると 60 秒後も枯渇が残り、GPT への退避を塞ぎ続ける。
    const { clock, now } = clockAt(1000);
    const state = createGptPoolState({ now, unusableTtlMs: 60000 });
    state.observe(parseBridgeContract(headers({ 'x-ombr-reset-at': '2028-02-30T00:00:00Z' })), 529, 'gpt-6-astra');
    const view = state.read().pool;
    assert.equal(view.state, 'unusable');
    assert.equal(view.resetAt, null, '不正な日付は保持しない');

    clock.ms = 1000 + 60000;
    assert.equal(state.read().pool.state, 'unknown', 'TTL で解除される（枯渇が残り続けない）');
  });

  it('x-ombr-contract は10進整数だけを受理する（16進・指数・小数を弾く）', () => {
    for (const value of ['0x10', '1e3', '1.0', '+1', '-1', '0', ' ', 'Infinity', '1_000']) {
      assert.equal(parseBridgeContract({ 'x-ombr-contract': value }).contract, null, value);
    }
    assert.equal(parseBridgeContract({ 'x-ombr-contract': '1' }).contract, 1);
    assert.equal(parseBridgeContract({ 'x-ombr-contract': '42' }).contract, 42);
  });

  it('x-ombr-upstream-status は3桁10進の 100〜599 と none だけを受理する', () => {
    for (const value of ['0x1F4', '1e2', '4.29', '99', '600', '999', '-429', '429.0', 'None']) {
      assert.equal(parseBridgeContract({ 'x-ombr-upstream-status': value }).upstreamStatus, null, value);
    }
    assert.equal(parseBridgeContract({ 'x-ombr-upstream-status': '100' }).upstreamStatus, 100);
    assert.equal(parseBridgeContract({ 'x-ombr-upstream-status': '599' }).upstreamStatus, 599);
    assert.equal(parseBridgeContract({ 'x-ombr-upstream-status': 'none' }).upstreamStatus, 'none');
  });

  it('used-percent は 0〜100・小数第1位までだけを受理する（契約 §C3.2）', () => {
    for (const value of ['12.34', '1e2', '0x10', '-1', '101', '100.1', '.5', '5.', '97,5']) {
      assert.equal(parseBridgeContract({ 'x-ombr-primary-used-percent': value }).primaryUsedPercent, null, value);
    }
    assert.equal(parseBridgeContract({ 'x-ombr-primary-used-percent': '0' }).primaryUsedPercent, 0);
    assert.equal(parseBridgeContract({ 'x-ombr-primary-used-percent': '97.5' }).primaryUsedPercent, 97.5);
    assert.equal(parseBridgeContract({ 'x-ombr-secondary-used-percent': '100.0' }).secondaryUsedPercent, 100);
  });
});

describe('指摘4: degrade-reason は列挙値だけを受理する（識別子の混入を遮断）', () => {
  const DOCUMENTED_REASONS = [
    'codex_pool_exhausted', 'codex_account_exhausted', 'codex_attempt_limit',
    'codex_needs_login', 'codex_pool_mixed', 'codex_no_account_for_model',
    'codex_upstream_overloaded', 'codex_upstream_error', 'codex_upstream_unreachable',
    'codex_upstream_timeout', 'bridge_internal_error', 'request_invalid', 'request_too_large',
  ];

  it('契約 §C3.4 の列挙値はそのまま通す', () => {
    for (const reason of DOCUMENTED_REASONS) {
      assert.equal(parseBridgeContract({ 'x-ombr-degrade-reason': reason }).reason, reason, reason);
    }
  });

  it('列挙値以外は unknown へ正規化し、元の文字列をどこにも残さない', () => {
    const leaked = 'user-a@example.com';
    const parsed = parseBridgeContract({ 'x-ombr-contract': '1', 'x-ombr-degrade-reason': leaked });
    assert.equal(parsed.reason, 'unknown');
    assert.equal(JSON.stringify(parsed).includes(leaked), false, '解析結果に識別子を持ち回らない');

    const meta = buildBridgeLogMeta(parsed, {});
    assert.equal(meta.degradeReason, 'unknown');
    assert.equal(formatLogMeta(meta).includes(leaked), false, 'ログ行にも出さない');
  });

  it('unusable として保持する reason も正規化後の値になる', () => {
    const state = createGptPoolState({ now: () => 1000 });
    state.observe(
      parseBridgeContract(headers({ 'x-ombr-degrade-reason': 'quota exhausted for sakane@example.com' })),
      529,
      'gpt-6-astra',
    );
    const view = state.read().pool;
    assert.equal(view.state, 'unusable', 'scope=pool ヘッダがあるので学習自体は起きる');
    assert.equal(view.reason, 'unknown');
  });

  it('reason が無ければ null のまま（既定 scope は model へ倒す）', () => {
    const parsed = parseBridgeContract({ 'x-ombr-contract': '1' });
    assert.equal(parsed.reason, null);
    assert.equal(parsed.effectiveScope, 'model');
  });
});

// ---------------------------------------------------------------------------
// R4-1 の付随修正: read() は観測していないモデル鍵を作らない（non_blocking 改善）
//
// read(model) は毎要求のログ組み立て（src/openai-bridge.js の poolStateFields）から
// 呼ばれる。ここでエントリを作ると、bridge へ投げたモデル名の分だけ Map が単調に
// 増え続け、snapshot() にも「一度も観測していないモデル」が unknown として並ぶ。
// エントリを作ってよいのは observe()（＝実際に bridge から学習したとき）だけである。
// ---------------------------------------------------------------------------
describe('createGptPoolState > read() は観測していないモデル鍵を作らない (R4-1 付随)', () => {
  it('does not add an entry to snapshot() for a model that was only read', () => {
    const state = createGptPoolState({ now: () => 1000 });

    const view = state.read('gpt-6-astra');
    assert.equal(view.model.state, 'unknown', '未観測のモデルは unknown を返す（戻り値は変わらない）');
    assert.deepEqual(state.snapshot().models, {}, 'read() だけではモデル鍵を作らない');

    // 読み取りを何度繰り返しても増えない（毎要求 read() される経路の保護）。
    for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'o3-mini']) state.read(model);
    assert.deepEqual(state.snapshot().models, {});

    // observe() だけがエントリを作る。
    state.observe(
      parseBridgeContract({
        'x-ombr-contract': '1',
        'x-ombr-degrade-reason': 'codex_no_account_for_model',
        'x-ombr-degrade-scope': 'model',
        'x-ombr-pool-state': 'no-account-for-model',
      }),
      403,
      'gpt-6-astra',
    );
    assert.deepEqual(Object.keys(state.snapshot().models), ['gpt-6-astra']);
    assert.equal(state.read('gpt-6-astra').model.state, 'unusable');
  });
});

// ---------------------------------------------------------------------------
// 契約 v1.5（project-d5 提案 C-20260908-D5-03・当方 ACK）:
// 新しい reason `codex_credentials_unavailable` と pool-state `credentials-unavailable`。
// rotator の扱いは `codex_needs_login` と**完全に同一**にする（403 を素通しし、
// (pool) は利用不可として学習する＝設計書 §8.8。403 書換の根拠にはしない）。
// ---------------------------------------------------------------------------
describe('契約 v1.5 > codex_credentials_unavailable は codex_needs_login と同一に扱う', () => {
  const v15Headers = reason => ({
    'x-ombr-contract': '1',
    'x-ombr-degrade-reason': reason,
    'x-ombr-degrade-scope': 'pool',
    'x-ombr-pool-state': reason === 'codex_needs_login' ? 'needs-login' : 'credentials-unavailable',
    'x-ombr-upstream-status': 'none',
    'x-ombr-upstream-sent': 'no',
  });

  it('accepts the new enum values and behaves exactly like needs-login', () => {
    const parsed = parseBridgeContract(v15Headers('codex_credentials_unavailable'));
    assert.equal(parsed.reason, 'codex_credentials_unavailable', '列挙外へ丸めない（unknown にしない）');
    assert.equal(parsed.poolState, 'credentials-unavailable', 'pool-state も受理する');
    assert.equal(parsed.rawScope, 'pool');

    // 学習は needs-login と同じ（T3: (pool) を利用不可にする）。
    const state = createGptPoolState({ now: () => 1000 });
    const result = state.observe(parsed, 403, 'gpt-6-astra');
    assert.equal(result.transition, 'T3');
    assert.equal(state.read().pool.state, 'unusable');
    assert.equal(state.read().pool.reason, 'codex_credentials_unavailable');

    // 403 の書換は起きない（元から 403 であり、pool-state も書換の対象2値ではない）。
    assert.deepEqual(
      decideBridgeResponse(parsed, {
        enabled: true, upstreamStatus: 403, claudeAllUnusable: true,
        gptPoolState: 'unusable', bothUnusableStatus: 403,
      }),
      { rewrite: false, reason: 'status-not-529' },
    );

    // reason だけが違う同型の応答（needs-login）と、学習の結果が一致すること。
    const loginState = createGptPoolState({ now: () => 1000 });
    loginState.observe(parseBridgeContract(v15Headers('codex_needs_login')), 403, 'gpt-6-astra');
    assert.equal(loginState.read().pool.state, state.read().pool.state);
  });

  it('derives scope=pool from the reason even without an explicit x-ombr-degrade-scope', () => {
    const parsed = parseBridgeContract({
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_credentials_unavailable',
      'x-ombr-pool-state': 'credentials-unavailable',
    });
    assert.equal(parsed.rawScope, null);
    assert.equal(parsed.effectiveScope, 'pool', 'codex_needs_login と同じ既定 scope');
  });
});

// ---------------------------------------------------------------------------
// R4-1 再検証①: 契約ヘッダを持たない応答は 403 へ書き換えない（契約 §C3.7-1）
// ---------------------------------------------------------------------------
describe('decideBridgeResponse > x-ombr-contract が無ければ書き換えない (R4-1 再検証①)', () => {
  const rewritable = {
    enabled: true, upstreamStatus: 529, claudeAllUnusable: true,
    gptPoolState: 'unusable', bothUnusableStatus: 403,
  };

  it('requires a valid x-ombr-contract before rewriting', () => {
    // 4条件をすべて満たす応答（契約ヘッダあり）は書き換える。
    const withContract = parseBridgeContract({
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_pool_exhausted',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'exhausted',
    });
    assert.equal(decideBridgeResponse(withContract, rewritable).rewrite, true, 'precondition');

    // x-ombr-contract だけを落とす／壊すと、他が同じでも書き換えない。
    for (const contract of [undefined, 'abc', '0', '-1', '1e3']) {
      const parsed = parseBridgeContract({
        ...(contract === undefined ? {} : { 'x-ombr-contract': contract }),
        'x-ombr-degrade-reason': 'codex_pool_exhausted',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'exhausted',
      });
      assert.deepEqual(
        decideBridgeResponse(parsed, rewritable),
        { rewrite: false, reason: 'no-contract-header' },
        `x-ombr-contract=${String(contract)}`,
      );
    }
    assert.deepEqual(decideBridgeResponse(null, rewritable), { rewrite: false, reason: 'no-contract-header' });
  });
});

// ---------------------------------------------------------------------------
// R4-1 再検証②: 403 本文の最早回復時刻に Claude 側を含める
// ---------------------------------------------------------------------------
describe('claudeEarliestResetAt (R4-1 再検証②)', () => {
  const managerWith = entries => ({ getRoutingAvailability: () => entries });

  it('returns the earliest availableAt across the ledger', () => {
    assert.equal(
      claudeEarliestResetAt(managerWith([
        { state: 'waiting', availableAt: '2026-09-08T14:00:00.000Z' },
        { state: 'waiting', availableAt: '2026-09-08T13:00:00.000Z' },
        { state: 'unknown', availableAt: null },
      ])),
      '2026-09-08T13:00:00.000Z',
    );
  });

  it('returns null when no account reports a usable recovery time', () => {
    assert.equal(claudeEarliestResetAt(managerWith([{ state: 'unknown', availableAt: null }])), null);
    assert.equal(claudeEarliestResetAt(managerWith([{ availableAt: 'not-a-time' }])), null);
    assert.equal(claudeEarliestResetAt(managerWith([])), null);
    assert.equal(claudeEarliestResetAt(null), null, '台帳が無い呼び出しでも投げない');
    assert.equal(claudeEarliestResetAt({}), null);
  });

  it('feeds buildDegradeBody so the earlier of the two pools is shown', () => {
    assert.match(
      buildDegradeBody(403, { resetAts: ['2099-01-01T00:00:00Z', '2026-09-08T13:00:00Z'] }),
      /Earliest recovery: 2026-09-08T13:00:00Z\./,
    );
  });
});
