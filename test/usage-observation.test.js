// 応答本文から usage を読む純関数のテスト（計画書 Task 1・Task 2）。
//
// このファイルは HTTP を一切使わない。偽上流も実サービスも立てないので、
// `~/.claude/rules/02-verification.md` §3 の到達防止は構造的に満たされる。
//
// fixture には実在の資格情報・実セッション id・実メールアドレスを書かない。
// セッション id は本ファイルで生成した合成文字列である。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import {
  DEFAULT_OBSERVABILITY,
  normalizeObservability,
  observationLogFields,
  parseUsageObservation,
  upstreamAcceptEncoding,
} from '../src/usage-observation.js';

const brotliCompress = promisify(zlib.brotliCompress);

// 本件の核心となる SSE。message_start に入力側の4分類、message_delta に出力が載る。
const SSE = [
  'event: message_start',
  'data: ' + JSON.stringify({
    type: 'message_start',
    message: {
      model: 'claude-opus-5-1',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 99000,
        cache_creation_input_tokens: 1500,
        cache_creation: {
          ephemeral_1h_input_tokens: 1500,
          ephemeral_5m_input_tokens: 0,
        },
      },
    },
  }),
  '',
  'event: message_delta',
  'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 20 } }),
  '',
  '',
].join('\n');

const EXPECTED = {
  parse: 'ok',
  model: 'claude-opus-5-1',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 99000,
  cacheCreationTokens: 1500,
  cacheCreation1hTokens: 1500,
  cacheCreation5mTokens: 0,
};

function assertUsage(actual, expected = EXPECTED) {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key], value, `${key} が一致しない`);
  }
}

// ---------------------------------------------------------------------------
// parseUsageObservation: 圧縮された応答本文（本件の根本原因）
// ---------------------------------------------------------------------------

describe('parseUsageObservation / content-encoding', () => {
  it('gzip で固めた SSE を content-encoding 付きで渡すと平文と同じ値が返る', async () => {
    const plain = await parseUsageObservation(Buffer.from(SSE, 'utf8'), {});
    assertUsage(plain);

    const gzipped = zlib.gzipSync(Buffer.from(SSE, 'utf8'));
    assertUsage(await parseUsageObservation(gzipped, { contentEncoding: 'gzip' }));
    // 大文字・パラメータ付きでも同じ（HTTP のヘッダ値は大小を区別しない）。
    assertUsage(await parseUsageObservation(gzipped, { contentEncoding: 'GZIP' }));
    assertUsage(await parseUsageObservation(gzipped, { contentEncoding: 'x-gzip' }));
  });

  it('content-encoding を渡さないと解釈できず parse=unparsable・トークンは 0 になる（現行の欠陥）', async () => {
    const gzipped = zlib.gzipSync(Buffer.from(SSE, 'utf8'));
    const result = await parseUsageObservation(gzipped, {});
    assert.equal(result.parse, 'unparsable');
    assert.equal(result.model, null);
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'cacheCreation1hTokens', 'cacheCreation5mTokens']) {
      assert.equal(result[key], 0, `${key} は 0 のはず`);
    }
  });

  it('deflate と br も解ける', async () => {
    assertUsage(await parseUsageObservation(
      zlib.deflateSync(Buffer.from(SSE, 'utf8')),
      { contentEncoding: 'deflate' },
    ));
    // deflate を raw で返す上流にも耐える（Content-Encoding: deflate の実装ゆれ）。
    assertUsage(await parseUsageObservation(
      zlib.deflateRawSync(Buffer.from(SSE, 'utf8')),
      { contentEncoding: 'deflate' },
    ));
    assertUsage(await parseUsageObservation(
      await brotliCompress(Buffer.from(SSE, 'utf8')),
      { contentEncoding: 'br' },
    ));
  });

  it('identity と空文字列は無圧縮として扱う', async () => {
    const body = Buffer.from(SSE, 'utf8');
    assertUsage(await parseUsageObservation(body, { contentEncoding: 'identity' }));
    assertUsage(await parseUsageObservation(body, { contentEncoding: '' }));
    assertUsage(await parseUsageObservation(body, { contentEncoding: null }));
  });

  it('zstd は Node が解ける版でだけ解く（本番実体は Node 22 系なので解ける）', async (t) => {
    // 本番の rotator は Node 22.22.2 で動いており zstdDecompress を持つ。
    // 開発機の既定 node が 20 系だとこの分岐は走らないので、skip を明示して
    // 「通ったつもり」にならないようにする。
    if (typeof zlib.zstdCompress !== 'function') {
      t.skip('この Node には zstd の API が無い（v22.15 未満）');
      return;
    }
    const zstdCompress = promisify(zlib.zstdCompress);
    const compressed = await zstdCompress(Buffer.from(SSE, 'utf8'));
    assertUsage(await parseUsageObservation(compressed, { contentEncoding: 'zstd' }));
  });

  it('解けない符号化は unsupported-encoding として観測可能に落ちる（黙って 0 件にしない）', async () => {
    const result = await parseUsageObservation(Buffer.from('anything'), { contentEncoding: 'zstd' });
    assert.equal(result.parse, typeof zlib.zstdDecompress === 'function' ? 'unparsable' : 'unsupported-encoding');
    assert.equal(result.inputTokens, 0);

    const unknown = await parseUsageObservation(Buffer.from('anything'), { contentEncoding: 'snappy' });
    assert.equal(unknown.parse, 'unsupported-encoding');
  });

  it('壊れた gzip は例外を投げず unparsable になる', async () => {
    const result = await parseUsageObservation(Buffer.from('not actually gzip'), { contentEncoding: 'gzip' });
    assert.equal(result.parse, 'unparsable');
    assert.equal(result.inputTokens, 0);
  });

  it('encoding フィールドに正規化した符号化名を返す', async () => {
    const gzipped = zlib.gzipSync(Buffer.from(SSE, 'utf8'));
    assert.equal((await parseUsageObservation(gzipped, { contentEncoding: 'GZIP' })).encoding, 'gzip');
    assert.equal((await parseUsageObservation(Buffer.from(SSE), {})).encoding, null);
    assert.equal((await parseUsageObservation(Buffer.from('x'), { contentEncoding: 'snappy' })).encoding, 'snappy');
  });
});

// ---------------------------------------------------------------------------
// parseUsageObservation: 本文の読み方
// ---------------------------------------------------------------------------

describe('parseUsageObservation / 本文の読み方', () => {
  it('非ストリームの JSON から4分類を読む', async () => {
    const body = Buffer.from(JSON.stringify({
      model: 'claude-opus-5-1',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 99000,
        cache_creation_input_tokens: 1500,
        cache_creation: { ephemeral_1h_input_tokens: 1500, ephemeral_5m_input_tokens: 0 },
      },
    }), 'utf8');
    assertUsage(await parseUsageObservation(body, {}));
  });

  it('CRLF 区切りの SSE も読める', async () => {
    const crlf = SSE.replace(/\n/g, '\r\n');
    assertUsage(await parseUsageObservation(Buffer.from(crlf, 'utf8'), {}));
  });

  it('message_delta に cache_* が載っていたら大きい方を採る', async () => {
    const sse = [
      'data: ' + JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-opus-5-1', usage: { input_tokens: 10, cache_read_input_tokens: 99000 } },
      }),
      '',
      'data: ' + JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 20, cache_read_input_tokens: 99500, cache_creation_input_tokens: 1500 },
      }),
      '',
    ].join('\n');
    const result = await parseUsageObservation(Buffer.from(sse, 'utf8'), {});
    assert.equal(result.cacheReadTokens, 99500);
    assert.equal(result.cacheCreationTokens, 1500);
    assert.equal(result.outputTokens, 20);
  });

  it('usage の無い本文は no-usage になる（429 / 401 の本文）', async () => {
    const body = Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'synthetic' },
    }), 'utf8');
    const result = await parseUsageObservation(body, {});
    assert.equal(result.parse, 'no-usage');
    assert.equal(result.inputTokens, 0);
  });

  it('JSON でも SSE でもない本文は unparsable になる', async () => {
    const result = await parseUsageObservation(Buffer.from('<html>gateway</html>', 'utf8'), {});
    assert.equal(result.parse, 'unparsable');
  });

  it('空の本文は no-usage になる', async () => {
    const result = await parseUsageObservation(Buffer.alloc(0), {});
    assert.equal(result.parse, 'no-usage');
  });

  it('maxBytes を超える本文は解析せず too-large になる', async () => {
    const body = zlib.gzipSync(Buffer.from(SSE, 'utf8'));
    const result = await parseUsageObservation(body, { contentEncoding: 'gzip', maxBytes: 4 });
    assert.equal(result.parse, 'too-large');
    assert.equal(result.inputTokens, 0);
    assert.equal(result.model, null);
  });

  it('model は応答から採る（message_start.message.model / 非ストリームの model）', async () => {
    assert.equal((await parseUsageObservation(Buffer.from(SSE, 'utf8'), {})).model, 'claude-opus-5-1');
    const noModel = [
      'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
      '',
    ].join('\n');
    assert.equal((await parseUsageObservation(Buffer.from(noModel, 'utf8'), {})).model, null);
  });

  it('数値でない usage 値は 0 として扱い、例外を投げない', async () => {
    const body = Buffer.from(JSON.stringify({
      usage: { input_tokens: 'many', output_tokens: null, cache_read_input_tokens: -5 },
    }), 'utf8');
    const result = await parseUsageObservation(body, {});
    assert.equal(result.parse, 'ok');
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.cacheReadTokens, 0);
  });
});

// ---------------------------------------------------------------------------
// upstreamAcceptEncoding: 解けない符号化を上流向けに落とす（Task 1 Step 0 の帰結）
// ---------------------------------------------------------------------------

describe('upstreamAcceptEncoding', () => {
  const ZSTD_OK = typeof zlib.zstdDecompress === 'function';

  it('Claude Code の実測値から、解けない符号化だけを落とす', () => {
    // Task 1 Step 0 の実測値（Claude Code 2.1.275 / Bun 1.4.3）。
    const observed = 'gzip, deflate, br, zstd';
    const rewritten = upstreamAcceptEncoding(observed);
    if (ZSTD_OK) {
      assert.equal(rewritten, observed, 'zstd を解ける環境では書き換えない');
    } else {
      assert.equal(rewritten, 'gzip, deflate, br');
    }
  });

  it('解ける値しか無ければ受け取った文字列をそのまま返す（バイト同一）', () => {
    for (const value of ['gzip, deflate, br', 'gzip', 'identity', 'gzip;q=1.0, deflate;q=0.5']) {
      assert.equal(upstreamAcceptEncoding(value), value);
    }
  });

  it('品質値つきのトークンも落とせる', () => {
    const rewritten = upstreamAcceptEncoding('zstd;q=1.0, gzip;q=0.8');
    if (ZSTD_OK) assert.equal(rewritten, 'zstd;q=1.0, gzip;q=0.8');
    else assert.equal(rewritten, 'gzip;q=0.8');
  });

  it('解ける値が1つも残らないときは identity を送る（上流が何も返せなくなるのを防ぐ）', () => {
    const rewritten = upstreamAcceptEncoding('zstd');
    assert.equal(rewritten, ZSTD_OK ? 'zstd' : 'identity');
  });

  it('未知のトークンは残す（落としてよいのは「解けないと分かっている」ものだけ）', () => {
    assert.equal(upstreamAcceptEncoding('gzip, snappy'), 'gzip, snappy');
    assert.equal(upstreamAcceptEncoding('*'), '*');
  });

  it('文字列でない値・空文字列は触らない', () => {
    assert.equal(upstreamAcceptEncoding(undefined), undefined);
    assert.equal(upstreamAcceptEncoding(null), null);
    assert.equal(upstreamAcceptEncoding(''), '');
    const asArray = ['gzip', 'zstd'];
    assert.deepEqual(upstreamAcceptEncoding(asArray), asArray);
  });
});

// ---------------------------------------------------------------------------
// normalizeObservability（計画書「設定」節）
// ---------------------------------------------------------------------------

describe('normalizeObservability', () => {
  it('未指定・不正な型は既定へ倒れ、戻り値は凍結される', () => {
    for (const raw of [undefined, null, 'true', 1, [], () => {}]) {
      const settings = normalizeObservability(raw);
      assert.deepEqual(settings, DEFAULT_OBSERVABILITY);
      assert.ok(Object.isFrozen(settings));
      assert.ok(Object.isFrozen(settings.requestLog));
      assert.ok(Object.isFrozen(settings.upstream));
    }
  });

  it('既定は requestLog.enabled=true / sessionFromBody=false / logMaxBytes=32MiB', () => {
    assert.equal(DEFAULT_OBSERVABILITY.requestLog.enabled, true);
    assert.equal(DEFAULT_OBSERVABILITY.requestLog.sessionFromBody, false);
    assert.equal(DEFAULT_OBSERVABILITY.requestLog.maxBodyBytes, 16 * 1024 * 1024);
    assert.equal(DEFAULT_OBSERVABILITY.upstream.dropUndecodableAcceptEncoding, true);
    assert.equal(DEFAULT_OBSERVABILITY.logMaxBytes, 32 * 1024 * 1024);
  });

  it('真偽キーは真偽値以外すべて既定になる', () => {
    for (const raw of ['true', 1, 'yes', {}, [], null, 0]) {
      assert.equal(normalizeObservability({ requestLog: { enabled: raw } }).requestLog.enabled, true);
      assert.equal(normalizeObservability({ requestLog: { sessionFromBody: raw } }).requestLog.sessionFromBody, false);
      assert.equal(
        normalizeObservability({ upstream: { dropUndecodableAcceptEncoding: raw } }).upstream.dropUndecodableAcceptEncoding,
        true,
      );
    }
    assert.equal(normalizeObservability({ requestLog: { enabled: false } }).requestLog.enabled, false);
    assert.equal(normalizeObservability({ requestLog: { sessionFromBody: true } }).requestLog.sessionFromBody, true);
    assert.equal(
      normalizeObservability({ upstream: { dropUndecodableAcceptEncoding: false } }).upstream.dropUndecodableAcceptEncoding,
      false,
    );
  });

  it('maxBodyBytes は 1 MiB〜64 MiB へクランプする', () => {
    const MIB = 1024 * 1024;
    assert.equal(normalizeObservability({ requestLog: { maxBodyBytes: 1 } }).requestLog.maxBodyBytes, MIB);
    assert.equal(normalizeObservability({ requestLog: { maxBodyBytes: 999 * MIB } }).requestLog.maxBodyBytes, 64 * MIB);
    assert.equal(normalizeObservability({ requestLog: { maxBodyBytes: 8 * MIB } }).requestLog.maxBodyBytes, 8 * MIB);
    // 範囲外の「数値」はクランプする（0 や負数で解析が止まらないように min へ寄せる）。
    assert.equal(normalizeObservability({ requestLog: { maxBodyBytes: -1 } }).requestLog.maxBodyBytes, MIB);
    assert.equal(normalizeObservability({ requestLog: { maxBodyBytes: 0 } }).requestLog.maxBodyBytes, MIB);
    // そもそも数値でない値は既定へ倒す。
    for (const raw of ['8', NaN, Infinity, null, {}, true]) {
      assert.equal(
        normalizeObservability({ requestLog: { maxBodyBytes: raw } }).requestLog.maxBodyBytes,
        DEFAULT_OBSERVABILITY.requestLog.maxBodyBytes,
      );
    }
  });

  it('logMaxBytes は 1 MiB〜256 MiB へクランプする', () => {
    const MIB = 1024 * 1024;
    assert.equal(normalizeObservability({ logMaxBytes: 1 }).logMaxBytes, MIB);
    assert.equal(normalizeObservability({ logMaxBytes: 9999 * MIB }).logMaxBytes, 256 * MIB);
    assert.equal(normalizeObservability({ logMaxBytes: 10 * MIB }).logMaxBytes, 10 * MIB);
    assert.equal(normalizeObservability({ logMaxBytes: -1 }).logMaxBytes, MIB);
    for (const raw of ['10', NaN, Infinity, null, {}]) {
      assert.equal(normalizeObservability({ logMaxBytes: raw }).logMaxBytes, DEFAULT_OBSERVABILITY.logMaxBytes);
    }
  });
});

// ---------------------------------------------------------------------------
// observationLogFields（計画書 (b)）
// ---------------------------------------------------------------------------

describe('observationLogFields', () => {
  const observationLog = {
    model: 'claude-opus-5-1',
    sid: 'ab12cd34ef56',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 99000,
    cacheCreationTokens: 1500,
    cacheCreation1hTokens: 1500,
    cacheCreation5mTokens: 0,
    quota: { unified5h: 0.76, unified5hReset: 1789012345, unified7d: 0.33, unified7dReset: 1789098765 },
    encoding: 'gzip',
    parse: 'ok',
  };

  it('null なら空文字列（行が現行とバイト同一になる）', () => {
    assert.equal(observationLogFields(null), '');
    assert.equal(observationLogFields(undefined), '');
  });

  it('計画書の順序どおりに追記する', () => {
    assert.equal(
      observationLogFields(observationLog),
      ' model=claude-opus-5-1 sid=ab12cd34ef56 in=10 out=20 cr=99000 cc=1500 c1h=1500 c5m=0'
      + ' u5h=0.76 u5hReset=1789012345 u7d=0.33 u7dReset=1789098765 enc=gzip',
    );
  });

  it('parse が ok 以外のときだけ usageParse= を出す', () => {
    const failed = { ...observationLog, parse: 'unsupported-encoding' };
    assert.ok(observationLogFields(failed).endsWith(' usageParse=unsupported-encoding'));
    assert.ok(!observationLogFields(observationLog).includes('usageParse='));
  });

  it('値の無いところは - を出す', () => {
    const empty = {
      model: null,
      sid: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheCreation5mTokens: 0,
      quota: {},
      encoding: null,
      parse: 'ok',
    };
    assert.equal(
      observationLogFields(empty),
      ' model=- sid=- in=0 out=0 cr=0 cc=0 c1h=0 c5m=0 u5h=- u5hReset=- u7d=- u7dReset=- enc=-',
    );
  });

  it('sticky の affinityLog が sid を持つときだけ sid= を譲る（!affinityLog?.sid）', () => {
    // sticky R-S7 が sid= を出す行では二重に出さない。
    assert.ok(!observationLogFields(observationLog, { sid: 'ffffffffffff' }).includes('sid='));
    // affinityLog はあるが鍵なしの要求（sid が無い）では、こちらが sid=- を出す。
    // ここを「affinityLog が null のときだけ」にすると sid=- が消え、付与率が測れなくなる。
    assert.ok(observationLogFields(observationLog, { sid: null }).includes(' sid=ab12cd34ef56 '));
    assert.ok(observationLogFields(observationLog, {}).includes(' sid=ab12cd34ef56 '));
    assert.ok(observationLogFields(observationLog, null).includes(' sid=ab12cd34ef56 '));
  });

  it('enc= と model= の値から空白・記号を落とす（行の区切りが崩れない）', () => {
    const rendered = observationLogFields({
      ...observationLog,
      // 複数符号化や上流が名乗る想定外のモデル名で空白が混ざっても1トークンに収める。
      encoding: 'gzip, br',
      model: 'claude opus/5 "1"',
    });
    assert.ok(rendered.includes(' model=claude_opus_5__1_ '), rendered);
    assert.ok(rendered.endsWith(' enc=gzip__br'), rendered);
    // 追記部分に空白区切りのトークンが所定の数だけ並ぶ（値の空白で増えていない）。
    assert.equal(rendered.trim().split(' ').length, 13);
  });

  it('生のセッション id を出さない（12 hex だけ）', () => {
    const rendered = observationLogFields(observationLog);
    assert.match(rendered, / sid=[0-9a-f]{12} /);
  });
});
