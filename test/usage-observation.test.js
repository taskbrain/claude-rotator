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
// parseUsageObservation: message id（usage-events.jsonl の照合補助）
// ---------------------------------------------------------------------------

describe('parseUsageObservation / messageId', () => {
  it('非ストリームは本文の id、SSE は message_start の message.id を返す', async () => {
    const json = await parseUsageObservation(Buffer.from(JSON.stringify({
      id: 'msg_json',
      model: 'claude-opus-5-1',
      usage: { input_tokens: 1, output_tokens: 2 },
    }), 'utf8'), {});
    assert.equal(json.parse, 'ok');
    assert.equal(json.messageId, 'msg_json');

    const sse = SSE.replace('"message":{', '"message":{"id":"msg_sse",');
    const stream = await parseUsageObservation(Buffer.from(sse, 'utf8'), {});
    assertUsage(stream);
    assert.equal(stream.messageId, 'msg_sse');
  });

  it('id が無い・読めないときは null', async () => {
    assert.equal((await parseUsageObservation(Buffer.from(SSE, 'utf8'), {})).messageId, null);
    assert.equal((await parseUsageObservation(Buffer.from('not json', 'utf8'), {})).messageId, null);
  });
});

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

  it('解凍後に上限を超える本文（解凍爆弾）は too-large になり、例外は漏れない', async () => {
    // 圧縮後は maxBytes に収まり、解凍後だけが超える形。入口の長さ判定（圧縮後）は
    // 素通りするので、デコーダへ渡す maxOutputLength が無いと 4 MiB を展開してしまう。
    const maxBytes = 64 * 1024;
    const bomb = Buffer.alloc(4 * 1024 * 1024, 0x61);
    const cases = [
      ['gzip', zlib.gzipSync(bomb)],
      ['deflate', zlib.deflateSync(bomb)],
      // raw 形式へのフォールバック側も上限を受け継ぐこと。
      ['deflate', zlib.deflateRawSync(bomb)],
      ['br', zlib.brotliCompressSync(bomb)],
    ];
    if (typeof zlib.zstdCompressSync === 'function') cases.push(['zstd', zlib.zstdCompressSync(bomb)]);

    for (const [encoding, compressed] of cases) {
      assert.ok(compressed.length <= maxBytes, `${encoding}: fixture が圧縮後の長さ判定で弾かれている`);
      const result = await parseUsageObservation(compressed, { contentEncoding: encoding, maxBytes });
      assert.equal(result.parse, 'too-large', `${encoding} は too-large のはず`);
      assert.equal(result.encoding, encoding);
      assert.equal(result.model, null);
      assert.equal(result.inputTokens, 0);
    }

    // maxOutputLength を足しても正常系は壊れない（上限内なら従来どおり解ける）。
    assertUsage(await parseUsageObservation(
      zlib.gzipSync(Buffer.from(SSE, 'utf8')),
      { contentEncoding: 'gzip', maxBytes },
    ));
  });

  it('toString 段階の例外も観測値になり、呼び出し側へ漏れない', async () => {
    // 解凍後が Node の文字列上限（buffer.constants.MAX_STRING_LENGTH ＝ 536,870,888）を
    // 超えると Buffer#toString が ERR_STRING_TOO_LONG を投げる。512 MiB を実際に確保せず、
    // その例外だけを Buffer に生やして再現する（Buffer.isBuffer は真のまま）。
    const bufferThatThrows = (error) => {
      const buffer = Buffer.from(SSE, 'utf8');
      Object.defineProperty(buffer, 'toString', { value: () => { throw error; } });
      assert.ok(Buffer.isBuffer(buffer));
      return buffer;
    };

    const tooLong = new Error('Cannot create a string longer than 0x1fffffe8 characters');
    tooLong.code = 'ERR_STRING_TOO_LONG';
    const sized = await parseUsageObservation(bufferThatThrows(tooLong), {});
    assert.equal(sized.parse, 'too-large');
    assert.equal(sized.inputTokens, 0);

    // サイズ以外の予期しない例外は unparsable。いずれにせよ外へは投げない。
    const other = await parseUsageObservation(bufferThatThrows(new Error('synthetic')), {});
    assert.equal(other.parse, 'unparsable');
    assert.equal(other.inputTokens, 0);
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

// ---------------------------------------------------------------------------
// observationLogFields / 猶予（usage-limit grace）の追記（差分案 3章 (b)・案A）
// ---------------------------------------------------------------------------

describe('observationLogFields / 猶予（grace）', () => {
  const base = {
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
  // grace を持たない現行の材料で出る文字列（既存テスト「計画書の順序どおりに追記する」と同じ）。
  const WITHOUT_GRACE = ' model=claude-opus-5-1 sid=ab12cd34ef56 in=10 out=20 cr=99000 cc=1500 c1h=1500 c5m=0'
    + ' u5h=0.76 u5hReset=1789012345 u7d=0.33 u7dReset=1789098765 enc=gzip';

  it('猶予ヘッダが無い応答（g5h・g7d とも null）では行が現行とバイト同一', () => {
    // grace キー自体が無い材料（旧版の buildObservationLog が返す形）。
    assert.equal(observationLogFields(base), WITHOUT_GRACE);
    // grace はあるが g5h/g7d とも null。status や overage だけ来ても追記しない。
    const noGrace = {
      ...base,
      grace: { g5h: null, g7d: null, ustat: 'allowed', ovs: 'rejected', ovu: 'false' },
    };
    assert.equal(observationLogFields(noGrace), WITHOUT_GRACE);
    assert.equal(Buffer.compare(Buffer.from(observationLogFields(noGrace)), Buffer.from(WITHOUT_GRACE)), 0);
    // grace が null でも同じ。
    assert.equal(observationLogFields({ ...base, grace: null }), WITHOUT_GRACE);
  });

  it('猶予ヘッダが来た応答だけ末尾へ g5h g7d ustat ovs ovu の順で足す', () => {
    const withGrace = {
      ...base,
      grace: { g5h: 0.02, g7d: 0, ustat: 'allowed_warning', ovs: 'rejected', ovu: 'false' },
    };
    assert.equal(
      observationLogFields(withGrace),
      WITHOUT_GRACE + ' g5h=0.02 g7d=0 ustat=allowed_warning ovs=rejected ovu=false',
    );
  });

  it('片方だけ来たときはもう片方と欠けた文字列項目を - にする', () => {
    const only7d = { ...base, grace: { g5h: null, g7d: 0.5, ustat: null, ovs: null, ovu: null } };
    assert.ok(
      observationLogFields(only7d).endsWith(' enc=gzip g5h=- g7d=0.5 ustat=- ovs=- ovu=-'),
      observationLogFields(only7d),
    );
  });

  it('grace=0 は null ではないので追記する（上流が常に 0 を付ける場合の挙動）', () => {
    const zero = { ...base, grace: { g5h: 0, g7d: 0, ustat: 'allowed', ovs: null, ovu: null } };
    assert.ok(observationLogFields(zero).endsWith(' g5h=0 g7d=0 ustat=allowed ovs=- ovu=-'));
  });

  it('g5h が数値でなくても null でなければ追記し値は - になる。文字列項目は logToken で1トークンに収める', () => {
    // 本番では数値として読めない値は buildObservationLog 側で null になる。ここは
    // それ以外の値が渡ったときの observationLogFields 単体の挙動を固定する。
    const junk = { ...base, grace: { g5h: 'abc', g7d: undefined, ustat: 'allowed', ovs: null, ovu: null } };
    // 'abc' は != null なので条件は真になるが、numberOrDash で - に倒れる。
    assert.ok(observationLogFields(junk).endsWith(' g5h=- g7d=- ustat=allowed ovs=- ovu=-'));

    const spaced = {
      ...base,
      grace: { g5h: 1.2, g7d: null, ustat: 'allowed warning', ovs: 'org level/disabled', ovu: '' },
    };
    const rendered = observationLogFields(spaced);
    assert.ok(rendered.endsWith(' g5h=1.2 g7d=- ustat=allowed_warning ovs=org_level_disabled ovu=-'), rendered);
    // 既存13トークン＋猶予5トークン。値の空白でトークン数が増えていない。
    assert.equal(rendered.trim().split(' ').length, 18);
  });

  it('usageParse= より後ろ（行の最末尾）に付く', () => {
    const failed = {
      ...base,
      parse: 'unsupported-encoding',
      grace: { g5h: 0.1, g7d: null, ustat: 'allowed', ovs: 'rejected', ovu: 'false' },
    };
    assert.ok(
      observationLogFields(failed).endsWith(' usageParse=unsupported-encoding g5h=0.1 g7d=- ustat=allowed ovs=rejected ovu=false'),
      observationLogFields(failed),
    );
  });
});
