// Extra fields for the credential-refresh log lines: the login (refresh
// credential) expiry, where it came from, and the Claude Code version that ran
// the refresh.
//
// - The fields are built from the native refresher's observation only (numbers,
//   an enum and a version string). `context`, `refreshed` and `error` carry
//   tokens, so they are only used as lookup keys and never spread or printed.
// - Neither function throws: the log hooks call the alert watch after building
//   the line, and a throw here would skip that call.
// - Values are printed as recorded; they were normalized to milliseconds once by
//   the refresher and are not normalized again here.
// - The last success per account (two numbers and the source) is remembered in
//   memory so a later expired-login rejection of the same credential can repeat
//   the source. A credential is the same only when both its login expiry and its
//   access expiry match; anything else is `unknown`. A restart forgets this.
import { nativeRefreshObservation } from './native-claude-refresher.js';

const SUCCESS_SOURCES = new Set(['received', 'carried', 'absent']);
const REJECTION_SOURCES = new Set(['received', 'carried']);
const CLAUDE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const MAX_CLAUDE_VERSION_LENGTH = 64;

export function createRefreshLogFields({ observe = nativeRefreshObservation } = {}) {
  const lastSuccessByAccount = new Map();

  return {
    success({ context, refreshed } = {}) {
      try {
        const observation = observe(refreshed);
        if (!observation || !SUCCESS_SOURCES.has(observation.source)) return '';
        if (typeof context?.accountId === 'string') {
          lastSuccessByAccount.set(context.accountId, {
            refreshTokenExpiresAt: observation.refreshTokenExpiresAt,
            accessExpiresAt: observation.accessExpiresAt,
            source: observation.source,
          });
        }
        return ` refreshExpiresAt=${formatExpiry(observation.refreshTokenExpiresAt)}`
          + ` refreshExpirySource=${observation.source}`
          + ` refreshExpiresBefore=${formatExpiry(observation.previousRefreshTokenExpiresAt)}`
          + ` claudeVersion=${formatVersion(observation.claudeVersion)}`;
      } catch {
        return '';
      }
    },
    failure({ context, error, deferred = false } = {}) {
      try {
        if (deferred) return '';
        const observation = observe(error);
        if (!observation) return '';
        if (error?.code === 'NATIVE_REFRESH_REAUTH_REQUIRED') {
          const last = typeof context?.accountId === 'string'
            ? lastSuccessByAccount.get(context.accountId)
            : undefined;
          const source = last
            && REJECTION_SOURCES.has(last.source)
            && last.refreshTokenExpiresAt === observation.refreshTokenExpiresAt
            && last.accessExpiresAt === observation.accessExpiresAt
            ? last.source
            : 'unknown';
          const expiry = observation.refreshTokenExpiresAt == null
            ? 'unknown'
            : formatExpiry(observation.refreshTokenExpiresAt);
          return ` refreshExpiresAt=${expiry} refreshExpirySource=${source}`;
        }
        if (Object.hasOwn(observation, 'claudeVersion')) {
          return ` claudeVersion=${formatVersion(observation.claudeVersion)}`;
        }
        return '';
      } catch {
        return '';
      }
    },
  };
}

// `none` when there is no value, `unknown` when there is one that is not a time.
function formatExpiry(value) {
  if (value == null) return 'none';
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 'unknown';
  try {
    return new Date(value).toISOString();
  } catch {
    return 'unknown';
  }
}

function formatVersion(value) {
  return typeof value === 'string'
    && value.length <= MAX_CLAUDE_VERSION_LENGTH
    && CLAUDE_VERSION_RE.test(value)
    ? value
    : 'unknown';
}
