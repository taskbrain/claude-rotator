// 出来事（Events）の記録。メモリだけに、新しい方から決まった件数まで持つ（ファイルへは書かない）。
//
// 1件は { at, type, label } だけ。at は UTC の日時、type は決まった語、label は口座のラベルか null。
// 語の外の type と、ラベルの形に合わない label は記録しない（状態の JSON に口座のラベル以外の識別子を
// 出さないため）。
//
// 取得処理（usage-poller.js）と認証の規則（auth-tracker.js）は、停止・解除・窓の停止だけの解除・
// ログイン切れ・復帰をログ（log(level, event, fields)）へだけ出す。その2つを変えずに出来事を受けるため、
// ログの出来事の名前から出来事の種類へ写す recordLog を持つ。常駐は、ロガーへ渡すのと同じ呼出しを
// ここへも渡す。読み直し（reloaded）と選択（selected）は、常駐がその場で record する。
import {
  CODEX_EVENTS_LIMIT, CODEX_EVENT_TYPES, codexIsoTime, isCodexLabel,
} from '../shared/codex-status-schema.js';

// ログの出来事の名前 → 出来事の種類。これ以外のログの出来事は記録しない。
export const CODEX_EVENT_TYPE_OF_LOG = Object.freeze({
  codex_usage_capped: 'stopped',
  codex_usage_recovered: 'released',
  codex_usage_window_cap_dropped: 'window-cap-dropped',
  codex_auth_needs_login: 'needs-login',
  codex_auth_recovered: 'recovered',
});

const TYPE_OF_LOG = new Map(Object.entries(CODEX_EVENT_TYPE_OF_LOG));
const TYPES = new Set(CODEX_EVENT_TYPES);

/**
 * 出来事の記録を作る。
 * @param {{ now?: () => number }} [options] now は記録の時刻（ミリ秒）を返す関数
 * @returns {{
 *   record: (type: string, label?: string|null) => boolean,
 *   recordLog: (level: string, event: string, fields?: object) => boolean,
 *   list: () => Array<{ at: string, type: string, label: string|null }>,
 *   total: () => number,
 * }}
 */
export function createCodexEventLog({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const entries = [];
  let total = 0;

  // 記録したら true。記録しなかった（語の外・ラベルの形に合わない・時刻が表せない）なら false。
  function record(type, label = null) {
    if (!TYPES.has(type)) return false;
    if (label !== null && !isCodexLabel(label)) return false;
    const at = codexIsoTime(now());
    if (at === null) return false;
    entries.push({ at, type, label });
    if (entries.length > CODEX_EVENTS_LIMIT) entries.shift();
    total++;
    return true;
  }

  return {
    record,
    // ロガーと同じ引数を受ける。口座はログの account_label（ラベル）だけで指す。
    recordLog(_level, event, fields) {
      const type = TYPE_OF_LOG.get(event);
      if (type === undefined) return false;
      return record(type, fields?.account_label ?? null);
    },
    // 古い順の写し。戻り値を書き換えても記録は変わらない。
    list: () => entries.map(({ at, type, label }) => ({ at, type, label })),
    // これまでに記録した件数（上限で消えた分も数える）。
    total: () => total,
  };
}
