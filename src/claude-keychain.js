import { createHash } from 'node:crypto';

export const DEFAULT_CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

export function claudeKeychainServiceName(configDir = null) {
  if (configDir == null || String(configDir).trim() === '') {
    return DEFAULT_CLAUDE_KEYCHAIN_SERVICE;
  }
  const normalized = String(configDir).normalize('NFC');
  const suffix = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${DEFAULT_CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}
