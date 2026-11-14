// Mock-only tests for the T4/T5 check scripts. Every inspected command (security, lsof, pgrep, ps,
// launchctl, crontab) is a fake placed first on PATH through CASEG_CHECK_BIN; HOME and the config path
// point at a temp directory. No real Keychain, process, port or ~/.config/claude-rotator is read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { serviceNameFor } from '../expiry-helper.js';

const here = dirname(fileURLToPath(import.meta.url));
const T4 = join(here, '..', 'caseG-T4-check.sh');
const T5 = join(here, '..', 'caseG-T5-check.sh');
const SECRET = 'FAKE-SECRET-VALUE-should-never-appear';
const J_EMAIL = 'j-account@example.test';
const K_EMAIL = 'k-account@example.test';

// A fake .claude.json: the account email plus token-like values that must never be printed.
function claudeJson(email) {
  return JSON.stringify({
    primaryApiKey: `sk-ant-api03-${SECRET}`,
    oauthAccount: { emailAddress: email, accountUuid: 'uuid-1', accessToken: `sk-ant-oat01-${SECRET}`, refreshToken: SECRET },
    projects: { '/x': { lastSessionId: SECRET } },
  });
}

let root; let bin; let home; let k; let j; let log; let calls; let config;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'caseg-check-test-'));
  bin = join(root, 'bin'); home = join(root, 'home'); k = join(root, 'acct', 'cfgK'); j = join(root, 'acct', 'cfgJ');
  log = join(root, 'requests.jsonl'); calls = join(root, 'calls.log'); config = join(root, 'config.json');
  for (const d of [bin, home, k, j]) await mkdir(d, { recursive: true });
  await writeFile(config, '{"fake":true}\n');
  await writeFile(join(j, '.claude.json'), claudeJson(J_EMAIL));
  await writeFile(join(k, '.claude.json'), claudeJson(K_EMAIL));
  await writeFile(join(home, '.claude.json'), claudeJson('main@example.test'));
  await mkdir(join(home, 'runA', 'cfgX'), { recursive: true });
  await writeFile(join(home, 'runA', 'cfgX', '.claude.json'), claudeJson('other@example.test'));
  await mkdir(join(home, 'Library', 'cfgHidden'), { recursive: true });
  await writeFile(join(home, 'Library', 'cfgHidden', '.claude.json'), claudeJson(J_EMAIL));
  await writeFile(log, [
    '{"time":"t","method":"POST","pathname":"/v1/messages","status":200,"durationMs":1,"swapped":true,"inboundAuthPresent":true,"upstreamAuthEqualsInbound":false,"upstreamAuthIsSwapAccount":true}',
    '{"time":"t","method":"POST","pathname":"/v1/messages","status":429,"durationMs":1,"swapped":true,"inboundAuthPresent":true,"upstreamAuthEqualsInbound":false,"upstreamAuthIsSwapAccount":true}',
    '{"time":"t","method":"GET","pathname":"/api/hello","status":200,"durationMs":1,"swapped":false,"inboundAuthPresent":true,"upstreamAuthEqualsInbound":true,"upstreamAuthIsSwapAccount":false}',
    '',
  ].join('\n'));
  const svcK = serviceNameFor(k);
  const svcJ = serviceNameFor(j);
  const record = `echo "$(basename "$0") $*" >> "${calls}"`;
  const fakes = {
    security: `${record}
for a in "$@"; do case "$a" in -w|-g|dump-keychain) echo "password: \\"${SECRET}\\""; exit 0;; esac; done
case "$1" in
  list-keychains) [ -n "\${FAKE_SECURITY_LIST_FAIL:-}" ] && { echo "security: list failed" >&2; exit 1; }
    printf '    "%s"\\n' "/fake/login.keychain-db" "/Library/Keychains/System.keychain"; exit 0;;
  find-generic-password)
    kc="\${@: -1}"; [ "$kc" = "\${FAKE_SECURITY_FAIL_KC:-}" ] && { echo "security: interaction not allowed" >&2; exit 36; }
    svc=""; while [ $# -gt 0 ]; do [ "$1" = "-s" ] && svc="$2"; shift; done
    if [ "$kc" = "/fake/login.keychain-db" ] && { [ "$svc" = "${svcK}" ] || [ "$svc" = "${svcJ}" ]; }; then
      printf 'keychain: "%s"\\nattributes:\\n    "acct"<blob>="cirkit"\\n    "mdat"<timedate>=0x00  "20261112020000Z\\\\000"\\n    "svce"<blob>="%s"\\n' "$kc" "$svc"; exit 0
    fi
    echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; exit 44;;
esac
exit 1`,
    lsof: `${record}
[ -n "\${FAKE_LSOF_FAIL:-}" ] && { echo "lsof: can't open kernel memory" >&2; exit 1; }
case "$*" in
  *"+D ${k}"*) if [ -n "\${FAKE_LSOF_PARTIAL:-}" ]; then
      printf 'COMMAND PID\nclaude 4242\n'; echo "lsof: WARNING: can't stat() directory ${k}/private: Permission denied" >&2; exit 0
    fi;;
  *"+D ${j}"*) [ -n "\${FAKE_LSOF_NOMATCH:-}" ] && exit 1
    if [ -n "\${FAKE_LSOF_DENIED:-}" ]; then
      echo "lsof: WARNING: can't stat() directory ${j}/private: Permission denied" >&2; exit 1
    fi;;
esac
# FAKE_LSOF_PARENT: report the check script's parent (the caller's shell) as holding the folder.
if [ -n "\${FAKE_LSOF_PARENT:-}" ]; then case "$*" in *"+D ${k}"*)
  p=$(/bin/ps -o ppid= -p "$PPID" | tr -d ' '); p=$(/bin/ps -o ppid= -p "$p" | tr -d ' ')
  printf 'COMMAND PID\nzsh %s\n' "$p"; exit 0;; esac
fi
case "$*" in
  *"+D ${k}"*) printf 'COMMAND PID\\nclaude 4242\\n';;
  *"+D ${j}"*) printf 'COMMAND PID\\n';;
  *LISTEN*) printf 'COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\\nnode 73215 u 1 IPv4 0 0 TCP 127.0.0.1:37891\\nnode 999 u 1 IPv4 0 0 TCP 127.0.0.1:8080\\n';;
  *cwd*) printf 'p4242\\nn%s/work\\n' "${k}";;
esac
exit 0`,
    pgrep: `${record}
[ -n "\${FAKE_PGREP_FAIL:-}" ] && exit 3
[ -n "\${FAKE_PGREP_NONE:-}" ] && exit 1
# FAKE_PGREP_SELF: answer -f the way the real pgrep would for the check script itself: its own PID and the
# $(...) subshells between it and pgrep, which carry the same arguments.
if [ -n "\${FAKE_PGREP_SELF:-}" ] && [ "$1" = "-f" ]; then
  p=$PPID; for _ in 1 2 3 4; do echo "$p"; p=$(/bin/ps -o ppid= -p "$p" | tr -d ' '); done; exit 0
fi
case "$*" in *"${j}"*) exit 1;; esac
echo 4242`,
    ps: `${record}
case "$*" in
  *"-axo pid=,comm="*) [ -n "\${FAKE_PS_LIST_FAIL:-}" ] && exit 1
    printf '  4242 /Users/tester/.local/bin/claude\\n  4343 /Users/tester/.local/share/claude/versions/2.1.325\\n  5555 /Applications/Other.app/Contents/MacOS/Other\\n  6666 /usr/bin/claudette\\n'; exit 0;;
  *lstart=*) echo "Sat Nov 14 13:30:00 2026"; exit 0;;
esac
[ -n "\${FAKE_PGREP_SELF:-}" ] && case "$*" in *comm=*|*ppid=*) exec /bin/ps "$@";; esac
case "$*" in *"-p 99999"*) exit 1;; esac
[ -n "\${FAKE_LSOF_PARENT:-}" ] && case "$*" in *comm=*|*ppid=*) exec /bin/ps "$@";; esac
case "$*" in *comm=*) echo claude;; *ppid=*) echo 1;; *) echo "  73215 01:02:03 S";; esac`,
    launchctl: `${record}
[ -n "\${FAKE_LAUNCHCTL_FAIL:-}" ] && exit 5
printf 'PID Status Label\\n123 0 com.example.claude-helper\\n- 0 com.apple.other\\n'`,
    find: `${record}
# FAKE_FIND_DENIED: the .claude.json search also reports this folder as unreadable (find exits 1).
if [ -n "\${FAKE_FIND_DENIED:-}" ]; then case "$*" in *.claude.json*)
  /usr/bin/find "$@"; echo "find: \${FAKE_FIND_DENIED}: Permission denied" >&2; exit 1;; esac
fi
exec /usr/bin/find "$@"`,
    crontab: `${record}
[ "\${FAKE_CRONTAB:-}" = none ] && { echo "crontab: no crontab for tester" >&2; exit 1; }
[ "\${FAKE_CRONTAB:-}" = fail ] && { echo "crontab: tmp/tmp.123: Permission denied" >&2; exit 1; }
printf '0 * * * * TOKEN=${SECRET} claude --x ${j}\\n'`,
  };
  for (const [name, body] of Object.entries(fakes)) {
    await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }
});
after(async () => { await rm(root, { recursive: true, force: true }); });

function run(script, args, extraEnv = {}) {
  return spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: { CASEG_CHECK_BIN: bin, HOME: home, CASEG_ROTATOR_CONFIG: config, CASEG_PROTECT_PIDS: '73215',
      CASEG_EMAIL_ROOTS: home, PATH: '/usr/bin:/bin', ...extraEnv },
  });
}

async function assertReadOnlyCalls() {
  const text = await readFile(calls, 'utf8');
  const securityLines = text.split('\n').filter(line => line.startsWith('security '));
  assert.ok(securityLines.length > 0);
  assert.ok(securityLines.every(line => !/(^|\s)(-w|-g|dump-keychain)(\s|$)/.test(line)), 'security must not be asked for values');
  assert.ok(!/^security (add|delete|set|unlock|import|export)/m.test(text), 'security must not be asked to write');
  assert.ok(!/^launchctl (?!list)/m.test(text), 'launchctl may only list');
  assert.ok(!/^lsof .*(^|\s)-w(\s|$)/m.test(text), 'lsof warnings must not be silenced');
  assert.ok(!/^crontab (?!-l)/m.test(text), 'crontab may only list');
}

test('T4 check: attributes, openers, ports and log counts, without values', async () => {
  await rm(calls, { force: true });
  const r = run(T4, [k, log]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.ok(!out.includes(SECRET));
  assert.match(out, new RegExp(`項目名=${serviceNameFor(k)}`));
  assert.match(out, /件数=1（期待どおり）/);
  assert.match(out, /\/fake\/login\.keychain-db: あり acct=cirkit mdat=11\/12 11:00:00 JST/);
  assert.match(out, /claude 4242/);
  assert.match(out, /node 73215 127\.0\.0\.1:37891/);
  assert.ok(!out.includes(':8080'));
  assert.match(out, /POST \/v1\/messages=2/);
  assert.match(out, /swapped=true=2/);
  assert.match(out, /status 2xx=2/);
  assert.match(out, /status 2xx 以外=1/);
  assert.match(out, /73215 01:02:03 S/);
  assert.match(out, /^[0-9a-f]{64}$/m);
  assert.ok(!out.includes('"time"'), 'log lines themselves are not printed');
  assert.match(out, /## 結果: 取得はすべて成功/);
  assert.ok(!out.includes('!! 未確認'));
  await assertReadOnlyCalls();
});

test('T5 check: both folders, automation by name only, crontab lines hidden', async () => {
  await rm(calls, { force: true });
  const r = run(T5, [k, j, log]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.ok(!out.includes(SECRET));
  assert.ok(!out.includes('TOKEN='));
  assert.match(out, new RegExp(`k=${k} 項目名=${serviceNameFor(k)}`));
  assert.match(out, new RegExp(`j=${j} 項目名=${serviceNameFor(j)}`));
  assert.equal(out.match(/件数=1（期待どおり）/g).length, 2);
  assert.match(out, /com\.example\.claude-helper/);
  assert.ok(!out.includes('com.apple.other'));
  assert.match(out, /claude を含む行=1、k のフォルダを含む行=0、j のフォルダを含む行=1/);
  await assertReadOnlyCalls();
});

test('a missing Keychain item is not exactly one and exits non-zero', async () => {
  const other = join(root, 'acct', 'cfgOther');
  await mkdir(other, { recursive: true });
  const r = run(T4, [other]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /!! 未確認: 件数=0（1件でない）/);
  assert.ok(!r.stdout.includes('件数=1（期待どおり）'));
  assert.match(r.stdout, /記録の指定なし/);
  assert.match(r.stdout, /## 結果: 未確認/);
});

function assertUnverified(r, pattern) {
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, pattern);
  assert.match(r.stdout, /## 結果: 未確認/);
  assert.ok(!r.stdout.includes(SECRET));
}

test('a keychain that cannot be read is not counted as none, and the other match is not reported as one', async () => {
  const r = run(T4, [k, log], { FAKE_SECURITY_FAIL_KC: '/Library/Keychains/System.keychain' });
  assertUnverified(r, /System\.keychain: 読めない（終了コード 36）/);
  assert.match(r.stdout, /!! 未確認: 読めない Keychain が 1 件ある。件数は数えない/);
  assert.ok(!r.stdout.includes('件数=1（期待どおり）'));
  assert.ok(!r.stdout.includes('System.keychain: なし'));
});

test('a failed keychain search list is unverified', async () => {
  const r = run(T4, [k], { FAKE_SECURITY_LIST_FAIL: '1' });
  assertUnverified(r, /!! 未確認: 検索対象の Keychain の一覧を取れない/);
  assert.ok(!r.stdout.includes('件数='));
});

test('lsof failures are unverified, not zero openers', async () => {
  const r = run(T4, [k, log], { FAKE_LSOF_FAIL: '1' });
  assertUnverified(r, /!! 未確認: lsof \+D .* の取得に失敗/);
  assert.match(r.stdout, /!! 未確認: 待ち受けの一覧の取得に失敗/);
});

test('pgrep failures are unverified, not zero processes', async () => {
  const r = run(T4, [k], { FAKE_PGREP_FAIL: '1' });
  assertUnverified(r, /!! 未確認: pgrep -f の取得に失敗/);
});

test('a failed Claude Code process list is unverified, not zero processes', async () => {
  const r = run(T5, [k, j], { FAKE_PS_LIST_FAIL: '1' });
  assertUnverified(r, /!! 未確認: Claude Code のプロセス一覧（ps -axo）の取得に失敗/);
  assert.ok(!/^件数=\d+$/m.test(r.stdout), 'no process count is printed');
});

test('T5 inventory lists claude and versions/<ver> processes with start time and cwd', async () => {
  const r = run(T5, [k, j, log]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const inv = r.stdout.split('## Claude Code の全プロセス')[1].split('## ')[0];
  assert.match(inv, new RegExp(`4242 開始=11/14 13:30:00 JST cwd=${k}/work 起動=claude`));
  assert.match(inv, new RegExp(`4343 開始=11/14 13:30:00 JST cwd=${k}/work`));
  assert.ok(!inv.includes('5555') && !inv.includes('6666'), 'other programs are not listed');
  assert.match(inv, /^件数=2$/m);
  const cwdSection = r.stdout.split('- claude の各プロセスの作業フォルダ')[1].split('（何も出なければ0件）')[0];
  assert.match(cwdSection, /4343 cwd=/, 'a versions/<ver> launch is checked for its cwd too');
});

test('real "no match" from lsof (exit 1, no output) and pgrep (exit 1) are zero, not unverified', async () => {
  const r = run(T5, [k, j, log], { FAKE_LSOF_NOMATCH: '1', FAKE_PGREP_NONE: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes('!! 未確認'));
  const jSection = r.stdout.split('差し替え先 j のフォルダ（0件のはず） を開いているプロセス')[1].split('## ')[0];
  const lsofPart = jSection.split('- lsof +D:\n')[1].split('- 命令の引数にフォルダを含むプロセス')[0];
  assert.equal(lsofPart.trim(), '');
  const pgrepPart = jSection.split('（PID とコマンド名）:\n')[1].split('- claude の各プロセスの作業フォルダ')[0];
  assert.equal(pgrepPart.trim(), '');
});

test('T5 prints the newest change under each folder without reading contents', async () => {
  await mkdir(join(j, 'sub'), { recursive: true });
  await writeFile(join(j, 'sub', 'state.json'), SECRET);
  const r = run(T5, [k, j]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes(SECRET));
  const jPart = r.stdout.split('## 差し替え先 j のフォルダ（区間中に変わらないはず） の下で最後に更新されたもの')[1].split('## ')[0];
  assert.match(jPart, /項目=\d+（フォルダ自身を含む） 最終更新=\d\d\/\d\d \d\d:\d\d:\d\d JST (sub|sub\/state\.json)/);
  await rm(join(j, 'sub'), { recursive: true, force: true });
});

test('launchctl and crontab failures are unverified; "no crontab" is zero lines', async () => {
  let r = run(T5, [k, j], { FAKE_LAUNCHCTL_FAIL: '1' });
  assertUnverified(r, /!! 未確認: launchctl list の取得に失敗/);
  r = run(T5, [k, j], { FAKE_CRONTAB: 'fail' });
  assertUnverified(r, /!! 未確認: crontab -l の取得に失敗/);
  assert.ok(!r.stdout.includes('claude を含む行='));
  r = run(T5, [k, j], { FAKE_CRONTAB: 'none' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /claude を含む行=0、k のフォルダを含む行=0、j のフォルダを含む行=0/);
});

test('proxy log lines with missing fields stop the counts instead of printing zeros', async () => {
  const badLog = join(root, 'bad-requests.jsonl');
  await writeFile(badLog, [
    '{"time":"t","method":"POST","pathname":"/v1/messages","status":200,"swapped":true,"upstreamAuthIsSwapAccount":true}',
    '{"time":"t","method":"POST","path":"/v1/messages","status":200,"swapped":true,"upstreamAuthIsSwapAccount":true}',
    '',
  ].join('\n'));
  const r = run(T4, [k, badLog]);
  assertUnverified(r, /!! 未確認: 記録に欄の形が合わない行が 1 行ある。件数は出さない/);
  assert.ok(!r.stdout.includes('POST /v1/messages='));
  const missing = run(T4, [k, join(root, 'no-such.jsonl')]);
  assertUnverified(missing, /!! 未確認: 記録を読めない/);
});

test('the check script does not count itself as a process holding the folder', async () => {
  const r = run(T4, [k], { FAKE_PGREP_SELF: '1' });
  assert.equal(r.status, 0, r.stdout);
  const section = r.stdout.split('- 命令の引数にフォルダを含むプロセス（PID とコマンド名）:\n')[1]
    .split('- claude の各プロセスの作業フォルダ')[0];
  assert.equal(section.trim(), '', 'the running check script is excluded');
});

test('refuses relative paths, ~/.claude, the rotator config dir and k = j before inspecting anything', async () => {
  await mkdir(join(home, '.claude'), { recursive: true });
  await rm(calls, { force: true });
  for (const [script, args] of [[T4, ['relative/dir']], [T4, [join(home, '.claude')]],
    [T4, [join(home, '.config', 'claude-rotator')]], [T4, [home]], [T5, [k, k]], [T4, []], [T5, [k]]]) {
    const r = run(script, args);
    assert.equal(r.status, 2, `${args.join(' ')} should be refused`);
    assert.equal(r.stdout, '');
  }
  await assert.rejects(readFile(calls, 'utf8'), { code: 'ENOENT' });
});

test('lsof with a path it cannot see is incomplete, not zero, even when it exits 0', async () => {
  const r = run(T4, [k, log], { FAKE_LSOF_PARTIAL: '1' });
  assertUnverified(r, /!! 未確認: lsof \+D .*cfgK の探索が不完全/);
  assert.match(r.stdout, /claude 4242/, 'what was found is still listed');
});

test('lsof that finds nothing but could not see every path is not read as zero openers', async () => {
  await rm(calls, { force: true });
  const r = run(T5, [k, j], { FAKE_LSOF_DENIED: '1' });
  assertUnverified(r, /!! 未確認: lsof \+D .*cfgJ の取得に失敗/);
  await assertReadOnlyCalls();
});

test('a missing protected PID, a missing config and an unreadable config end with exit 3', async () => {
  let r = run(T4, [k], { CASEG_PROTECT_PIDS: '73215 99999' });
  assertUnverified(r, /!! 未確認: PID 99999 が無い（中止の条件）/);
  r = spawnSync('/bin/bash', [T4, k], { encoding: 'utf8', env: { CASEG_CHECK_BIN: bin, HOME: home,
    CASEG_ROTATOR_CONFIG: join(root, 'no-config.json'), CASEG_PROTECT_PIDS: '73215', PATH: '/usr/bin:/bin' } });
  assertUnverified(r, /!! 未確認: 本番の config\.json が見つからない/);
  const locked = join(root, 'locked-config.json');
  await writeFile(locked, '{}');
  await chmod(locked, 0o000);
  r = spawnSync('/bin/bash', [T4, k], { encoding: 'utf8', env: { CASEG_CHECK_BIN: bin, HOME: home,
    CASEG_ROTATOR_CONFIG: locked, CASEG_PROTECT_PIDS: '73215', PATH: '/usr/bin:/bin' } });
  await chmod(locked, 0o600);
  assertUnverified(r, /!! 未確認: 本番の config\.json の sha256 を取れない/);
});

test('the shell that called the check script is not counted as holding the folder', async () => {
  const r = run(T4, [k], { FAKE_LSOF_PARENT: '1' });
  assert.equal(r.status, 0, r.stdout);
  const section = r.stdout.split('- lsof +D:\n')[1].split('- 命令の引数にフォルダを含むプロセス')[0];
  assert.equal(section.trim(), '', 'the caller (an ancestor) is excluded');
  assert.match(r.stdout, /数えないもの: この確認スクリプト自身 PID \d+ とその子孫、祖先 PID \d+/);
});

function emailSection(out) {
  return out.split('## 各口座フォルダの .claude.json のメール欄')[1].split('\n## ')[0];
}

test('T5 lists the account email of every .claude.json, never the tokens beside it', async () => {
  const r = run(T5, [k, j, log]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes(SECRET), 'token-like values are not printed');
  assert.ok(!/sk-ant|accessToken|refreshToken|primaryApiKey|accountUuid|uuid-1/.test(r.stdout), 'no other key or value is printed');
  const sec = emailSection(r.stdout);
  const [rj, rk, rh] = await Promise.all([realpath(j), realpath(k), realpath(home)]);
  assert.match(sec, new RegExp(`  ${rj} メール=${J_EMAIL} 更新=\\d\\d/\\d\\d \\d\\d:\\d\\d:\\d\\d JST ← j`));
  assert.match(sec, new RegExp(`  ${rk} メール=${K_EMAIL} 更新=.* JST ← k`));
  assert.match(sec, new RegExp(`  ${rh} メール=main@example\\.test`), 'the default ~/.claude.json is included');
  assert.match(sec, new RegExp(`  ${rh}/runA/cfgX メール=other@example\\.test`));
  assert.ok(!sec.includes('cfgHidden'), 'Library is not searched');
  assert.match(sec, /^フォルダ=4（メール欄を読めたもの） 口座=4 指紋（フォルダとメール、時刻を除く）=[0-9a-f]{16}$/m);
  assert.match(sec, /j の口座でログインしているフォルダ=1（j だけ。期待どおり）/);
  assert.match(r.stdout, /## j の判定材料/);
  assert.match(r.stdout, new RegExp(`- j の Keychain 項目 ${serviceNameFor(j)} の mdat=11/12 11:00:00 JST`));
  assert.match(r.stdout, /- j のフォルダの最終更新=\d\d\/\d\d \d\d:\d\d:\d\d JST /);
  assert.match(r.stdout, /- メール一覧の指紋=[0-9a-f]{16}$/m);
});

test('the email fingerprint ignores file times and changes when a folder or account changes', async () => {
  const fp = out => out.match(/指紋（フォルダとメール、時刻を除く）=([0-9a-f]{16})/)[1];
  const first = fp(run(T5, [k, j]).stdout);
  await writeFile(join(home, 'runA', 'cfgX', '.claude.json'), claudeJson('other@example.test'));
  assert.equal(fp(run(T5, [k, j]).stdout), first, 'rewriting the same email keeps the fingerprint');
  await writeFile(join(home, 'runA', 'cfgX', '.claude.json'), claudeJson('changed@example.test'));
  assert.notEqual(fp(run(T5, [k, j]).stdout), first);
  await writeFile(join(home, 'runA', 'cfgX', '.claude.json'), claudeJson('other@example.test'));
});

test('j\'s account logged in in another folder is NG (exit 4), even with different letter case', async () => {
  const dup = join(home, 'old', 'cfgDup');
  await mkdir(dup, { recursive: true });
  await writeFile(join(dup, '.claude.json'), claudeJson(J_EMAIL.toUpperCase()));
  const r = run(T5, [k, j]);
  await rm(join(home, 'old'), { recursive: true, force: true });
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes(SECRET));
  assert.match(r.stdout, new RegExp(`!! NG: j の口座が j 以外のフォルダでもログインしている: ${(await realpath(home))}/old/cfgDup`));
  assert.match(r.stdout, /j の口座でログインしているフォルダ=2（j 以外にもある）/);
  assert.match(r.stdout, /## 結果: NG/);
});

test('an unreadable .claude.json or a non-email value is unverified and its contents stay hidden', async () => {
  const bad = join(home, 'bad');
  await mkdir(join(bad, 'cfgBroken'), { recursive: true });
  await mkdir(join(bad, 'cfgOdd'), { recursive: true });
  await writeFile(join(bad, 'cfgBroken', '.claude.json'), `{"oauthAccount": {"emailAddress": "x@y", "accessToken": "${SECRET}"`);
  await writeFile(join(bad, 'cfgOdd', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `sk-ant-oat01-${SECRET}` } }));
  const r = run(T5, [k, j]);
  await rm(bad, { recursive: true, force: true });
  assertUnverified(r, /!! 未確認: .*cfgBroken\/\.claude\.json のメール欄を読めない/);
  assert.match(r.stdout, /cfgOdd メール=（欄の形が合わない。値は出さない）/);
  assert.ok(!r.stdout.includes('sk-ant'));
});

test('a j folder without .claude.json is unverified; a k folder without one is only listed', async () => {
  const freshK = join(root, 'acct', 'cfgFreshK');
  const freshJ = join(root, 'acct', 'cfgFreshJ');
  await mkdir(freshK, { recursive: true });
  await mkdir(freshJ, { recursive: true });
  const r = run(T5, [freshK, freshJ]);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /cfgFreshK \.claude\.json 無し ← k/);
  assert.match(r.stdout, /!! 未確認: j のフォルダに \.claude\.json が無い/);
  assert.match(r.stdout, /!! 未確認: j のフォルダのメール欄が取れない/);
});

test('an unreadable folder owned by another user is listed as not searched; one of our own is unverified', async () => {
  let r = run(T5, [k, j], { FAKE_FIND_DENIED: '/usr/sbin' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /（見ていない: 自分以外の持ち主で開けないフォルダ: \/usr\/sbin（持ち主 root））/);
  assert.match(r.stdout, /j の口座でログインしているフォルダ=1/);
  r = run(T5, [k, j], { FAKE_FIND_DENIED: home });
  assertUnverified(r, /!! 未確認: \.claude\.json の探索が不完全/);
});
