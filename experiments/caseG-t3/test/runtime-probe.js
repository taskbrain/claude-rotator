import { createProxy } from '../proxy-core.js';

// Import-only probe: it never listens or requests credentials, even on failure.
if (!process.env.NODE_TEST_CONTEXT && process.argv[2]) {
  let accepted = false;
  for (const injected of [
    { upstream: 'http://127.0.0.1:41999' },
    { store: { async read() { throw new Error('not used'); } } },
    { port: 0 },
  ]) {
    try {
      const proxy = await createProxy({ configFile: process.argv[2], mode: 'passthrough', apply: true, ...injected });
      accepted = true;
      await proxy.close();
    } catch { /* Refusal is the expected outcome. */ }
  }
  process.stdout.write(accepted ? 'accepted\n' : 'refused\n');
  process.exitCode = accepted ? 1 : 0;
}
