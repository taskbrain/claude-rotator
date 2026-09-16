// セッション単位の口座固定（sticky affinity）の鍵と表（設計書 v1.5 §2・§3・§4.4・§8）。
//
// このファイルは単独で完結する。HTTP も fs も触らず、時刻は必ず注入された `now()` から読む。
// `AccountManager` の内部状態は増やさない（設計書 §3）。proxy への結線は R-S7 以降で行う。
//
// 表の鍵は「セッション鍵の SHA-256 先頭12桁」である（§3 の `Map<sidHash, entry>`）。
// 生のセッション id は表にも、ログにも、`runtime-state.json` にも残さない（R7・D-54-1・§8）。
// 生の鍵を表の鍵にする案（§9 F14）は採らなかった——保存形式 §8 が `"k":"<12桁ハッシュ>"` で
// あり、復元後に同じセッションを引き当てるには「セッション id から鍵を再計算できること」が
// 要る。生の鍵を表の鍵にすると、その鍵を保存しない限り復元が成立せず、保存すれば §8 の
// 「生 UUID を含まない」に反する。F14 の衝突（10,000 セッションで約 1.8×10⁻⁷）は残るが、
// 衝突しても要求は必ず通る（R1）。
import { createHash } from 'node:crypto';

/** 保存形式の版（§8）。読み込み時に一致しなければ表ごと捨てる。 */
export const SESSION_AFFINITY_STATE_VERSION = 1;
/** 既定の idle TTL（6時間・§3）。実際の値の正規化とクランプは R-S6 の設定側が行う。 */
export const DEFAULT_IDLE_TTL_MS = 21_600_000;
/** 既定の表の上限（§3）。溢れは `lastSeen` の古い順に落とす。 */
export const DEFAULT_MAX_SESSIONS = 10_000;
/** 鍵の最大長（§2.2）。これを超える値は鍵にしない。 */
export const MAX_SESSION_KEY_LENGTH = 128;

/**
 * 設定セクション `sessionAffinity` の既定（設計書 §6・D-54-6）。
 * `createDefaultConfig()` にはこのキーを足さない——足すと ①浅いマージで、利用者が一部だけ
 * 書いた瞬間に残りが `undefined` になる ②本機能を使わない利用者の生成 `config.json` が
 * 変わる。既定は内部の凍結定数として持ち、キーごとに個別へ正規化する
 * （`normalizeDegradeMapping`(`openai-bridge.js`) と同型）。
 */
export const DEFAULT_SESSION_AFFINITY = Object.freeze({
  mode: 'off',
  idleTtlMs: DEFAULT_IDLE_TTL_MS,
  maxSessions: DEFAULT_MAX_SESSIONS,
  assignStopUtilization: 0.9,
  rebindGraceMs: 60_000,
  persist: true,
});

// `off`＝コード経路にも入らず現行と同一 ／ `observe`＝鍵の抽出とログだけ ／ `on`＝固定。
// 未知の値（大文字・真偽値・数値を含む）はすべて `off` へ倒す（§6）。
const SESSION_AFFINITY_MODES = new Set(['off', 'observe', 'on']);
// 4つの数値キーの値域（§6 の表）。`min` 側も既定へ戻さずクランプする——`rebindGraceMs:0` は
// 「待機の無効化」、`assignStopUtilization:0` は「ゲートの最も厳しい側」であって未指定ではない。
const SESSION_AFFINITY_RANGES = Object.freeze({
  idleTtlMs: { min: 60_000, max: 604_800_000 },
  maxSessions: { min: 1, max: DEFAULT_MAX_SESSIONS, integer: true },
  assignStopUtilization: { min: 0, max: 1 },
  rebindGraceMs: { min: 0, max: 600_000 },
});

const SESSION_ID_HEADER = 'x-claude-code-session-id';
// 制御文字・改行・空白・カンマ結合された重複ヘッダを鍵にしない（§2.2）。
const SESSION_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SID_HASH_PATTERN = /^[0-9a-f]{12}$/;

// 結び付け先を付け替えてよい理由（§4.3 の表・§7.2）。確定（§4.4 ②）でこの3つ以外の理由が
// 来たときは表を書き換えない——認証失敗・throttled・error・上流 5xx・切断・timeout・短期
// レート制限は、その要求だけ別の口座で完走させ、次の要求は元の口座へ戻す（D-63 C3）。
const REBIND_REASONS = new Set(['common_exhausted', 'family_exhausted', 'account_removed']);
// 確定（§4.4 ②）で付け替えてよい理由は枠の枯渇の2値だけである（D-142）。台帳から口座が
// 消えたことは予約段（`affinity_switch`）と退避段（`affinity_evict`）の事象であって、
// 送信直前にバインドを動かす理由にはならない。
const CONFIRM_REBIND_REASONS = new Set(['common_exhausted', 'family_exhausted']);
// 退避の理由（§7.2 の `affinity_evict` ＋ §8.1 の reload で台帳から消えた口座）。
const EVICT_REASONS = new Set(['ttl', 'capacity', 'credential_changed', 'account_removed']);
const UNKNOWN_REASON = 'unknown';

/**
 * セッション鍵を正規化する（設計書 §2.2）。
 * 受理しない値は `null` を返すだけで、要求を拒否も記録もしない（F7）。
 *
 * @param {unknown} raw ヘッダまたは本文から取り出した値。
 * @returns {string|null} 正規化された鍵。使えなければ `null`。
 */
export function normalizeSessionKey(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SESSION_KEY_LENGTH) return null;
  return SESSION_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * ログ・永続化・表の鍵に使う 48bit の指紋（設計書 §2.3・D-54-1）。
 * 正規化してから数えるので、前後に空白の付いた同じセッションは同じ値になる。
 *
 * @param {unknown} key セッション鍵（正規化前でよい）。
 * @returns {string|null} 16進12桁。鍵として使えない値なら `null`。
 */
export function sidHash(key) {
  const normalized = normalizeSessionKey(key);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * 要求からセッション鍵を取り出す（設計書 §2.1・D-54-1）。
 * ①ヘッダ `x-claude-code-session-id` ②本文 `metadata.user_id`（JSON 文字列）の `session_id`
 * ③どちらも使えなければ `null`＝セッション無しとして現行経路へ落とす。
 *
 * `x-claude-code-agent-id` は鍵に混ぜない——混ぜるとサブエージェントだけ別口座へ飛び、
 * 親子ともキャッシュを失う（D-54-1）。
 *
 * @param {{headers?:object, rawHeaders?:string[]}|null} req 受信要求。
 * @param {Buffer|string|object|null} body 本文。解析済みのオブジェクトを渡してもよい
 *   （R-S7 は `routingModelFamily` の解析結果を共有して二重解析を避ける）。
 * @returns {string|null} 正規化済みのセッション鍵。
 */
export function sessionKeyFrom(req, body) {
  const fromHeader = normalizeSessionKey(sessionHeaderValue(req));
  if (fromHeader) return fromHeader;
  return normalizeSessionKey(sessionIdFromBody(body));
}

// 同名ヘッダが複数あれば鍵にしない（§2.2）。Node の http はそれをカンマで結合するので、
// 結合後の値も §2.2 の文字集合で弾かれる（二重の防御）。
function sessionHeaderValue(req) {
  const raw = req?.rawHeaders;
  if (Array.isArray(raw)) {
    let found = null;
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const name = raw[index];
      if (typeof name !== 'string' || name.toLowerCase() !== SESSION_ID_HEADER) continue;
      if (found !== null) return null;
      found = raw[index + 1];
    }
    if (found !== null) return found;
  }
  const value = req?.headers?.[SESSION_ID_HEADER];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return typeof value === 'string' ? value : null;
}

function sessionIdFromBody(body) {
  const userId = parseBody(body)?.metadata?.user_id;
  // spike06 の実測どおり `user_id` は JSON を文字列にしたもの。構造体で来た場合も読む。
  const parsed = typeof userId === 'string' ? parseJson(userId) : userId;
  const sessionId = parsed && typeof parsed === 'object' ? parsed.session_id : null;
  return typeof sessionId === 'string' ? sessionId : null;
}

function parseBody(body) {
  if (body === null || body === undefined) return null;
  if (Buffer.isBuffer(body)) return parseJson(body.toString('utf8'));
  if (typeof body === 'string') return parseJson(body);
  return typeof body === 'object' ? body : null;
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 設定セクション `sessionAffinity` を正規化する（設計書 §6）。
 * セクションが無い・型が違う・キーが欠けている、のいずれでも既定へ倒れるので、
 * 戻り値のキーが `undefined` になることはない。
 *
 * @param {unknown} raw `config.sessionAffinity`。
 * @returns {Readonly<typeof DEFAULT_SESSION_AFFINITY>} 凍結した設定。
 */
export function normalizeSessionAffinity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_SESSION_AFFINITY;
  return Object.freeze({
    mode: normalizeMode(raw.mode),
    idleTtlMs: clampSetting(raw.idleTtlMs, 'idleTtlMs'),
    maxSessions: clampSetting(raw.maxSessions, 'maxSessions'),
    assignStopUtilization: clampSetting(raw.assignStopUtilization, 'assignStopUtilization'),
    rebindGraceMs: clampSetting(raw.rebindGraceMs, 'rebindGraceMs'),
    // 既定が真のキーなので、真偽値の `false` だけを「切った」と読む（型違いは既定へ）。
    persist: raw.persist !== false,
  });
}

/**
 * 起動時に1行だけ残す記録（U17・§5.2 末尾）。
 *
 * `switchThreshold` は sticky の前提ではない（v1.0 の「`mode:"on"` かつ 1 未満なら affinity を
 * off へ倒す」は D-56-7 で撤回した）が、1 未満だと既存の可用性判定と全滅判定がその分だけ
 * 手前で止まるため、後から読めるように値を残す。**`mode:"off"` では1行も出さない**——
 * 未記載構成でログ・status・CLI 出力・`runtime-state.json` を現行と同一に保つため。
 *
 * @param {object|null} settings `normalizeSessionAffinity()` の戻り値。
 * @param {{switchThreshold?:number|null, logger?:Function|null, now?:number}} [options]
 * @returns {string[]} 実際に出した行（`mode:"off"` では空配列）。
 */
export function logSessionAffinityStartupNotice(settings, {
  switchThreshold = null,
  logger = null,
  now = Date.now(),
} = {}) {
  const mode = normalizeMode(settings?.mode);
  if (mode === 'off') return [];
  const threshold = Number.isFinite(switchThreshold) ? switchThreshold : 'unknown';
  const lines = [
    `${new Date(now).toISOString()} affinity config mode=${mode} switchThreshold=${threshold}`,
  ];
  for (const line of lines) logger?.(line);
  return lines;
}

function normalizeMode(value) {
  return SESSION_AFFINITY_MODES.has(value) ? value : DEFAULT_SESSION_AFFINITY.mode;
}

function clampSetting(value, key) {
  const { min, max, integer } = SESSION_AFFINITY_RANGES[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SESSION_AFFINITY[key];
  const clamped = Math.min(max, Math.max(min, value));
  return integer ? Math.floor(clamped) : clamped;
}

/**
 * セッション鍵から結び付け先への表（設計書 §3）。
 *
 * エントリは `{ home, families, gen, boundAt, lastSeen, requests, switches }` で、
 * `gen` は「そのセッションのバインドが変わった回数」を数える単調増加の整数である。
 * 予約（§4.4 ①）で控えた `gen` を確定（②）へ渡すことで、`await` を挟んで遅れて着いた確定が
 * その間に別の要求が作った新しいバインドを上書きすることを防ぐ（D-60-1）。
 *
 * 表の順序は recency（古い順）で保つ。溢れたときは先頭＝最も長く触られていないエントリを
 * 落とす（§3 の LRU）。
 */
export class SessionAffinity {
  constructor({
    mode = DEFAULT_SESSION_AFFINITY.mode,
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
    now = () => Date.now(),
    logger = null,
    onChange = null,
  } = {}) {
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.logger = typeof logger === 'function' ? logger : null;
    // 現在のモードはインスタンスが持つ（FU-69・D-175）。結線側が reload のたびに
    // 直前のモードを渡す方式だと、渡し忘れた瞬間に「有効→off」の affinity_disabled が
    // 黙って消える。applySettings は明示の previousMode が無ければこの値を使う。
    this.mode = normalizeMode(mode);
    // 表が変わったことの唯一の通知口（設計書 §8 の dirty）。バインドが変わったときだけ
    // 呼び、`lastSeen` の更新（再訪）では呼ばない。
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.idleTtlMs = positiveInteger(idleTtlMs, DEFAULT_IDLE_TTL_MS);
    this.maxSessions = positiveInteger(maxSessions, DEFAULT_MAX_SESSIONS);
    this.entries = new Map();
    this.switchCounts = new Map();
    this.evictCounts = new Map();
  }

  get size() {
    return this.entries.size;
  }

  /**
   * そのセッションの現在のバインドを読む。バインドは書き換えない（行うのは TTL 切れの掃除と、
   * 時計が逆行したときの `lastSeen` の丸めだけ・F4）。
   *
   * @param {unknown} key セッション鍵。
   * @param {{modelFamily?:string|null, now?:number}} [options]
   * @returns {object|null} エントリの複製。鍵が使えない・エントリが無い・TTL 切れなら `null`。
   */
  get(key, { modelFamily = null, now = this.now() } = {}) {
    const hash = sidHash(key);
    if (!hash) return null;
    const entry = this.lookup(hash, now);
    return entry ? snapshot(hash, entry, modelFamily) : null;
  }

  /**
   * 予約（§4.4 ①）と確定（②）の唯一の書き込み口。
   *
   * `expectedGen` を渡さなければ予約——エントリが無ければ作り、口座が変わっていれば
   * 付け替えて `gen` を1つ進める。呼び出し側は戻り値の `gen` を `myGen` として控える。
   * `expectedGen` を渡せば確定——表の `gen` が一致するときだけ書き、一致しなければ
   * `affinity_stale` を1行出して捨てる（D-60-1）。確定で付け替えるのは枠の枯渇由来の
   * 理由のときだけである（D-63 C3）。
   *
   * @param {unknown} key セッション鍵。
   * @param {{account:string, modelFamily?:string|null, expectedGen?:number|null,
   *          reason?:string|null, now?:number}} options
   * @returns {object|null} `{ sid, account, gen, disposition, slot, switches, reason }`。
   *   `disposition` は proxy 行の `aff` と同じ語彙（`new` / `bound` / `switch`）に `stale` を足したもの。
   *   鍵が使えない、または口座が空なら `null`（表は1バイトも変えない）。
   */
  note(key, { account, modelFamily = null, expectedGen = null, reason = null, now = this.now() } = {}) {
    const hash = sidHash(key);
    if (!hash) return null;
    if (typeof account !== 'string' || account.length === 0) return null;

    const entry = this.lookup(hash, now);
    if (expectedGen === null || expectedGen === undefined) {
      return this.reserve(hash, entry, { account, modelFamily, reason, now });
    }
    return this.confirm(hash, entry, { account, modelFamily, reason, now, expectedGen });
  }

  /**
   * 猶予の待機に入ったことを1行残す（§4.3.1・§7.2 の `affinity_defer`・D-60-2）。
   *
   * **表は1バイトも変えない。** この行は「バインドが変わらなかった」ことの記録であり、
   * 全損（§7.4 の遷移回数）には数えない。書き込み口を `note()` と分けているのは、
   * 猶予が結び付け先を動かさないことをこのクラスの側でも構造で示すためである。
   *
   * @param {unknown} key セッション鍵。
   * @param {{account:string, waitMs:number, now?:number}} options
   * @returns {{sid:string, account:string, waitMs:number}|null} 出した行の内容。
   *   鍵が使えない・口座が空・待機が正でないなら `null`（1行も出さない）。
   */
  noteDefer(key, { account, waitMs, now = this.now() } = {}) {
    const hash = sidHash(key);
    if (!hash) return null;
    if (typeof account !== 'string' || account.length === 0) return null;
    if (!Number.isFinite(waitMs) || waitMs <= 0) return null;
    this.write(now, `affinity_defer sid=${hash} account=${account} reason=quota_grace waitMs=${waitMs}`);
    return { sid: hash, account, waitMs };
  }

  /**
   * TTL 切れ・容量超過・台帳から消えた口座を表から落とす（§3・§8.1）。
   *
   * @param {{now?:number, knownAccountIds?:Iterable<string>|null}|number} [options]
   *   `knownAccountIds` を渡したときだけ、台帳に残っていない口座へのバインドも落とす
   *   （reload 直後の掃除・§8.1）。渡さなければ TTL と容量だけを見る。
   * @returns {Array<{sid:string, account:string, reason:string, ageMs:number}>} 落としたもの。
   */
  prune(options = {}) {
    const settings = typeof options === 'number' ? { now: options } : (options || {});
    const now = settings.now ?? this.now();
    const known = settings.knownAccountIds ? new Set(settings.knownAccountIds) : null;
    const evicted = [];

    for (const [hash, entry] of [...this.entries]) {
      // F4 の丸めは保持中でも行うので、判定は必ず expired() を通す。
      if (this.expired(entry, now) && !held(entry)) {
        evicted.push(this.dropEntry(hash, entry, 'ttl', now));
        continue;
      }
      if (!known) continue;
      if (!known.has(entry.home)) {
        evicted.push(this.dropEntry(hash, entry, 'account_removed', now));
        continue;
      }
      for (const [family, accountId] of Object.entries(entry.families)) {
        if (known.has(accountId)) continue;
        delete entry.families[family];
        evicted.push(this.recordEvict(hash, entry, accountId, 'account_removed', now));
      }
    }

    evicted.push(...this.trimToCapacity(now));
    return evicted;
  }

  /**
   * 資格情報が別物になった口座・台帳から消えた口座のバインドを落とす（§8.1・D-60-3・F3）。
   * 基本バインドが該当すればセッションごと、系統別副バインドが該当すればその副バインドだけ。
   *
   * @param {Iterable<string>|string|null} ids 対象の口座 ID。
   * @param {{reason?:string, now?:number}} [options]
   * @returns {Array<{sid:string, account:string, reason:string, ageMs:number}>} 落としたもの。
   */
  evictAccounts(ids, { reason = 'credential_changed', now = this.now() } = {}) {
    const targets = new Set(typeof ids === 'string' ? [ids] : (ids ?? []));
    if (targets.size === 0) return [];

    const evicted = [];
    for (const [hash, entry] of [...this.entries]) {
      if (targets.has(entry.home)) {
        evicted.push(this.dropEntry(hash, entry, reason, now));
        continue;
      }
      for (const [family, accountId] of Object.entries(entry.families)) {
        if (!targets.has(accountId)) continue;
        delete entry.families[family];
        evicted.push(this.recordEvict(hash, entry, accountId, reason, now));
      }
    }
    return evicted;
  }

  /**
   * 応答が終わるまで表の行を保持する（§9 F9）。長時間 SSE の途中で TTL・容量の退避に
   * 落とされると、確定（§4.4 ②）が行を見失い、次の要求が別の口座へ載る。
   * 戻り値は解放する関数で、二重に呼んでも保持数は負にならない。
   * `close` / `abort` を含む応答終了で**必ず**呼ぶこと。
   *
   * @param {unknown} key セッション鍵。
   * @returns {() => void} 解放する関数（鍵が使えない・行が無いときは何もしない）。
   */
  hold(key) {
    const hash = sidHash(key);
    const entry = hash ? this.entries.get(hash) : null;
    if (!entry) return () => {};
    entry.holds = (entry.holds ?? 0) + 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holds = Math.max(0, (entry.holds ?? 1) - 1);
    };
  }

  /**
   * 設定の再正規化（§6 の reload）で上限が変わったときに、その場で表へ反映する。
   * `maxSessions` を縮めたときは即 LRU で切り詰める（§3）。
   *
   * @param {{idleTtlMs?:number, maxSessions?:number}} [limits]
   * @param {{now?:number}} [options]
   */
  configure({ idleTtlMs, maxSessions } = {}, { now = this.now() } = {}) {
    if (idleTtlMs !== undefined) this.idleTtlMs = positiveInteger(idleTtlMs, this.idleTtlMs);
    if (maxSessions !== undefined) this.maxSessions = positiveInteger(maxSessions, this.maxSessions);
    return this.prune({ now });
  }

  /**
   * 正規化し直した設定を表へ反映する（§6 の reload）。
   * `off` へ落ちるときは表を破棄して `affinity_disabled sessions=<n>` を1行だけ残す
   * （設定値そのものはログへ出さない）。`off` から有効化するときは空表から開始する。
   * それ以外は上限を入れ直すだけで、結び付け先は保つ。
   *
   * @param {object} settings 生の `config.sessionAffinity` でも正規化済みでもよい。
   * @param {{previousMode?:string, now?:number}} [options] 直前のモード。**既定はインスタンスが
   *   覚えている現在のモード**（FU-69・D-175）——結線側の渡し忘れで `affinity_disabled` が
   *   消えないように、明示されたときだけそちらを優先する。
   * @returns {{mode:string, previousMode:string, cleared:number, evicted:Array}}
   */
  applySettings(settings, { previousMode = this.mode, now = this.now() } = {}) {
    const next = normalizeSessionAffinity(settings);
    const previous = normalizeMode(previousMode);
    this.mode = next.mode;

    if (next.mode === 'off') {
      const cleared = this.entries.size;
      this.entries.clear();
      if (previous !== 'off') this.write(now, `affinity_disabled sessions=${cleared}`);
      if (cleared > 0) this.markChanged();
      return { mode: next.mode, previousMode: previous, cleared, evicted: [] };
    }

    const cleared = previous === 'off' ? this.entries.size : 0;
    if (previous === 'off') this.entries.clear();
    if (cleared > 0) this.markChanged();
    const evicted = this.configure(
      { idleTtlMs: next.idleTtlMs, maxSessions: next.maxSessions },
      { now },
    );
    return { mode: next.mode, previousMode: previous, cleared, evicted };
  }

  /**
   * status 出力用の集計（§7.3）。
   * `sessionsByAccount` は「その口座に結び付いているセッション数」であり、系統別副バインドで
   * 1セッションが2口座に数えられるため、**合計はセッション総数と一致しない**。
   */
  summary() {
    const sessionsByAccount = {};
    for (const entry of this.entries.values()) {
      for (const accountId of new Set([entry.home, ...Object.values(entry.families)])) {
        sessionsByAccount[accountId] = (sessionsByAccount[accountId] ?? 0) + 1;
      }
    }
    return {
      sessions: this.entries.size,
      capacity: this.maxSessions,
      idleTtlMs: this.idleTtlMs,
      sessionsByAccount,
      switchesByReason: Object.fromEntries(this.switchCounts),
      evictionsByReason: Object.fromEntries(this.evictCounts),
    };
  }

  /**
   * `runtime-state.json` へ相乗りさせる表のスナップショット（§8）。
   * 含めるのは ①12桁ハッシュ ②口座ラベル ③系統別副バインド ④epoch ms ⑤切替回数だけで、
   * 秘密・メールアドレス・生 UUID は含まない。**世代番号 `gen` は保存しない**（D-60-1）。
   */
  export({ now = this.now() } = {}) {
    const entries = [];
    for (const [hash, entry] of this.entries) {
      const record = { k: hash, a: entry.home };
      if (Object.keys(entry.families).length > 0) record.f = { ...entry.families };
      record.t = entry.lastSeen;
      record.s = entry.switches;
      entries.push(record);
    }
    return { version: SESSION_AFFINITY_STATE_VERSION, savedAt: new Date(now).toISOString(), entries };
  }

  /**
   * 保存した表を読み戻す（§8 の破棄条件・§8.1・F1）。
   * 該当分を捨てるだけで、**起動は必ず成功させる**。
   *
   * 破棄条件: ①`version` 不一致 ②`savedAt` が未来（時計逆行） ③口座が現台帳に無い
   * ④`now - t > idleTtlMs` ⑤`maxSessions` 超過分（`t` 降順で残す）
   * ⑥`credentialIdentityChanged` が真だった口座（D-60-3・F3）。
   *
   * @param {object|null} saved 保存された `sessionAffinity` セクション。
   * @param {{accountManager?:{accounts?:Array}|null, knownAccountIds?:Iterable<string>|null,
   *          credentialChangedAccountIds?:Iterable<string>|null, now?:number}} [options]
   *   `credentialChangedAccountIds` は `restoreState` の戻り値をそのまま渡す。`undefined`
   *   （早期 return の名残）でも壊れないよう「該当なし」として扱う。
   * @returns {{restored:number, skipped:string|null, dropped:object}}
   */
  restore(saved, {
    accountManager = null,
    knownAccountIds = null,
    credentialChangedAccountIds = null,
    now = this.now(),
  } = {}) {
    const dropped = { unknown_account: 0, ttl: 0, capacity: 0, credential_changed: 0 };
    const skip = reason => {
      // F1: 壊れた保存データの本文はログへ出さない。理由コードだけを1行。
      this.write(now, `affinity_restore skipped=${reason}`);
      return { restored: 0, skipped: reason, dropped };
    };

    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || !Array.isArray(saved.entries)) {
      return skip('malformed');
    }
    if (saved.version !== SESSION_AFFINITY_STATE_VERSION) return skip('version');
    const savedAt = Date.parse(saved.savedAt);
    if (!Number.isFinite(savedAt) || savedAt > now) return skip('saved-at');

    const known = knownAccountIds ? new Set(knownAccountIds) : accountIdsOf(accountManager);
    const changed = new Set(credentialChangedAccountIds ?? []);
    const usable = [];

    for (const record of saved.entries) {
      if (!record || typeof record !== 'object') continue;
      const hash = typeof record.k === 'string' && SID_HASH_PATTERN.test(record.k) ? record.k : null;
      const home = typeof record.a === 'string' && record.a.length > 0 ? record.a : null;
      if (!hash || !home || !Number.isFinite(record.t)) continue;

      if (changed.has(home)) {
        dropped.credential_changed += 1;
        continue;
      }
      if (known && !known.has(home)) {
        dropped.unknown_account += 1;
        continue;
      }
      const lastSeen = Math.min(record.t, now);
      if (now - lastSeen > this.idleTtlMs) {
        dropped.ttl += 1;
        continue;
      }

      const families = {};
      const savedFamilies = record.f && typeof record.f === 'object' ? record.f : {};
      for (const [family, accountId] of Object.entries(savedFamilies)) {
        if (typeof accountId !== 'string' || accountId.length === 0) continue;
        // 副バインドだけが該当するときは、その副バインドを落として home は残す（D-63 C2）。
        if (changed.has(accountId)) continue;
        if (known && !known.has(accountId)) continue;
        families[family] = accountId;
      }

      usable.push({
        hash,
        entry: {
          home,
          families,
          gen: 0,
          boundAt: lastSeen,
          lastSeen,
          requests: 0,
          switches: Number.isFinite(record.s) ? record.s : 0,
        },
      });
    }

    usable.sort((left, right) => right.entry.lastSeen - left.entry.lastSeen);
    // 空の表へ読み戻すのが通常（起動時・§8.1）。すでに何か入っている表へ読み戻すときは、
    // 生きているエントリを押し出さないよう空き分だけを復元する。
    const room = Math.max(0, this.maxSessions - this.entries.size);
    if (usable.length > room) {
      dropped.capacity = usable.length - room;
      usable.length = room;
    }
    // 表の順序は recency（古い順）で保つので、古いほうから入れ直す。
    for (const { hash, entry } of usable.reverse()) this.entries.set(hash, entry);

    return { restored: usable.length, skipped: null, dropped };
  }

  // --- 内部 ---------------------------------------------------------------

  lookup(hash, now) {
    const entry = this.entries.get(hash);
    if (!entry) return null;
    if (!this.expired(entry, now)) return entry;
    // F9: 応答中の行は落とさない。解放されてから次の掃除で落ちる。
    if (held(entry)) return entry;
    this.dropEntry(hash, entry, 'ttl', now);
    return null;
  }

  // F4: 時計が逆行したらエントリを捨てず `lastSeen` を now へ丸め、経過時間は
  // Math.max(0, …) で測る（負の経過時間で全消ししない）。
  expired(entry, now) {
    if (entry.lastSeen > now) entry.lastSeen = now;
    return now - entry.lastSeen > this.idleTtlMs;
  }

  reserve(hash, entry, { account, modelFamily, reason, now }) {
    if (!entry) {
      const created = {
        home: account,
        families: {},
        gen: 1,
        boundAt: now,
        lastSeen: now,
        requests: 1,
        switches: 0,
      };
      this.entries.set(hash, created);
      this.trimToCapacity(now, hash);
      this.write(now, `affinity_bind sid=${hash} account=${account} reason=new_session sessions=${this.entries.size}`);
      this.markChanged();
      return result(hash, account, created, 'new', 'home', 'new_session');
    }

    entry.requests += 1;
    this.touch(hash, entry, now);
    const bound = boundAccount(entry, modelFamily);
    if (bound === account) return result(hash, account, entry, 'bound', null, reason);
    // 予約で口座が変わるのは、選択側が新しい結び付け先を決めたときである（§4.1）。
    return this.rebind(hash, entry, { account, modelFamily, reason, now, gen: entry.gen + 1 });
  }

  confirm(hash, entry, { account, modelFamily, reason, now, expectedGen }) {
    if (!entry || entry.gen !== expectedGen) {
      // 待っているあいだに別の要求が新しいバインドを作った。遅着した確定は捨て、
      // この要求は送信済みの口座でそのまま完走させる（D-60-1）。
      this.write(now, `affinity_stale sid=${hash} myGen=${expectedGen} curGen=${entry ? entry.gen : 'none'} dropped=${account}`);
      return {
        sid: hash,
        account,
        gen: entry ? entry.gen : null,
        disposition: 'stale',
        slot: null,
        switches: entry ? entry.switches : 0,
        reason: reason ?? null,
      };
    }

    this.touch(hash, entry, now);
    const bound = boundAccount(entry, modelFamily);
    if (bound === account) return result(hash, account, entry, 'bound', null, reason);
    // 枠の枯渇由来のときだけ付け替える。一時障害（認証失敗・throttled・error・上流 5xx・
    // 切断・timeout・短期レート制限）では表を書き換えない（D-63 C3・§4.3 の表）。
    if (!CONFIRM_REBIND_REASONS.has(reason)) return result(hash, bound, entry, 'bound', null, reason);
    return this.rebind(hash, entry, { account, modelFamily, reason, now, gen: expectedGen + 1 });
  }

  rebind(hash, entry, { account, modelFamily, reason, now, gen }) {
    const from = boundAccount(entry, modelFamily);
    const slot = rebindSlot(entry, modelFamily, reason);
    if (slot === 'family') {
      entry.families[modelFamily] = account;
    } else {
      // home を付け替えるときは副バインドを破棄する——副バインドは home の系統別の
      // 迂回先なので、home が移れば前提が変わる（§4.1・D-56-4）。
      entry.home = account;
      entry.families = {};
      entry.boundAt = now;
    }
    entry.gen = gen;
    entry.switches += 1;

    const label = REBIND_REASONS.has(reason) ? reason : UNKNOWN_REASON;
    bump(this.switchCounts, label);
    this.write(
      now,
      `affinity_switch sid=${hash} from=${from} to=${account}`
      + ` reason=${label} family=${modelFamily === 'fable' ? 'fable' : 'other'} switches=${entry.switches}`,
    );
    this.markChanged();
    return result(hash, account, entry, 'switch', slot, label);
  }

  touch(hash, entry, now) {
    entry.lastSeen = now;
    // Map の挿入順を recency として使う（LRU の退避が O(1) で済む）。
    this.entries.delete(hash);
    this.entries.set(hash, entry);
  }

  trimToCapacity(now, protectedHash = null) {
    const evicted = [];
    while (this.entries.size > this.maxSessions) {
      // 古い順に、応答中（F9）でも作ったばかりでもない行を1つ選ぶ。候補が無ければ
      // 容量超過を一時的に許す——要求は必ず通す方を優先する（R1）。
      let victim = null;
      for (const candidate of this.entries) {
        if (candidate[0] === protectedHash || held(candidate[1])) continue;
        victim = candidate;
        break;
      }
      if (!victim) break;
      evicted.push(this.dropEntry(victim[0], victim[1], 'capacity', now));
    }
    return evicted;
  }

  dropEntry(hash, entry, reason, now) {
    this.entries.delete(hash);
    return this.recordEvict(hash, entry, entry.home, reason, now);
  }

  recordEvict(hash, entry, account, reason, now) {
    const ageMs = Math.max(0, now - entry.lastSeen);
    const label = EVICT_REASONS.has(reason) ? reason : UNKNOWN_REASON;
    bump(this.evictCounts, label);
    this.write(now, `affinity_evict sid=${hash} account=${account} reason=${label} ageMs=${ageMs}`);
    this.markChanged();
    return { sid: hash, account, reason: label, ageMs };
  }

  // 表が変わったことを結線側へ知らせる（設計書 §8 の dirty）。通知そのものが失敗しても
  // HTTP 処理を巻き添えにしない——永続化は次の書き込みで必ず追いつく。
  markChanged() {
    if (!this.onChange) return;
    try {
      this.onChange();
    } catch {
      // 保存の予約に失敗しても表の一貫性は保たれる。
    }
  }

  write(now, line) {
    if (!this.logger) return;
    this.logger(`${new Date(now).toISOString()} ${line}`);
  }
}

// F9 の保持数。復元・保存には現れない（`export` は項目を明示して組み立てる）。
function held(entry) {
  return (entry.holds ?? 0) > 0;
}

function snapshot(hash, entry, modelFamily) {
  return {
    sid: hash,
    home: entry.home,
    bound: boundAccount(entry, modelFamily),
    families: { ...entry.families },
    gen: entry.gen,
    boundAt: entry.boundAt,
    lastSeen: entry.lastSeen,
    requests: entry.requests,
    switches: entry.switches,
  };
}

function boundAccount(entry, modelFamily) {
  const sub = modelFamily ? entry.families[modelFamily] : null;
  return sub ?? entry.home;
}

// 付け替える範囲は「いま使えなかった結び付け先」に限る（D-63 C2）。
// 当該系統の副バインドが使われていたならその副バインドだけを、home が使われていたなら
// home を付け替える。系統枠だけが枯れたときは副バインドを新しく1つ作る（D-54-3）。
function rebindSlot(entry, modelFamily, reason) {
  if (!modelFamily) return 'home';
  if (reason === 'family_exhausted') return 'family';
  return entry.families[modelFamily] != null ? 'family' : 'home';
}

function result(hash, account, entry, disposition, slot, reason) {
  return {
    sid: hash,
    account,
    gen: entry.gen,
    disposition,
    slot,
    switches: entry.switches,
    reason: reason ?? null,
  };
}

function accountIdsOf(accountManager) {
  const accounts = accountManager?.accounts;
  if (!Array.isArray(accounts)) return null;
  return new Set(accounts.map(account => account?.id).filter(id => typeof id === 'string'));
}

function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
