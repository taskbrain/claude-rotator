// 端末に出す文字列の部品（幅・バー・時間・日時）。Claude 側の画面（src/monitor.js）と Codex の状態の表示
// （src/shared/codex-view.js）は、どちらもこの部品で描く（同じ規則で描くために1か所に置く）。
//
// 共用部品なので、import してよいのは src/shared/ と node: の標準部品だけ（境界検査）。

const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const ZERO_WIDTH_CHARACTER = /[\p{Mark}\p{Control}\p{Format}]/u;
const JAPAN_TIME_OFFSET_MS = 9 * 60 * 60 * 1000;
const JAPAN_TIME_LABEL = 'JST';

/** 東アジアの全角の文字（端末で2桁を使う）の符号位置か。 */
export function isFullWidthCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b001)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** 書記素1つの端末の桁数（絵文字と全角は2、結合文字・制御文字だけなら0、ほかは1）。 */
export function terminalGraphemeWidth(segment) {
  if (EMOJI_GRAPHEME.test(segment) || segment.includes('\uFE0F')) return 2;
  for (const character of segment) {
    if (ZERO_WIDTH_CHARACTER.test(character)) continue;
    return isFullWidthCodePoint(character.codePointAt(0)) ? 2 : 1;
  }
  return 0;
}

/** 文字列の端末の桁数。 */
export function terminalDisplayWidth(value) {
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(String(value))) {
    width += terminalGraphemeWidth(segment);
  }
  return width;
}

/** 端末の桁数で width まで右を空白で埋める（長い文字列は切らない）。 */
export function terminalPadEnd(value, width) {
  const text = String(value);
  return `${text}${' '.repeat(Math.max(0, width - terminalDisplayWidth(text)))}`;
}

/** 0〜1 の割合のバー。値が無ければ `-` で埋める。 */
export function progressBar(ratio, width = 10) {
  if (ratio == null || Number.isNaN(Number(ratio))) return '-'.repeat(width);
  const normalized = Math.max(0, Math.min(1, Number(ratio)));
  const filled = Math.floor(normalized * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

/** 長さ（ミリ秒）を `45m`・`2h12m`・`3d16h` の形にする。0以下・有限でない値は `now`。 */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d${restHours}h` : `${days}d`;
}

/** 時刻（ミリ秒）を日本時間の `MM/DD HH:MM JST` にする。有限でなければ空の文字列。 */
export function formatJstDate(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts + JAPAN_TIME_OFFSET_MS);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi} ${JAPAN_TIME_LABEL}`;
}
