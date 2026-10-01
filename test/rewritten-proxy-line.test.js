// Pins the shape of the proxy log line when an upstream or local 429 is
// rewritten to 529 (all Claude accounts exhausted) or to 403 (the Codex pool is
// unusable as well): the status actually returned, the mapping fields, and the
// usage-limit grace fields, in that order.
//
// Isolation: upstream, bridge and proxy all listen on 127.0.0.1 port 0 inside
// this process. Secrets live in a MemorySecretStore; see
// test/helpers/mapping-proxy.js for the stubs that keep the proxy off the
// network and off the real config directory.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { startFakeBridge } from './helpers/fake-bridge.js';
import { close, listen, proxyLines, requestJson, startMappingProxy } from './helpers/mapping-proxy.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

const GRACE_HEADERS = Object.freeze({
  'anthropic-ratelimit-unified-grace-5h-utilization': '0.02',
  'anthropic-ratelimit-unified-grace-7d-utilization': '0',
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-overage-in-use': 'false',
});

const GRACE_TAIL = ' g5h=0.02 g7d=0 ustat=allowed_warning ovs=rejected ovu=false';

// The pattern log readers use to pull the returned status and the outcome out
// of a proxy line. `upstreamStatus=` must not be picked up as a second status.
const STATUS_AND_OUTCOME = / (outcome=[a-z-]+|status=[0-9]+)/g;

function sendMessage(proxy, model) {
  return requestJson(`${proxy.url}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model }),
    headers: { 'content-type': 'application/json' },
  });
}

async function singleAccount() {
  const secretStore = new MemorySecretStore();
  await secretStore.set('acct_1', { accessToken: 'access-token-acct_1' });
  const accountManager = new AccountManager({
    accounts: [{ id: 'acct_1', type: 'oauth' }],
    now: () => 1000,
  });
  return { secretStore, accountManager };
}

async function startUpstream(handler) {
  const seen = [];
  const upstream = await listen(http.createServer((req, res) => {
    req.resume();
    seen.push(req.headers.authorization);
    handler(req, res);
  }));
  cleanups.push(() => close(upstream.server));
  return { upstream, seen };
}

// One account, upstream answers 429 (the same setup as the rate-limit
// passthrough scenario in test/proxy-server.test.js). With `warmBridge`, one
// round trip to an exhausted fake bridge first teaches the proxy that the
// Codex pool is unusable.
async function runUpstream429({ extraHeaders = {}, warmBridge = false } = {}) {
  const { upstream, seen } = await startUpstream((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'upstream throttled' } }));
  });
  let bridgeUrl = null;
  if (warmBridge) {
    const bridge = await startFakeBridge({ port: 0, mode: 'exhausted' });
    cleanups.push(() => bridge.close());
    bridgeUrl = bridge.url;
  }
  const { secretStore, accountManager } = await singleAccount();
  const logLines = [];
  const proxy = await startMappingProxy({
    accountManager, secretStore, upstreamUrl: upstream.url, logLines, bridgeUrl,
  });
  cleanups.push(() => close(proxy.server));

  if (warmBridge) {
    const warm = await sendMessage(proxy, 'gpt-6-astra');
    assert.equal(warm.status, 529, 'precondition: the bridge 529 passes through and marks the pool unusable');
    assert.deepEqual(seen, [], 'precondition: the warm-up request never reaches the Claude upstream');
  }

  const response = await sendMessage(proxy, 'sonnet');
  return { response, logLines, seen };
}

describe('proxy line of a rewritten 429', () => {
  it('upstream 429 with grace headers -> 529: mapping fields come before the grace fields', async () => {
    const { response, logLines, seen } = await runUpstream429({ extraHeaders: GRACE_HEADERS });

    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.deepEqual(seen, ['Bearer access-token-acct_1']);

    const lines = proxyLines(logLines);
    assert.equal(lines.length, 1, lines.join('\n'));
    const line = lines[0];
    assert.match(
      line,
      / status=529 .* upstreamStatus=429 gptPoolState=unknown claudePoolState=all-exhausted mappedFrom=429 (?:mappedFromType=\S+ )?mappedTo=529 mapReason=all_claude_accounts_exhausted mapPath=e .* g5h=0\.02 g7d=0 ustat=allowed_warning ovs=rejected ovu=false$/,
    );
    // The header-time rewrite happens before the upstream body is read, so this
    // pattern does not check mappedFromType (the field may or may not be there).
    assert.deepEqual(line.match(STATUS_AND_OUTCOME), [' status=529', ' outcome=rate-limit-passthrough']);
  });

  it('upstream 429 without grace headers -> 529: no grace fields are appended', async () => {
    const { response, logLines } = await runUpstream429();

    assert.equal(response.status, 529);
    const lines = proxyLines(logLines);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], / status=529 .* mappedTo=529 mapReason=all_claude_accounts_exhausted mapPath=e .* usageParse=no-usage$/);
    assert.ok(!lines[0].includes(' g5h='), lines[0]);
  });

  it('upstream 429 with grace headers -> 403 once the Codex pool is unusable too', async () => {
    const { response, logLines } = await runUpstream429({ extraHeaders: GRACE_HEADERS, warmBridge: true });

    assert.equal(response.status, 403);
    assert.equal(response.body.error.type, 'permission_error');

    const lines = proxyLines(logLines);
    assert.equal(lines.length, 1, lines.join('\n'));
    const line = lines[0];
    assert.match(
      line,
      / status=403 .* upstreamStatus=429 resetAt=\S+ gptPoolState=unusable claudePoolState=all-exhausted mappedFrom=429 (?:mappedFromType=\S+ )?mappedTo=403 mapReason=both_pools_unusable mapPath=e .* g5h=0\.02 g7d=0 ustat=allowed_warning ovs=rejected ovu=false$/,
    );
    assert.ok(line.endsWith(GRACE_TAIL), line);
    assert.deepEqual(line.match(STATUS_AND_OUTCOME), [' status=403', ' outcome=rate-limit-passthrough']);
  });

  it('locally synthesised quota 429 -> 529: no grace fields because nothing came back from upstream', async () => {
    const { upstream, seen } = await startUpstream((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...GRACE_HEADERS });
      res.end('{}');
    });
    const { secretStore, accountManager } = await singleAccount();
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    const logLines = [];
    const proxy = await startMappingProxy({ accountManager, secretStore, upstreamUrl: upstream.url, logLines });
    cleanups.push(() => close(proxy.server));

    const response = await sendMessage(proxy, 'sonnet');

    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.deepEqual(seen, [], 'the local 429 is answered without contacting upstream');
    const lines = proxyLines(logLines);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(
      lines[0],
      / status=529 .* mappedFrom=429 mappedFromType=rate_limit_error mappedTo=529 mapReason=all_claude_accounts_exhausted mapPath=a$/,
    );
    assert.ok(!lines[0].includes(' g5h='), lines[0]);
  });
});
