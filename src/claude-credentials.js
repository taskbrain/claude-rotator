import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { claudeKeychainServiceName } from './claude-keychain.js';
import { claudeConfigDir } from './paths.js';

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

export async function readCurrentClaudeCredentials({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  execFileImpl = execFileAsync,
  readFileImpl = readFile,
} = {}) {
  if (platform === 'darwin') {
    const customConfigDir = env.CLAUDE_CONFIG_DIR
      ? claudeConfigDir(env, home)
      : null;
    const { stdout } = await execFileImpl('security', [
      'find-generic-password',
      '-s',
      claudeKeychainServiceName(customConfigDir),
      '-w',
    ]);
    return parseClaudeCredentials(stdout.trim());
  }

  const path = join(claudeConfigDir(env, home), '.credentials.json');
  return parseClaudeCredentials(await readFileImpl(path, 'utf8'));
}
