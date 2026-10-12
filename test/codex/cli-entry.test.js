// codex-rotator の CLI の入口（src/codex/cli.js）のテスト。
//
// bin/codex-rotator.js を node で起動する形はテスト隔離の仕掛けが拒否するので、入口の関数
// main を直接呼ぶ。本物の振り分けの表の load は呼ばない（本体のモジュールを読ませない）。
// 例外は下の1本だけで、本物の表の load を呼んで本体のモジュールを読み込む（読み込むだけで、
// 副コマンドは走らせない）。
// 振り分けた後の取り決めは、load と本体の呼出しを記録する偽の表を main の第3引数に渡して
// 確かめる。env は空のオブジェクトを渡し、実の環境を読ませない（省いた欄を確かめるテストは、
// 渡された物が process の物と同じかを比べるだけで、中身は読まない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { USAGE, SUBCOMMANDS, main } from '../../src/codex/cli.js';

// 副コマンドごとの、本体のモジュールと呼ぶ関数の名前。
const CONTRACT = Object.freeze({
  exec: Object.freeze({ module: './exec.js', run: 'runExec' }),
  login: Object.freeze({ module: './login.js', run: 'runLogin' }),
  accounts: Object.freeze({ module: './accounts-json.js', run: 'runAccounts' }),
  status: Object.freeze({ module: './direct-read.js', run: 'runStatus' }),
});

function captureStream() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

// 本物の表と同じ欄と関数の名前を持つ偽の表。load と本体の呼出しを calls に記録し、本体は
// result() の値を返す。
function recordingTable(result = () => 0) {
  const calls = [];
  const entries = {};
  for (const [name, { run }] of Object.entries(CONTRACT)) {
    entries[name] = Object.freeze({
      load: async () => {
        calls.push({ kind: 'load', name });
        return {
          [run](argv, io) {
            calls.push({ kind: 'run', name, argv, io });
            return result();
          },
        };
      },
      run,
    });
  }
  return { calls, table: Object.freeze(entries) };
}

async function runEntry(argv, subcommands) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main(argv, { stdout, stderr, env: {} }, subcommands);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function assertUsageFailure(result) {
  assert.equal(result.code, 2);
  assert.equal(result.stderr, `${USAGE}\n`);
  assert.equal(result.stderr.split('\n').filter(Boolean).length, 1);
  assert.equal(result.stdout, '');
}

// 使い方の誤りは、本物の表でも偽の表でも使い方の1行と 2 で終わり、どの load も呼ばない。
async function assertRefusedWithoutLoading(argv) {
  assertUsageFailure(await runEntry(argv));
  const { calls, table } = recordingTable();
  assertUsageFailure(await runEntry(argv, table));
  assert.deepEqual(calls, [], `no loader ran for ${JSON.stringify(argv)}`);
}

test('the usage line names the command and every subcommand', () => {
  assert.match(USAGE, /^usage: codex-rotator /);
  assert.ok(!USAGE.includes('\n'));
  for (const name of Object.keys(CONTRACT)) assert.ok(USAGE.includes(name));
});

// README の codex-rotator の節（日英）は、使い方の1行をそのまま載せ、その直後の表に副コマンドを1行ずつ挙げる。
// README はリポジトリの根のものを、このファイルの場所から読む（テストの作業フォルダに依らない）。
test('the README shows the usage line and one table row for every subcommand, in Japanese and English', async () => {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const parts = readme.split(`\n${USAGE}\n`);
  assert.equal(parts.length - 1, 2, 'the usage line appears once in Japanese and once in English');
  for (const part of parts.slice(1)) {
    // 使い方の1行の後は、コードの囲みの終わり・空行・表の順に並ぶ。
    const rows = part.split('\n\n')[1].split('\n').filter(line => line.startsWith('| `'));
    assert.deepEqual(rows.map(row => /^\| `([a-z]+)` \|/.exec(row)?.[1]).sort(), Object.keys(CONTRACT).sort());
  }
});

test('no arguments prints the usage line to stderr, exits 2 and loads nothing', async () => {
  await assertRefusedWithoutLoading([]);
});

test('an unknown word prints the usage line to stderr, exits 2 and loads nothing', async () => {
  await assertRefusedWithoutLoading(['frobnicate']);
  await assertRefusedWithoutLoading(['--help']);
  await assertRefusedWithoutLoading(['']);
});

test('status is a subcommand: it loads only the status body and hands it the arguments after the word', async () => {
  const { calls, table } = recordingTable();
  const result = await runEntry(['status', '--json', '--section'], table);
  assert.equal(result.code, 0);
  assert.deepEqual(calls.map(call => [call.kind, call.name]), [['load', 'status'], ['run', 'status']]);
  assert.deepEqual(calls[1].argv, ['--json', '--section']);
});

test('inherited object keys are not taken for subcommands and load nothing', async () => {
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    await assertRefusedWithoutLoading([name]);
  }
});

test('the subcommand table has exactly exec, login, accounts and status, each a frozen loader and function name', () => {
  assert.deepEqual(Object.keys(SUBCOMMANDS).sort(), Object.keys(CONTRACT).sort());
  assert.ok(Object.isFrozen(SUBCOMMANDS));
  for (const [name, { module: specifier, run }] of Object.entries(CONTRACT)) {
    const spec = SUBCOMMANDS[name];
    assert.deepEqual(Object.keys(spec).sort(), ['load', 'run'], name);
    assert.equal(spec.run, run, name);
    assert.equal(typeof spec.load, 'function', name);
    assert.ok(Object.isFrozen(spec), name);
    // load は呼ばない（本体のモジュールを読ませない）。読み込む先は、load の関数の書き方で固定する。
    assert.equal(String(spec.load), `() => import('${specifier}')`, name);
  }
});

// ほかのテストと違い、このテストだけは本物の表の load を呼び、本体のモジュール（exec・login・
// accounts・status）を実際に読む。import の行き先が解決し、表の run の欄が名指す関数をそのモジュールが
// 公開していることを確かめるためで、読むだけで本体の関数は呼ばない（副コマンドは走らない）。
test('every subcommand in the entry table loads a module that exports its runner', async () => {
  for (const [name, spec] of Object.entries(SUBCOMMANDS)) {
    const mod = await spec.load();
    assert.equal(typeof mod[spec.run], 'function', `${name} exports ${spec.run}`);
  }
});

test('the body gets the arguments after the subcommand word, and only that subcommand is loaded', async () => {
  for (const name of Object.keys(CONTRACT)) {
    const { calls, table } = recordingTable();
    const result = await runEntry([name, '--json', name, 'two words'], table);
    assert.equal(result.code, 0, name);
    assert.deepEqual(calls.map(call => [call.kind, call.name]), [['load', name], ['run', name]]);
    // 副コマンドの語は先頭の1つだけを取り除き、後ろに同じ語があればそのまま渡す。
    assert.deepEqual(calls[1].argv, ['--json', name, 'two words'], name);

    const bare = recordingTable();
    await runEntry([name], bare.table);
    assert.deepEqual(bare.calls[1].argv, [], `${name} with no further arguments`);
  }
});

test('omitted io fields fall back to process.stdout, process.stderr and process.env', async () => {
  const ioPassed = async (io, name = 'exec') => {
    const { calls, table } = recordingTable();
    assert.equal(await main([name], io, table), 0);
    return calls.find(call => call.kind === 'run').io;
  };

  for (const io of [undefined, {}]) {
    const passed = await ioPassed(io);
    assert.equal(passed.stdout, process.stdout);
    assert.equal(passed.stderr, process.stderr);
    assert.equal(passed.env, process.env);
  }

  // 欄ごとに補う。渡した欄は、同じ物がそのまま本体へ届く。
  const stdout = captureStream();
  const stderr = captureStream();
  const env = {};
  const onlyStdout = await ioPassed({ stdout }, 'login');
  assert.equal(onlyStdout.stdout, stdout);
  assert.equal(onlyStdout.stderr, process.stderr);
  assert.equal(onlyStdout.env, process.env);

  const all = await ioPassed({ stdout, stderr, env }, 'accounts');
  assert.equal(all.stdout, stdout);
  assert.equal(all.stderr, stderr);
  assert.equal(all.env, env);
});

test('a result that is not an integer becomes 1, and an integer result is returned as it is', async () => {
  const cases = [
    ['undefined', undefined, 1],
    ['null', null, 1],
    ['a string', 'text', 1],
    ['a numeric string', '0', 1],
    ['a fraction', 1.5, 1],
    ['NaN', Number.NaN, 1],
    ['a promise of a string', Promise.resolve('5'), 1],
    ['zero', 0, 0],
    ['two', 2, 2],
    ['three', 3, 3],
    ['a promise of an integer', Promise.resolve(5), 5],
  ];
  for (const [label, value, expected] of cases) {
    const { table } = recordingTable(() => value);
    const result = await runEntry(['exec'], table);
    assert.equal(result.code, expected, label);
    assert.equal(result.stderr, '', label);
  }
});
