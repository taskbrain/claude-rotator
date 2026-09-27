// 秘密の伏せ字（src/codex/redact.js）のテスト。
//
// 形式で伏せる経路（キー・トークン・パスなどに見える文字列を消す）と、値で伏せる経路（登録した値を形式に関係なく消す。
// 制御トークン・User-Agent・originator の値に使う）の両方を固定する。
// 文字列はすべて合成の値で、実在のキー・トークンではない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  MAX_REDACTED_LENGTH,
  NON_ERROR_TEXT,
  REDACTED,
  createSecretRegistry,
  formatError,
  redactRegisteredValues,
  redactSecrets,
} from '../../src/codex/redact.js';

const marker = () => `ZZ-MARKER-${randomBytes(8).toString('hex')}`;

// ---------------------------------------------------------------------------
// 形式で伏せる
// ---------------------------------------------------------------------------

test('redact: API-key, Bearer, Authorization and JWT forms are replaced', () => {
  const jwt = `eyJ${'A'.repeat(24)}.eyJ${'B'.repeat(24)}.zzsig`;
  for (const [input, secret] of [
    ['leaked key sk-zz-fake-ABC123xyz here', 'sk-zz-fake-ABC123xyz'],
    ['failed with Bearer zzFakeToken123', 'zzFakeToken123'],
    ['failed request, Authorization:zz-fake-raw-key-123', 'zz-fake-raw-key-123'],
    ['Authorization: Bearer zzFakeToken456', 'zzFakeToken456'],
    [`token=${jwt}`, jwt],
  ]) {
    const out = redactSecrets(input);
    assert.ok(!out.includes(secret), out);
    assert.ok(out.includes(REDACTED), out);
  }
});

test('redact: a JWT is removed with all three parts, the signature included', () => {
  const signature = `ZZ-SIGNATURE-MARKER-${randomBytes(4).toString('hex')}`;
  for (const jwt of [`eyJ${'A'.repeat(12)}.eyJ${'B'.repeat(12)}.${signature}`, `eyJ${'A'.repeat(10)}.${signature}`]) {
    const out = redactSecrets(`token ${jwt} end`);
    assert.equal(out, `token ${REDACTED} end`);
    assert.ok(!out.includes('ZZ-SIGNATURE-MARKER'));
  }
});

test('redact: absolute paths, file URLs and email addresses are removed by their form', () => {
  const cases = [
    "ENOENT: no such file or directory, open '/zz/home/ZZ-PATH-MARKER/auth.json'",
    'lstat failed for /zz/home/.codex-accounts/ZZ-PATH-MARKER',
    'path=/zz/ZZ-PATH-MARKER x (/zz/other/ZZ-PATH-MARKER) "/zz/q/ZZ-PATH-MARKER"',
    'cannot load file:///zz/home/ZZ-PATH-MARKER/x.js',
    'account zz@example.invalid rejected',
    'mail to zz.dummy+tag@example.invalid now',
  ];
  for (const input of cases) {
    const out = redactSecrets(input);
    assert.ok(!out.includes('ZZ-PATH-MARKER') && !out.includes('@example.invalid') && out.includes(REDACTED), out);
  }
});

test('redact: a ~/ path, a quoted path with spaces and a quoted relative path are removed whole', () => {
  const cases = [
    ['lstat failed for ~/.codex-accounts/ZZ-PATH-MARKER/auth.json', `lstat failed for ${REDACTED}`],
    ["ENOENT: no such file or directory, open '/zz/home/My Folder/ZZ-PATH-MARKER/auth.json'",
      `ENOENT: no such file or directory, open '${REDACTED}'`],
    ["EACCES: permission denied, mkdir '/zz/home/zz dir ZZ-PATH-MARKER'", `EACCES: permission denied, mkdir '${REDACTED}'`],
    ["open 'zz-accounts/ZZ-PATH-MARKER/auth.json' failed", `open '${REDACTED}' failed`],
    ["open './zz/ZZ-PATH-MARKER' failed", `open '${REDACTED}' failed`],
    ['open "zz accounts/ZZ-PATH-MARKER" failed', `open "${REDACTED}" failed`],
    ["rename '/zz/a ZZ-PATH-MARKER' -> '/zz/b ZZ-PATH-MARKER'", `rename '${REDACTED}' -> '${REDACTED}'`],
  ];
  for (const [input, expected] of cases) {
    const out = redactSecrets(input);
    assert.equal(out, expected);
    assert.ok(!out.includes('ZZ-PATH-MARKER'), out);
  }
});

test('redact: web URLs, ratios, protocol names and quoted words without a slash are not mistaken for paths', () => {
  for (const text of ['GET https://chatgpt.example/backend-api/wham/usage', 'ratio 3/4 and/or HTTP/1.1 and a / b',
    'mode 0700/0600', "the 'enabled' key", 'the "accounts" key']) {
    assert.equal(redactSecrets(text), text);
  }
});

test('redact: ordinary text is left untouched and null or undefined becomes an empty string', () => {
  assert.equal(redactSecrets('nothing secret here'), 'nothing secret here');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(42), '42');
});

test('redact: long text is cut to the limit with a visible truncation mark, and text at the limit is kept', () => {
  const cut = redactSecrets('x'.repeat(500));
  assert.equal(cut.length, MAX_REDACTED_LENGTH);
  assert.ok(cut.endsWith('…(truncated)'));
  const exact = 'y'.repeat(MAX_REDACTED_LENGTH);
  assert.equal(redactSecrets(exact), exact);
});

test('redact: an email address is removed whole, whatever sits right before or after it', () => {
  for (const [input, expected] of [
    ['x@example.invalid', REDACTED],
    ['zz.user+x@example.invalid', REDACTED],
    ['aax@example.invalid', REDACTED],
    ['user=x@example.invalid;', `user=${REDACTED};`],
    ['x@example.invalid9 end', `${REDACTED}9 end`],
    [`${'a'.repeat(65)}@example.invalid`, REDACTED],
    // 別の規則（sk-…）の一致がローカル部の文字の並びの途中で終わっても、残りのアドレスを伏せる。
    ['x sk-zz-fake.user@example.invalid y', `x ${REDACTED}${REDACTED} y`],
  ]) {
    assert.equal(redactSecrets(input), expected);
  }
});

// 旧規則は @ を含まない長い英数字の並びで処理時間が文字数の2乗に伸びた（4万字で約1秒）。
// 1秒は余裕を持たせた上限で、修正後は数ミリ秒で終わる。空白の無い並びは切った位置にかかる
// 1語なので、丸ごと1つの伏せ字になる。
test('redact: long runs of letters, digits or dots are handled well within the time budget', () => {
  for (const text of ['a'.repeat(40000), '1'.repeat(40000), '.'.repeat(40000)]) {
    const started = process.hrtime.bigint();
    const out = redactSecrets(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `${text[0]} x ${text.length}: ${elapsedMs} ms`);
    assert.equal(out, REDACTED);
  }
});

// 切る長さより短い入力は切る処理を通らないので、メールの規則そのものが速いことをここで固定する。
// 1つの規則で先頭の制限も上限も無い旧規則は、この長さで20回に約0.8〜1.3秒かかった（修正後は
// 約0.04〜0.06秒）。0.3秒は、両者の間で双方に余裕を持たせた上限。
test('redact: the email patterns themselves are fast on text shorter than the cut', () => {
  for (const ch of ['a', '.']) {
    const text = ch.repeat(8000);
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i += 1) redactSecrets(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 300, `${ch} x 8000, 20 times: ${elapsedMs} ms`);
  }
});

// 旧規則は `'` の後に `/` が続き閉じの引用符が無いと、/ の位置ごとに末尾まで読み直した
// （2万字で約0.8秒）。4万字は形式の規則の前で切られるので、切る処理と規則の両方を通る。
// 引用符から切った位置まで空白が無いので、引用符も含めた1語として伏せる。
test('redact: a quote followed by a long run of slashes is handled well within the time budget', () => {
  for (const quote of [`'`, '"']) {
    const text = `${quote}${'/'.repeat(40000)}`;
    const started = process.hrtime.bigint();
    const out = redactSecrets(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `${quote} + / x 40000: ${elapsedMs} ms`);
    assert.equal(out, REDACTED);
  }
});

// 切る長さより短い入力は切る処理を通らないので、規則そのものが速いことをここで固定する。
// 旧規則はこの長さで1回約0.13秒かかり、20回で1秒を超える。
test('redact: the quoted-path pattern itself is fast on text shorter than the cut', () => {
  for (const quote of [`'`, '"']) {
    const text = `${quote}${'/'.repeat(7999)}`;
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i += 1) redactSecrets(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 1000, `${quote} + / x 7999, 20 times: ${elapsedMs} ms`);
  }
});

// 切った位置より後ろに閉じの引用符があると、引用符の規則が効かず、空白より後ろのパスが残った。
test('redact: a quoted path whose closing quote falls beyond the cut is removed from the opening quote on', () => {
  for (const quote of [`'`, '"']) {
    const out = redactSecrets(`open ${quote}/zz/My Folder/ZZ-PATH-MARKER/${'q'.repeat(9000)}${quote} end`);
    assert.equal(out, `open ${quote}${REDACTED}`);
    assert.ok(!out.includes('ZZ-PATH-MARKER') && !out.includes('Folder'), out);
  }
});

test('redact: a quote left open in text shorter than the cut is treated as before', () => {
  const text = `don't stop ${'a'.repeat(300)}`;
  assert.ok(redactSecrets(text).startsWith("don't stop aaa"));
});

test('redact: an email address near the start of a very long text is still removed before the cut', () => {
  const out = redactSecrets(`mail zz@example.invalid ${'a'.repeat(40000)}`);
  assert.equal(out, `mail ${REDACTED} ${REDACTED}`);
  assert.ok(!out.includes('@example.invalid'), out);
});

// 切った位置がアドレスの途中に落ちると、メールの規則はドメインの後の `.` と英字2字を見られず
// 一致しない。切った位置にかかる語を丸ごと伏せるので、アドレスの前半も残らない。手前の長い
// `sk-…` は1つの伏せ字になり、切った位置の近くが出力の 200 文字に入る。
const PATTERN_INPUT_LIMIT = 8192; // src/codex/redact.js の MAX_PATTERN_INPUT_LENGTH
const ADDRESS = 'zz.user@example.invalid';

test('redact: an email address cut by the length limit is removed whole (two inputs that used to leave part of the address)', () => {
  // 切った位置の手前に残るのは、1つ目が `zz.`、2つ目が `zz.user@exam`（修正前は平文で残った）。
  for (const input of [`x sk-${'Q'.repeat(8183)} ${ADDRESS} tail`, `x sk-${'Q'.repeat(8174)} ${ADDRESS} tail`]) {
    const out = redactSecrets(input);
    assert.equal(out, `x ${REDACTED} ${REDACTED}`);
    assert.ok(!out.includes('zz.') && !out.includes('user') && !out.includes('example'), out);
  }
});

test('redact: an email address cut by the length limit is removed whole, wherever the cut falls', () => {
  // 切った位置の手前に残るアドレスの部分: 1字目の後、@ の直前、@ の直後、ドメインの途中、
  // `.` の直後、英字1字の後、アドレスの終わり。
  const keptParts = ['z', 'zz.user', 'zz.user@', 'zz.user@exam', 'zz.user@example.', 'zz.user@example.i', ADDRESS];
  for (const kept of keptParts) {
    for (const separator of [' ', '\n', '\t']) {
      const lead = `x sk-${'Q'.repeat(PATTERN_INPUT_LIMIT - 6 - kept.length)}${separator}`;
      const input = `${lead}${ADDRESS} tail`;
      assert.ok(input.slice(0, PATTERN_INPUT_LIMIT).endsWith(`${separator}${kept}`)); // 切る位置の確認
      assert.equal(redactSecrets(input), `x ${REDACTED}${separator}${REDACTED}`, JSON.stringify(kept));
    }
  }
});

test('redact: a cut word is removed from its start, even when another pattern matched part of it', () => {
  const run = 'Q'.repeat(PATTERN_INPUT_LIMIT - 15); // 切った位置の手前に joint の先頭 10 字が残る
  // `sk-…` の一致がアドレスの手前で終わる形（修正前は `.user@exam` や `=zz.user@e` が残った）。
  for (const joint of ['.user@example.invalid', '=zz.user@example.invalid', '/zz.user@example.invalid']) {
    const input = `x sk-${run}${joint} tail`;
    assert.ok(input.slice(0, PATTERN_INPUT_LIMIT).endsWith(`${run}${joint.slice(0, 10)}`)); // 切る位置の確認
    assert.equal(redactSecrets(input), `x ${REDACTED}`, joint);
  }
  // 空白が1つも無いときは、全体が切った位置にかかる1語になる。
  assert.equal(redactSecrets(`sk-${run}=zz.user@example.invalid`), REDACTED);
});

test('redact: text cut right after a space keeps the words before it as they are', () => {
  const input = `x sk-${'Q'.repeat(PATTERN_INPUT_LIMIT - 6)} ${ADDRESS} tail`;
  assert.equal(input[PATTERN_INPUT_LIMIT - 1], ' ');
  assert.equal(redactSecrets(input), `x ${REDACTED} `);
});

// 修正前は `Bearer\s+\S+` の値が区切りを挟んで次の `Bearer` まで飲み込み、飲み込まれた Bearer の
// 規則が掛からず、2つ目以降の値が平文で残った（`Bearer x,Bearer <値>` など）。
test('redact: Bearer tokens chained through separators are all removed', () => {
  for (const [input, expected] of [
    ['Bearer ZZ-TOKEN-A(Bearer ZZ-TOKEN-B', REDACTED],
    ['Bearer ZZ-TOKEN-A,Bearer ZZ-TOKEN-B', REDACTED],
    ['x Bearer ZZ-TOKEN-A;bearer ZZ-TOKEN-B,BEARER ZZ-TOKEN-C tail', `x ${REDACTED} tail`],
    ['Bearer ZZ-TOKEN-A[Bearer\tZZ-TOKEN-B] next', `${REDACTED} next`],
    ['Bearer ZZ-TOKEN-A"Bearer   ZZ-TOKEN-B"', REDACTED],
    ['Bearer ZZ-TOKEN-A|Bearer\nZZ-TOKEN-B end', `${REDACTED} end`],
  ]) {
    const out = redactSecrets(input);
    assert.equal(out, expected, input);
    assert.ok(!out.includes('ZZ-TOKEN'), out);
  }
});

// 同じ飲み込みは、空白をまたいで続く別の規則（Authorization:・引用符で囲まれたパス）の始まりと、
// 別の規則（パス・sk-…）の一致の末尾に来た Bearer でも起きた。
test('redact: a Bearer, Authorization: or quoted path swallowed by an earlier match is still removed', () => {
  for (const [input, expected] of [
    ['Bearer x,Authorization: ZZ-TOKEN-A more\nnext', `${REDACTED}\nnext`],
    ["Bearer x,'/zz/a ZZ-TOKEN-A' tail", `${REDACTED}' tail`],
    ['Authorization: x Bearer\nZZ-TOKEN-A next', `${REDACTED} next`],
    ['open /zz/Bearer ZZ-TOKEN-A next', `open ${REDACTED} next`],
    ['sk-zzBearer ZZ-TOKEN-A next', `${REDACTED} next`],
  ]) {
    const out = redactSecrets(input);
    assert.equal(out, expected, input);
    assert.ok(!out.includes('ZZ-TOKEN'), out);
  }
});

// 修正前はパスの規則が `:` の直後から始まれず、`key:/…` と `k:~/…` が平文で残った。`=`・`(`・`,`・
// `[`・`;` の直後は修正前から伏せており、変わらないことをあわせて固定する。
test('redact: an absolute or ~/ path right after a separator such as : = ( , is removed', () => {
  for (const [input, expected] of [
    ['key:/zz/ZZ-PATH-MARKER/auth.json', `key:${REDACTED}`],
    ['home:~/zz/ZZ-PATH-MARKER x', `home:${REDACTED} x`],
    ['ENOENT:/zz/ZZ-PATH-MARKER', `ENOENT:${REDACTED}`],
    ['a:b:/zz/ZZ-PATH-MARKER', `a:b:${REDACTED}`],
    // `:` の直後のパスが後ろの file: の URL を飲み込んでも、URL の `(` より後ろまで伏せる。
    ['key:/file://zz(ZZ-PATH-MARKER', `key:${REDACTED}`],
    ['path=/zz/home/ZZ-PATH-MARKER', `path=${REDACTED}`],
    ['--dir=/zz/ZZ-PATH-MARKER', `--dir=${REDACTED}`],
    ['k=~/zz/ZZ-PATH-MARKER', `k=${REDACTED}`],
    ['(/zz/ZZ-PATH-MARKER)', `(${REDACTED})`],
    ['a,/zz/ZZ-PATH-MARKER', `a,${REDACTED}`],
    ['[/zz/ZZ-PATH-MARKER]', `[${REDACTED}]`],
    ['x;/zz/ZZ-PATH-MARKER', `x;${REDACTED}`],
  ]) {
    const out = redactSecrets(input);
    assert.equal(out, expected, input);
    assert.ok(!out.includes('ZZ-PATH-MARKER'), out);
  }
});

test('redact: web URLs, file URLs and relative words keep their previous handling', () => {
  for (const text of ['GET https://example.invalid/a/b', 'http://h.example.invalid:8080/a/b', 'zz://example.invalid/a/b',
    'a/b', 'see zz/ZZ-RELATIVE']) {
    assert.equal(redactSecrets(text), text);
  }
  assert.equal(redactSecrets('cannot load file:///zz/ZZ-PATH-MARKER/x.js'), `cannot load ${REDACTED}`);
  assert.equal(redactSecrets('url=file://zz/ZZ-PATH-MARKER end'), `url=${REDACTED} end`);
});

// 切る長さより短い入力で、2つの規則（`:` の直後のパス・飲み込まれた規則の掛け直し）が
// 文字数の2乗に伸びないことを固定する。各形の20回は数ミリ秒〜数十ミリ秒で終わる。
test('redact: the separator-path pattern and the swallowed-match extension are fast on text shorter than the cut', () => {
  const texts = [
    ':/'.repeat(4000),
    `x ${':'.repeat(7990)}/zz`,
    'Bearer x,'.repeat(888),
    `Bearer x,${'Authorization:'.repeat(570)} y`,
    `Bearer x${"'/a".repeat(2660)} y`,
    `Bearer x,Bearer${' '.repeat(7980)}`,
    `Bearer '${'a'.repeat(7990)} y`,
    `k:/${'file://'.repeat(1140)}(x y`,
  ];
  for (const text of texts) {
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i += 1) redactSecrets(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 300, `${JSON.stringify(text.slice(0, 16))} x ${text.length}, 20 times: ${elapsedMs} ms`);
  }
});

// ---------------------------------------------------------------------------
// 値で伏せる
// ---------------------------------------------------------------------------

test('redact: a registered value is removed whatever its form, wherever and however often it appears', () => {
  const value = marker();
  const oddValue = `zz odd %s ${'$&'} (value) [x]* ${randomBytes(4).toString('hex')}`;
  const registry = createSecretRegistry([value, oddValue]);
  const out = redactSecrets(`a${value}b ${value}${value} c ${oddValue}.`, registry);
  assert.ok(!out.includes(value) && !out.includes(oddValue), out);
  assert.equal(out, `a${REDACTED}b ${REDACTED}${REDACTED} c ${REDACTED}.`);
  // 配列・Set・1つの文字列で渡しても同じ。
  for (const secrets of [[value], new Set([value]), value]) assert.ok(!redactSecrets(`x ${value} y`, secrets).includes(value));
});

test('redact: a value that the form patterns do not know is left alone unless it is registered', () => {
  const value = randomBytes(32).toString('hex'); // 乱数のトークンの形（形式の伏せ字では捕まらない）
  assert.ok(redactSecrets(`token ${value}`).includes(value));
  assert.ok(!redactSecrets(`token ${value}`, [value]).includes(value));
});

test('redact: longer registered values are removed first, so no tail of a longer value is left behind', () => {
  const short = 'zz-fake-originator';
  const long = `${short}-with-a-longer-tail-${randomBytes(4).toString('hex')}`;
  for (const secrets of [[short, long], [long, short]]) {
    const out = redactSecrets(`x ${long} y ${short} z`, secrets);
    assert.equal(out, `x ${REDACTED} y ${REDACTED} z`);
  }
});

test('redact: registered values that cross each other are removed together, leaving no tail of either', () => {
  const nonce = randomBytes(4).toString('hex');
  const left = `zz-left-${nonce}-shared`;
  const right = `${nonce}-shared-zz-right`;
  // 2つの値が重なって現れる（left の後ろ半分が right の前半分）。
  const text = `a zz-left-${nonce}-shared-zz-right b`;
  for (const secrets of [[left, right], [right, left]]) {
    assert.equal(redactRegisteredValues(text, secrets), `a ${REDACTED} b`);
    assert.equal(redactSecrets(text, secrets), `a ${REDACTED} b`);
  }
  // 重ならない値はそれぞれ伏せる。
  assert.equal(redactRegisteredValues(`${left} x ${right}`, [left, right]), `${REDACTED} x ${REDACTED}`);
});

test('redact: redactRegisteredValues removes only registered values and keeps the form of the rest', () => {
  assert.equal(redactRegisteredValues('/internal/reload', ['zz-secret']), '/internal/reload');
  assert.equal(redactRegisteredValues('/internal/zz-secret', ['zz-secret']), `/internal/${REDACTED}`);
  assert.equal(redactRegisteredValues(null, ['zz']), '');
});

test('redact: values are removed before the form patterns, so a pattern cannot split a registered value', () => {
  const value = `zz-lead Bearer zz-middle zz-tail-${randomBytes(4).toString('hex')}`;
  const out = redactSecrets(`before ${value} after`, [value]);
  assert.equal(out, `before ${REDACTED} after`);
});

test('redact: values are removed before truncation, so a cut never leaves part of a registered value', () => {
  const value = marker();
  const out = redactSecrets(`${'x'.repeat(MAX_REDACTED_LENGTH - 20)}${value}${'y'.repeat(50)}`, [value]);
  assert.ok(!out.includes(value.slice(0, 12)), out);
  assert.equal(out.length, MAX_REDACTED_LENGTH);
});

test('redact: the registry ignores empty strings and non-strings and keeps each value once', () => {
  const registry = createSecretRegistry();
  for (const value of ['', null, undefined, 42, {}, ['zz']]) registry.add(value);
  assert.equal(registry.size, 0);
  assert.equal(redactSecrets('text stays', registry), 'text stays');
  registry.add('zz-one').add('zz-one').add('zz-longer-one');
  assert.equal(registry.size, 2);
  assert.deepEqual(registry.values(), ['zz-longer-one', 'zz-one']);
  assert.equal(registry.has('zz-one'), true);
});

// ---------------------------------------------------------------------------
// 例外の1行表示
// ---------------------------------------------------------------------------

test('formatError: only the name and the redacted message, never the stack, cause or extra fields', () => {
  assert.equal(formatError(new TypeError('boom')), 'TypeError: boom');
  const error = new Error('boom');
  error.cause = new Error('inner sk-zz-fake-999');
  error.requestOptions = { headers: { Authorization: 'Bearer zz-fake-abc123' } };
  const line = formatError(error);
  assert.equal(line, 'Error: boom');
  assert.doesNotMatch(line, /at |zz-fake|requestOptions/);
});

test('formatError: a secret in the message or in a replaced name is removed, by form and by value', () => {
  const value = marker();
  const error = new Error(`rejected sk-zz-fake-ABCDEFGH1234 and ${value}`);
  error.name = value;
  const line = formatError(error, [value]);
  assert.ok(!line.includes(value) && !line.includes('sk-zz-fake-ABCDEFGH1234'), line);
  assert.equal(line, `${REDACTED}: rejected ${REDACTED} and ${REDACTED}`);
  const byForm = Object.assign(new Error('boom'), { name: 'sk-zz-fake-error-name' });
  assert.equal(formatError(byForm), `${REDACTED}: boom`);
});

test('formatError: a value that is not an Error is replaced by a fixed text without reading it', () => {
  const value = marker();
  let touched = false;
  const tricky = { toString() { touched = true; return value; }, get message() { touched = true; return value; } };
  for (const input of [null, undefined, 42, { a: 1 }, 'plain string', value, tricky, Object.create(null)]) {
    assert.equal(formatError(input, [value]), NON_ERROR_TEXT);
  }
  assert.equal(touched, false);
});

test('formatError: getters that throw on message or name do not escape', () => {
  const badMessage = new Error('x');
  Object.defineProperty(badMessage, 'message', { get() { throw new Error('getter'); } });
  assert.equal(formatError(badMessage), 'Error: unprintable error');
  const badName = new Error('boom');
  Object.defineProperty(badName, 'name', { get() { throw new Error('getter'); } });
  assert.equal(formatError(badName), 'Error: boom');
  const badToString = new Error('x');
  badToString.message = { toString() { throw new Error('toString'); } };
  assert.equal(formatError(badToString), 'Error: unprintable error');
});
