import { isAbsolute, resolve, sep } from 'node:path';
import { claudeKeychainServiceName, DEFAULT_CLAUDE_KEYCHAIN_SERVICE } from './claude-keychain.js';
import { appConfigDir, runtimeStatePath } from './paths.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f"\\]/.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const path = value => text(value) && isAbsolute(value);
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;

export function swapError(reason = 'credential_unavailable') {
  return new Error(reason);
}

const STARTUP_REASONS = new Set(['invalid_swap_config', 'swap_config_required',
  'swap_state_unavailable', 'swap_port_in_use', 'swap_listen_unavailable']);

export function credentialSwapStartupReason(error) {
  if (STARTUP_REASONS.has(error?.message)) return error.message;
  if (error?.code === 'EADDRINUSE') return 'swap_port_in_use';
  if (['EACCES', 'EPERM', 'EADDRNOTAVAIL'].includes(error?.code)) return 'swap_listen_unavailable';
  return 'credential_swap_serve_failed';
}

function overlaps(left, right) {
  return left === right || left.startsWith(right.endsWith(sep) ? right : right + sep)
    || right.startsWith(left.endsWith(sep) ? left : left + sep);
}

export function normalizeCredentialSwap(config) {
  if (!object(config)) throw swapError('invalid_swap_config');
  if (!Object.hasOwn(config, 'credentialSwap')) return null;
  const raw = config.credentialSwap;
  if (!object(raw)) throw swapError('invalid_swap_config');
  const result = {
    enabled: false,
    listenPort: 37991,
    expiryMarginMs: 300_000,
    legacyProxyUrl: 'http://127.0.0.1:37891',
    requestTimeoutMs: 180_000,
    callers: [],
    swapAccounts: [],
    ...raw,
  };
  if (typeof result.enabled !== 'boolean'
    || !integer(result.listenPort, 1, 65535)
    || !integer(result.expiryMarginMs, 0)
    || !integer(result.requestTimeoutMs, 1)
    || !path(result.stateDir)
    || !Array.isArray(result.callers)
    || !Array.isArray(result.swapAccounts)
    || result.swapAccounts.length > 1
    || (result.enabled && result.swapAccounts.length !== 1)) throw swapError('invalid_swap_config');
  result.stateDir = resolve(result.stateDir);
  if ([appConfigDir(), runtimeStatePath()].some(protectedPath =>
    overlaps(result.stateDir, resolve(protectedPath)))) throw swapError('invalid_swap_config');
  try {
    if (typeof result.legacyProxyUrl !== 'string') throw swapError();
    const url = new URL(result.legacyProxyUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || Number(url.port || 80) === result.listenPort) throw swapError();
    result.legacyProxyUrl = url.origin;
  } catch { throw swapError('invalid_swap_config'); }
  const hashes = new Set();
  for (const caller of result.callers) {
    if (!object(caller) || !id(caller.accountId) || typeof caller.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(caller.sha256)
      || !integer(caller.expiresAt, 1) || hashes.has(caller.sha256)) throw swapError('invalid_swap_config');
    hashes.add(caller.sha256);
  }
  for (const account of result.swapAccounts) validateSwapAccount(account);
  return structuredClone(result);
}

export function validateSwapAccount(account) {
  if (!object(account) || !id(account.id) || !path(account.configDir)
    || !text(account.acct) || !path(account.keychainPath)
    || account.service === DEFAULT_CLAUDE_KEYCHAIN_SERVICE
    || account.service !== claudeKeychainServiceName(account.configDir)
    || !Array.isArray(account.keychainAllowlist) || account.keychainAllowlist.length === 0
    || account.keychainAllowlist.some(value => !path(value))
    || new Set(account.keychainAllowlist).size !== account.keychainAllowlist.length
    || !account.keychainAllowlist.includes(account.keychainPath)) throw swapError('invalid_swap_config');
}
