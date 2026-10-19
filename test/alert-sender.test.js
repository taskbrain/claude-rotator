import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createAlertSender } from '../src/alert-sender.js';
import '../fixtures/service-command-guard.js';

// 目印の字。URL の中身とファイルのパスの両方に入れ、どの出口にも出ないことを見る。
const URL_MARK = 'ZZMARK-URL-q81';
const PATH_MARK = 'ZZMARK-PATH-q81';
const HOOK_URL = `https://example.invalid/${URL_MARK}/post`;

let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), `alert-sender-${PATH_MARK}-`));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

let fileSeq = 0;
async function urlFile(content = `${HOOK_URL}\n`, mode = 0o600) {
  fileSeq += 1;
  const path = join(dir, `hook-${fileSeq}`);
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}

// 登録したら setImmediate で必ず呼ぶタイマー。待ちの長さを記録する。
function autoTimers() {
  const delays = [];
  return {
    delays,
    setTimeout(fn, ms) {
      delays.push(ms);
      const timer = { cleared: false };
      setImmediate(() => {
        if (!timer.cleared) fn();
      });
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };
}

// 自分では呼ばないタイマー。
function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      pending.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  };
}

function response(status, body = '', headers = {}) {
  return new Response(body, { status, headers });
}

// 決めた順に応答を返す偽の fetch。関数を並べると、それを呼んだ結果を返す（reject もできる）。
function scriptedFetch(steps) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return typeof step === 'function' ? step() : step;
  };
  return { fetchImpl, calls };
}

const noExec = async () => {
  throw new Error('execFile must not be called');
};

function networkError() {
  return new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED ${HOOK_URL}`) });
}

function timeoutError() {
  return new DOMException(`timed out ${HOOK_URL}`, 'TimeoutError');
}

function assertNoMarks(value, label) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(URL_MARK), `${label} has the URL mark`);
  assert.ok(!text.includes(PATH_MARK), `${label} has the path mark`);
  assert.ok(!text.includes('example.invalid'), `${label} has the URL host`);
}

describe('createAlertSender (S1)', () => {
  it('throws when execFile or fetchImpl is not a function', () => {
    const fetchImpl = async () => response(200);
    assert.throws(() => createAlertSender(), TypeError);
    assert.throws(() => createAlertSender({ fetchImpl }), /execFile/);
    assert.throws(() => createAlertSender({ execFile: noExec }), /fetchImpl/);
    assert.throws(() => createAlertSender({ execFile: 'osascript', fetchImpl }), /execFile/);
    assert.doesNotThrow(() => createAlertSender({ execFile: noExec, fetchImpl }));
  });
});

describe('notifyMac (S2)', () => {
  it('runs osascript with the message as argv items and keeps the URL out of argv', async () => {
    const execCalls = [];
    const execFile = async (file, args, options) => {
      execCalls.push({ file, args, options });
    };
    const { fetchImpl } = scriptedFetch([response(200)]);
    const sender = createAlertSender({ execFile, fetchImpl, platform: 'darwin', timers: manualTimers() });

    assert.deepEqual(await sender.postWebhook({ urlFile: await urlFile(), text: 'hello' }), { result: 'ok', reason: null });
    const result = await sender.notifyMac({ title: 'claude-rotator', body: 'Run: claude-rotator login --id acc-1' });

    assert.deepEqual(result, { result: 'exited-0' });
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].file, '/usr/bin/osascript');
    assert.deepEqual(execCalls[0].args, [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv)',
      '-e', 'end run',
      'Run: claude-rotator login --id acc-1',
      'claude-rotator',
    ]);
    assert.equal(execCalls[0].options.timeout, 10_000);
    assertNoMarks(execCalls[0].args, 'argv');
  });

  it('does not run anything off macOS', async () => {
    let called = 0;
    const execFile = async () => {
      called += 1;
    };
    for (const platform of ['linux', 'win32']) {
      const sender = createAlertSender({ execFile, fetchImpl: async () => response(200), platform, timers: manualTimers() });
      assert.deepEqual(await sender.notifyMac({ title: 't', body: 'b' }), { result: 'skipped-platform' });
    }
    assert.equal(called, 0);
  });

  it('maps exec failures and timeouts to short results', async () => {
    const fetchImpl = async () => response(200);
    const failing = createAlertSender({
      execFile: async () => {
        throw Object.assign(new Error(`exit 1 ${HOOK_URL}`), { code: 1 });
      },
      fetchImpl,
      platform: 'darwin',
      timers: manualTimers(),
    });
    const failed = await failing.notifyMac({ title: 't', body: 'b' });
    assert.deepEqual(failed, { result: 'failed-exec' });

    const killed = createAlertSender({
      execFile: async () => {
        throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
      },
      fetchImpl,
      platform: 'darwin',
      timers: manualTimers(),
    });
    assert.deepEqual(await killed.notifyMac({ title: 't', body: 'b' }), { result: 'timeout' });

    // execFile が返らないままでも、10秒のタイマーで timeout を返す。
    const timers = autoTimers();
    const hung = createAlertSender({ execFile: () => new Promise(() => {}), fetchImpl, platform: 'darwin', timers });
    assert.deepEqual(await hung.notifyMac({ title: 't', body: 'b' }), { result: 'timeout' });
    assert.deepEqual(timers.delays, [10_000]);
  });
});

describe('checkWebhookFile and the URL file (S3)', () => {
  function sender(extra = {}) {
    const fetched = scriptedFetch([response(200)]);
    return {
      fetched,
      sender: createAlertSender({ execFile: noExec, fetchImpl: fetched.fetchImpl, platform: 'linux', timers: manualTimers(), ...extra }),
    };
  }

  it('accepts a private https file and returns no URL or path', async () => {
    const { sender: s } = sender();
    const result = await s.checkWebhookFile(await urlFile());
    assert.deepEqual(result, { usable: true, problem: null });
  });

  it('classifies each unusable file and never sends', async () => {
    const cases = [];
    cases.push(['missing', join(dir, 'no-such-file')]);
    cases.push(['missing', join(dir, 'no-such-dir', 'hook')]);
    cases.push(['not-absolute', `${PATH_MARK}/hook`]);
    cases.push(['not-absolute', '']);
    cases.push(['not-absolute', undefined]);
    const target = await urlFile();
    const link = join(dir, 'hook-link');
    await symlink(target, link);
    cases.push(['type', link]);
    const folder = join(dir, 'hook-folder');
    await mkdir(folder, { mode: 0o700 });
    cases.push(['type', folder]);
    cases.push(['mode', await urlFile(`${HOOK_URL}\n`, 0o644)]);
    cases.push(['mode', await urlFile(`${HOOK_URL}\n`, 0o640)]);
    cases.push(['size', await urlFile(`${HOOK_URL}${'a'.repeat(4096)}\n`)]);
    cases.push(['scheme', await urlFile(`http://example.invalid/${URL_MARK}\n`)]);
    cases.push(['format', await urlFile(`https://user:pass@example.invalid/${URL_MARK}\n`)]);
    cases.push(['format', await urlFile(`https://user@example.invalid/${URL_MARK}\n`)]);
    cases.push(['format', await urlFile(`not a url ${URL_MARK}\n`)]);
    cases.push(['format', await urlFile(`${HOOK_URL}\n${HOOK_URL}\n`)]);
    cases.push(['format', await urlFile('\n')]);

    for (const [problem, path] of cases) {
      const { sender: s, fetched } = sender();
      const checked = await s.checkWebhookFile(path);
      assert.deepEqual(checked, { usable: false, problem }, `check ${problem}`);
      const posted = await s.postWebhook({ urlFile: path, text: 'hello' });
      assert.deepEqual(posted, { result: `unusable-${problem}`, reason: null }, `post ${problem}`);
      assert.equal(fetched.calls.length, 0, `${problem} must not send`);
      assertNoMarks(checked, `check ${problem}`);
      assertNoMarks(posted, `post ${problem}`);
    }
  });

  it('refuses a file owned by another user', async () => {
    // 走る利用者によらず持ち主の食い違いを作るため、fstat を差し替えて uid をずらす
    // （root でない利用者は chown で持ち主を変えられない）。
    const fstat = async handle => {
      const info = await handle.stat();
      return { isFile: () => info.isFile(), uid: info.uid + 1, mode: info.mode, size: info.size };
    };
    const { sender: s, fetched } = sender({ fstat });
    const path = await urlFile();
    assert.deepEqual(await s.checkWebhookFile(path), { usable: false, problem: 'owner' });
    assert.deepEqual(await s.postWebhook({ urlFile: path, text: 'x' }), { result: 'unusable-owner', reason: null });
    assert.equal(fetched.calls.length, 0);
  });

  it('maps a failing stat to read without leaking the error', async () => {
    const fstat = async () => {
      throw new Error(`EIO ${dir} ${HOOK_URL}`);
    };
    const { sender: s } = sender({ fstat });
    const result = await s.checkWebhookFile(await urlFile());
    assert.deepEqual(result, { usable: false, problem: 'read' });
    assertNoMarks(result, 'read result');
  });

  it('accepts surrounding whitespace and sends the URL read from the file', async () => {
    const fetched = scriptedFetch([response(200)]);
    const s = createAlertSender({ execFile: noExec, fetchImpl: fetched.fetchImpl, platform: 'linux', timers: manualTimers() });
    const path = await urlFile(`  ${HOOK_URL}  \n\n`);
    assert.deepEqual(await s.postWebhook({ urlFile: path, text: 'x' }), { result: 'ok', reason: null });
    assert.equal(fetched.calls[0].url, HOOK_URL);
  });
});

describe('postWebhook responses (S4)', () => {
  async function post(steps, { text = 'hello', timers = autoTimers() } = {}) {
    const fetched = scriptedFetch(steps);
    const s = createAlertSender({ execFile: noExec, fetchImpl: fetched.fetchImpl, platform: 'linux', timers });
    const result = await s.postWebhook({ urlFile: await urlFile(), text });
    return { result, calls: fetched.calls, delays: timers.delays };
  }

  it('posts JSON once, refuses redirects, has a timeout signal, and keeps the URL out of the body', async () => {
    const { result, calls } = await post([response(200, 'ok')], { text: 'claude-rotator: test' });
    assert.deepEqual(result, { result: 'ok', reason: null });
    assert.equal(calls.length, 1);
    const { options } = calls[0];
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, '{"text":"claude-rotator: test"}');
    assertNoMarks(options.body, 'body');
  });

  it('cuts the text at 3,000 characters', async () => {
    const { calls } = await post([response(200)], { text: 'é'.repeat(3_500) });
    assert.equal(JSON.parse(calls[0].options.body).text, 'é'.repeat(3_000));
  });

  it('waits for Retry-After on 429, capped at 300 seconds, 30 seconds when unreadable', async () => {
    let run = await post([response(429, '', { 'retry-after': '7' }), response(200)]);
    assert.deepEqual(run.result, { result: 'ok', reason: null });
    assert.equal(run.calls.length, 2);
    assert.deepEqual(run.delays, [7_000]);

    run = await post([response(429, '', { 'retry-after': '9999' }), response(429, '', { 'retry-after': 'soon' }), response(429)]);
    assert.deepEqual(run.result, { result: 'gave-up-429', reason: null });
    assert.equal(run.calls.length, 3);
    assert.deepEqual(run.delays, [300_000, 30_000]);
  });

  it('gives up after 3 attempts on 5xx, network failures and timeouts, waiting 30 and 120 seconds', async () => {
    let run = await post([response(500, 'boom'), response(502), response(503)]);
    assert.deepEqual(run.result, { result: 'gave-up-5xx', reason: null });
    assert.equal(run.calls.length, 3);
    assert.deepEqual(run.delays, [30_000, 120_000]);

    run = await post([() => Promise.reject(networkError())]);
    assert.deepEqual(run.result, { result: 'gave-up-network', reason: null });
    assert.equal(run.calls.length, 3);
    assert.deepEqual(run.delays, [30_000, 120_000]);

    run = await post([() => Promise.reject(timeoutError())]);
    assert.deepEqual(run.result, { result: 'gave-up-timeout', reason: null });
    assert.equal(run.calls.length, 3);

    run = await post([response(503), response(200)]);
    assert.deepEqual(run.result, { result: 'ok', reason: null });
    assert.equal(run.calls.length, 2);

    // 回数は種類をまたいで数え、最後の失敗の種類で止まる。
    run = await post([response(500), () => Promise.reject(networkError()), response(429, '', { 'retry-after': '1' })]);
    assert.deepEqual(run.result, { result: 'gave-up-429', reason: null });
    assert.equal(run.calls.length, 3);
    assert.deepEqual(run.delays, [30_000, 120_000]);

    // rollup_error は一時的なので送り直す。
    run = await post([response(500, 'rollup_error'), response(200)]);
    assert.deepEqual(run.result, { result: 'ok', reason: null });
    assert.equal(run.calls.length, 2);
  });

  it('does not retry 4xx or a permanent word on 5xx', async () => {
    const cases = [
      [400, 'invalid_payload', 'invalid_payload'],
      [403, 'action_prohibited', 'action_prohibited'],
      [404, 'channel_not_found', 'channel_not_found'],
      [410, 'channel_is_archived', 'channel_is_archived'],
      [404, 'user_not_found\n', 'user_not_found'],
      [403, 'posting_to_general_channel_denied', 'posting_to_general_channel_denied'],
      [400, `bad ${URL_MARK}`, 'other'],
      [401, '', 'other'],
      [400, `no_service${'x'.repeat(2_000)}`, 'other'],
      [500, 'no_service', 'no_service'],
      [503, 'channel_is_archived', 'channel_is_archived'],
    ];
    for (const [status, body, reason] of cases) {
      const run = await post([response(status, body), response(200)]);
      assert.deepEqual(run.result, { result: `rejected-${status}`, reason }, `${status} ${reason}`);
      assert.equal(run.calls.length, 1, `${status} ${reason} must not retry`);
      assert.deepEqual(run.delays, []);
    }
  });

  it('does not follow redirects', async () => {
    let run = await post([() => Promise.reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }))]);
    assert.deepEqual(run.result, { result: 'rejected-redirect', reason: null });
    assert.equal(run.calls.length, 1);

    run = await post([response(302, '', { location: `https://example.invalid/${URL_MARK}/elsewhere` })]);
    assert.deepEqual(run.result, { result: 'rejected-redirect', reason: null });
    assert.equal(run.calls.length, 1);
  });

  it('reads the URL file again for each attempt', async () => {
    const path = await urlFile();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      // 1回目の後にファイルを置き直す。2回目は新しい中身で判断する。
      await writeFile(path, `http://example.invalid/${URL_MARK}\n`, { mode: 0o600 });
      return response(500);
    };
    const s = createAlertSender({ execFile: noExec, fetchImpl, platform: 'linux', timers: autoTimers() });
    assert.deepEqual(await s.postWebhook({ urlFile: path, text: 'x' }), { result: 'unusable-scheme', reason: null });
    assert.equal(calls, 1);
  });

  it('stop() ends a pending retry wait without sending again', async () => {
    const timers = manualTimers();
    const fetched = scriptedFetch([response(500), response(200)]);
    const s = createAlertSender({ execFile: noExec, fetchImpl: fetched.fetchImpl, platform: 'linux', timers });
    const pending = s.postWebhook({ urlFile: await urlFile(), text: 'x' });
    // ファイルの読みと1回目の送りが終わるのを待つ（壊れた実装で止まらないよう、5秒で打ち切る）。
    const deadline = Date.now() + 5_000;
    while (timers.pending.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(timers.pending.length, 1, 'a retry wait must be pending');
    assert.equal(timers.pending[0].ms, 30_000);
    s.stop();
    assert.deepEqual(await pending, { result: 'gave-up-5xx', reason: null });
    assert.equal(timers.pending[0].cleared, true);
    assert.equal(fetched.calls.length, 1);
  });
});

describe('failures with marked messages stay contained (S5)', () => {
  it('never puts the URL or the path into results, logs or unhandled rejections', async () => {
    const logged = [];
    const unhandled = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const onUnhandled = reason => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    for (const name of Object.keys(original)) console[name] = (...args) => logged.push(args);
    const results = [];
    try {
      const marked = () => Promise.reject(new Error(`refused ${HOOK_URL} ${dir}`));
      const fetched = scriptedFetch([marked]);
      const execFile = async () => {
        throw new Error(`osascript ${HOOK_URL} ${dir}`);
      };
      const s = createAlertSender({ execFile, fetchImpl: fetched.fetchImpl, platform: 'darwin', timers: autoTimers() });
      const path = await urlFile();
      results.push(await s.postWebhook({ urlFile: path, text: 'x' }));
      results.push(await s.notifyMac({ title: 't', body: 'b' }));
      results.push(await s.checkWebhookFile(path));
      // fetch が同期で throw しても reject しない。
      const throwing = createAlertSender({
        execFile,
        fetchImpl: () => {
          throw new Error(`sync ${HOOK_URL}`);
        },
        platform: 'darwin',
        timers: autoTimers(),
      });
      results.push(await throwing.postWebhook({ urlFile: path, text: 'x' }));
      // 本文の読みが失敗しても reject しない。
      const brokenBody = createAlertSender({
        execFile,
        fetchImpl: async () => ({
          status: 400,
          headers: new Headers(),
          body: { getReader: () => ({ read: () => Promise.reject(new Error(`body ${HOOK_URL}`)), cancel: async () => {} }) },
        }),
        platform: 'darwin',
        timers: autoTimers(),
      });
      results.push(await brokenBody.postWebhook({ urlFile: path, text: 'x' }));
      for (let i = 0; i < 3; i += 1) await new Promise(resolve => setImmediate(resolve));
    } finally {
      Object.assign(console, original);
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(results, [
      { result: 'gave-up-network', reason: null },
      { result: 'failed-exec' },
      { usable: true, problem: null },
      { result: 'gave-up-network', reason: null },
      { result: 'rejected-400', reason: 'other' },
    ]);
    assertNoMarks(results, 'results');
    assert.deepEqual(logged, []);
    assert.deepEqual(unhandled, []);
  });
});
