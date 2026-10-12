// ログイン切れの検出。
//
// codex-rotator は生成を送らないので、口座の認証状態を決める根拠は、使用量の GET の応答
// （401・403）と、資格情報ファイルの読取（期限切れ・読めない）だけである。この部品はその規則
// だけを持ち、プールの状態を次の遷移でだけ動かす。
//   - usageConfirmed（GET の 2xx で ready へ）・usageAuthRejected（needs-login へ）: 専用の遷移
//   - credentials（資格情報が読めた／読めない）・rechecked（再確認をした）: 資格情報の遷移
// 生成の成功を表す遷移は使わない。
//
// 規則（1つの口座について）
//   - 資格情報が読めない: 1周期目は据え置き、2周期続いたら no creds（credentials-unavailable）。
//   - access token の期限切れ（手元の時計）: その周期は GET を送らずに needs login
//     （理由 access-token-expired）。
//   - 資格情報が読めて期限内なら、unknown・no creds の口座は ready へ移す。取得処理は、読めたという
//     結果を GET が終わった後に、GET の結果（usageResult）の直前に渡すので、GET が失敗した周期
//     （5xx など）でも ready へ移る。使用量が分からない間は、プールの規則で選ばれない。
//   - GET の 401: 2回続いたら needs login（理由 upstream-unauthorized）。
//   - GET の 403: 2回続き、かつ同じ周期に別の口座の GET が成功していたら needs login（理由
//     upstream-forbidden）。403 は上流の手前の防御（ボット対策など）でも返りうるので、他の口座の
//     成功で裏付ける。全口座が失敗している周期では裏付けが無いので決めない。口座が1つだけなら
//     403 は数えない（401 だけを数える）。
//   - 401 と 403 が混ざるとき: 直近2回の拒否の種類だけで決める。2回とも 401 なら上の 401 の規則、
//     どちらかが 403 なら上の 403 の規則（裏付けが要る）。それより前の拒否の種類は見ない。
//   - 連続の数え方: GET の成功で0に戻す。資格情報ファイルの更新時刻が前の拒否のときと違えば、
//     1から数え直す（CLI がトークンを更新した直後に古いトークンで断られた分を数えないため）。
//     どちらのときも、直近の拒否の種類の記録も一緒に捨てる。タイムアウト・5xx・429・その他の
//     失敗・GET を送らなかった周期は、増やしも戻しもしない。
//   - needs login の間: GET を送らない。資格情報ファイルの更新時刻が変わったとき、または再確認の
//     時刻（プールの recheckAt。既定は拒否から10分）を過ぎたときだけ、資格情報を読み直して GET を
//     1回送る。成功なら ready へ戻し、それ以外は据え置いて次の再確認を予約する。
//   - 「同じ周期」は、2つの GET の結果の時刻の差が取得の間隔（usagePollIntervalMs）の半分より
//     短いこと。各口座は取得の間隔ごとに1回読むので、別の口座の読取のうち時刻が一番近い1回だけが
//     同じ周期に入り、1つ前や1つ後の周期の成功は入らない（ちょうど半分は、裏付けの無い側に倒す）。
//
// ログには口座のラベルと理由の語だけを出す（上流の応答の本文・資格情報・パスは出さない）。

// needs login と決めるまでに要る、続けての拒否（401・403）の回数。
export const AUTH_REJECTIONS_FOR_NEEDS_LOGIN = 2;
// no creds と決めるまでに要る、続けて資格情報を読めなかった周期の数。
export const UNREADABLE_CYCLES_FOR_NO_CREDS = 2;
// usageAuthRejected() へ渡す理由（account-pool.js の USAGE_AUTH_REJECTION_REASONS と同じ3語）。
export const AUTH_REJECTION_REASON = Object.freeze({
  unauthorized: 'upstream-unauthorized',
  forbidden: 'upstream-forbidden',
  expired: 'access-token-expired',
});
// credentialsRead() が受け取る、資格情報の読取の結果。
export const CREDENTIALS_OUTCOME = Object.freeze({ readable: 'readable', expired: 'expired', unreadable: 'unreadable' });

const DEFAULT_CYCLE_MS = 60000;

function freshState() {
  // recent は直近の拒否の種類（401・403）を、古い順に AUTH_REJECTIONS_FOR_NEEDS_LOGIN 個まで持つ。
  return { rejections: 0, recent: [], forbiddenInStreak: false, rejectionEpoch: undefined, lastRejectionAt: null,
    unreadableCycles: 0, lastSuccessAt: null };
}

function clearRejections(state) {
  state.rejections = 0;
  state.recent = [];
  state.forbiddenInStreak = false;
  state.rejectionEpoch = undefined;
  state.lastRejectionAt = null;
}

/**
 * @param {{ pool: object, now?: () => number, log?: (level: string, event: string, fields: object) => void }} options
 */
export function createAuthTracker({ pool, now = Date.now, log = () => {} } = {}) {
  if (!pool) throw new TypeError('pool required');
  let descriptors = [];
  let cycleMs = DEFAULT_CYCLE_MS;
  const states = new Map();
  const stateOf = key => {
    let state = states.get(key);
    if (!state) {
      state = freshState();
      states.set(key, state);
    }
    return state;
  };
  const labelOf = key => descriptors.find(account => account.key === key)?.label;
  const entryOf = key => pool.snapshot().find(entry => entry.key === key);
  // 同じ周期: 時刻の差が取得の間隔の半分より短い（時刻が一番近い周期に割り当てる）。
  const sameCycle = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < cycleMs / 2;

  function needsLogin(key, reason, seenMtime) {
    const at = now();
    pool.usageAuthRejected(key, at, { reason, seenMtime: seenMtime ?? null });
    clearRejections(stateOf(key));
    log('info', 'codex_auth_needs_login', { account_label: labelOf(key), reason });
  }

  // 403 を含む連続の拒否を、同じ周期の別の口座の成功で裏付けられるか。
  function corroborated(key, state) {
    for (const [other, otherState] of states) {
      if (other === key || !descriptors.some(account => account.key === other)) continue;
      if (sameCycle(otherState.lastSuccessAt, state.lastRejectionAt)) return true;
    }
    return false;
  }

  function decide(key, state) {
    if (state.rejections < AUTH_REJECTIONS_FOR_NEEDS_LOGIN) return;
    if (!state.forbiddenInStreak) needsLogin(key, AUTH_REJECTION_REASON.unauthorized, state.rejectionEpoch);
    else if (corroborated(key, state)) needsLogin(key, AUTH_REJECTION_REASON.forbidden, state.rejectionEpoch);
  }

  // 別の口座の成功が、先に着いていた 403 の連続を裏付ける場合（結果の着く順番によらない）。
  function corroborateOthers(successKey, successAt) {
    for (const [key, state] of states) {
      if (key === successKey || !state.forbiddenInStreak || state.rejections < AUTH_REJECTIONS_FOR_NEEDS_LOGIN) continue;
      if (!descriptors.some(account => account.key === key) || !sameCycle(successAt, state.lastRejectionAt)) continue;
      if (entryOf(key)?.state === 'needs-login') continue;
      needsLogin(key, AUTH_REJECTION_REASON.forbidden, state.rejectionEpoch);
    }
  }

  return {
    /** 口座の一覧と周期の長さ（取得の間隔）を入れ替える。外れた口座の数え方は捨てる。 */
    configure(accounts, { usagePollIntervalMs } = {}) {
      descriptors = accounts;
      cycleMs = Number.isFinite(usagePollIntervalMs) && usagePollIntervalMs > 0 ? usagePollIntervalMs : DEFAULT_CYCLE_MS;
      for (const key of [...states.keys()]) {
        if (!accounts.some(account => account.key === key)) states.delete(key);
      }
    },

    /**
     * この周期に資格情報を読んで GET を送ってよいか。needs login の口座は、資格情報ファイルの
     * 更新時刻が変わったとき、または再確認の時刻を過ぎたときだけ送る。
     */
    shouldRead(key, epoch) {
      const entry = entryOf(key);
      if (!entry || entry.state !== 'needs-login') return true;
      const changed = epoch !== null && epoch !== undefined && epoch !== entry.seenMtime;
      return changed || now() >= entry.recheckAt;
    },

    /** 資格情報の読取の結果（CREDENTIALS_OUTCOME のどれか）を受ける。epoch はその時点の更新時刻。 */
    credentialsRead(key, outcome, epoch) {
      const entry = entryOf(key);
      if (!entry) return;
      const state = stateOf(key);
      const at = now();
      if (outcome === CREDENTIALS_OUTCOME.readable) {
        state.unreadableCycles = 0;
        if (entry.state === 'unknown' || entry.state === 'credentials-unavailable') pool.credentials(key, true, at);
        return;
      }
      if (outcome === CREDENTIALS_OUTCOME.expired) {
        state.unreadableCycles = 0;
        if (entry.state === 'needs-login') {
          pool.rechecked(key, epoch ?? null, at);
          return;
        }
        needsLogin(key, AUTH_REJECTION_REASON.expired, epoch);
        return;
      }
      state.unreadableCycles++;
      if (entry.state === 'needs-login') {
        pool.rechecked(key, epoch ?? null, at);
        return;
      }
      if (state.unreadableCycles < UNREADABLE_CYCLES_FOR_NO_CREDS || entry.state === 'credentials-unavailable') return;
      pool.credentials(key, false, at);
      log('info', 'codex_credentials_unavailable', { account_label: labelOf(key) });
    },

    /**
     * GET の結果（readCodexUsage の戻り値）を受ける。GET を送らなかった周期は result に null を渡す。
     * startedAt はその読取を始めた時刻（ログイン切れと決めた時刻以前の GET で ready へ戻さないため）。
     */
    usageResult(key, result, epoch, { startedAt } = {}) {
      const entry = entryOf(key);
      if (!entry) return;
      const state = stateOf(key);
      const at = now();
      if (result?.classification === 'success') {
        state.lastSuccessAt = at;
        clearRejections(state);
        const before = entry.state;
        pool.usageConfirmed(key, at, Number.isFinite(startedAt) ? startedAt : at);
        if (before === 'needs-login' && entryOf(key)?.state === 'ready') {
          log('info', 'codex_auth_recovered', { account_label: labelOf(key) });
        }
        corroborateOthers(key, at);
        return;
      }
      if (entry.state === 'needs-login') {
        // 再確認で成功しなかった。据え置いて次の再確認を予約する。
        pool.rechecked(key, epoch ?? null, at);
        return;
      }
      const status = result?.classification === 'http-error' ? result.status : null;
      if (status !== 401 && status !== 403) return;
      if (status === 403 && descriptors.length < 2) return;
      if (state.rejections > 0 && state.rejectionEpoch !== epoch) clearRejections(state);
      state.rejections++;
      state.rejectionEpoch = epoch;
      state.lastRejectionAt = at;
      // 403 が含まれるかは、直近の拒否の種類だけで決める（古い 403 が後の 401 の連続を止めないため）。
      state.recent = [...state.recent, status].slice(-AUTH_REJECTIONS_FOR_NEEDS_LOGIN);
      state.forbiddenInStreak = state.recent.includes(403);
      decide(key, state);
    },
  };
}
