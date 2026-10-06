// File-only, read-only identity projection. JWT claims are decoded locally;
// "verified" means a valid local identity, NOT signature or online validation.
import { open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export const accountIdHash = value => createHash('sha256').update(value).digest('hex').slice(0, 12);
export const codexHomeHash = value => createHash('sha256').update(value).digest('hex').slice(0, 8);

export class CredentialsError extends Error {
  constructor(message, credentialsMode = 'unknown') {
    super(message);
    this.name = 'CredentialsError';
    this.credentialsMode = credentialsMode;
  }
}

async function fileMode(authPath) {
  let text;
  try {
    text = await readFile(join(dirname(authPath), 'config.toml'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return 'file'; // Codex's default credential store.
    throw new CredentialsError('credentials mode unreadable');
  }
  // Only root settings apply. Fail closed on unsupported syntax for this key;
  // do not mistake a profile/table value for the root credential store.
  const root = text.split(/^\s*\[/m)[0];
  const entries = root.split(/\r?\n/).filter(line => /^\s*(?:cli_auth_credentials_store|["']cli_auth_credentials_store["'])\s*=/.test(line));
  if (!entries.length) return 'file';
  const match = entries.length === 1 && entries[0].match(/^\s*(?:cli_auth_credentials_store|["']cli_auth_credentials_store["'])\s*=\s*["'](file|keyring|auto|ephemeral)["']\s*(?:#.*)?$/);
  const mode = match ? match[1] : 'unknown';
  if (mode !== 'file') throw new CredentialsError('File credentials required', mode);
  return mode;
}

export async function readCodexCredentials(authPath) {
  return readSnapshot(authPath, (_auth, identity) => identity);
}

// This private projection never escapes through the registration/health reader.
// Both values come from the same validated descriptor read, not two snapshots.
export async function readCodexSendSnapshot(authPath, { nowMs, readFileImpl } = {}) {
  if (!Number.isFinite(nowMs)) throw new CredentialsError('snapshot time required');
  return readSnapshot(authPath, (auth, identity) => {
    const accessToken = auth.tokens?.access_token;
    if (typeof accessToken !== 'string' || !accessToken.trim()) throw new CredentialsError('send credentials unavailable', 'file');
    const parts = accessToken.split('.');
    if (parts.length === 3) {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (typeof claims.exp === 'number' && claims.exp * 1000 <= nowMs) {
        throw new CredentialsError('send credentials expired', 'file');
      }
    }
    return { accountId: identity.accountId, accessToken };
  }, readFileImpl);
}

async function readSnapshot(authPath, project, readFileImpl = handle => handle.readFile('utf8')) {
  const credentialsMode = await fileMode(authPath);
  let handle;
  try {
    handle = await open(authPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024) {
      throw new CredentialsError('credentials permissions or file type invalid', credentialsMode);
    }
    const auth = JSON.parse(await readFileImpl(handle));
    if (auth.auth_mode != null && auth.auth_mode !== 'chatgpt') throw new Error();
    const jwt = auth.tokens?.id_token;
    if (typeof jwt !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) throw new Error();
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 1024) throw new Error();
    if (auth.tokens.account_id != null && auth.tokens.account_id !== accountId) throw new Error();
    return project(auth, { accountId, accountIdHash: accountIdHash(accountId), credentialsMode, identityCheck: 'verified' });
  } catch (error) {
    if (error instanceof CredentialsError) throw error;
    // Neither JSON parse errors nor filesystem errors may disclose credentials/paths.
    throw new CredentialsError('credentials identity unavailable', credentialsMode);
  } finally {
    await handle?.close();
  }
}
