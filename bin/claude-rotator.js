#!/usr/bin/env node

const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  process.stderr.write(`claude-rotator requires Node.js 18 or newer. Current Node.js is ${process.version}.\n`);
  process.exit(1);
}

const { setDefaultResultOrder } = await import('node:dns');
const { fileURLToPath } = await import('node:url');
setDefaultResultOrder('ipv4first');

const { runCli } = await import('../src/cli.js');

const code = await runCli(process.argv.slice(2), {
  cliPath: fileURLToPath(import.meta.url),
});
process.exit(code);
