import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildUsageEvent,
  createUsageEventWriter,
  usageEventsDir,
  usageFromObservation,
  USAGE_EVENTS_FILENAME,
} from '../src/usage-events.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    const writer = createUsageEventWriter({
      dir: join(base, 'usage-events'),
      fsOps: {
        async appendFile(...args) {
          appendCalls += 1;
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
    // Let the queue run up to the stalled write.
    await new Promise(resolve => setTimeout(resolve, 20));
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
          if (chmodFileFails && target.endsWith(USAGE_EVENTS_FILENAME)) {
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
            if (!target.endsWith(USAGE_EVENTS_FILENAME)) return info;
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
      assert.equal(logs.length, 1, label);
      assert.match(logs[0], new RegExp(`target=file reason=${reason} action=skip-event`), label);
    }
  });
});
