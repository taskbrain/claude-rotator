import { readFile, writeFile } from 'node:fs/promises';

export function createFileBackedFakeKeychainOptions(lockDir, keychainPath) {
  return {
    lockDir,
    execFileImpl: async (command, args, options = {}) => {
      if (command !== 'security') throw new Error('Unexpected fake Keychain command');
      if (args[0] === '-i') {
        await options.beforeInput?.(process.pid);
        const accountId = options.input.match(/ -a "([^"]+)"/)?.[1];
        if (!accountId) throw new Error('Fake Keychain account is missing');
        const items = await readItems(keychainPath);
        if (options.input.startsWith('delete-generic-password ')) {
          delete items[accountId];
        } else {
          const payloadHex = options.input.match(/ -X "([0-9a-f]+)"/)?.[1];
          if (!payloadHex) throw new Error('Fake Keychain payload is missing');
          items[accountId] = Buffer.from(payloadHex, 'hex').toString('utf8');
        }
        await writeFile(keychainPath, JSON.stringify(items), { mode: 0o600 });
        await options.afterClose?.(process.pid);
        return { stdout: '' };
      }

      const accountId = args[args.indexOf('-a') + 1];
      const payload = (await readItems(keychainPath))[accountId];
      if (payload == null) {
        const error = new Error('not found');
        error.code = 44;
        throw error;
      }
      return { stdout: `${payload}\n` };
    },
  };
}

async function readItems(keychainPath) {
  try {
    return JSON.parse(await readFile(keychainPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}
