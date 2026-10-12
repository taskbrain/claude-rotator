// ループバックの待受に関する共用部品。Claude 側の proxy（src/proxy-server.js）と、codex-rotator の
// 常駐・CLI の両方が使う。
//
// 共用部品なので、import してよいのは src/shared/ と node: の標準部品だけ（境界検査）。このファイルは
// 何も import しない（要求関数は呼出し元から受け取る）。
//
// 中身は3つ:
//   1. 要求を信用するかの検査（assertLoopbackProxyHost・isTrustedLocalHttpRequest・
//      loopbackHostAuthority・isLoopbackHostname）。src/proxy-server.js から中身を変えずに移した。
//   2. 常駐の接続先の URL を作る関数 localServiceUrl。既定のポートを持たない。ポートが 0・undefined・
//      範囲外なら、既定値へ置き換えずに例外にする（既定値を補うのは設定の読込だけ）。
//   3. 常駐への要求の関数 requestLocal。要求関数（http.request 相当）を必ず引数で受け、既定の
//      http.request へ落ちない（テストでは隔離の補助の「登録した接続先以外は拒否」する関数を渡す）。
//      全体の期限と、応答の本文の大きさの上限を持つ。失敗の例外のメッセージには、要求のヘッダ・本文・
//      下の層の例外のメッセージを入れない（制御トークンなどがヘッダで渡るため）。下の層の例外から
//      引き継ぐのは、許した接続の失敗の語（LOCAL_HTTP_FORWARDED_CODES）の code だけ。

// ---------------------------------------------------------------------------
// 1. 要求を信用するかの検査（src/proxy-server.js から移した。中身は変えていない）
// ---------------------------------------------------------------------------

export function assertLoopbackProxyHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (['127.0.0.1', '::1', 'localhost'].includes(normalized)) return;
  throw new Error(`Proxy host must be loopback, received ${normalized || '<empty>'}`);
}

export function isTrustedLocalHttpRequest(req) {
  const hostAuthority = loopbackHostAuthority(req.headers.host);
  if (!hostAuthority) return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && isLoopbackHostname(parsed.hostname)
      && parsed.host.toLowerCase() === hostAuthority;
  } catch {
    return false;
  }
}

export function loopbackHostAuthority(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return isLoopbackHostname(parsed.hostname) ? parsed.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname) {
  return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(
    String(hostname || '').trim().toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// 2. 常駐の接続先の URL
// ---------------------------------------------------------------------------

/** 常駐へ接続するときの相手。常駐はループバックだけで待ち受ける。 */
export const LOCAL_SERVICE_HOST = '127.0.0.1';

// パスは `/` で始まり、パスに使う文字だけからなるもの（問い合わせ文字列・断片・空白を含めない）。
const LOCAL_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]*$/;

function isValidLocalPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 常駐の接続先の URL を作る。既定値を持たない。
 * @param {number} port 実際に待ち受けている番号（1〜65535 の整数）。0・undefined・範囲外・数でない値は
 *   RangeError（設定のポート 0 や欠けたポートを、既定の番号へ置き換えない）。
 * @param {string} path `/` で始まるパス（例 `/internal/status`）。形が違えば TypeError。
 * @returns {string} `http://127.0.0.1:<port><path>`
 */
export function localServiceUrl(port, path) {
  if (!isValidLocalPort(port)) {
    throw new RangeError('local service port must be an integer from 1 to 65535; 0 and a missing port are not replaced by a default');
  }
  if (typeof path !== 'string' || !LOCAL_PATH_PATTERN.test(path)) {
    throw new TypeError('local service path must start with / and contain only path characters');
  }
  return `http://${LOCAL_SERVICE_HOST}:${port}${path}`;
}

// ---------------------------------------------------------------------------
// 3. 常駐への要求
// ---------------------------------------------------------------------------

/** requestLocal の全体の期限の既定値（要求を出してから応答の本文を読み終えるまで）。 */
export const DEFAULT_LOCAL_REQUEST_TIMEOUT_MS = 2000;
/** requestLocal が受け取る応答の本文の大きさの上限の既定値。 */
export const DEFAULT_LOCAL_RESPONSE_MAX_BYTES = 1024 * 1024;

/** setTimeout が受けられる最大の期限（これを超えると Node は 1 ms に置き換える）。 */
export const MAX_LOCAL_REQUEST_TIMEOUT_MS = 2147483647;

/** requestLocal が自分で付ける例外の code。 */
export const LOCAL_HTTP_ERROR = Object.freeze({
  timeout: 'ELOCALTIMEOUT',
  tooLarge: 'ELOCALTOOLARGE',
  cutOff: 'ELOCALCUTOFF',
  failed: 'ELOCALREQUEST',
});

/**
 * 下の層（要求関数・応答）の例外から引き継ぐ code。これ以外の code と、code の無い例外は
 * LOCAL_HTTP_ERROR.failed にする（任意の code を通すと、要求の中身を code に載せて持ち出せるため）。
 * ECONNREFUSED は、呼出し側が「常駐が無い」の判定に使う。EISOLATION はテストの隔離の拒否。
 */
export const LOCAL_HTTP_FORWARDED_CODES = Object.freeze(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE',
  'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EISOLATION']);
const FORWARDED_CODES = new Set(LOCAL_HTTP_FORWARDED_CODES);

const LOCAL_METHODS = new Set(['GET', 'POST']);

/** requestLocal の失敗。メッセージは固定の文言だけで、要求の中身と下の層のメッセージを含まない。 */
export class LocalHttpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LocalHttpError';
    this.code = code;
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

// 下の層の例外の code を1回だけ読む。読むのは例外そのものが持つ値のプロパティだけで、getter は呼ばない
// （1回目と2回目で違う値を返す getter や、読むと例外を投げる getter で検査をすり抜けさせないため）。
// 調べる途中で例外が出たら（Proxy など）、中身を見ずに undefined を返す。この関数は例外を投げない。
function lowerLayerCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

// 下の層の例外は、許した code だけを引き継いだ新しい例外に替える。メッセージ・スタック・ほかの
// プロパティは持ち込まない。下の層が LocalHttpError を投げても同じく作り直す（自分で作る例外は
// finish() へ直接渡すので、ここを通らない）。引き継ぐのは、読んだ値が文字列で、許した語と完全に
// 一致するときだけ。この関数は例外を投げない（非同期の経路でも finish() の後片付けまで必ず届く）。
function asLocalHttpError(error) {
  const code = lowerLayerCode(error);
  const forwarded = typeof code === 'string' && FORWARDED_CODES.has(code) ? code : LOCAL_HTTP_ERROR.failed;
  return new LocalHttpError('local request failed', forwarded);
}

// requestLocal の後始末の設計。
//
// 下の層（要求関数が返す要求 req と、req が知らせる応答）への前提（この3つの外は保証しない）:
//   1. response は多くとも1回しか知らせない。ただし、コードは2回目以降も安全に扱う。同じオブジェクトの
//      再通知は、捨てたものを含めて無視する。別の応答には、何もしない error の受け手を付けてから、読まずに
//      破棄する。追加の応答の後始末の失敗は、採用した応答の決着を変えない。
//   2. 本関数が行う on・end・destroy の呼出しの中と、プロパティの読取（headers・statusCode の getter 等）の
//      中で、本関数が監視している出来事（response・data・end・close・error）を同期に出して、本関数へ再入
//      しない。受け手の関数が戻った後に、同じ手番で次の出来事を続けて出すことは許す。Node の destroy が
//      同期に aborted を出すことは許す（本関数は監視していない）。
//   3. on は投げない。それ以外の読取・呼出しが同期に投げることは許す。その場合は、許した code だけを
//      引き継いだ例外にして reject する。
// 前提の外の下の層に対しては、決着が1回であることと、例外の中身を持ち出さないことを保証しない。
// 渡してよい要求関数は、http.request と、同じ規則で振る舞うテストの偽物だけ。
//
// 前提の内での約束（決着は1回・Promise の外へ出る例外は0）を守る仕組み:
//   a. 要求を得た直後と、採用した応答を得た直後に、何かを読む・呼ぶ前に error の受け手を登録する（採用した
//      応答には close の受け手も）。受け手は決着の後も外さず、決着の後に届いた error は settle が捨てる。
//   b. 決着（resolve・reject）は settle の1か所だけで行い、2回目以降は何もしない。reject に渡すのは、
//      asLocalHttpError の戻り値か、自分で作る固定の例外（期限切れ・上限超え・途中切れ）だけ。
//   c. 上限超えなどで失敗を見つけたら先に決着し、要求と採用した応答の破棄は settle の片付けの1か所だけで
//      行う（破棄が投げても、出来事を出しても、決着は変わらない）。
//   d. 下の層の読取・呼出しは、守りの包み guard の中で行い、出た例外は settle(asLocalHttpError(e)) へ送る。
//      決着の後の片付けと、追加の応答の後始末は、黙って捨てる包み quietly の中で行う。
//      guard・quietly・settle・asLocalHttpError は投げない。
//   e. 最初に知らせた応答だけを採る。知らせた応答は WeakSet に記録し、同じオブジェクトの再通知は無視する。
//   f. 決着の後は req.end を呼ばない（前提の内では、end の前に決着する経路は無い。防御の分岐）。
/**
 * 常駐へ1回だけ要求を出し、応答を読み切って返す。リダイレクトはたどらない。
 *
 * 引数の誤り（要求関数が無い・ポートやパスの形が違う・方法が GET と POST 以外・期限が 1〜2147483647 の
 * 整数でない・上限が正の整数でない・本文が文字列と Buffer 以外）は、要求を出す前にその場で例外にする
 * （Promise を返さない）。要求を出した後の失敗は、LocalHttpError で reject する。
 *
 * ヘッダは、呼出し側が渡した Host・Origin・sec-fetch-site をそのまま送る（常駐の拒否の検査のテストが
 * 使う）。本番の呼出し側は、外から来た値をヘッダに入れない。
 *
 * @param {object} options
 * @param {Function} options.request 要求関数（http.request と同じ呼び方の関数）。必須で、既定値は無い。
 *   渡してよいのは http.request と、それと同じ手番の規則で振る舞うテストの偽物だけ。前提の外の要求関数に
 *   対しては、決着1回と持ち出し0を保証しない（上の「requestLocal の後始末の設計」の前提1〜3）。
 * @param {number} options.port 接続先の番号（localServiceUrl と同じ検査）
 * @param {string} options.path 接続先のパス
 * @param {'GET'|'POST'} [options.method]
 * @param {Record<string, string>} [options.headers] 要求ヘッダ。content-length はここで付け直す。
 * @param {string|Buffer} [options.body]
 * @param {number} [options.timeoutMs] 全体の期限（既定 DEFAULT_LOCAL_REQUEST_TIMEOUT_MS）
 * @param {number} [options.maxResponseBytes] 応答の本文の上限（既定 DEFAULT_LOCAL_RESPONSE_MAX_BYTES）
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function requestLocal({
  request, port, path, method = 'GET', headers = {}, body,
  timeoutMs = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS, maxResponseBytes = DEFAULT_LOCAL_RESPONSE_MAX_BYTES,
} = {}) {
  if (typeof request !== 'function') {
    throw new TypeError('requestLocal needs a request function; it has no default and never falls back to http.request');
  }
  const url = localServiceUrl(port, path);
  if (!LOCAL_METHODS.has(method)) throw new TypeError('requestLocal method must be GET or POST');
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('requestLocal headers must be a plain object');
  }
  if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
    throw new TypeError('requestLocal body must be a string or a Buffer');
  }
  if (!isPositiveInteger(timeoutMs) || timeoutMs > MAX_LOCAL_REQUEST_TIMEOUT_MS) {
    throw new RangeError('requestLocal timeoutMs must be an integer from 1 to 2147483647');
  }
  if (!isPositiveInteger(maxResponseBytes)) throw new RangeError('requestLocal maxResponseBytes must be a positive integer');

  const payload = body === undefined ? null : Buffer.from(body);
  const requestHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-length') requestHeaders[name] = value;
  }
  if (payload) requestHeaders['content-length'] = String(payload.length);
  // 1回ずつの要求なので、接続を使い回さずに閉じる（CLI の終了と常駐の停止を待たせない）。
  if (!Object.keys(requestHeaders).some(name => name.toLowerCase() === 'connection')) requestHeaders.connection = 'close';

  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    // 採用した応答（最初に知らせたもの）。本文・大きさはこの応答のものだけを持つ。
    let res = null;
    let timer = null;
    const chunks = [];
    let size = 0;
    // 知らせた応答の記録（採用したもの・捨てたものの両方）。同じオブジェクトの再通知を無視するため。
    const notified = new WeakSet();

    // d: 下の層への読取と呼出しの包み。出た例外は許した code だけを持つ例外に替えて settle へ送る。
    const guard = action => {
      try {
        return action();
      } catch (error) {
        settle(asLocalHttpError(error));
        return undefined;
      }
    };
    // d: 黙って捨てる包み。決着の後の片付けと、追加の応答の後始末に使う（その失敗を決着へ送らない）。
    const quietly = action => {
      try {
        action();
      } catch {
        // 捨てる。
      }
    };

    // b・c: 決着はここだけ。reject した後に、要求と採用した応答をここで1回だけ破棄する。
    function settle(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        quietly(() => req?.destroy());
        quietly(() => res?.destroy());
      } else {
        resolve(value);
      }
    }

    const tooLarge = () => new LocalHttpError('local response is too large', LOCAL_HTTP_ERROR.tooLarge);
    const cutOff = () => new LocalHttpError('local response was cut off', LOCAL_HTTP_ERROR.cutOff);
    // a: error の受け手は決着の後も外さない。決着の後に届いた error は、settle が黙って捨てる。
    const onLowerLayerError = error => settle(asLocalHttpError(error));
    const ignoreError = () => {};

    const onData = chunk => guard(() => {
      if (settled) return;
      size += chunk.length;
      if (size > maxResponseBytes) {
        settle(tooLarge());
        return;
      }
      chunks.push(chunk);
    });

    const onEnd = () => guard(() => {
      if (settled) return;
      // 値を先に読み切ってから決着する（読取で投げたら、包みが reject する）。
      const value = { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
      settle(null, value);
    });

    // e: 採らない応答（2つ目以降・決着の後に届いたもの）は、何もしない error の受け手を付けてから、読まずに
    // 破棄する。この後始末の失敗は、採用した応答の決着を変えない。
    const discard = response => {
      quietly(() => response.on('error', ignoreError));
      quietly(() => response.destroy());
    };

    const adopt = response => guard(() => {
      res = response;
      // a: 何かを読む前に error と close の受け手を登録する。
      response.on('error', onLowerLayerError);
      // 'end' の前に閉じたら、本文が途中で切れている（'end' の後なら決着済みなので何もしない）。
      response.on('close', () => settle(cutOff()));
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxResponseBytes) {
        settle(tooLarge());
        return;
      }
      response.on('data', onData);
      response.on('end', onEnd);
    });

    const onResponse = response => {
      // e: 同じオブジェクトの再通知は、捨てたものを含めて無視する。
      if (notified.has(response)) return;
      quietly(() => notified.add(response));
      if (settled || res !== null) {
        discard(response);
        return;
      }
      adopt(response);
    };

    timer = setTimeout(() => settle(new LocalHttpError('local request timed out', LOCAL_HTTP_ERROR.timeout)), timeoutMs);
    guard(() => {
      req = request(url, { method, headers: requestHeaders });
      // a: 要求を得た直後、何かを呼ぶ前に error の受け手を登録する。
      req.on('error', onLowerLayerError);
      req.on('response', onResponse);
      // f: 決着の後は end を呼ばない（防御の分岐）。
      if (!settled) req.end(payload ?? undefined);
    });
  });
}
