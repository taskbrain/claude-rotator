import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { swapError, validateSwapAccount } from './credential-swap-config.js';

const exec = promisify(execFile);
export const EXPIRY_REASONS = new Set(['credential_expiry_unknown', 'credential_expired', 'credential_within_margin']);

export function credentialExpiryReason(expiresAt, now, marginMs) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return 'credential_expiry_unknown';
  if (expiresAt <= now) return 'credential_expired';
  if (expiresAt <= now + marginMs) return 'credential_within_margin';
  return null;
}

// There is deliberately no arbitrary command entry point. Attribute dumps never
// request decryption; password reads always name the exact service, acct and file.
export function createSwapKeychainReader({ execute = exec, now = Date.now } = {}) {
  let tail = Promise.resolve();
  return {
    async read(account, { marginMs, signal } = {}) {
      validateSwapAccount(account);
      let release;
      const previous = tail;
      tail = new Promise(resolve => { release = resolve; });
      // Preserve serialization even when a queued caller abandons its wait.
      try {
        await previous;
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(marginMs) || marginMs < 0) throw swapError();
        const before = await snapshot(account, execute, signal);
        signal?.throwIfAborted();
        const { stdout } = await execute('/usr/bin/security', [
          'find-generic-password', '-a', account.acct, '-s', account.service,
          '-w', account.keychainPath,
        ], options(signal));
        const after = await snapshot(account, execute, signal);
        if (before !== after) throw swapError();
        let parsed;
        try { parsed = JSON.parse(String(stdout)); } catch { throw swapError(); }
        const credential = parsed?.claudeAiOauth;
        if (!credential || typeof credential.accessToken !== 'string'
          || !/^[\x21-\x7e]+$/.test(credential.accessToken)) throw swapError();
        const reason = credentialExpiryReason(credential.expiresAt, now(), marginMs);
        if (reason) throw swapError(reason);
        return { accessToken: credential.accessToken, expiresAt: credential.expiresAt };
      } catch (error) { throw swapError(EXPIRY_REASONS.has(error?.message) ? error.message : undefined); }
      finally { release(); }
    },
  };
}

function options(signal) {
  return { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 10_000, signal };
}

async function snapshot(account, execute, signal) {
  signal?.throwIfAborted();
  const { stdout } = await execute('/usr/bin/security', ['list-keychains', '-d', 'user'], options(signal));
  const lines = String(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.some(line => !/^"[^"\\]+"$/.test(line))) throw swapError();
  const search = lines.map(line => line.slice(1, -1));
  if (new Set(search).size !== search.length || !search.includes(account.keychainPath)
    || search.some(file => !account.keychainAllowlist.includes(file))) throw swapError();
  const matches = [];
  // find-generic-password alone returns only the first match. Enumerate
  // attributes in each explicitly allowed file to establish uniqueness first.
  for (const file of account.keychainAllowlist) {
    signal?.throwIfAborted();
    const result = await execute('/usr/bin/security', ['dump-keychain', file], options(signal));
    const body = String(result.stdout).trim();
    if (!body) continue;
    const blocks = body.split(/(?=^keychain: )/m).filter(Boolean);
    for (const block of blocks) {
      if (!block.startsWith(`keychain: "${file}"\n`) || /^data:/m.test(block)) throw swapError();
      if (!/^class: "genp"$/m.test(block)) continue;
      const acct = attribute(block, 'acct', 'blob');
      const service = attribute(block, 'svce', 'blob');
      if (acct === null || service === null) throw swapError();
      if (acct !== account.acct || service !== account.service) continue;
      if (file !== account.keychainPath || !attribute(block, 'mdat', 'timedate')) throw swapError();
      matches.push(block.trim());
    }
  }
  if (matches.length !== 1) throw swapError();
  return JSON.stringify([search, matches[0]]);
}

function attribute(block, key, kind) {
  const matches = [...block.matchAll(new RegExp(`^\\s*"${key}"<${kind}>=(?:0x[0-9A-Fa-f]+ )?"([^"\\\\]*)"\\s*$`, 'gm'))];
  return matches.length === 1 ? matches[0][1] : null;
}
