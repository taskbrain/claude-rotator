import { LinuxFileSecretStore } from '../src/secret-store.js';

const [accountsDir, accountId] = process.argv.slice(2);
const store = new LinuxFileSecretStore({ accountsDir });

try {
  const current = await store.get(accountId);
  await store.refreshIfUnchanged(accountId, current, async (_secret, transaction) => {
    if (typeof transaction?.beforeHandoff !== 'function') {
      throw new Error('refresh handoff transaction hook is unavailable');
    }
    await transaction.beforeHandoff();
    process.send?.({ type: 'handed-off' });
    await new Promise(() => {});
  });
} catch (error) {
  process.send?.({ type: 'worker-error', message: error?.message || 'unknown error' });
  process.exitCode = 1;
}
