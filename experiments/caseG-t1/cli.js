#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runOperation } from './helper.js';
import { fail, safeError } from './safety.js';

export async function main(args, { env = process.env, run = runOperation,
  stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    const [command, ...rest] = args;
    const options = { command, env, apply: false };
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (seen.has(flag)) fail('INVALID_COMMAND');
      seen.add(flag);
      if (flag === '--apply') options.apply = true;
      else if (['--config', '--account', '--to'].includes(flag)) {
        const value = rest[++i];
        if (!value || value.startsWith('--')) fail('INVALID_COMMAND');
        if (flag === '--config') options.configPath = value;
        else {
          if ((flag === '--account' && command !== 'import') || (flag === '--to' && command !== 'switch')) fail('INVALID_COMMAND');
          options.label = value;
        }
      } else fail('INVALID_COMMAND');
    }
    const result = await run(options);
    stdout(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    stderr(JSON.stringify({ status: 'refused', code: safeError(error).code }) + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
