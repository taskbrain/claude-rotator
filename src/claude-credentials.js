import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseClaudeCredentials(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const data = parsed.claudeAiOauth || parsed;
  if (!data.accessToken) throw new Error('Claude credentials JSON must contain accessToken');
  const credential = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || null,
    expiresAt: data.expiresAt || null,
  };
  const scopes = normalizeScopes(data.scopes);
  if (scopes.length > 0) credential.scopes = scopes;
  for (const field of [
    'refreshTokenExpiresAt',
    'clientId',
    'subscriptionType',
    'rateLimitTier',
  ]) {
    if (data[field] != null) credential[field] = data[field];
  }
  return credential;
}

function normalizeScopes(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  return [...new Set(entries.map(scope => String(scope).trim()).filter(Boolean))];
}

export async function readCurrentClaudeCredentials({ platform = process.platform, home = homedir() } = {}) {
  if (platform === 'darwin') {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ]);
    return parseClaudeCredentials(stdout.trim());
  }

  const path = join(home, '.claude', '.credentials.json');
  return parseClaudeCredentials(await readFile(path, 'utf8'));
}
