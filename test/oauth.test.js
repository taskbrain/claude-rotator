import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeExpiresAt,
  isTokenExpiringSoon,
  parseTokenResponse,
  refreshAccessToken,
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
});

describe('token refresh', () => {
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
    assert.equal(JSON.parse(calls[0].options.body).refresh_token, 'refresh1');
  });
});

describe('usage response parsing', () => {
  it('normalizes OAuth usage payloads', () => {
    const parsed = parseUsageResponse({
      five_hour: { utilization: 76, resets_at: '2026-06-04T09:00:00Z' },
      seven_day: { utilization: 0.51, resets_at: '2026-06-06T10:00:00Z' },
    });

    assert.equal(parsed.five_hour.utilization, 0.76);
    assert.equal(parsed.five_hour.resets_at, '2026-06-04T09:00:00Z');
    assert.equal(parsed.seven_day.utilization, 0.51);
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

function jsonResponse(status, body) {
  return {
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
