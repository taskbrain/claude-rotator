import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAccountPool } from '../../src/codex/account-pool.js';

// Outward mixed classification includes observed exclusion,
// without learning that observation as confirmed exhaustion.
for (const otherHealthy of [false, true]) {
  for (const failure of ['needs-login', 'credentials-unavailable']) {
    for (const confirmedReset of [undefined, 2000, 4000]) {
      test(`mixed: ${otherHealthy ? 'model scope' : 'pool scope'} ${failure} confirmed reset ${confirmedReset ?? 'absent'}`, () => {
        const entries = [
          { key: 'excluded', models: ['astra'] },
          { key: 'failed', models: ['astra'] },
          ...(confirmedReset === undefined ? [] : [{ key: 'exhausted', models: ['astra'] }]),
          ...(otherHealthy ? [{ key: 'other', models: ['other'] }] : []),
        ];
        const pool = createCodexAccountPool(entries);
        for (const { key } of entries) pool.credentials(key, true, 0);
        pool.observe('excluded', { primary_used_percent: 95, primary_reset_at: 3000,
          secondary_used_percent: 99, secondary_reset_at: 5000 }, 100);
        if (failure === 'needs-login') pool.forbidden('failed', 100);
        else pool.credentials('failed', false, 100);
        if (confirmedReset !== undefined) pool.exhausted('exhausted', { resetAt: confirmedReset, retryAt: confirmedReset }, 100);
        assert.equal(pool.select('astra', 101), null);
        assert.deepEqual(pool.terminal('astra', 101), {
          status: 529, type: 'overloaded_error', reason: 'codex_pool_mixed',
          scope: otherHealthy ? 'model' : 'pool', state: 'mixed',
          resetAt: confirmedReset === 2000 ? 2000 : 3000,
        });
        assert.equal(pool.snapshot().find(a => a.key === 'excluded').state, 'ready');
        if (otherHealthy) assert.equal(pool.select('other', 101).key, 'other');
      });
    }
  }
}
