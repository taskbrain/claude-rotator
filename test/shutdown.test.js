import { it } from 'node:test';
import assert from 'node:assert/strict';

import { closeServerWithDeadline } from '../src/cli.js';

it('forces active HTTP connections closed when graceful shutdown exceeds its deadline', async () => {
  let closeCallback;
  let idleCloseCalls = 0;
  let forceCloseCalls = 0;
  const server = {
    close(callback) {
      closeCallback = callback;
    },
    closeIdleConnections() {
      idleCloseCalls += 1;
    },
    closeAllConnections() {
      forceCloseCalls += 1;
      closeCallback();
    },
  };

  await closeServerWithDeadline(server, 10);

  assert.equal(idleCloseCalls, 1);
  assert.equal(forceCloseCalls, 1);
});
