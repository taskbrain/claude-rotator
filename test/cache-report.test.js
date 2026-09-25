import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/cache-report.sh reads only the file given with --log; nothing here
// touches the real ~/.config/claude-rotator log, the service, or the network.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cache-report.sh');

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function proxyLine(minutesAgo, fields) {
  return `${isoMinutesAgo(minutesAgo)} proxy account=acct-a method=POST path=/v1/messages status=200 durationMs=10 outcome=ok ${fields}`;
}

function writeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-rotator-cache-report-'));
  const path = join(dir, 'server.log');
  const lines = [
    // Outside a 1h window: must be dropped.
    proxyLine(180, 'model=claude-opus-5-5 sid=aaaaaaaaaaaa in=1000 out=1 cr=0 cc=0 c1h=0 c5m=0 enc=gzip'),
    proxyLine(10, 'model=claude-opus-5-5 sid=aaaaaaaaaaaa in=10 out=5 cr=900 cc=90 c1h=90 c5m=0 enc=gzip'),
    proxyLine(5, 'model=claude-opus-5-5 sid=bbbbbbbbbbbb in=0 out=5 cr=300 cc=100 c1h=40 c5m=60 enc=gzip'),
    proxyLine(4, 'model=- sid=bbbbbbbbbbbb in=0 out=0 cr=0 cc=0 c1h=0 c5m=0 u5h=- enc=- usageParse=no-usage'),
    proxyLine(3, 'model=claude-haiku-4-5 sid=- in=50 out=5 cr=50 cc=0 c1h=0 c5m=0 enc=gzip'),
    // A proxy line without the observation fields and a non-proxy line: ignored.
    `${isoMinutesAgo(2)} proxy account=acct-a method=POST path=/v1/messages status=- durationMs=5 outcome=upstream-error errorType=ETIMEDOUT`,
    `${isoMinutesAgo(2)} account_switch from=acct-a to=acct-b model=claude-opus-5-5 in=999`,
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

// Pin macOS's stock bash 3.2 when it exists, so bash-4-only syntax fails here.
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

function run(args) {
  return spawnSync(BASH, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('scripts/cache-report.sh', () => {
  it('groups by model within the window and reports cr / (in + cr + cc)', () => {
    const log = writeFixture();
    const result = run(['--log', log, '--since', '1h', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);

    assert.equal(report.by, 'model');
    assert.deepEqual(report.groups.map(group => [group.key, group.requests]), [
      ['claude-opus-5-5', 2],
      ['-', 1],
      ['claude-haiku-4-5', 1],
    ]);
    const opus = report.groups[0];
    assert.deepEqual(
      { in: opus.in, cr: opus.cr, cc: opus.cc, c1h: opus.c1h, c5m: opus.c5m, noUsage: opus.noUsage },
      { in: 10, cr: 1200, cc: 190, c1h: 130, c5m: 60, noUsage: 0 },
    );
    assert.equal(opus.hitRate, Number((1200 / 1400).toFixed(4)));
    assert.equal(report.groups[1].hitRate, null);
    assert.equal(report.groups[1].noUsage, 1);

    assert.deepEqual(report.total, {
      requests: 4, hitRate: Number((1250 / 1500).toFixed(4)),
      in: 60, cr: 1250, cc: 190, c1h: 130, c5m: 60, noUsage: 1,
    });
  });

  it('widens the window with --since and groups by sid', () => {
    const log = writeFixture();
    const result = run(['--log', log, '--since', '1d', '--by', 'sid', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const bySid = Object.fromEntries(report.groups.map(group => [group.key, group.requests]));
    assert.deepEqual(bySid, { aaaaaaaaaaaa: 2, bbbbbbbbbbbb: 2, '-': 1 });
    assert.equal(report.total.in, 1060);
  });

  it('prints a text table with a TOTAL row', () => {
    const log = writeFixture();
    const result = run(['--log', log, '--by', 'account']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^acct-a\s+4\s+83\.3%/m);
    assert.match(result.stdout, /^TOTAL\s+4\s+83\.3%\s+60\s+1250\s+190\s+130\s+60\s+1$/m);
  });

  it('skips a whole rotated log whose newest line is older than the window', () => {
    const current = writeFixture();
    const rotated = join(dirname(current), 'server.log.1');
    // The first line is recent, but the file ends 3h ago: the file is skipped
    // without being scanned, so the recent line must not be counted.
    writeFileSync(rotated, [
      proxyLine(1, 'model=claude-rotated sid=cccccccccccc in=7 out=1 cr=7 cc=7 c1h=7 c5m=0 enc=gzip'),
      proxyLine(180, 'model=claude-rotated sid=cccccccccccc in=7 out=1 cr=7 cc=7 c1h=7 c5m=0 enc=gzip'),
    ].join('\n') + '\n');
    const result = run(['--log', rotated, '--log', current, '--since', '1h', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.files, [rotated, current]);
    assert.equal(report.groups.some(group => group.key === 'claude-rotated'), false);
    assert.equal(report.total.requests, 4);
  });

  it('accepts a zero-padded --since such as 08h (not read as octal)', () => {
    const result = run(['--log', writeFixture(), '--since', '08h', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.window, '08h');
    assert.equal(report.total.requests, 5);
  });

  it('rejects a malformed --since', () => {
    for (const since of ['2w', '0h', '1234567h']) {
      const result = run(['--log', writeFixture(), '--since', since]);
      assert.equal(result.status, 2, since);
      assert.match(result.stderr, /--since/, since);
    }
  });
});
