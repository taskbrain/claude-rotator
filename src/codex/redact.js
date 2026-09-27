// 秘密の伏せ字。ログ・例外の1行表示へ出す文字列は、必ずここを通す。
//
// 伏せ方は2つある。
//   1. 値で伏せる: 呼び出し側が「秘密として登録した値」（制御トークン、User-Agent と
//      originator の値など）を、形式に関係なくそのまま探して消す。乱数のトークンのように
//      決まった形を持たない値は、形式による伏せ字では捕まらないため。
//   2. 形式で伏せる: API キー（sk-…）・Bearer トークン・Authorization ヘッダ・JWT（3つの部分
//      ごと）・メールアドレス・パス（絶対パス・~/ で始まるパス・file: の URL・引用符で囲まれた
//      / を含む文字列）に見える文字列を消す。登録し忘れた秘密と、例外のメッセージに入り込む
//      口座のフォルダ・資格情報のパスへの保険である。
// 値で伏せる方を先に行う（形式の伏せ字が値の一部だけを書き換えると、残りの部分が値として
// 見つからなくなり、平文で残るため）。

export const REDACTED = '[REDACTED]';
// 1つの値を伏せ字にした後の文字列の長さの上限。切り詰めたときは末尾に目印を付ける。
export const MAX_REDACTED_LENGTH = 200;
const TRUNCATION_SUFFIX = '…(truncated)';
// 形式の規則に掛ける文字列の長さの上限。出力は MAX_REDACTED_LENGTH へ切り詰めるので、これより
// 後ろの文字は表に出ない。切った位置にかかる語と、切った位置で開いたままの引用符の中身は丸ごと
// 伏せる（replaceCutText）。
const MAX_PATTERN_INPUT_LENGTH = 8192;
// Error でない値は中身を読まずにこの文言にする（toString や getter の中身を出さない）。
export const NON_ERROR_TEXT = 'Error: (a value that is not an Error was withheld)';

// 形式で伏せる規則。上から順に、同じ位置では先に書いたものが勝つ。
//   - 引用符（' か "）で囲まれ、/ を含む文字列は、引用符の中を丸ごと消す（引用符は残す）。
//     ファイル操作の例外は `open '<パス>'` の形でパスを出すので、空白を含むパスも相対パスも
//     ここで捕まえる。最初に置くのは、下の絶対パスの規則が空白の手前で止まり、残りが平文で
//     残るのを防ぐため。最初の / までを「/ 以外」で読むのは、後戻りを無くすため（`[^'\n]*\/`
//     のように書くと、閉じの引用符が無いとき / の位置ごとに末尾まで読み直し、処理時間が
//     文字数の2乗に伸びる）。一致する範囲は変わらない。
//   - Authorization: は行末まで丸ごと消す（`Authorization: Bearer <値>` の2語の形で、1語だけを
//     消すと後ろの値が残るため）。
//   - JWT は署名まで3つの部分を消す（ヘッダだけ消すと本文と署名が残るため）。
//   - 引用符の外のパスは、語・`.`・`:`・`/`・`~`・`-` の直後でない `/` か `~/` から始まるもの
//     （URL の中の `//host/path` と `a/b` は対象外）と、`:` の直後の `/` か `~/` から始まるもの
//     （`key:/…`・`k:~/…`。`https://` のように `//` が続くものは URL なので対象外）。空白で止まる
//     ので、空白を含むパスを完全に消せるのは引用符で囲まれた形だけである。file: の URL はパス
//     として丸ごと消す（`file://` は手前の `f` から一致するので、`:` の直後の規則より先に勝つ）。
//   - 空白や改行をまたいで続く規則（Bearer・Authorization:・引用符）の始まりが、先に一致した
//     規則の範囲に飲み込まれたときは、範囲を延ばす（extendSwallowedMatch）。
//   - メールアドレスは2つの規則に分ける。1つ目はローカル部の文字の並びの先頭からだけ始める
//     （並び1つにつき1回しか試さない）。2つ目は、別の規則の一致が並びの途中で終わった直後
//     （`sk-…` の直後の `.user@…` など）のためのもので、ローカル部を 64 文字までに限る。
//     1つの規則で先頭の制限も上限も無いと、@ を含まない長い英数字の並びで開始位置ごとに
//     並びの終わりまで読み直し、処理時間が文字数の2乗に伸びるため。
//     既知の制約: 別の規則の一致がローカル部の途中で終わり、残りが 65 文字以上あると、2つ目の規則は
//     後ろの 64 文字しか伏せず前半が残る。規格上ローカル部は 64 文字までで、実在のアドレスでは起きない。
const SECRET_PATTERN = new RegExp([
  String.raw`(?<=')[^'\n\/]*\/[^'\n]*(?=')`,
  String.raw`(?<=")[^"\n\/]*\/[^"\n]*(?=")`,
  String.raw`sk-[\w-]+`,
  String.raw`Bearer\s+\S+`,
  String.raw`Authorization:[^\n]*`,
  String.raw`eyJ[\w-]{10,}(?:\.[\w-]*){0,2}`,
  String.raw`(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
  String.raw`[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
  String.raw`file:\/\/[^\s'"<>\x60]+`,
  String.raw`(?<![\w.:/~-])~?\/[^\s'"<>()[\]{},;|\x60]+`,
  String.raw`(?<=:)~?\/(?!\/)[^\s'"<>()[\]{},;|\x60]+`,
].join('|'), 'gi');

// 先の一致の終わりを越えて続きうる規則の始まり（組の名前が規則の種類）。
// Bearer・Authorization:・引用符は空白や改行をまたぐ。file: の URL は、パスの規則が止まる
// `(`・`,`・`;` なども含むので、パスの一致に飲み込まれると `file:` より後ろが短く切られる
// （`:/file://(…` の `(…`）。
const REACHING_START = /(?<bearer>Bearer\s)|(?<authorization>Authorization:)|(?<file>file:\/\/)|(?<quote>['"])/iy;
// 規則ごとに、一致が越えられない文字。end の文字がこれ（か文字列の終わり）なら、範囲の中から
// 掛け直しても end を越えないので掛け直さない（同じ行に Authorization: や file:// が並ぶとき、
// 1つごとに行末や語末まで読み直さないため）。Bearer は空白も改行もまたぐので止まる文字が無い。
const REACH_STOP = { authorization: /\n/, file: /[\s'"<>\x60]/, quote: /\n/ };
// 飲み込まれた位置から規則を掛け直すための、同じ規則の sticky 版（その位置から始まる一致だけを見る）。
const SECRET_PATTERN_AT = new RegExp(SECRET_PATTERN.source, 'iy');

// 一致した範囲 [start, end) の中に、end を越えて続きうる規則の始まり（REACHING_START）があれば、
// その位置から規則を掛け直し、一致が end より先へ延びれば end を延ばして返す。先の一致がその
// 始まりを飲み込むと、その規則は掛からず、後ろの値が平文で残るため（`Bearer x,Bearer <値>` の
// 2つ目の値、`Bearer x,Authorization: <値>` の値、`Bearer x,'/zz/a b'` の空白より後ろ、
// `k:/file://(…` の `(…` など）。延ばした部分も同じように調べる（Bearer が3つ以上続く形のため）。
// 延ばすだけで縮めないので、伏せる量は減らない。
// 範囲の中を1文字ずつ sticky の正規表現で調べ、範囲の外は読まない（処理時間は範囲の長さに比例する）。
// end の文字が規則の止まる文字なら掛け直さない（REACH_STOP）。
function extendSwallowedMatch(text, start, end) {
  for (let at = start; at < end; at += 1) {
    REACHING_START.lastIndex = at;
    const found = REACHING_START.exec(text);
    if (found === null) continue;
    const kind = Object.keys(found.groups).find(name => found.groups[name] !== undefined);
    const stop = REACH_STOP[kind];
    if (stop !== undefined && (end === text.length || stop.test(text[end]))) continue;
    // 引用符の規則は中身だけに一致する（引用符は残す）ので、引用符の次の位置から掛け直す。
    SECRET_PATTERN_AT.lastIndex = kind === 'quote' ? at + 1 : at;
    if (SECRET_PATTERN_AT.test(text) && SECRET_PATTERN_AT.lastIndex > end) end = SECRET_PATTERN_AT.lastIndex;
  }
  return end;
}

// 形式の規則に一致する範囲を、前から順に [始まり, 終わり) で返す。終わりは extendSwallowedMatch で
// 延ばした後の位置で、次の一致はそこから探す（延ばさなければ String#replace と同じ範囲になる）。
function* secretRanges(text) {
  const pattern = new RegExp(SECRET_PATTERN); // lastIndex を呼び出しごとに持つ
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const end = extendSwallowedMatch(text, match.index, match.index + match[0].length);
    yield [match.index, end];
    pattern.lastIndex = Math.max(end, match.index + 1); // 空の一致で止まらないための備え
  }
}

function replaceSecretPatterns(text) {
  let out = '';
  let cursor = 0;
  for (const [start, end] of secretRanges(text)) {
    out += text.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return out + text.slice(cursor);
}

// 登録の集まりか、ただの値の並び（配列・Set など）かを見分ける印。
const REGISTRY = Symbol('codex-rotator.secret-registry');

/**
 * 秘密として登録した値の集まり。空文字と文字列以外は登録しない（空文字で伏せると
 * すべての位置に一致してしまう）。values() は長い順に返す。
 */
export function createSecretRegistry(initial = []) {
  const values = new Set();
  const registry = {
    [REGISTRY]: true,
    add(value) {
      if (typeof value === 'string' && value.length > 0) values.add(value);
      return registry;
    },
    has: value => values.has(value),
    values: () => [...values].sort((a, b) => b.length - a.length),
    get size() { return values.size; },
  };
  for (const value of initial) registry.add(value);
  return registry;
}

function secretValuesOf(secrets) {
  if (!secrets) return [];
  if (typeof secrets === 'string') return [secrets]; // 1文字ずつに分けて伏せない
  if (secrets[REGISTRY] === true) return secrets.values();
  return createSecretRegistry(secrets).values();
}

const toText = text => (text === undefined || text === null ? '' : String(text));

// 登録した値に一致する範囲を、元の文字列の上で全部集め、重なるものをまとめる。
// 値を1つずつ置き換えると、2つの値が交差するとき（'abcd' と 'cdef' が 'abcdef' の中にあるなど）、
// 先に置き換えた方が後の値を壊し、後の値の残りが平文で残るため。
function registeredRanges(text, values) {
  const ranges = [];
  for (const value of values) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) ranges.push([at, at + value.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * 登録した値だけを伏せ字にする（形式による伏せ字も切り詰めもしない）。値の形が決まっていて、
 * 形式の規則に掛けると意味が消えるもの（ログの要求のパスなど）に使う。
 */
export function redactRegisteredValues(text, secrets) {
  const source = toText(text);
  const ranges = registeredRanges(source, secretValuesOf(secrets));
  if (ranges.length === 0) return source;
  let out = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += source.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return out + source.slice(cursor);
}

// 切った文字列の末尾で引用符が開いたままのとき、その中身の始まりの位置を返す（無ければ -1）。
// 引用符の規則は閉じの引用符を見て初めて一致するので、閉じの引用符が切り落とされると、
// 中身が他の規則（空白で止まるパスの規則など）にしか掛からず、一部が平文で残る。
// 最後の引用符より後ろに改行が無ければ、その中身は切った位置まで続いているとみなす
// （引用符の規則は改行をまたがない）。どの引用符が開きかは数えない（アポストロフィで
// 数え違えるため）。閉じの引用符でも開きとみなすので、伏せる量が増える側に倒れる。
function openQuoteContentStart(text) {
  const lastNewline = text.lastIndexOf('\n');
  let start = -1;
  for (const quote of [`'`, '"']) {
    const at = text.lastIndexOf(quote);
    if (at > lastNewline && (start === -1 || at + 1 < start)) start = at + 1;
  }
  return start !== -1 && start < text.length ? start : -1;
}

// 語の区切り。規則の `\s`・`\S` と同じ範囲にする。後ろの形を見て初めて一致する規則（メール
// アドレス・JWT）はこの範囲の文字をまたがない。またぐ引用符の規則は openQuoteContentStart で見る。
const WORD_SEPARATOR = /\s/;

// 切った文字列の末尾の語（最後の空白か改行の直後から、切った位置まで）の始まりの位置を返す。
// 空白が1つも無ければ 0（全体が1語）。メールアドレスは、ドメインの後の `.` と英字2字を見て
// 初めて一致するので、切った位置がアドレスの途中に落ちると一致せず、前半が平文で残る。
// 末尾から1文字ずつ戻って探す（`\S*$` のような末尾に固定した正規表現は、開始位置ごとに
// 末尾まで読み直し、処理時間が文字数の2乗に伸びる）。
function lastWordStart(text) {
  let at = text.length;
  while (at > 0 && !WORD_SEPARATOR.test(text[at - 1])) at -= 1;
  return at;
}

// 切った文字列の末尾で丸ごと伏せる範囲の始まりを返す（無ければ -1）。末尾の語と、開いたままの
// 引用符の中身のうち、手前から始まる方に合わせる（両方を覆う。伏せる量が増える側に倒れる）。
function cutTailStart(text) {
  const quote = openQuoteContentStart(text);
  const word = lastWordStart(text);
  const start = quote === -1 ? word : Math.min(quote, word);
  return start < text.length ? start : -1;
}

// 切った文字列に形式の規則を掛け、末尾で丸ごと伏せる範囲（cutTailStart）を、その始まりから
// 切った位置まで1つの伏せ字にする。その手前は切っていない文字列と同じ規則で伏せる（規則は
// 切った文字列の全体に掛けるので、範囲の手前から始まる一致も欠けない）。
function replaceCutText(text) {
  const start = cutTailStart(text);
  if (start === -1) return replaceSecretPatterns(text);
  let out = '';
  let cursor = 0;
  for (const [matchStart, matchEnd] of secretRanges(text)) {
    if (matchStart >= start) break;
    out += text.slice(cursor, matchStart) + REDACTED;
    cursor = matchEnd;
    if (cursor > start) return out; // 一致が範囲へ食い込んだ: 範囲ごとこの伏せ字に含まれる
  }
  return out + text.slice(cursor, start) + REDACTED;
}

/**
 * 文字列の秘密を伏せ字にし、MAX_REDACTED_LENGTH 文字へ切り詰める。
 * @param {unknown} text
 * @param {Iterable<string>|{values: () => string[]}} [secrets] 秘密として登録した値
 * @returns {string}
 */
export function redactSecrets(text, secrets) {
  // 値で伏せた後、形式の規則に掛ける前に長さを切る（規則の処理時間の上限を決めるための多重の
  // 備え）。値で伏せる前には切らない（切った位置で登録した値が半分だけ残り、見つからなくなるため）。
  const source = redactRegisteredValues(text, secrets);
  const out = source.length > MAX_PATTERN_INPUT_LENGTH
    ? replaceCutText(source.slice(0, MAX_PATTERN_INPUT_LENGTH))
    : replaceSecretPatterns(source);
  if (out.length <= MAX_REDACTED_LENGTH) return out;
  return out.slice(0, MAX_REDACTED_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

function readSafely(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * 例外を `名前: 伏せ字済みのメッセージ` の1行にする。stack・cause・その他の
 * プロパティは含めない。名前も伏せ字を通す（名前を差し替えて秘密を載せる経路を塞ぐ）。
 * Error でない値は中身を使わず NON_ERROR_TEXT を返す。getter が例外を投げても投げ返さない。
 * @param {unknown} error
 * @param {Iterable<string>|{values: () => string[]}} [secrets]
 * @returns {string}
 */
export function formatError(error, secrets) {
  if (!readSafely(() => error instanceof Error, false)) return NON_ERROR_TEXT;
  const name = readSafely(() => error.name, 'Error');
  const message = readSafely(() => String(error.message), 'unprintable error');
  const rawName = typeof name === 'string' && name ? name : 'Error';
  return `${redactSecrets(rawName, secrets)}: ${redactSecrets(message, secrets)}`;
}
