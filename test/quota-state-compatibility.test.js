import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFF_MODES, HEADER_CASES } from '../fixtures/quota-recovery-compatibility-worker.js';
import { AccountManager } from '../src/account-manager.js';
import { restoreQuotaWindowObservations } from '../src/quota.js';

const START = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 3_600_000;
const future = String((START + HOUR) / 1000);
const make = (policy = 'plan', mode = 'off', at = START, switchThreshold = 1) => new AccountManager({
  accounts: [{ id: 'sample-a' }, { id: 'sample-b' }], now: () => at,
  switchThreshold,
  planQuota: { mode: policy === 'plan' ? mode : 'off' },
  accountUrgency: { mode: policy === 'urgency' ? mode : 'off' },
});

describe('default-off bytes against fixed revisions', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const worker = join(root, 'fixtures/quota-recovery-compatibility-worker.js');
  const guard = join(root, 'fixtures/service-command-guard.js');
  const baseline = 'b3f0db928f1a97833762186ca86f0f36e697e9ff';
  const observationBaseline = 'ecab7a5356d62dd7ff71d8be0069fc19aa41b9ce';
  const httpFields = ['selection', 'status', 'state', 'monitor', 'logs', 'initial', 'response', 'internal', 'runtime', 'writes', 'upstream'];
  let directory;
  let current;
  let main;
  let parent;
  let mismatch = false;
  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'quota-recovery-byte-'));
    async function extract(revision, name) {
      const destination = join(directory, name);
      await mkdir(destination);
      const archive = execFileSync('git', ['archive', '--format=tar', revision, 'src', 'package.json'],
        { cwd: root, maxBuffer: 16 * 1024 * 1024 });
      execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
      return destination;
    }
    const mainRoot = await extract(baseline, 'main-source');
    const parentRoot = await extract(observationBaseline, 'observation-source');
    const input = JSON.stringify([randomUUID(), randomUUID()]);
    function run(sourceRoot, name, scope = 'all') {
      const storage = join(directory, name);
      return new Promise((resolveRun, reject) => {
        const child = execFile(process.execPath, ['--import', guard, worker, sourceRoot, storage, scope], {
          cwd: sourceRoot, maxBuffer: 16 * 1024 * 1024,
          env: { PATH: process.env.PATH || '', TMPDIR: directory, TZ: 'UTC', LANG: 'C', LC_ALL: 'C',
            CLAUDE_ROTATOR_REAL_KEYCHAIN: '0', XDG_CONFIG_HOME: join(storage, 'config'),
            XDG_DATA_HOME: join(storage, 'data'), CLAUDE_CONFIG_DIR: join(storage, 'claude-fixture'),
            CLAUDE_ROTATOR_SERVICE_COMMAND_LOG: join(storage, 'service-guard.log') },
        }, (error, stdout, stderr) => {
          if (error) reject(new Error(`compatibility worker ${name} failed: ${error.code}; ${stderr}`));
          else {
            try { resolveRun(JSON.parse(stdout)); } catch { reject(new Error(`compatibility worker ${name} returned invalid JSON`)); }
          }
        });
        child.stdin.on('error', reject);
        child.stdin.end(input);
      });
    }
    const runs = await Promise.allSettled([run(root, 'current'), run(mainRoot, 'main'), run(parentRoot, 'parent', 'observation')]);
    for (const run of runs) assert.equal(run.status, 'fulfilled', run.reason?.message);
    [current, main, parent] = runs.map(run => run.value);
  });
  after(async () => { if (directory && !mismatch) await rm(directory, { recursive: true, force: true }); });

  function equalBytes(actual, expected, label) {
    const left = Buffer.from(actual, 'base64');
    const right = Buffer.from(expected, 'base64');
    const digest = value => createHash('sha256').update(value).digest('hex');
    if (!left.equals(right)) {
      mismatch = true;
      const evidence = join(directory, `mismatch-${digest(Buffer.from(label)).slice(0, 12)}.json`);
      writeFileSync(evidence, JSON.stringify({ label, current: actual, baseline: expected }, null, 2) + '\n');
      assert.fail(`${label}: byte mismatch; current=${digest(left)} baseline=${digest(right)} evidence=${evidence}`);
    }
  }
  for (const mode of OFF_MODES) for (const scenario of HEADER_CASES) {
    const id = `${mode}/${scenario.id}`;
    it(`keeps selection, status, persistence and monitor bytes equal to main for ${id}`, () => {
      assert.ok(current.manager[id]);
      assert.ok(main.manager[id]);
      for (const field of ['selection', 'status', 'state', 'monitor', 'logs']) {
        equalBytes(current.manager[id][field], main.manager[id][field], `${id}/${field}`);
      }
    });
    for (const status of [200, 429]) {
      const httpId = `${id}/${status}`;
      it(`keeps full HTTP, state and log bytes equal to main for ${httpId}`, () => {
        assert.ok(current.http[httpId]);
        assert.ok(main.http[httpId]);
        for (const field of httpFields) equalBytes(current.http[httpId][field], main.http[httpId][field], `${httpId}/${field}`);
      });
    }
  }
  for (const mode of OFF_MODES) for (const status of [200, 429]) {
    const id = `${mode}/invalid-fable/${status}`;
    it(`keeps observation-only routing equal to main and preserves existing observation log bytes for ${id}`, () => {
      assert.ok(current.observation[id]);
      assert.ok(main.observation[id]);
      assert.ok(parent.observation[id]);
      for (const field of httpFields) {
        equalBytes(current.observation[id][field], parent.observation[id][field], `${id}/parent/${field}`);
        if (field !== 'logs') equalBytes(current.observation[id][field], main.observation[id][field], `${id}/main/${field}`);
      }
      const logs = JSON.parse(Buffer.from(current.observation[id].logs, 'base64').toString());
      assert.equal(logs.filter(line => line.startsWith('{') && JSON.parse(line).event === 'quota_shape').length, 1);
      assert.equal(logs.some(line => line.startsWith('quota_recovery ')), false);
    });
  }
});

describe('default-off rate-limit compatibility', () => {
  for (const mode of ['off', 'shadow']) {
    for (const [name, headers, selected, used, resetAt] of [
      ['past reset', { 'anthropic-ratelimit-unified-5h-utilization': '0',
        'anthropic-ratelimit-unified-5h-reset': String((START - 1000) / 1000) }, 'sample-b', null, null],
      ['zero reset', { 'anthropic-ratelimit-unified-5h-utilization': '0',
        'anthropic-ratelimit-unified-5h-reset': '0' }, 'sample-a', 0, 0],
      ['utilization only', { 'anthropic-ratelimit-unified-5h-utilization': '0' }, 'sample-a', 0.1, START + HOUR],
      ['reset only', { 'anthropic-ratelimit-unified-5h-reset': '0' }, 'sample-a', 0.1, START + HOUR],
    ]) {
      it(`keeps the legacy 429 assignment and quota for ${name} in ${mode}`, () => {
        const manager = make('plan', mode);
        for (const [id, value] of [['sample-a', '0.1'], ['sample-b', '0.2']]) manager.updateQuota(id, {
          'anthropic-ratelimit-unified-5h-utilization': value,
          'anthropic-ratelimit-unified-5h-reset': future,
        });
        assert.equal(manager.selectForNewAssignment().id, 'sample-a');
        manager.updateQuota('sample-a', headers, { atomicUnifiedWindows: true });
        assert.equal(manager.selectForNewAssignment().id, selected);
        assert.equal(manager.find('sample-a').quota.unified5h, used);
        assert.equal(manager.find('sample-a').quota.unified5hReset, resetAt);
      });
    }
  }
});

describe('shadow observation persistence', () => {
  for (const policy of ['plan', 'urgency']) {
    it(`restores a shadow Fable stop before selecting an on-mode recovery account (${policy})`, () => {
      const shadow = make(policy, 'shadow', START, 0.97);
      shadow.updateQuota('sample-a', {
        'anthropic-ratelimit-unified-7d-utilization': '0.3',
        'anthropic-ratelimit-unified-7d-reset': String((START + 24 * HOUR) / 1000),
        'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
        'anthropic-ratelimit-unified-7d-fable-reset': String((START + 24 * HOUR) / 1000),
      });
      assert.deepEqual(shadow.find('sample-a').quota.weeklyScoped, []);
      const saved = shadow.exportState();
      assert.ok(saved.accounts[0].windowObservations, 'shadow observations must be persisted');
      assert.equal(saved.accounts[0].windowObservations['7d_fable'].lastKnown.usedFraction, 0.99);
      const restored = make(policy, 'on', START + 31 * 60_000, 0.97);
      restored.restoreState(saved);
      assert.equal(restored.selectForNewAssignment({ modelFamily: 'fable' }), null);
      assert.equal(restored.canRecoverWeeklyQuota(restored.find('sample-a'), 'fable'), false);
      assert.equal(restored.selectForNewAssignment()?.id, 'sample-a');
      assert.equal(restored.find('sample-a').windowObservations['7d_fable'].lastKnown.observedAt, START);
      restored.updateQuota('sample-a', {
        'anthropic-ratelimit-unified-7d-utilization': '0.31',
        'anthropic-ratelimit-unified-7d-reset': String((START + 24 * HOUR) / 1000),
      });
      assert.equal(restored.canSendWithUrgency(restored.find('sample-a'), 'fable'), false);
    });
  }

  it('keeps observations through a shadow restart without changing the legacy quota', () => {
    const shadow = make('plan', 'shadow');
    shadow.updateQuota('sample-a', {
      'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
      'anthropic-ratelimit-unified-7d-fable-reset': String((START + 24 * HOUR) / 1000),
    });
    const saved = shadow.exportState();
    const restored = make('plan', 'shadow');
    restored.restoreState(saved);
    assert.deepEqual(restored.find('sample-a').windowObservations, saved.accounts[0].windowObservations);
    assert.deepEqual(restored.find('sample-a').quota, shadow.find('sample-a').quota);
  });

  it('omits the new observation state when both policies are off', () => {
    const off = make();
    off.updateQuota('sample-a', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': future,
    });
    assert.equal(Object.hasOwn(off.exportState().accounts[0], 'windowObservations'), false);
  });
});

describe('persisted five-hour display', () => {
  for (const [state, fiveHour] of [
    ['missing', undefined],
    ['explicit_null', null],
    ['invalid', { utilization: '0', resets_at: new Date(START + HOUR).toISOString() }],
  ]) {
    it(`preserves a retained five-hour display after an urgency-only restart (${state})`, () => {
      const clock = { ms: START };
      const create = () => new AccountManager({ accounts: [{ id: 'sample-a' }],
        accountUrgency: { mode: 'on' }, now: () => clock.ms });
      const manager = create();
      const week = { utilization: 0.3, resets_at: new Date(START + 24 * HOUR).toISOString() };
      manager.applyUsage('sample-a', { seven_day: week, five_hour: {
        utilization: 0.99, resets_at: new Date(START + HOUR).toISOString(),
      } });
      clock.ms += 60_000;
      manager.applyUsage('sample-a', { seven_day: week,
        ...(state === 'missing' ? {} : { five_hour: fiveHour }) });
      const before = manager.getStatus().accountUrgency.accounts[0].fiveHour;
      const known = { usedFraction: 0.99, resetAt: START + HOUR, observedAt: START };
      assert.equal(before.retainedConstraint, true);
      assert.deepEqual(before.lastKnown, known);
      assert.equal(manager.selectForNewAssignment(), null);

      const saved = JSON.parse(JSON.stringify(manager.exportState()));
      clock.ms += 60_000;
      const restarted = create();
      restarted.restoreState(saved);
      const persisted = restarted.exportState();
      const section = restarted.getStatus().accountUrgency;
      const five = section.accounts[0].fiveHour;
      assert.equal(five.retainedConstraint, true);
      assert.deepEqual(five.lastKnown, known);
      assert.equal(five.observedAt, START);
      assert.equal(five.reportedAt, START + 60_000);
      assert.equal(five.observationState, state);
      assert.equal(five.source, before.source);
      assert.equal(five.usedFraction, null);
      assert.equal(five.fresh, false);
      assert.equal(section.accounts[0].weekly.fresh, false);
      assert.equal(section.accounts[0].requiredPace, null);
      const displayWindow = section.accounts[0].windows.find(window => window.id === '5h');
      assert.equal(displayWindow.retainedConstraint, true);
      assert.deepEqual(displayWindow.lastKnown, known);
      assert.equal(displayWindow.observedAt, START);
      assert.deepEqual(restarted.exportState(), persisted, 'status must not turn saved values into new observations');
      assert.equal(restarted.urgencyRows()[0].fiveHour.retainedConstraint, false, 'policy metrics remain unrestored');
      assert.equal(restarted.canSendWithUrgency(restarted.find('sample-a')), false);
      assert.equal(restarted.selectForNewAssignment(), null);

      clock.ms = START + HOUR;
      assert.equal(restarted.getStatus().accountUrgency.accounts[0].fiveHour.retainedConstraint, false);
      assert.equal(restarted.getStatus().accountUrgency.accounts[0].fiveHour.lastKnown, null);
      assert.equal(restarted.selectForNewAssignment()?.id, 'sample-a');
    });
  }
});

describe('upstream short-term holds with scoped exhaustion', () => {
  for (const policy of ['plan', 'urgency']) {
    for (const mode of ['off', 'shadow', 'on']) {
      it(`honors a short-term hold only in on mode and releases it at its deadline (${policy}, ${mode})`, () => {
        const clock = { ms: START };
        const manager = new AccountManager({ accounts: [{ id: 'sample-a' }], now: () => clock.ms,
          planQuota: { mode: policy === 'plan' ? mode : 'off' },
          accountUrgency: { mode: policy === 'urgency' ? mode : 'off' } });
        manager.applyUsage('sample-a', {
          seven_day: { utilization: 0.3, resets_at: new Date(START + 24 * HOUR).toISOString() },
          scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1,
            resets_at: new Date(START + HOUR).toISOString() }],
        });
        const account = manager.find('sample-a');
        assert.equal(manager.isAvailable(account), true);
        manager.markRateLimited('sample-a', 60);
        assert.equal(manager.isAvailable(account), mode !== 'on');
        assert.equal(account.status, 'exhausted', 'a scope stop must not hide the upstream hold in on mode');
        assert.equal(manager.isAvailable(account, 'fable'), false);
        clock.ms += 59_999;
        assert.equal(manager.isAvailable(account), mode !== 'on');
        clock.ms++;
        assert.equal(manager.isAvailable(account), true);
        assert.equal(account.rateLimitedUntil, null);
        assert.equal(manager.isAvailable(account, 'fable'), false);
      });
    }
  }
});

describe('restored quota reset validation', () => {
  it('discards last-known windows with missing or non-finite resets', () => {
    for (const id of ['5h', '7d', '7d_fable']) {
      for (const resetAt of [null, undefined, NaN, Infinity, -Infinity, '2026-01-02T00:00:00Z']) {
        const observations = restoreQuotaWindowObservations({ [id]: {
          observationState: 'missing', observedAt: START + 60_000, source: 'header',
          lastKnown: { usedFraction: 0.99, resetAt, observedAt: START },
        } });
        assert.equal(observations[id].lastKnown, null, `${id}: ${String(resetAt)}`);
      }
    }
  });

  for (const policy of ['plan', 'urgency']) {
    it(`does not restore an unbounded five-hour stop from a corrupt saved state (${policy})`, () => {
      const original = make(policy, 'on');
      original.applyUsage('sample-a', { seven_day: {
        utilization: 0.3, resets_at: new Date(START + 24 * HOUR).toISOString(),
      } });
      const saved = JSON.parse(JSON.stringify(original.exportState()));
      saved.accounts[0].windowObservations['5h'] = {
        observationState: 'missing', observedAt: START, source: 'header',
        lastKnown: { usedFraction: 0.99, resetAt: null, observedAt: START },
      };
      const restored = make(policy, 'on');
      restored.restoreState(saved);
      assert.equal(restored.find('sample-a').windowObservations['5h'].lastKnown, null);
      assert.equal(restored.find('sample-a').quota.unified5h, null);
      assert.equal(restored.find('sample-a').quota.unified5hReset, null);
      assert.equal(restored.selectForNewAssignment()?.id, 'sample-a');
    });
  }

  it('does not write an unbounded five-hour observation back when enabling plan quota', () => {
    const manager = make('plan', 'shadow');
    manager.find('sample-a').windowObservations['5h'] = {
      observationState: 'missing', observedAt: START, source: 'header',
      lastKnown: { usedFraction: 0.99, resetAt: null, observedAt: START },
    };
    manager.configurePlanQuota({ mode: 'on' });
    assert.equal(manager.find('sample-a').quota.unified5h, null);
    assert.equal(manager.find('sample-a').quota.unified5hReset, null);
  });
});
