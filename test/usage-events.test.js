import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFile, link, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rename, stat, symlink, unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  buildUsageEvent,
  createUsageEventWriter,
  usageEventsDir,
  usageFromObservation,
  USAGE_EVENTS_FILENAME,
} from '../src/usage-events.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// The writer appends to one file per UTC day: usage-events-YYYYMMDD.jsonl.
const DAILY_FILE = /usage-events-[0-9]{8}\.jsonl$/;

function observation(overrides = {}) {
  return {
    parse: 'ok',
    encoding: null,
    model: 'claude-sonnet-4-5',
    messageId: 'msg_1',
    inputTokens: 11,
    outputTokens: 22,
    cacheReadTokens: 33,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheCreation5mTokens: 0,
    ...overrides,
  };
}

describe('usageEventsDir', () => {
  it('defaults under the app config dir and honours the env override', () => {
    assert.equal(
      usageEventsDir({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/alice'),
      '/tmp/xdg/claude-rotator/usage-events',
    );
    assert.equal(usageEventsDir({}, '/home/alice'), '/home/alice/.config/claude-rotator/usage-events');
    assert.equal(
      usageEventsDir({ CLAUDE_ROTATOR_USAGE_EVENTS_DIR: '~/events' }, '/home/alice'),
      '/home/alice/events',
    );
  });
});

describe('usageFromObservation', () => {
  it('maps a parsed 2xx observation to the five usage keys', () => {
    assert.deepEqual(
      usageFromObservation(observation({
        cacheCreationTokens: 44,
        cacheCreation5mTokens: 40,
        cacheCreation1hTokens: 4,
      }), 200),
      { inputTokens: 11, outputTokens: 22, cacheCreation5m: 40, cacheCreation1h: 4, cacheRead: 33 },
    );
  });

  it('reports 0/0 when nothing was written to the cache', () => {
    const usage = usageFromObservation(observation(), 200);
    assert.equal(usage.cacheCreation5m, 0);
    assert.equal(usage.cacheCreation1h, 0);
  });

  it('does not guess a 5m/1h split when only the aggregate is positive', () => {
    const usage = usageFromObservation(observation({ cacheCreationTokens: 7 }), 200);
    assert.equal(usage.cacheCreation5m, null);
    assert.equal(usage.cacheCreation1h, null);
    assert.equal(usage.inputTokens, 11);
  });

  it('returns null for non-2xx responses and for observations that did not parse', () => {
    assert.equal(usageFromObservation(observation(), 500), null);
    assert.equal(usageFromObservation(observation(), 429), null);
    assert.equal(usageFromObservation(observation(), null), null);
    assert.equal(usageFromObservation(observation({ parse: 'unsupported-encoding' }), 200), null);
    assert.equal(usageFromObservation(null, 200), null);
    assert.equal(usageFromObservation(undefined, 200), null);
  });
});

describe('buildUsageEvent', () => {
  it('derives eventId from requestId and attempt and keeps only allow-listed fields', () => {
    const event = buildUsageEvent({
      ts: '2026-08-02T12:00:00.000Z',
      requestId: 'req_011',
      attempt: 2,
      accountId: 'acct_1',
      messageId: 'msg_1',
      model: 'claude-sonnet-4-5',
      outcome: 'ok',
      statusCode: 200,
      errorType: null,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheCreation5m: null,
        cacheCreation1h: null,
        cacheRead: 3,
        // must never reach the JSONL either
        rawBody: 'prompt text',
      },
      // fields below must never reach the JSONL
      authorization: 'Bearer secret',
      body: 'prompt text',
    });

    assert.deepEqual(Object.keys(event).sort(), [
      'accountId', 'attempt', 'errorType', 'eventId', 'messageId',
      'model', 'outcome', 'requestId', 'statusCode', 'ts', 'usage',
    ]);
    assert.deepEqual(Object.keys(event.usage).sort(), [
      'cacheCreation1h', 'cacheCreation5m', 'cacheRead', 'inputTokens', 'outputTokens',
    ]);
    assert.equal(event.eventId, 'req_011/2');
    assert.doesNotMatch(JSON.stringify(event), /secret|prompt text/);
  });

  it('falls back to a UUID when requestId is unavailable', () => {
    const event = buildUsageEvent({
      ts: '2026-08-02T12:00:00.000Z',
      requestId: null,
      attempt: 1,
      accountId: 'acct_1',
      outcome: 'upstream-error',
      statusCode: null,
      errorType: 'ECONNRESET',
      usage: null,
    });

    assert.match(event.eventId, UUID_V4);
    assert.equal(event.requestId, null);
    assert.equal(event.usage, null);
    assert.equal(event.messageId, null);
    assert.equal(event.model, null);
    assert.equal(event.errorType, 'ECONNRESET');
  });
});

describe('createUsageEventWriter', () => {
  it('appends one JSON line per event with 0700 dir and 0600 file modes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    const dir = join(base, 'usage-events');
    const writer = createUsageEventWriter({ dir });

    await writer.append(buildUsageEvent({
      ts: '2026-08-02T12:00:00.000Z', requestId: 'req_a', attempt: 1,
      accountId: 'acct_1', outcome: 'ok', statusCode: 200,
      usage: { inputTokens: 1, outputTokens: 2, cacheCreation5m: 0, cacheCreation1h: 0, cacheRead: 0 },
    }));
    await writer.append(buildUsageEvent({
      ts: '2026-08-02T12:00:01.000Z', requestId: 'req_b', attempt: 1,
      accountId: 'acct_1', outcome: 'upstream-timeout', statusCode: null,
      errorType: 'ETIMEDOUT', usage: null,
    }));

    assert.equal(writer.path, join(dir, USAGE_EVENTS_FILENAME));
    const lines = (await readFile(writer.path, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).eventId, 'req_a/1');
    assert.equal(JSON.parse(lines[1]).usage, null);

    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(writer.path)).mode & 0o777, 0o600);
  });

  it('fixes an existing 0755 directory to 0700 and an existing 0644 file to 0600', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    const dir = join(base, 'usage-events');
    await mkdir(dir, { mode: 0o755 });
    const path = join(dir, USAGE_EVENTS_FILENAME);
    await writeFile(path, '', { mode: 0o644 });
    const writer = createUsageEventWriter({ dir });

    await writer.append(buildUsageEvent({
      ts: '2026-08-02T12:00:00.000Z', requestId: 'req_c', attempt: 1,
      accountId: 'acct_1', outcome: 'ok', statusCode: 200, usage: null,
    }));

    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it('isolates append failures: logs and resolves instead of throwing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    const blocker = join(base, 'blocker');
    await writeFile(blocker, 'not a directory');
    const logs = [];
    const writer = createUsageEventWriter({ dir: join(blocker, 'usage-events'), logger: line => logs.push(line) });

    await writer.append({ ts: 'x', eventId: 'e', accountId: 'a' });

    assert.equal(logs.length, 1);
    assert.match(logs[0], /usage-events-append result=failed errorType=ENOTDIR/);
  });

  it('stays fail-open when the logger itself throws', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    const blocker = join(base, 'blocker');
    await writeFile(blocker, 'not a directory');
    const writer = createUsageEventWriter({
      dir: join(blocker, 'usage-events'),
      logger: () => { throw new Error('logger boom'); },
    });

    await assert.doesNotReject(writer.append({ ts: 'x', eventId: 'e', accountId: 'a' }));
  });

  it('logs a fail-loud warning once the file passes the size limit', async () => {
    const logs = [];
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    const writer = createUsageEventWriter({
      dir: join(base, 'usage-events'),
      logger: line => logs.push(line),
      sizeWarnBytes: 1,
      sizeCheckEvery: 1,
    });

    await writer.append(buildUsageEvent({
      ts: '2026-08-02T12:00:00.000Z', requestId: 'req_a', attempt: 1,
      accountId: 'acct_1', outcome: 'ok', statusCode: 200, usage: null,
    }));

    assert.equal(logs.length, 1);
    assert.match(logs[0], /usage-events-size result=over-limit bytes=\d+ limitBytes=1/);
  });

  it('returns from append() before the disk write finishes and keeps the queue order', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let appendCalls = 0;
    let signalWriteStarted;
    const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
    const writer = createUsageEventWriter({
      dir: join(base, 'usage-events'),
      fsOps: {
        async appendFile(...args) {
          appendCalls += 1;
          signalWriteStarted();
          await gate;
          return appendFile(...args);
        },
      },
    });

    const results = ['req_1', 'req_2', 'req_3'].map(requestId => {
      let settled = false;
      const promise = writer.append(buildUsageEvent({
        ts: '2026-08-02T12:00:00.000Z', requestId, attempt: 1,
        accountId: 'acct_1', outcome: 'ok', statusCode: 200, usage: null,
      })).then(() => { settled = true; });
      return { promise, isSettled: () => settled };
    });
    // Wait until the queue reaches the stalled write (not a fixed delay), with an upper bound
    // so an implementation that never starts the write fails instead of hanging.
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fsOps.appendFile was not called within 5000ms')), 5000);
    });
    try {
      await Promise.race([writeStarted, timeout]);
    } finally {
      clearTimeout(timer);
    }
    assert.ok(appendCalls >= 1);
    assert.equal(results.some(result => result.isSettled()), false);

    release();
    await writer.flush();
    const ids = (await readFile(writer.path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line).eventId);
    assert.deepEqual(ids, ['req_1/1', 'req_2/1', 'req_3/1']);
  });

  it('accepts a promise of an event and swallows its rejection without an unhandled rejection', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    const logs = [];
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const writer = createUsageEventWriter({ dir: join(base, 'usage-events'), logger: line => logs.push(line) });
      writer.append(Promise.reject(Object.assign(new Error('build failed'), { code: 'EBUILD' })));
      writer.append(Promise.resolve(buildUsageEvent({
        ts: '2026-08-02T12:00:00.000Z', requestId: 'req_after', attempt: 1,
        accountId: 'acct_1', outcome: 'ok', statusCode: 200, usage: null,
      })));
      writer.append(Promise.resolve(null));
      await writer.flush();
      await new Promise(resolve => setImmediate(resolve));

      assert.deepEqual(unhandled, []);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /usage-events-append result=failed errorType=EBUILD/);
      const lines = (await readFile(writer.path, 'utf8')).trimEnd().split('\n');
      assert.deepEqual(lines.map(line => JSON.parse(line).eventId), ['req_after/1']);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('drops events past maxPending instead of growing the queue without bound', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const logs = [];
    const writer = createUsageEventWriter({
      dir: join(base, 'usage-events'),
      logger: line => logs.push(line),
      maxPending: 2,
      fsOps: {
        async appendFile(...args) {
          await gate;
          return appendFile(...args);
        },
      },
    });
    for (const requestId of ['req_1', 'req_2', 'req_3', 'req_4']) {
      writer.append(buildUsageEvent({
        ts: '2026-08-02T12:00:00.000Z', requestId, attempt: 1,
        accountId: 'acct_1', outcome: 'ok', statusCode: 200, usage: null,
      }));
    }
    release();
    await writer.flush();

    const ids = (await readFile(writer.path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line).eventId);
    assert.deepEqual(ids, ['req_1/1', 'req_2/1']);
    assert.equal(logs.filter(line => /result=dropped reason=queue-full maxPending=2/.test(line)).length, 1);
  });
});

describe('createUsageEventWriter permissions', () => {
  function event(requestId) {
    return buildUsageEvent({
      ts: '2026-08-02T12:00:00.000Z', requestId, attempt: 1,
      accountId: 'acct_1', outcome: 'ok', statusCode: 200, usage: null,
    });
  }

  async function readLines(path) {
    try {
      return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).eventId);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  it('does not write while the file chmod fails, logs once per interval, and retries on the next event', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    const logs = [];
    let clock = 0;
    let chmodFileFails = true;
    const writer = createUsageEventWriter({
      dir: join(base, 'usage-events'),
      logger: line => logs.push(line),
      now: () => clock,
      fsOps: {
        async chmod(target, mode) {
          if (chmodFileFails && DAILY_FILE.test(target)) {
            throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
          }
          const { chmod } = await import('node:fs/promises');
          return chmod(target, mode);
        },
      },
    });

    await writer.append(event('req_1'));
    clock += 60 * 1000;
    await writer.append(event('req_2'));
    assert.deepEqual(await readLines(writer.path), []);
    assert.deepEqual(await readLines(writer.currentPath()), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /usage-events-chmod result=failed target=file reason=chmod errorType=EPERM action=skip-event/);

    // After the suppression window the warning comes back, with the suppressed count.
    clock += 10 * 60 * 1000;
    await writer.append(event('req_3'));
    assert.equal(logs.length, 2);
    assert.match(logs[1], /target=file reason=chmod errorType=EPERM action=skip-event suppressed=1/);

    // Once chmod works again, the very next event is written (the "ensured" flag was never set).
    chmodFileFails = false;
    await writer.append(event('req_4'));
    assert.deepEqual(await readLines(writer.path), ['req_4/1']);
    assert.equal((await stat(writer.path)).mode & 0o777, 0o600);
  });

  it('does not write when the directory cannot be made 0700', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
    const dir = join(base, 'usage-events');
    const logs = [];
    const writer = createUsageEventWriter({
      dir,
      logger: line => logs.push(line),
      fsOps: {
        async chmod() {
          throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        },
      },
    });

    await writer.append(event('req_1'));

    assert.deepEqual(await readLines(writer.path), []);
    assert.deepEqual(await readLines(writer.currentPath()), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /usage-events-chmod result=failed target=dir reason=chmod errorType=EPERM action=skip-event/);
  });

  it('does not write when stat shows a foreign owner or group/other access after chmod', async () => {
    for (const [label, tamper, reason] of [
      ['owner', info => ({ uid: info.uid + 1 }), 'owner'],
      ['mode', info => ({ mode: info.mode | 0o020 }), 'mode'],
    ]) {
      const base = await mkdtemp(join(tmpdir(), 'usage-events-'));
      const logs = [];
      const writer = createUsageEventWriter({
        dir: join(base, 'usage-events'),
        logger: line => logs.push(line),
        fsOps: {
          async stat(target) {
            const info = await stat(target);
            if (!DAILY_FILE.test(target)) return info;
            const patched = tamper(info);
            return {
              isDirectory: () => info.isDirectory(),
              isFile: () => info.isFile(),
              size: info.size,
              uid: patched.uid ?? info.uid,
              mode: patched.mode ?? info.mode,
            };
          },
        },
      });

      await writer.append(event('req_1'));

      assert.deepEqual(await readLines(writer.path), [], label);
      assert.deepEqual(await readLines(writer.currentPath()), [], label);
      assert.equal(logs.length, 1, label);
      assert.match(logs[0], new RegExp(`target=file reason=${reason} action=skip-event`), label);
    }
  });
});

describe('createUsageEventWriter daily files', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const OCT_2_NOON = Date.UTC(2026, 9, 2, 12);
  const LEGACY_BYTES = '{"eventId":"old_1/1"}\n{"eventId":"old_2/1"}\n';
  const OLDER_WRITER_LINE = '{"eventId":"older_1/1"}\n';

  function named(day) {
    return `usage-events-${day}.jsonl`;
  }

  function nameAt(ms) {
    return named(new Date(ms).toISOString().slice(0, 10).replaceAll('-', ''));
  }

  function event(requestId, ts = '2026-10-02T12:00:00.000Z') {
    return buildUsageEvent({
      ts, requestId, attempt: 1, accountId: 'acct_1', outcome: 'ok', statusCode: 200, usage: null,
    });
  }

  function lineOf(requestId, ts) {
    return `${JSON.stringify(event(requestId, ts))}\n`;
  }

  function errorWithCode(code) {
    return Object.assign(new Error(code), { code });
  }

  function failingWith(code) {
    return async () => {
      throw errorWithCode(code);
    };
  }

  async function freshDir() {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-daily-'));
    const dir = join(base, 'usage-events');
    await mkdir(dir, { mode: 0o700 });
    return dir;
  }

  async function eventIds(path) {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).eventId);
  }

  async function exists(path) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function legacyRegularFile(dir) {
    const path = join(dir, USAGE_EVENTS_FILENAME);
    await writeFile(path, LEGACY_BYTES, { mode: 0o600 });
    return lstat(path);
  }

  it('writes to the file of the UTC day the line is written, not of the event ts, and switches at midnight', async () => {
    const dir = await freshDir();
    let clock = Date.UTC(2026, 9, 1, 23, 59, 59, 999);
    const writer = createUsageEventWriter({ dir, now: () => clock });

    await writer.append(event('req_1', '2026-10-01T23:59:59.000Z'));
    clock = Date.UTC(2026, 9, 2, 0, 0, 0, 0);
    // Built just before midnight but written just after: it belongs to the new day's file.
    await writer.append(event('req_2', '2026-10-01T23:59:59.500Z'));
    await writer.append(event('req_3', '2026-10-02T00:00:00.000Z'));

    assert.deepEqual(await eventIds(join(dir, named('20261001'))), ['req_1/1']);
    assert.deepEqual(await eventIds(join(dir, named('20261002'))), ['req_2/1', 'req_3/1']);
    assert.equal(writer.path, join(dir, USAGE_EVENTS_FILENAME));
    assert.equal(writer.currentPath(), join(dir, named('20261002')));
    assert.ok((await lstat(writer.path)).isSymbolicLink());
    assert.equal(await readlink(writer.path), named('20261002'));
    for (const day of ['20261001', '20261002']) {
      const info = await lstat(join(dir, named(day)));
      assert.ok(info.isFile(), day);
      assert.equal(info.nlink, 1, day);
      assert.equal(info.mode & 0o777, 0o600, day);
    }
  });

  it('moves a regular legacy file to the day\'s name on the first write after start, keeping its inode and bytes', async () => {
    const dir = await freshDir();
    const before = await legacyRegularFile(dir);
    const writer = createUsageEventWriter({ dir, now: () => OCT_2_NOON });
    // Creating the writer alone does not touch the legacy file.
    assert.ok((await lstat(writer.path)).isFile());

    await writer.append(event('req_new'));

    const moved = join(dir, named('20261002'));
    const info = await lstat(moved);
    assert.equal(info.dev, before.dev);
    assert.equal(info.ino, before.ino);
    assert.equal(info.nlink, 1);
    assert.equal(await readFile(moved, 'utf8'), `${LEGACY_BYTES}${lineOf('req_new')}`);
    assert.equal(await readlink(writer.path), named('20261002'));
    assert.deepEqual((await readdir(dir)).sort(), [USAGE_EVENTS_FILENAME, named('20261002')].sort());
  });

  it('never overwrites an existing dated file and moves the legacy file to the latest free earlier day', async () => {
    const dir = await freshDir();
    const today = join(dir, named('20261002'));
    await writeFile(today, '{"eventId":"today_1/1"}\n', { mode: 0o600 });
    const todayBefore = await lstat(today);
    const before = await legacyRegularFile(dir);
    const logs = [];
    const writer = createUsageEventWriter({ dir, now: () => OCT_2_NOON, logger: line => logs.push(line) });

    await writer.append(event('req_new'));

    const previous = join(dir, named('20261001'));
    assert.equal((await lstat(previous)).ino, before.ino);
    assert.equal(await readFile(previous, 'utf8'), LEGACY_BYTES);
    assert.equal((await lstat(today)).ino, todayBefore.ino);
    assert.deepEqual(await eventIds(today), ['today_1/1', 'req_new/1']);
    assert.equal(await readlink(writer.path), named('20261002'));
    assert.deepEqual(logs, []);
  });

  it('handles EEXIST from link() without overwriting: same inode, legacy name moved, dated name gone', async () => {
    for (const [label, otherProcess, expectedLinkCalls] of [
      // Another process linked the same file first: only the legacy name is left to drop.
      ['same inode', async (from, to) => {
        await link(from, to);
      }, 1],
      // Another process finished the move first: nothing to do, and no going back a day.
      ['legacy name gone', async (from, to) => {
        await link(from, to);
        await unlink(from);
      }, 1],
      ['legacy name already a link', async (from, to) => {
        await link(from, to);
        await unlink(from);
        await symlink(basename(to), from);
      }, 1],
      // The dated name vanished right after EEXIST: link() is tried exactly once more.
      ['dated name gone', async () => {}, 2],
    ]) {
      const dir = await freshDir();
      const before = await legacyRegularFile(dir);
      const logs = [];
      let linkCalls = 0;
      const writer = createUsageEventWriter({
        dir,
        now: () => OCT_2_NOON,
        logger: line => logs.push(line),
        fsOps: {
          async link(from, to) {
            linkCalls += 1;
            if (linkCalls > 1) return link(from, to);
            await otherProcess(from, to);
            throw errorWithCode('EEXIST');
          },
        },
      });

      await writer.append(event('req_new'));

      const moved = join(dir, named('20261002'));
      const info = await lstat(moved);
      assert.equal(info.ino, before.ino, label);
      assert.equal(info.nlink, 1, label);
      assert.equal(await readFile(moved, 'utf8'), `${LEGACY_BYTES}${lineOf('req_new')}`, label);
      assert.equal(await readlink(writer.path), named('20261002'), label);
      assert.deepEqual((await readdir(dir)).sort(), [USAGE_EVENTS_FILENAME, named('20261002')].sort(), label);
      assert.equal(linkCalls, expectedLinkCalls, label);
      assert.deepEqual(logs, [], label);
    }
  });

  it('treats a dated name that is a symbolic link to the legacy name as taken and moves the legacy file a day back', async () => {
    const dir = await freshDir();
    const before = await legacyRegularFile(dir);
    // The day's name already exists as a link back to the legacy name. Following it would find the
    // legacy file itself; dropping the legacy name then would leave its data with no name at all.
    const today = join(dir, named('20261002'));
    await symlink(USAGE_EVENTS_FILENAME, today);
    const todayBefore = await lstat(today);
    const logs = [];
    const writer = createUsageEventWriter({ dir, now: () => OCT_2_NOON, logger: line => logs.push(line) });

    await writer.append(event('req_new'));

    const previous = join(dir, named('20261001'));
    const info = await lstat(previous);
    assert.ok(info.isFile());
    assert.equal(info.dev, before.dev);
    assert.equal(info.ino, before.ino);
    assert.equal(info.nlink, 1);
    assert.equal(await readFile(previous, 'utf8'), LEGACY_BYTES);
    const todayAfter = await lstat(today);
    assert.ok(todayAfter.isSymbolicLink());
    assert.equal(todayAfter.ino, todayBefore.ino);
    assert.equal(await readlink(today), USAGE_EVENTS_FILENAME);
    assert.deepEqual(logs, []);
  });

  it('leaves the legacy file a regular file, untouched, when link() fails', async () => {
    for (const [label, linkOp, expected] of [
      ['EPERM', failingWith('EPERM'), /usage-events-migrate result=failed reason=link errorType=EPERM/],
      ['ENOTSUP', failingWith('ENOTSUP'), /usage-events-migrate result=failed reason=link errorType=ENOTSUP/],
      // EEXIST with nothing at the dated name, twice in a row: the move is given up after one retry.
      ['EEXIST twice', failingWith('EEXIST'), /usage-events-migrate result=failed reason=link errorType=EEXIST/],
    ]) {
      const dir = await freshDir();
      const before = await legacyRegularFile(dir);
      const logs = [];
      const writer = createUsageEventWriter({
        dir, now: () => OCT_2_NOON, logger: line => logs.push(line), fsOps: { link: linkOp },
      });

      await writer.append(event('req_new'));

      const legacy = await lstat(writer.path);
      assert.ok(legacy.isFile(), label);
      assert.equal(legacy.ino, before.ino, label);
      assert.equal(legacy.nlink, 1, label);
      assert.equal(await readFile(writer.path, 'utf8'), LEGACY_BYTES, label);
      // The event itself is still written, to the day's own file.
      assert.deepEqual(await eventIds(writer.currentPath()), ['req_new/1'], label);
      assert.equal(logs.length, 1, label);
      assert.match(logs[0], expected, label);
    }
  });

  it('keeps the legacy file a regular file when every name back to 13 days earlier is taken', async () => {
    const dir = await freshDir();
    const taken = [];
    for (let back = 0; back <= 13; back += 1) {
      const name = nameAt(OCT_2_NOON - back * DAY_MS);
      taken.push(name);
      await writeFile(join(dir, name), `{"eventId":"taken_${back}/1"}\n`, { mode: 0o600 });
    }
    const before = await legacyRegularFile(dir);
    const logs = [];
    const writer = createUsageEventWriter({ dir, now: () => OCT_2_NOON, logger: line => logs.push(line) });

    await writer.append(event('req_new'));

    const legacy = await lstat(writer.path);
    assert.ok(legacy.isFile());
    assert.equal(legacy.ino, before.ino);
    assert.equal(await readFile(writer.path, 'utf8'), LEGACY_BYTES);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /usage-events-migrate result=failed reason=name-taken/);
    assert.equal(await exists(join(dir, named('20260918'))), false);
    assert.deepEqual((await readdir(dir)).sort(), [USAGE_EVENTS_FILENAME, ...taken].sort());
    assert.deepEqual(await eventIds(join(dir, named('20261002'))), ['taken_0/1', 'req_new/1']);
  });

  it('finishes a move stopped between link and unlink on the next day without linking a second dated name', async () => {
    const dir = await freshDir();
    const legacyPath = join(dir, USAGE_EVENTS_FILENAME);
    const before = await legacyRegularFile(dir);
    let clock = OCT_2_NOON;
    let unlinkFails = true;
    const logs = [];
    const writer = createUsageEventWriter({
      dir,
      now: () => clock,
      logger: line => logs.push(line),
      fsOps: {
        async unlink(target) {
          if (unlinkFails && target === legacyPath) throw errorWithCode('EACCES');
          return unlink(target);
        },
      },
    });

    await writer.append(event('req_1'));
    await writer.append(event('req_2'));

    const oct2 = join(dir, named('20261002'));
    const legacy = await lstat(legacyPath);
    assert.ok(legacy.isFile());
    assert.equal(legacy.ino, before.ino);
    assert.equal(legacy.nlink, 2);
    assert.equal((await lstat(oct2)).ino, before.ino);
    // Lines written on the day the move stopped are readable from the legacy name too.
    assert.deepEqual(await eventIds(legacyPath), ['old_1/1', 'old_2/1', 'req_1/1', 'req_2/1']);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /usage-events-migrate result=failed reason=unlink errorType=EACCES/);

    unlinkFails = false;
    clock += DAY_MS;
    await writer.append(event('req_3'));

    const oct3 = join(dir, named('20261003'));
    assert.equal((await lstat(oct2)).ino, before.ino);
    assert.equal((await lstat(oct2)).nlink, 1);
    assert.notEqual((await lstat(oct3)).ino, before.ino);
    assert.deepEqual(await eventIds(oct3), ['req_3/1']);
    assert.equal(await readlink(legacyPath), named('20261003'));
    assert.deepEqual((await readdir(dir)).sort(), [USAGE_EVENTS_FILENAME, named('20261002'), named('20261003')].sort());
  });

  it('drops only the legacy name when a new writer starts after a move stopped between link and unlink', async () => {
    const dir = await freshDir();
    const before = await legacyRegularFile(dir);
    const oct1 = join(dir, named('20261001'));
    await link(join(dir, USAGE_EVENTS_FILENAME), oct1);
    const writer = createUsageEventWriter({ dir, now: () => OCT_2_NOON });

    await writer.append(event('req_new'));

    const oct2 = join(dir, named('20261002'));
    assert.equal((await lstat(oct1)).ino, before.ino);
    assert.equal((await lstat(oct1)).nlink, 1);
    assert.equal(await readFile(oct1, 'utf8'), LEGACY_BYTES);
    assert.notEqual((await lstat(oct2)).ino, before.ino);
    assert.deepEqual(await eventIds(oct2), ['req_new/1']);
    assert.equal(await readlink(writer.path), named('20261002'));
  });

  // An older version of the writer appends to usage-events.jsonl with O_CREAT. If it writes in the
  // moment between dropping the legacy name and creating the link, a new regular file appears there.
  function writerWithOlderWriterInTheGap(dir, now) {
    const legacyPath = join(dir, USAGE_EVENTS_FILENAME);
    let simulated = false;
    return createUsageEventWriter({
      dir,
      now,
      fsOps: {
        async appendFile(target, data, options) {
          await appendFile(target, data, options);
          if (!simulated && DAILY_FILE.test(target) && String(data).length > 1) {
            simulated = true;
            await appendFile(legacyPath, OLDER_WRITER_LINE, { mode: 0o600 });
          }
        },
      },
    });
  }

  it('keeps a regular file an older writer creates at the legacy name, and moves it on the next day', async () => {
    const dir = await freshDir();
    const legacyPath = join(dir, USAGE_EVENTS_FILENAME);
    await legacyRegularFile(dir);
    let clock = OCT_2_NOON;
    const writer = writerWithOlderWriterInTheGap(dir, () => clock);

    await writer.append(event('req_1'));

    const recreated = await lstat(legacyPath);
    assert.ok(recreated.isFile());
    assert.equal(await readFile(legacyPath, 'utf8'), OLDER_WRITER_LINE);
    assert.deepEqual(await eventIds(join(dir, named('20261002'))), ['old_1/1', 'old_2/1', 'req_1/1']);

    clock += DAY_MS;
    await writer.append(event('req_2'));

    const oct3 = join(dir, named('20261003'));
    assert.equal((await lstat(oct3)).ino, recreated.ino);
    assert.deepEqual(await eventIds(oct3), ['older_1/1', 'req_2/1']);
    assert.equal(await readlink(legacyPath), named('20261003'));
    assert.deepEqual(await eventIds(join(dir, named('20261002'))), ['old_1/1', 'old_2/1', 'req_1/1']);
    assert.equal(await exists(join(dir, named('20261001'))), false);
  });

  it('moves that file to the previous day when a new writer retries on the same day', async () => {
    const dir = await freshDir();
    const legacyPath = join(dir, USAGE_EVENTS_FILENAME);
    await legacyRegularFile(dir);
    await writerWithOlderWriterInTheGap(dir, () => OCT_2_NOON).append(event('req_1'));
    const recreated = await lstat(legacyPath);
    assert.ok(recreated.isFile());

    const restarted = createUsageEventWriter({ dir, now: () => OCT_2_NOON });
    await restarted.append(event('req_2'));

    const oct1 = join(dir, named('20261001'));
    assert.equal((await lstat(oct1)).ino, recreated.ino);
    assert.equal(await readFile(oct1, 'utf8'), OLDER_WRITER_LINE);
    assert.deepEqual(await eventIds(join(dir, named('20261002'))), ['old_1/1', 'old_2/1', 'req_1/1', 'req_2/1']);
    assert.equal(await readlink(legacyPath), named('20261002'));
  });

  it('logs and leaves alone a legacy name that is neither a regular file nor a link', async () => {
    const dir = await freshDir();
    const legacyPath = join(dir, USAGE_EVENTS_FILENAME);
    await mkdir(legacyPath);
    const logs = [];
    const writer = createUsageEventWriter({ dir, now: () => OCT_2_NOON, logger: line => logs.push(line) });

    await writer.append(event('req_new'));

    assert.ok((await lstat(legacyPath)).isDirectory());
    assert.deepEqual(await eventIds(join(dir, named('20261002'))), ['req_new/1']);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /usage-events-migrate result=skipped reason=not-a-file/);
  });

  it('repoints the legacy link by renaming a temp link from the same directory over it, never backwards', async () => {
    for (const [label, pointedAt, expected] of [
      ['yesterday', named('20261001'), named('20261002')],
      ['today', named('20261002'), named('20261002')],
      ['a future day', named('20261005'), named('20261005')],
    ]) {
      const dir = await freshDir();
      const legacyPath = join(dir, USAGE_EVENTS_FILENAME);
      await symlink(pointedAt, legacyPath);
      const renames = [];
      const unlinks = [];
      const writer = createUsageEventWriter({
        dir,
        now: () => OCT_2_NOON,
        fsOps: {
          async rename(from, to) {
            // The legacy name still holds the old link right up to the rename.
            renames.push({ from, to, before: await readlink(legacyPath) });
            return rename(from, to);
          },
          async unlink(target) {
            unlinks.push(target);
            return unlink(target);
          },
        },
      });

      await writer.append(event('req_new'));

      assert.equal(await readlink(legacyPath), expected, label);
      assert.equal(unlinks.includes(legacyPath), false, label);
      if (expected === pointedAt) {
        assert.deepEqual(renames, [], label);
      } else {
        assert.equal(renames.length, 1, label);
        assert.equal(renames[0].to, legacyPath, label);
        assert.equal(dirname(renames[0].from), dir, label);
        assert.match(basename(renames[0].from), /^\.usage-events\.jsonl\.[0-9]+\.[0-9a-f]+\.tmp$/, label);
        assert.equal(renames[0].before, pointedAt, label);
      }
      assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [], label);
      assert.deepEqual(await eventIds(join(dir, named('20261002'))), ['req_new/1'], label);
    }
  });

  it('removes only regular files with a real dated name past retention, oldest first, at most two per run', async () => {
    const dir = await freshDir();
    const oct20 = Date.UTC(2026, 9, 20, 12);
    const expired = [named('20261001'), named('20261002'), named('20261003'), named('20261006')];
    const kept = [
      named('20261007'), // 13 days before: inside the 14 days
      named('20260931'), // not a real date
      named('20250229'), // not a real date (2025 is not a leap year)
      'usage-events.other.jsonl',
      'usage-events-2026092.jsonl',
      'usage-events-20260922.jsonl.bak',
      'xusage-events-20260923.jsonl',
    ];
    for (const name of [...expired, ...kept]) {
      await writeFile(join(dir, name), '{"eventId":"x/1"}\n', { mode: 0o600 });
    }
    // Older dated names that are not regular files, and a leftover temp link.
    await symlink(named('20261007'), join(dir, named('20260920')));
    await mkdir(join(dir, named('20260921')));
    await symlink(named('20261007'), join(dir, '.usage-events.jsonl.123.abcdef.tmp'));
    kept.push(named('20260920'), named('20260921'), '.usage-events.jsonl.123.abcdef.tmp');
    const logs = [];
    // Each run is a fresh start of the writer on the same day.
    const run = () => createUsageEventWriter({ dir, now: () => oct20, logger: line => logs.push(line) })
      .append(event('req_x'));

    await run();
    assert.deepEqual(
      await Promise.all(expired.map(name => exists(join(dir, name)))),
      [false, false, true, true],
    );
    await run();
    assert.deepEqual(
      await Promise.all(expired.map(name => exists(join(dir, name)))),
      [false, false, false, false],
    );
    await run();
    assert.deepEqual((await readdir(dir)).sort(), [...kept, USAGE_EVENTS_FILENAME, named('20261020')].sort());
    assert.deepEqual(logs, []);
  });

  it('keeps at least 8 days even when a shorter retention is asked for', async () => {
    const dir = await freshDir();
    const oct20 = Date.UTC(2026, 9, 20, 12);
    for (const day of ['20261012', '20261013', '20261017']) {
      await writeFile(join(dir, named(day)), '{"eventId":"x/1"}\n', { mode: 0o600 });
    }

    await createUsageEventWriter({ dir, now: () => oct20, retentionDays: 3 }).append(event('req_x'));

    assert.equal(await exists(join(dir, named('20261012'))), false);
    assert.equal(await exists(join(dir, named('20261013'))), true);
    assert.equal(await exists(join(dir, named('20261017'))), true);
  });

  it('closes a partial line with one newline before the first write to a file', async () => {
    const dir = await freshDir();
    const today = join(dir, named('20261002'));
    const partial = '{"eventId":"a/1"}\n{"eventId":"b/1","us';
    await writeFile(today, partial, { mode: 0o600 });
    const logs = [];
    const writer = createUsageEventWriter({ dir, now: () => OCT_2_NOON, logger: line => logs.push(line) });

    await writer.append(event('req_1'));

    assert.equal(await readFile(today, 'utf8'), `${partial}\n${lineOf('req_1')}`);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /usage-events-repair result=closed-partial-line/);
  });

  it('closes the partial line a failed write left before the next write, reading the tail only then', async () => {
    const dir = await freshDir();
    const logs = [];
    let opens = 0;
    const writer = createUsageEventWriter({
      dir,
      now: () => OCT_2_NOON,
      logger: line => logs.push(line),
      fsOps: {
        async appendFile(target, data, options) {
          if (String(data).includes('"req_2/1"')) {
            // The disk fills up part-way through the line.
            await appendFile(target, String(data).slice(0, 12), options);
            throw errorWithCode('ENOSPC');
          }
          return appendFile(target, data, options);
        },
        async open(...args) {
          opens += 1;
          return open(...args);
        },
      },
    });

    for (const requestId of ['req_1', 'req_2', 'req_3', 'req_4']) await writer.append(event(requestId));

    assert.deepEqual((await readFile(writer.currentPath(), 'utf8')).split('\n'), [
      lineOf('req_1').trimEnd(),
      lineOf('req_2').slice(0, 12),
      lineOf('req_3').trimEnd(),
      lineOf('req_4').trimEnd(),
      '',
    ]);
    // The tail is read before the first write and once after the failure, not on every append.
    assert.equal(opens, 2);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /usage-events-append result=failed errorType=ENOSPC/);
    assert.match(logs[1], /usage-events-repair result=closed-partial-line/);
  });

  it('lets two writers move and append in the same directory at once without losing or mixing lines', async () => {
    const dir = await freshDir();
    const before = await legacyRegularFile(dir);
    const logs = [];
    const writers = [0, 1].map(() => createUsageEventWriter({
      dir, now: () => OCT_2_NOON, logger: line => logs.push(line),
    }));
    for (let i = 0; i < 50; i += 1) {
      for (const [w, writer] of writers.entries()) writer.append(event(`req_${w}_${i}`));
    }
    await Promise.all(writers.map(writer => writer.flush()));

    const today = join(dir, named('20261002'));
    const text = await readFile(today, 'utf8');
    assert.ok(text.startsWith(LEGACY_BYTES));
    assert.ok(text.endsWith('\n'));
    const ids = text.split('\n').filter(Boolean).map(line => JSON.parse(line).eventId);
    assert.equal(ids.length, 2 + 100);
    for (const w of [0, 1]) {
      assert.deepEqual(
        ids.filter(id => id.startsWith(`req_${w}_`)),
        Array.from({ length: 50 }, (_, i) => `req_${w}_${i}/1`),
      );
    }
    const info = await lstat(today);
    assert.equal(info.ino, before.ino);
    assert.equal(info.nlink, 1);
    assert.equal(await readlink(join(dir, USAGE_EVENTS_FILENAME)), named('20261002'));
    assert.deepEqual((await readdir(dir)).sort(), [USAGE_EVENTS_FILENAME, named('20261002')].sort());
    assert.deepEqual(logs, []);
  });
});
