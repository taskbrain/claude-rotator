import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  CONTRACT_VERSION,
  DEFAULT_ACCOUNT_LABEL,
  MODE_NAMES,
  buildErrorBody,
  buildOmbrHeaders,
  defaultResetAt,
  normalizeOptions,
  parseArgs,
  startFakeBridge,
} from './fake-bridge.js';

// 偽 bridge（test/helpers/fake-bridge.js）が、契約 v1.4 §C3/§C4/§D2 の
// 「状態ごとの status ／ error.type ／ x-ombr-* の組」を実 TCP で返すことを固定する。
// ここで検証しているのは偽 bridge 自身の応答であって、rotator の写像ではない。
// rotator 側の写像は R4-1 の統合テストが本ファイルを require して確認する。

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 偽 bridge を起動して fn を実行し、必ず後始末する。 */
async function withBridge(options, fn) {
  const bridge = await startFakeBridge(options);
  try {
    return await fn(bridge);
  } finally {
    await bridge.close();
  }
}

/** JSON 応答を返すモード向け。fetch で1リクエストする。 */
async function postJson(bridge, body = '{"model":"gpt-6-astra","max_tokens":1,"messages":[]}') {
  const response = await fetch(`${bridge.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const text = await response.text();
  return { response, text };
}

/** SSE を段階的に読むため、生の http.request でリクエストする。 */
function postRaw(bridge, body = '{"model":"gpt-6-astra","stream":true}') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: bridge.port,
        path: '/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      res => resolve({ req, res }),
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// 引数とオプションの正規化
// ---------------------------------------------------------------------------

describe('fake-bridge argument handling', () => {
  it('parses --key value and --key=value', () => {
    assert.deepEqual(parseArgs(['--port', '18799', '--mode', 'exhausted']), { port: '18799', mode: 'exhausted' });
    assert.deepEqual(parseArgs(['--port=18799', '--mode=mixed']), { port: '18799', mode: 'mixed' });
  });

  it('rejects unknown arguments and missing values', () => {
    assert.throws(() => parseArgs(['--bogus', '1']), /unknown argument/);
    assert.throws(() => parseArgs(['--port']), /--port requires a value/);
    assert.throws(() => parseArgs(['--port', '--mode', 'ok']), /--port requires a value/);
  });

  it('rejects unknown modes, bad ports, bad account labels and bad reset-at values', () => {
    assert.throws(() => normalizeOptions({ port: 0, mode: 'nope' }), /unknown mode/);
    assert.throws(() => normalizeOptions({ port: 70000 }), /--port must be an integer/);
    assert.throws(() => normalizeOptions({ port: 0, account: 'user@example.com' }), /--account must match/);
    assert.throws(() => normalizeOptions({ port: 0, account: 'Acct-A' }), /--account must match/);
    assert.throws(() => normalizeOptions({ port: 0, resetAt: '2026-09-08 13:00:00' }), /--reset-at must be RFC3339/);
  });

  it('defaults the account label and the reset-at offset', () => {
    const options = normalizeOptions({ port: 0 });
    assert.equal(options.account, DEFAULT_ACCOUNT_LABEL);
    assert.equal(options.mode, 'ok');
    assert.match(options.resetAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(defaultResetAt(Date.parse('2026-09-08T12:59:00Z')), '2026-09-08T13:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// 契約 §D2 / §C3: 状態ごとの status ・ error.type ・ x-ombr-* の組
// ---------------------------------------------------------------------------

// 期待値の表。契約 v1.4 §C3.4（reason の列挙と推奨ステータス）と §D2（S5b・S6・S7b・S8・S9）に対応する。
const EXPECTED = [
  {
    mode: 'exhausted',
    status: 529,
    errorType: 'overloaded_error',
    headers: {
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_pool_exhausted',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'exhausted',
      'x-ombr-upstream-status': '429',
      'x-ombr-upstream-sent': 'yes',
      'x-ombr-account': DEFAULT_ACCOUNT_LABEL,
    },
    resetAt: true,
  },
  {
    mode: 'mixed',
    status: 529,
    errorType: 'overloaded_error',
    headers: {
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_pool_mixed',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'mixed',
      'x-ombr-upstream-status': '429',
      'x-ombr-upstream-sent': 'yes',
      'x-ombr-account': DEFAULT_ACCOUNT_LABEL,
    },
    resetAt: true,
  },
  {
    mode: 'attempt-limit',
    status: 529,
    errorType: 'overloaded_error',
    headers: {
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_attempt_limit',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'degraded',
      'x-ombr-upstream-status': '429',
      'x-ombr-upstream-sent': 'yes',
      'x-ombr-account': DEFAULT_ACCOUNT_LABEL,
    },
    resetAt: false,
  },
  {
    mode: 'needs-login',
    status: 403,
    errorType: 'permission_error',
    headers: {
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_needs_login',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'needs-login',
      'x-ombr-upstream-status': 'none',
      'x-ombr-upstream-sent': 'no',
    },
    resetAt: false,
    bodyMatch: /codex login required/,
  },
  {
    mode: 'no-account',
    status: 403,
    errorType: 'permission_error',
    headers: {
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_no_account_for_model',
      'x-ombr-degrade-scope': 'model',
      'x-ombr-pool-state': 'no-account-for-model',
      'x-ombr-upstream-status': 'none',
      'x-ombr-upstream-sent': 'no',
    },
    resetAt: false,
  },
];

describe('fake-bridge degraded modes', () => {
  for (const expected of EXPECTED) {
    it(`--mode ${expected.mode} answers ${expected.status} ${expected.errorType} with the contracted headers`, async () => {
      await withBridge({ port: 0, mode: expected.mode, resetAt: '2026-09-08T13:00:00Z' }, async bridge => {
        const { response, text } = await postJson(bridge);
        assert.equal(response.status, expected.status, text);
        const parsed = JSON.parse(text);
        assert.equal(parsed.type, 'error');
        assert.equal(parsed.error.type, expected.errorType);
        if (expected.bodyMatch) assert.match(parsed.error.message, expected.bodyMatch);

        for (const [name, value] of Object.entries(expected.headers)) {
          assert.equal(response.headers.get(name), value, `${expected.mode}: ${name}`);
        }
        assert.equal(
          response.headers.get('x-ombr-reset-at'),
          expected.resetAt ? '2026-09-08T13:00:00Z' : null,
          `${expected.mode}: x-ombr-reset-at`,
        );
        // 上流へ送っていないモードでは「実際に使ったアカウント」が存在しない（§C3.2）。
        if (!('x-ombr-account' in expected.headers)) {
          assert.equal(response.headers.get('x-ombr-account'), null, `${expected.mode}: x-ombr-account`);
        }
        // Content-Length を明示している（chunked にしない）。設計書 §11.4 (3) が
        // 529 の本文長と 403 書換後の本文長の一致を確認するのに要る。
        assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
      });
    });
  }

  it('carries the --account label on modes where an account was actually used', async () => {
    await withBridge({ port: 0, mode: 'exhausted', account: 'acct-b' }, async bridge => {
      const { response } = await postJson(bridge);
      assert.equal(response.headers.get('x-ombr-account'), 'acct-b');
    });
  });

  it('defaults --reset-at to a future timestamp', async () => {
    await withBridge({ port: 0, mode: 'exhausted' }, async bridge => {
      const { response } = await postJson(bridge);
      const resetAt = response.headers.get('x-ombr-reset-at');
      assert.match(resetAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.ok(Date.parse(resetAt) > Date.now(), `${resetAt} should be in the future`);
    });
  });
});

// ---------------------------------------------------------------------------
// 契約 §C3.7-1: 契約前 bridge の再現
// ---------------------------------------------------------------------------

describe('fake-bridge legacy mode', () => {
  it('answers 429 rate_limit_error with no x-ombr-* header at all', async () => {
    await withBridge({ port: 0, mode: 'legacy' }, async bridge => {
      const { response, text } = await postJson(bridge);
      assert.equal(response.status, 429, text);
      assert.equal(JSON.parse(text).error.type, 'rate_limit_error');
      const ombr = [...response.headers.keys()].filter(name => name.startsWith('x-ombr-'));
      assert.deepEqual(ombr, [], `legacy mode must not send contract headers, saw: ${ombr.join(', ')}`);
    });
  });
});

// ---------------------------------------------------------------------------
// 契約 §C4: 200 の SSE と開始マーカー
// ---------------------------------------------------------------------------

describe('fake-bridge streaming modes', () => {
  it('--mode ok streams the start marker and terminates', async () => {
    await withBridge({ port: 0, mode: 'ok' }, async bridge => {
      const { response, text } = await postJson(bridge, '{"model":"gpt-6-astra","stream":true}');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      assert.equal(response.headers.get('x-ombr-contract'), String(CONTRACT_VERSION));
      assert.equal(response.headers.get('x-ombr-pool-state'), 'ok');
      assert.equal(response.headers.get('x-ombr-upstream-status'), '200');
      assert.equal(response.headers.get('x-ombr-upstream-sent'), 'yes');
      assert.equal(response.headers.get('x-ombr-degrade-reason'), null, '成功応答に degrade-reason は付けない');
      assert.match(text, /message_start/);
      assert.match(text, /message_stop/);
      assert.ok(text.indexOf('message_start') < text.indexOf('message_stop'));
    });
  });

  it('--mode idle sends the start marker and then stays silent', async () => {
    await withBridge({ port: 0, mode: 'idle' }, async bridge => {
      const { res } = await postRaw(bridge);
      res.on('error', () => {}); // close() でソケットを切るため
      let received = '';
      res.on('data', chunk => { received += chunk.toString('utf8'); });

      // 開始マーカーは届く（契約 §C4 の義務2）。
      await delay(120);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-ombr-pool-state'], 'ok');
      assert.match(received, /message_start/, '開始マーカーが届いていない');
      const afterMarker = received;

      // その後は無音のまま（アイドルタイムアウトの再現）。300ms は「短い注入値」。
      await delay(300);
      assert.equal(received, afterMarker, `開始マーカーの後にバイトが届いた: ${JSON.stringify(received.slice(afterMarker.length))}`);
      assert.equal(res.complete, false, 'ストリームはまだ終端していない');
    });
  });

  it('--mode stream-error sends the start marker and then destroys the socket', async () => {
    await withBridge({ port: 0, mode: 'stream-error' }, async bridge => {
      const { res } = await postRaw(bridge);
      let received = '';
      res.on('data', chunk => { received += chunk.toString('utf8'); });

      const outcome = await new Promise(resolve => {
        res.on('error', error => resolve({ kind: 'error', code: error.code }));
        res.on('aborted', () => resolve({ kind: 'aborted' }));
        res.on('end', () => resolve({ kind: 'end' }));
      });

      assert.equal(res.statusCode, 200);
      assert.match(received, /message_start/, '開始マーカーが届いていない');
      assert.notEqual(outcome.kind, 'end', `正常終端ではなく異常終了になること: ${JSON.stringify(outcome)}`);
      assert.equal(res.complete, false, '本文が最後まで届いていないこと');
    });
  });
});

// ---------------------------------------------------------------------------
// 設計書 §11.4 (1): 不達
// ---------------------------------------------------------------------------

describe('fake-bridge unreachable mode', () => {
  it('does not listen and does not occupy --port', async () => {
    // 空きポートを1つ確保してから解放し、そのポートで unreachable を起動する。
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const freePort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));

    const bridge = await startFakeBridge({ port: freePort, mode: 'unreachable' });
    try {
      assert.equal(bridge.listening, false);
      assert.equal(bridge.port, freePort);
      await assert.rejects(
        fetch(`${bridge.url}/v1/messages`, { method: 'POST', body: '{}' }),
        error => {
          assert.ok(error instanceof Error);
          return true;
        },
        '接続は拒否されること',
      );
    } finally {
      await bridge.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /healthz
// ---------------------------------------------------------------------------

describe('fake-bridge /healthz', () => {
  it('returns ok, the contract version, the mode and the account label only', async () => {
    await withBridge({ port: 0, mode: 'exhausted', account: 'acct-b' }, async bridge => {
      const response = await fetch(`${bridge.url}/healthz`);
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.deepEqual(JSON.parse(text), { ok: true, contract: CONTRACT_VERSION, mode: 'exhausted', account: 'acct-b' });
      // 契約 §C3.1・§13.3: ラベル以外の識別子（メールアドレス等）を出さない。
      assert.ok(!text.includes('@'), 'health body must not contain an email address');
    });
  });
});

// ---------------------------------------------------------------------------
// 純関数（R4-1 が期待値を組み立てるのに使う）
// ---------------------------------------------------------------------------

describe('fake-bridge pure helpers', () => {
  it('exposes every documented mode', () => {
    assert.deepEqual([...MODE_NAMES].sort(), [
      'attempt-limit', 'exhausted', 'idle', 'legacy', 'mixed',
      'needs-login', 'no-account', 'ok', 'stream-error', 'unreachable',
    ]);
  });

  it('builds header sets whose values are ASCII with no whitespace or comma (§C3.1)', () => {
    for (const mode of MODE_NAMES) {
      if (mode === 'unreachable') continue;
      const headers = buildOmbrHeaders({ mode, account: DEFAULT_ACCOUNT_LABEL, resetAt: '2026-09-08T13:00:00Z' });
      for (const [name, value] of Object.entries(headers)) {
        assert.match(name, /^x-ombr-[a-z-]+$/, name);
        assert.match(value, /^[!-~]+$/, `${mode}: ${name}=${value} must be ASCII without spaces, commas or newlines`);
        assert.ok(!value.includes(','), `${mode}: ${name} must not contain a comma`);
      }
    }
    assert.deepEqual(buildOmbrHeaders({ mode: 'legacy', account: 'acct-a', resetAt: '2026-09-08T13:00:00Z' }), {});
  });

  it('appends the recovery time only to the modes that carry reset-at', () => {
    const exhausted = JSON.parse(buildErrorBody({ mode: 'exhausted', resetAt: '2026-09-08T13:00:00Z' }));
    assert.match(exhausted.error.message, /Earliest recovery: 2026-09-08T13:00:00Z\./);
    const attemptLimit = JSON.parse(buildErrorBody({ mode: 'attempt-limit', resetAt: '2026-09-08T13:00:00Z' }));
    assert.ok(!/Earliest recovery/.test(attemptLimit.error.message), attemptLimit.error.message);
  });
});
