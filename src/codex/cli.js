// codex-rotator の CLI の入口。副コマンドの振り分けだけを行う。
//
// 取り決め（副コマンドの本体を書くモジュールは、この形に合わせる）:
//   exec     → ./exec.js          の runExec(argv, io)
//   login    → ./login.js         の runLogin(argv, io)
//   accounts → ./accounts-json.js の runAccounts(argv, io)
// - 本体のモジュールは、その副コマンドが呼ばれたときだけ、表の load の関数で読む。
// - argv は副コマンドの後ろの引数の配列（副コマンドの語そのものは含まない）。
// - io は { stdout, stderr, env }。省いた欄は process.stdout・process.stderr・process.env。
// - 戻り値は終了コードの整数（それに解決する Promise でもよい）。整数でないときは 1 とする。
//
// 表に無い呼び方（引数なし・知らない語・まだ無い副コマンド）は、どのモジュールも読まずに、
// 使い方の1行を標準エラーへ出して 2 で終わる。
//
// 副コマンドを足すときは、SUBCOMMANDS の表と USAGE の両方に足す。load の関数の中の import は
// 文字列リテラルで書く。行き先を静的に追えるようにするためで、変数や組み立てた文字列を渡すと
// test/invariance.test.js の import の境界の検査が違反として止める。

export const USAGE = 'usage: codex-rotator <exec|login|accounts> [args...]';

export const SUBCOMMANDS = Object.freeze({
  exec: Object.freeze({ load: () => import('./exec.js'), run: 'runExec' }),
  login: Object.freeze({ load: () => import('./login.js'), run: 'runLogin' }),
  accounts: Object.freeze({ load: () => import('./accounts-json.js'), run: 'runAccounts' }),
});

const USAGE_EXIT_CODE = 2;

function resolveIo(io = {}) {
  return {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
  };
}

/**
 * 副コマンドを振り分けて、その終了コードを返す。
 * @param {string[]} argv process.argv.slice(2) に当たる引数
 * @param {{stdout?: object, stderr?: object, env?: object}} [io]
 * @param {Readonly<Record<string, {load: () => Promise<object>, run: string}>>} [subcommands]
 *   振り分けの表。既定は SUBCOMMANDS。テストが呼出しを記録する表を渡すためにある。
 * @returns {Promise<number>}
 */
export async function main(argv = [], io = {}, subcommands = SUBCOMMANDS) {
  const streams = resolveIo(io);
  const [name, ...rest] = argv;
  // 継承したプロパティ（toString など）を副コマンドと取り違えないよう、自身の欄だけを見る。
  if (typeof name !== 'string' || !Object.hasOwn(subcommands, name)) {
    streams.stderr.write(`${USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  const spec = subcommands[name];
  const mod = await spec.load();
  const code = await mod[spec.run](rest, streams);
  return Number.isInteger(code) ? code : 1;
}
