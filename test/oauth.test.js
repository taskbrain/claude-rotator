import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';

import {
  createSingleFlightTokenRefresher,
  normalizeExpiresAt,
  isTokenExpiringSoon,
  isOAuthTokenRefreshRateLimit,
  parseTokenResponse,
  refreshAccessToken,
  fetchProfile,
  fetchUsage,
  DEFAULT_OAUTH_CONNECT_RETRIES,
  DEFAULT_OAUTH_CONNECT_RETRY_DELAY_MS,
  DEFAULT_OAUTH_CONNECT_TIMEOUT_MS,
  DEFAULT_OAUTH_REQUEST_TIMEOUT_MS,
  DEFAULT_OAUTH_REFRESH_LEAD_MS,
  DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS,
  DEFAULT_SUSTAINED_TOKEN_REFRESH_RETRY_MS,
  DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS,
  DEFAULT_TOKEN_REFRESH_RETRY_AFTER_MS,
  CLAUDE_AI_OAUTH_SCOPES,
  OAuthTokenRefreshError,
  OAUTH_USER_AGENT,
  parseUsageResponse,
  createAuthorizationUrl,
} from '../src/oauth.js';

describe('OAuth time helpers', () => {
  it('normalizes seconds to milliseconds', () => {
    assert.equal(normalizeExpiresAt(1780582800), 1780582800000);
    assert.equal(normalizeExpiresAt(1780582800000), 1780582800000);
  });

  it('detects tokens expiring within the threshold', () => {
    const now = 1780580000000;

    assert.equal(isTokenExpiringSoon(now + 2000, now, 3000), true);
    assert.equal(isTokenExpiringSoon(now + 10_000, now, 3000), false);
  });

  it('refreshes early enough for multiple default polling opportunities', () => {
    const now = 1780580000000;

    assert.equal(DEFAULT_OAUTH_REFRESH_LEAD_MS, 30 * 60 * 1000);
    assert.equal(isTokenExpiringSoon(now + DEFAULT_OAUTH_REFRESH_LEAD_MS - 1, now), true);
    assert.equal(isTokenExpiringSoon(now + DEFAULT_OAUTH_REFRESH_LEAD_MS + 1, now), false);
  });
});

describe('token refresh', () => {
  it('coalesces concurrent refreshes and retains the rotated result for late callers', async () => {
    let calls = 0;
    const refreshContexts = [];
    const successCallbacks = [];
    let now = 1000;
    const coordinated = createSingleFlightTokenRefresher(async (refreshToken, context) => {
      calls += 1;
      refreshContexts.push(context);
      await new Promise(resolve => setImmediate(resolve));
      return {
        accessToken: `access-${calls}`,
        refreshToken: `${refreshToken}-rotated-${calls}`,
      };
    }, {
      retentionMs: 60_000,
      now: () => now,
      onSuccess: ({ context, rotated }) => {
        successCallbacks.push({ context, rotated });
      },
    });

    const [first, second] = await Promise.all([
      coordinated('refresh-1', { accountId: 'acct-1' }),
      coordinated('refresh-1'),
    ]);
    const late = await coordinated('refresh-1');

    assert.equal(calls, 1);
    assert.deepEqual(refreshContexts, [{ accountId: 'acct-1' }]);
    assert.deepEqual(successCallbacks, [{ context: { accountId: 'acct-1' }, rotated: true }]);
    assert.deepEqual(second, first);
    assert.deepEqual(late, first);

    now += 60_001;
    const afterRetention = await coordinated('refresh-1');
    assert.equal(calls, 2);
    assert.deepEqual(refreshContexts, [{ accountId: 'acct-1' }, undefined]);
    assert.equal(successCallbacks.length, 2);
    assert.equal(afterRetention.refreshToken, 'refresh-1-rotated-2');
  });

  it('does not retain failed refresh attempts', async () => {
    let calls = 0;
    const coordinated = createSingleFlightTokenRefresher(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
      return { accessToken: 'recovered', refreshToken: 'refresh-2' };
    });

    await assert.rejects(coordinated('refresh-1'), /temporary failure/);
    assert.deepEqual(await coordinated('refresh-1'), {
      accessToken: 'recovered',
      refreshToken: 'refresh-2',
    });
    assert.equal(calls, 2);
  });

  it('does not pass a null options object when refresh context is omitted', async () => {
    const coordinated = createSingleFlightTokenRefresher(async (
      refreshToken,
      options = {},
    ) => {
      assert.equal(refreshToken, 'refresh-1');
      assert.deepEqual(options, {});
      return { accessToken: 'access-1', refreshToken };
    }, { retentionMs: 0 });

    assert.equal((await coordinated('refresh-1')).accessToken, 'access-1');
  });

  it('retains a token endpoint cooldown without repeating the refresh request', async () => {
    let calls = 0;
    let now = 1000;
    const coordinated = createSingleFlightTokenRefresher(async () => {
      calls += 1;
      throw new OAuthTokenRefreshError({
        status: 429,
        code: 'rate_limit_error',
        retryAfterMs: 10_000,
      });
    }, { now: () => now });

    await assert.rejects(coordinated('refresh-1'), { status: 429 });
    await assert.rejects(coordinated('refresh-1'), { status: 429 });
    assert.equal(calls, 1);

    now += 10_001;
    await assert.rejects(
      coordinated('refresh-1'),
      error => error.status === 429 && error.retryAfterMs === 20_000,
    );
    await assert.rejects(coordinated('refresh-1'), { status: 429 });
    assert.equal(calls, 2);

    now += 20_001;
    await assert.rejects(
      coordinated('refresh-1'),
      error => error.status === 429 && error.retryAfterMs === 40_000,
    );
    assert.equal(calls, 3);
  });

  it('keeps token endpoint cooldowns independent across account refresh tokens', async () => {
    let calls = 0;
    let now = 1000;
    const failures = [];
    const coordinated = createSingleFlightTokenRefresher(async () => {
      calls += 1;
      throw new OAuthTokenRefreshError({
        status: 429,
        code: 'rate_limit_error',
        retryAfterMs: 10_000,
      });
    }, {
      now: () => now,
      onFailure: ({ context }) => {
        failures.push(context.accountId);
      },
    });

    await assert.rejects(coordinated('refresh-1', { accountId: 'acct-1' }), { status: 429 });
    await assert.rejects(coordinated('refresh-2', { accountId: 'acct-2' }), { status: 429 });
    assert.equal(calls, 2);
    assert.deepEqual(failures, ['acct-1', 'acct-2']);

    now += 10_001;
    await assert.rejects(
      coordinated('refresh-2', { accountId: 'acct-2' }),
      error => error.status === 429 && error.retryAfterMs === 20_000,
    );
    assert.equal(calls, 3);
  });

  it('serializes concurrent refreshes for different accounts without starving either account', async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const coordinated = createSingleFlightTokenRefresher(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      throw new OAuthTokenRefreshError({
        status: 429,
        code: 'rate_limit_error',
        retryAfterMs: 10_000,
      });
    });

    const [first, second] = await Promise.allSettled([
      coordinated('refresh-1', { accountId: 'acct-1' }),
      coordinated('refresh-2', { accountId: 'acct-2' }),
    ]);

    assert.equal(first.status, 'rejected');
    assert.equal(second.status, 'rejected');
    assert.equal(calls, 2);
    assert.equal(maxActive, 1);
  });

  it('opens a fixed hourly circuit after repeated fifteen-minute refresh failures', async () => {
    let calls = 0;
    let now = 1000;
    const coordinated = createSingleFlightTokenRefresher(async () => {
      calls += 1;
      throw new OAuthTokenRefreshError({
        status: 429,
        code: 'rate_limit_error',
        retryAfterMs: DEFAULT_TOKEN_REFRESH_RETRY_AFTER_MS,
        retryAfterSource: 'fallback',
      });
    }, { now: () => now });

    assert.equal(DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS, 15 * 60 * 1000);
    const expectedDelays = [
      60_000,
      120_000,
      240_000,
      480_000,
      900_000,
      900_000,
      DEFAULT_SUSTAINED_TOKEN_REFRESH_RETRY_MS,
      DEFAULT_SUSTAINED_TOKEN_REFRESH_RETRY_MS,
    ];
    for (const expectedDelay of expectedDelays) {
      await assert.rejects(
        coordinated('refresh-1'),
        error => error.retryAfterMs === expectedDelay,
      );
      now += expectedDelay + 1;
    }
    assert.equal(calls, expectedDelays.length);
  });

  it('honors an explicit Retry-After without exponential amplification', async () => {
    let calls = 0;
    let now = 1000;
    const coordinated = createSingleFlightTokenRefresher(async () => {
      calls += 1;
      throw new OAuthTokenRefreshError({
        status: 429,
        code: 'rate_limit_error',
        retryAfterMs: 2 * 60 * 60 * 1000,
        retryAfterSource: 'provider',
      });
    }, { now: () => now });

    await assert.rejects(
      coordinated('refresh-1'),
      error => error.retryAfterMs === 2 * 60 * 60 * 1000,
    );
    now += 2 * 60 * 60 * 1000 + 1;
    await assert.rejects(
      coordinated('refresh-1'),
      error => error.retryAfterMs === 2 * 60 * 60 * 1000,
    );
    assert.equal(calls, 2);
  });

  it('keeps a native fixed retry delay constant without exponential amplification', async () => {
    let calls = 0;
    let now = 1000;
    const coordinated = createSingleFlightTokenRefresher(async () => {
      calls += 1;
      throw Object.assign(new Error('native refresh failed'), {
        code: 'NATIVE_REFRESH_COMMAND_FAILED',
        retryAfterMs: 5 * 60 * 1000,
        retryAfterSource: 'fixed',
      });
    }, { now: () => now });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await assert.rejects(
        coordinated('refresh-1'),
        error => error.retryAfterMs === 5 * 60 * 1000
          && isOAuthTokenRefreshRateLimit(error),
      );
      now += 5 * 60 * 1000 + 1;
    }
    assert.equal(calls, 8);
  });

  it('reports only the remaining cooldown to late callers', async () => {
    let calls = 0;
    let now = 1000;
    const deferred = [];
    const coordinated = createSingleFlightTokenRefresher(async () => {
      calls += 1;
      throw new OAuthTokenRefreshError({
        status: 429,
        code: 'rate_limit_error',
        retryAfterMs: 120_000,
        retryAfterSource: 'provider',
      });
    }, {
      now: () => now,
      onFailure: ({ deferred: wasDeferred }) => deferred.push(wasDeferred),
    });

    await assert.rejects(
      coordinated('refresh-1'),
      error => error.retryAfterMs === 120_000 && error.deferred !== true,
    );
    now += 30_000;
    await assert.rejects(
      coordinated('refresh-1'),
      error => error.retryAfterMs === 90_000 && error.deferred === true,
    );
    assert.equal(calls, 1);
    assert.deepEqual(deferred, [false, true]);
  });

  it('resets the account backoff after a successful refresh', async () => {
    let calls = 0;
    let now = 1000;
    const coordinated = createSingleFlightTokenRefresher(async refreshToken => {
      calls += 1;
      if (calls === 3) return { accessToken: 'recovered', refreshToken };
      throw new OAuthTokenRefreshError({
        status: 429,
        code: 'rate_limit_error',
        retryAfterMs: 10_000,
        retryAfterSource: 'fallback',
      });
    }, { now: () => now, retentionMs: 0 });

    await assert.rejects(coordinated('refresh-1'), error => error.retryAfterMs === 10_000);
    now += 10_001;
    await assert.rejects(coordinated('refresh-1'), error => error.retryAfterMs === 20_000);
    now += 20_001;
    await coordinated('refresh-1');
    await assert.rejects(coordinated('refresh-1'), error => error.retryAfterMs === 10_000);
    assert.equal(calls, 4);
  });

  it('parses token endpoint responses', () => {
    const parsed = parseTokenResponse({
      access_token: 'access2',
      refresh_token: 'refresh2',
      expires_at: 1780582800,
    }, 'refresh1');

    assert.deepEqual(parsed, {
      accessToken: 'access2',
      refreshToken: 'refresh2',
      expiresAt: 1780582800000,
    });
  });

  it('preserves OAuth scopes and refresh-token expiry metadata', () => {
    const now = 1780580000000;
    const parsed = parseTokenResponse({
      access_token: 'access2',
      expires_in: 3600,
      refresh_token_expires_in: 7200,
      scope: 'user:profile user:inference user:profile',
    }, 'refresh1', now, {
      scopes: ['stale:scope'],
      clientId: 'client-1',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });

    assert.deepEqual(parsed, {
      accessToken: 'access2',
      refreshToken: 'refresh1',
      expiresAt: now + 3600 * 1000,
      scopes: ['user:profile', 'user:inference'],
      refreshTokenExpiresAt: now + 7200 * 1000,
      clientId: 'client-1',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });
  });

  it('keeps the previous refresh-token expiry for missing or invalid durations', () => {
    const now = 1780580000000;
    const previousRefreshTokenExpiresAt = 1812118800;

    for (const value of [null, '', Number.MAX_VALUE]) {
      const parsed = parseTokenResponse({
        access_token: 'access2',
        expires_in: 3600,
        refresh_token_expires_in: value,
      }, 'refresh1', now, {
        refreshTokenExpiresAt: previousRefreshTokenExpiresAt,
      });
      assert.equal(parsed.refreshTokenExpiresAt, previousRefreshTokenExpiresAt * 1000);
    }
  });

  it('refreshes access tokens through injected fetch', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {
        access_token: 'access2',
        expires_in: 3600,
      });
    };

    const result = await refreshAccessToken('refresh1', {
      fetchImpl,
      now: () => 1000,
    });

    assert.equal(result.accessToken, 'access2');
    assert.equal(result.refreshToken, 'refresh1');
    assert.equal(result.expiresAt, 3601000);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      grant_type: 'refresh_token',
      refresh_token: 'refresh1',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      scope: CLAUDE_AI_OAUTH_SCOPES.join(' '),
    });
    assert.deepEqual(result.scopes, CLAUDE_AI_OAUTH_SCOPES);
    assert.equal(calls[0].options.headers['User-Agent'], OAUTH_USER_AGENT);
    assert.equal(calls[0].options.headers['Accept-Encoding'], 'identity');
    assert.equal(calls[0].options.headers['Content-Length'], Buffer.byteLength(calls[0].options.body));
  });

  it('uses imported OAuth scopes and client id when refreshing', async () => {
    let request;
    const result = await refreshAccessToken('refresh1', {
      fetchImpl: async (url, options) => {
        request = { url, options };
        return jsonResponse(200, { access_token: 'access2', expires_in: 3600 });
      },
      now: () => 1000,
      scopes: ['user:profile', 'user:inference'],
      clientId: 'custom-client',
      refreshTokenExpiresAt: 9999999999999,
    });

    assert.deepEqual(JSON.parse(request.options.body), {
      grant_type: 'refresh_token',
      refresh_token: 'refresh1',
      client_id: 'custom-client',
      scope: 'user:profile user:inference',
    });
    assert.deepEqual(result.scopes, ['user:profile', 'user:inference']);
    assert.equal(result.clientId, 'custom-client');
    assert.equal(result.refreshTokenExpiresAt, 9999999999999);
  });

  it('requires stored scopes for custom OAuth clients', async () => {
    await assert.rejects(
      refreshAccessToken('refresh1', { clientId: 'custom-client' }),
      /OAuth scopes are required for custom client credentials/,
    );
  });

  it('returns a sanitized refresh error with the server retry delay', async () => {
    await assert.rejects(
      refreshAccessToken('secret-refresh-token', {
        fetchImpl: async () => jsonResponse(429, {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' },
        }, { 'retry-after': '105' }),
        now: () => 1000,
      }),
      error => {
        assert.equal(error instanceof OAuthTokenRefreshError, true);
        assert.equal(error.status, 429);
        assert.equal(error.oauthCode, 'rate_limit_error');
        assert.equal(error.retryAfterMs, 105_000);
        assert.equal(error.retryAfterSource, 'provider');
        assert.equal(error.message.includes('secret-refresh-token'), false);
        return true;
      },
    );
  });

  it('uses a conservative refresh cooldown when Retry-After is missing', async () => {
    await assert.rejects(
      refreshAccessToken('refresh-1', {
        fetchImpl: async () => jsonResponse(429, { error: 'rate_limit_error' }),
      }),
      error => error.retryAfterMs === DEFAULT_TOKEN_REFRESH_RETRY_AFTER_MS
        && error.retryAfterSource === 'fallback',
    );
  });

  it('bounds an extreme provider Retry-After to a representable deadline', async () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    await assert.rejects(
      refreshAccessToken('refresh-1', {
        fetchImpl: async () => jsonResponse(
          429,
          { error: 'rate_limit_error' },
          { 'retry-after': String(Number.MAX_VALUE) },
        ),
        now: () => now,
      }),
      error => {
        assert.equal(error.retryAfterSource, 'provider');
        assert.equal(Number.isFinite(error.retryAfterMs), true);
        assert.equal(error.retryAfterMs, DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS);
        assert.doesNotThrow(() => new Date(now + error.retryAfterMs).toISOString());
        return true;
      },
    );
  });
});

describe('usage response parsing', () => {
  it('passes the OAuth profile AbortSignal to an injected fetch implementation', async () => {
    const controller = new AbortController();
    let receivedSignal;

    await fetchProfile('access1', {
      signal: controller.signal,
      fetchImpl: async (url, init) => {
        receivedSignal = init.signal;
        return jsonResponse(200, {});
      },
    });

    assert.equal(receivedSignal, controller.signal);
  });

  it('fetches OAuth usage through the native request helper by default', async () => {
    const calls = [];
    const usage = await fetchUsage('access1', {
      endpoint: 'https://example.test/api/oauth/usage',
      requestImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse(200, {
          five_hour: { utilization: 25, resets_at: '2026-06-04T09:00:00Z' },
          seven_day: { utilization: 50, resets_at: '2026-06-06T10:00:00Z' },
        });
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/api/oauth/usage');
    assert.equal(calls[0].options.timeoutMs, DEFAULT_OAUTH_REQUEST_TIMEOUT_MS);
    assert.equal(calls[0].options.connectTimeoutMs, DEFAULT_OAUTH_CONNECT_TIMEOUT_MS);
    assert.equal(calls[0].options.connectRetries, DEFAULT_OAUTH_CONNECT_RETRIES);
    assert.equal(calls[0].options.connectRetryDelayMs, DEFAULT_OAUTH_CONNECT_RETRY_DELAY_MS);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer access1');
    assert.equal(calls[0].options.headers['User-Agent'], OAUTH_USER_AGENT);
    assert.equal(calls[0].options.headers['Accept-Encoding'], 'identity');
    assert.equal(usage.five_hour.utilization, 0.25);
    assert.equal(usage.seven_day.utilization, 0.5);
  });

  it('passes the OAuth usage AbortSignal to an injected fetch implementation', async () => {
    const controller = new AbortController();
    let receivedSignal;

    await fetchUsage('access1', {
      signal: controller.signal,
      fetchImpl: async (url, init) => {
        receivedSignal = init.signal;
        return jsonResponse(200, {});
      },
    });

    assert.equal(receivedSignal, controller.signal);
  });

  it('retries OAuth usage requests that fail before a connection is established', async () => {
    const originalRequest = https.request;
    let requests = 0;
    https.request = function patchedRequest(options, callback) {
      requests++;
      const requestNumber = requests;
      const fakeRequest = new EventEmitter();
      fakeRequest.setTimeout = () => fakeRequest;
      fakeRequest.write = () => {};
      fakeRequest.destroy = error => {
        if (error) setTimeout(() => fakeRequest.emit('error', error), 0);
      };
      fakeRequest.end = () => {
        if (requestNumber === 1) {
          setTimeout(() => {
            const error = new Error('connect ETIMEDOUT');
            error.code = 'ETIMEDOUT';
            fakeRequest.emit('error', error);
          }, 1);
          return;
        }
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        setTimeout(() => {
          response.emit('data', Buffer.from(JSON.stringify({
            five_hour: { utilization: 25, resets_at: '2026-06-04T09:00:00Z' },
            seven_day: { utilization: 50, resets_at: '2026-06-06T10:00:00Z' },
          })));
          response.emit('end');
        }, 1);
      };
      return fakeRequest;
    };

    try {
      const usage = await fetchUsage('access1', {
        endpoint: 'https://api.anthropic.test/api/oauth/usage',
        connectRetries: 1,
        connectRetryDelayMs: 1,
      });

      assert.equal(requests, 2);
      assert.equal(usage.five_hour.utilization, 0.25);
      assert.equal(usage.seven_day.utilization, 0.5);
    } finally {
      https.request = originalRequest;
    }
  });

  it('aborts a native OAuth usage request after its response starts', async () => {
    const originalRequest = https.request;
    const controller = new AbortController();
    let destroyedWith;
    https.request = function patchedRequest(options, callback) {
      const fakeRequest = new EventEmitter();
      fakeRequest.setTimeout = () => fakeRequest;
      fakeRequest.write = () => {};
      fakeRequest.destroy = error => {
        destroyedWith = error;
        queueMicrotask(() => fakeRequest.emit('error', error));
      };
      fakeRequest.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.emit('data', Buffer.from('{'));
      };
      return fakeRequest;
    };

    try {
      const request = fetchUsage('access1', {
        endpoint: 'https://api.anthropic.test/api/oauth/usage',
        signal: controller.signal,
        connectRetries: 3,
      });
      controller.abort();

      await assert.rejects(
        Promise.race([
          request,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('OAuth usage request did not settle after abort')),
            100,
          )),
        ]),
        error => error.code === 'OAUTH_REQUEST_ABORTED',
      );
      assert.equal(destroyedWith?.code, 'OAUTH_REQUEST_ABORTED');
    } finally {
      https.request = originalRequest;
    }
  });

  it('rejects without creating a native request when the OAuth usage signal is already aborted', async () => {
    const originalRequest = https.request;
    const controller = new AbortController();
    let requests = 0;
    https.request = () => {
      requests += 1;
      throw new Error('native request should not start');
    };
    controller.abort();

    try {
      await assert.rejects(
        fetchUsage('access1', {
          endpoint: 'https://api.anthropic.test/api/oauth/usage',
          signal: controller.signal,
        }),
        error => error.code === 'OAUTH_REQUEST_ABORTED',
      );
      assert.equal(requests, 0);
    } finally {
      https.request = originalRequest;
    }
  });

  it('stops an OAuth connection retry delay when the signal aborts', async () => {
    const originalRequest = https.request;
    const controller = new AbortController();
    let requests = 0;
    https.request = () => {
      requests += 1;
      const fakeRequest = new EventEmitter();
      fakeRequest.setTimeout = () => fakeRequest;
      fakeRequest.write = () => {};
      fakeRequest.destroy = error => queueMicrotask(() => fakeRequest.emit('error', error));
      fakeRequest.end = () => {
        const error = new Error('connect ETIMEDOUT');
        error.code = 'ETIMEDOUT';
        queueMicrotask(() => fakeRequest.emit('error', error));
      };
      return fakeRequest;
    };

    try {
      const request = fetchUsage('access1', {
        endpoint: 'https://api.anthropic.test/api/oauth/usage',
        signal: controller.signal,
        connectRetries: 3,
        connectRetryDelayMs: 1000,
      });
      await new Promise(resolve => setImmediate(resolve));
      controller.abort();

      await assert.rejects(
        Promise.race([
          request,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('OAuth retry delay did not stop after abort')),
            100,
          )),
        ]),
        error => error.code === 'OAUTH_REQUEST_ABORTED',
      );
      assert.equal(requests, 1);
    } finally {
      https.request = originalRequest;
    }
  });

  it('normalizes OAuth usage payloads', () => {
    const parsed = parseUsageResponse({
      five_hour: { utilization: 76, resets_at: '2026-06-04T09:00:00Z' },
      seven_day: { utilization: 1, resets_at: '2026-06-06T10:00:00Z' },
    });

    assert.equal(parsed.five_hour.utilization, 0.76);
    assert.equal(parsed.five_hour.resets_at, '2026-06-04T09:00:00Z');
    assert.equal(parsed.seven_day.utilization, 0.01);
  });

  it('distinguishes missing, explicit-null, and malformed global usage observations', () => {
    const missing = parseUsageResponse({});
    assert.equal(Object.hasOwn(missing, 'five_hour'), false);
    assert.equal(Object.hasOwn(missing, 'seven_day'), false);

    const explicitNull = parseUsageResponse({ five_hour: null, seven_day: null });
    assert.equal(Object.hasOwn(explicitNull, 'five_hour'), true);
    assert.equal(Object.hasOwn(explicitNull, 'seven_day'), true);
    assert.equal(explicitNull.five_hour, null);
    assert.equal(explicitNull.seven_day, null);

    const explicitNullWithStructuredFallback = parseUsageResponse({
      limits: [
        { kind: 'session', percent: 40, resets_at: '2026-09-10T09:00:00Z' },
        { kind: 'weekly_all', percent: 50, resets_at: '2026-09-11T09:00:00Z' },
      ],
      five_hour: null,
      seven_day: null,
    });
    assert.deepEqual(explicitNullWithStructuredFallback.five_hour, {
      utilization: 0.4,
      resets_at: '2026-09-10T09:00:00Z',
    });
    assert.deepEqual(explicitNullWithStructuredFallback.seven_day, {
      utilization: 0.5,
      resets_at: '2026-09-11T09:00:00Z',
    });

    const malformed = parseUsageResponse({ five_hour: {}, seven_day: 'invalid' });
    assert.deepEqual(malformed.five_hour, { utilization: null, resets_at: null });
    assert.deepEqual(malformed.seven_day, { utilization: null, resets_at: null });
  });

  it('keeps valid legacy global fields authoritative when structured limits conflict', () => {
    const parsed = parseUsageResponse({
      limits: [
        { kind: 'session', percent: 100, resets_at: '2026-09-08T09:00:00Z' },
        { kind: 'weekly_all', percent: 20, resets_at: '2026-09-09T09:00:00Z' },
      ],
      five_hour: { utilization: 20, resets_at: '2026-09-10T09:00:00Z' },
      seven_day: { utilization: 100, resets_at: '2026-09-11T09:00:00Z' },
    });

    assert.deepEqual(parsed.five_hour, {
      utilization: 0.2,
      resets_at: '2026-09-10T09:00:00Z',
    });
    assert.deepEqual(parsed.seven_day, {
      utilization: 1,
      resets_at: '2026-09-11T09:00:00Z',
    });
  });

  it('uses structured globals to repair malformed legacy fields and complement matching resets', () => {
    const parsed = parseUsageResponse({
      limits: [
        { kind: 'session', percent: 40, resets_at: '2026-09-10T09:00:00Z' },
        { kind: 'weekly_all', percent: 50, resets_at: '2026-09-11T09:00:00Z' },
      ],
      five_hour: {},
      seven_day: { utilization: 50 },
    });

    assert.deepEqual(parsed.five_hour, {
      utilization: 0.4,
      resets_at: '2026-09-10T09:00:00Z',
    });
    assert.deepEqual(parsed.seven_day, {
      utilization: 0.5,
      resets_at: '2026-09-11T09:00:00Z',
    });
  });

  it('keeps a legacy global reset when matching structured evidence has a newer reset', () => {
    const parsed = parseUsageResponse({
      limits: [
        { kind: 'session', percent: 100, resets_at: '2026-09-10T09:00:00Z' },
        { kind: 'weekly_all', percent: 50, resets_at: '2026-09-11T09:00:00Z' },
      ],
      five_hour: { utilization: 100, resets_at: '2026-09-01T09:00:00Z' },
      seven_day: { utilization: 50, resets_at: '2026-09-02T09:00:00Z' },
    });

    assert.equal(parsed.five_hour.resets_at, '2026-09-01T09:00:00Z');
    assert.equal(parsed.seven_day.resets_at, '2026-09-02T09:00:00Z');
  });

  it('repairs a malformed first structured global limit without replacing a first valid one', () => {
    const parsed = parseUsageResponse({
      limits: [
        { kind: 'session' },
        { kind: 'session', percent: 60, resets_at: '2026-09-10T09:00:00Z' },
        { kind: 'weekly_all', percent: 30, resets_at: '2026-09-11T09:00:00Z' },
        { kind: 'weekly_all', percent: 90, resets_at: '2026-09-12T09:00:00Z' },
      ],
    });

    assert.equal(parsed.five_hour.utilization, 0.6);
    assert.equal(parsed.five_hour.resets_at, '2026-09-10T09:00:00Z');
    assert.equal(parsed.seven_day.utilization, 0.3);
    assert.equal(parsed.seven_day.resets_at, '2026-09-11T09:00:00Z');
  });

  it('only emits a scoped snapshot when structured or legacy scoped usage was observed', () => {
    const missing = parseUsageResponse({});
    const malformedLimits = parseUsageResponse({ limits: {} });
    const explicitEmpty = parseUsageResponse({ limits: [] });

    assert.equal(Object.hasOwn(missing, 'scoped_weekly'), false);
    assert.equal(Object.hasOwn(malformedLimits, 'scoped_weekly'), false);
    assert.equal(Object.hasOwn(explicitEmpty, 'scoped_weekly'), true);
    assert.deepEqual(explicitEmpty.scoped_weekly, []);
  });

  it('normalizes structured scoped weekly limits from OAuth usage payloads', () => {
    const parsed = parseUsageResponse({
      limits: [
        { kind: 'session', percent: 76, resets_at: '2026-06-04T09:00:00Z' },
        { kind: 'weekly_all', percent: 41, resets_at: '2026-06-08T09:00:00Z' },
        {
          kind: 'weekly_scoped',
          percent: 12,
          resets_at: '2026-06-08T09:00:00Z',
          scope: { model: { display_name: 'Fable', id: 'claude-fable-5' } },
        },
        {
          kind: 'weekly_scoped',
          percent: 23,
          resets_at: '2026-06-09T09:00:00Z',
          scope: { model: { display_name: 'Sonnet', id: 'claude-sonnet-4-5' } },
        },
      ],
    });

    assert.equal(parsed.five_hour.utilization, 0.76);
    assert.equal(parsed.seven_day.utilization, 0.41);
    assert.deepEqual(parsed.scoped_weekly, [
      {
        key: 'fable',
        label: 'Fable',
        utilization: 0.12,
        resets_at: '2026-06-08T09:00:00Z',
      },
      {
        key: 'sonnet',
        label: 'Sonnet',
        utilization: 0.23,
        resets_at: '2026-06-09T09:00:00Z',
      },
    ]);
  });

  it('preserves malformed scoped observations so callers do not mistake them for an empty snapshot', () => {
    const structured = parseUsageResponse({
      limits: [{
        kind: 'weekly_scoped',
        scope: { model: { display_name: 'Fable', id: 'claude-fable-5' } },
      }],
    });
    const legacy = parseUsageResponse({ seven_day_fable: {} });

    const structuredSentinel = [{
      key: 'fable',
      label: 'Fable',
      utilization: null,
      resets_at: null,
    }];
    const legacySentinel = [{
      key: 'fable',
      label: 'Fable',
      utilization: null,
      resets_at: null,
    }];
    assert.deepEqual(structured.scoped_weekly, structuredSentinel);
    assert.deepEqual(legacy.scoped_weekly, legacySentinel);
  });

  it('preserves the exact model id when a scoped Usage limit has no display name', () => {
    const parsed = parseUsageResponse({
      limits: [{
        kind: 'weekly_scoped',
        percent: 100,
        resets_at: '2026-09-08T09:00:00Z',
        scope: { model: { id: 'claude-fable-5' } },
      }],
    });

    assert.deepEqual(parsed.scoped_weekly, [{
      key: 'claude_fable_5',
      label: 'claude-fable-5',
      utilization: 1,
      resets_at: '2026-09-08T09:00:00Z',
    }]);
  });

  it('uses a structured model id as the scoped key even when its display name says Fable', () => {
    const parsed = parseUsageResponse({
      limits: [{
        kind: 'weekly_scoped',
        percent: 100,
        resets_at: '2026-09-08T09:00:00Z',
        scope: { model: { id: 'claude-not-fable-5', display_name: 'Fable' } },
      }],
    });

    assert.deepEqual(parsed.scoped_weekly, [{
      key: 'claude_not_fable_5',
      label: 'Fable',
      utilization: 1,
      resets_at: '2026-09-08T09:00:00Z',
    }]);
  });

  it('uses the exact Fable model id when its display name is not a canonical alias', () => {
    const parsed = parseUsageResponse({
      limits: [{
        kind: 'weekly_scoped',
        percent: 100,
        resets_at: '2026-09-08T09:00:00Z',
        scope: { model: { id: 'claude-fable-5', display_name: 'Fable Weekly' } },
      }],
    });

    assert.deepEqual(parsed.scoped_weekly, [{
      key: 'claude_fable_5',
      label: 'Fable Weekly',
      utilization: 1,
      resets_at: '2026-09-08T09:00:00Z',
    }]);
  });

  it('prefers valid scoped evidence over a duplicate malformed model observation in either order', () => {
    const malformed = {
      kind: 'weekly_scoped',
      scope: { model: { display_name: 'Fable', id: 'claude-fable-5' } },
    };
    const valid = {
      kind: 'weekly_scoped',
      percent: 100,
      resets_at: '2026-09-08T09:00:00Z',
      scope: { model: { id: 'claude-fable-5' } },
    };

    for (const limits of [[malformed, valid], [valid, malformed]]) {
      const parsed = parseUsageResponse({ limits });
      assert.equal(parsed.scoped_weekly.length, 1);
      assert.equal(parsed.scoped_weekly[0].utilization, 1);
      assert.equal(parsed.scoped_weekly[0].resets_at, '2026-09-08T09:00:00Z');
    }

    const resetMissing = {
      ...valid,
      resets_at: undefined,
    };
    for (const limits of [[resetMissing, valid], [valid, resetMissing]]) {
      const parsed = parseUsageResponse({ limits });
      assert.equal(parsed.scoped_weekly.length, 1);
      assert.equal(parsed.scoped_weekly[0].utilization, 1);
      assert.equal(parsed.scoped_weekly[0].resets_at, '2026-09-08T09:00:00Z');
    }
  });

  it('keeps the first valid structured scoped utilization when duplicate values conflict', () => {
    for (const [firstPercent, secondPercent] of [[100, 20], [20, 100]]) {
      const parsed = parseUsageResponse({
        limits: [firstPercent, secondPercent].map((percent, index) => ({
          kind: 'weekly_scoped',
          percent,
          resets_at: `2026-09-${String(index + 8).padStart(2, '0')}T09:00:00Z`,
          scope: { model: { display_name: 'Fable', id: 'claude-fable-5' } },
        })),
      });

      assert.equal(parsed.scoped_weekly.length, 1);
      assert.equal(parsed.scoped_weekly[0].utilization, firstPercent / 100);
      assert.equal(parsed.scoped_weekly[0].resets_at, '2026-09-08T09:00:00Z');
    }
  });

  it('keeps structured scoped utilization authoritative over conflicting legacy fields', () => {
    for (const [structuredPercent, legacyPercent] of [[100, 20], [20, 100]]) {
      const parsed = parseUsageResponse({
        limits: [{
          kind: 'weekly_scoped',
          percent: structuredPercent,
          resets_at: '2026-09-08T09:00:00Z',
          scope: { model: { display_name: 'Fable', id: 'claude-fable-5' } },
        }],
        seven_day_fable: {
          utilization: legacyPercent,
          resets_at: '2026-09-09T09:00:00Z',
        },
      });

      assert.equal(parsed.scoped_weekly.length, 1);
      assert.equal(parsed.scoped_weekly[0].utilization, structuredPercent / 100);
      assert.equal(parsed.scoped_weekly[0].resets_at, '2026-09-08T09:00:00Z');
    }
  });

  it('deduplicates a structured Sonnet model id against its legacy display-name key', () => {
    const parsed = parseUsageResponse({
      limits: [{
        kind: 'weekly_scoped',
        percent: 10,
        resets_at: '2026-09-08T09:00:00Z',
        scope: { model: { display_name: 'Sonnet', id: 'claude-sonnet-4-5' } },
      }],
      seven_day_sonnet: {
        utilization: 90,
        resets_at: '2026-09-09T09:00:00Z',
      },
    });

    assert.deepEqual(parsed.scoped_weekly, [{
      key: 'sonnet',
      label: 'Sonnet',
      utilization: 0.1,
      resets_at: '2026-09-08T09:00:00Z',
    }]);
  });

  it('repairs malformed structured scoped usage and complements a matching legacy reset', () => {
    const repaired = parseUsageResponse({
      limits: [{
        kind: 'weekly_scoped',
        scope: { model: { display_name: 'Fable', id: 'claude-fable-5' } },
      }],
      seven_day_fable: {
        utilization: 100,
        resets_at: '2026-09-09T09:00:00Z',
      },
    });
    const complemented = parseUsageResponse({
      limits: [{
        kind: 'weekly_scoped',
        percent: 100,
        scope: { model: { display_name: 'Fable', id: 'claude-fable-5' } },
      }],
      seven_day_fable: {
        utilization: 100,
        resets_at: '2026-09-09T09:00:00Z',
      },
    });

    assert.equal(repaired.scoped_weekly[0].utilization, 1);
    assert.equal(repaired.scoped_weekly[0].resets_at, '2026-09-09T09:00:00Z');
    assert.equal(complemented.scoped_weekly[0].utilization, 1);
    assert.equal(complemented.scoped_weekly[0].resets_at, '2026-09-09T09:00:00Z');
  });

  it('keeps a structured scoped reset when matching legacy evidence has an older reset', () => {
    const parsed = parseUsageResponse({
      limits: [{
        kind: 'weekly_scoped',
        percent: 100,
        resets_at: '2026-09-10T09:00:00Z',
        scope: { model: { display_name: 'Fable', id: 'claude-fable-5' } },
      }],
      seven_day_fable: {
        utilization: 100,
        resets_at: '2026-09-01T09:00:00Z',
      },
    });

    assert.equal(parsed.scoped_weekly[0].utilization, 1);
    assert.equal(parsed.scoped_weekly[0].resets_at, '2026-09-10T09:00:00Z');
  });

  it('normalizes legacy flat model-specific weekly usage payloads', () => {
    const parsed = parseUsageResponse({
      seven_day_fable: { utilization: 50, resets_at: '2026-07-07T00:00:00Z' },
      seven_day_sonnet: { utilization: 25, resets_at: '2026-07-06T00:00:00Z' },
    });

    assert.deepEqual(parsed.scoped_weekly, [
      {
        key: 'fable',
        label: 'Fable',
        utilization: 0.5,
        resets_at: '2026-07-07T00:00:00Z',
      },
      {
        key: 'sonnet',
        label: 'Sonnet',
        utilization: 0.25,
        resets_at: '2026-07-06T00:00:00Z',
      },
    ]);
  });
});

describe('authorization URL', () => {
  it('creates a Claude OAuth URL with PKCE parameters', () => {
    const url = createAuthorizationUrl({
      redirectUri: 'http://localhost:1234/callback',
      state: 'state1',
      codeChallenge: 'challenge1',
    });

    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('state'), 'state1');
    assert.equal(url.searchParams.get('code_challenge'), 'challenge1');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1234/callback');
  });
});

function jsonResponse(status, body, headers = {}) {
  return {
    headers,
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}
