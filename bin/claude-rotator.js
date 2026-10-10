#!/usr/bin/env node

const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major < 22) {
  process.stderr.write(`claude-rotator requires Node.js 22 or newer. Current Node.js is ${process.version}.\n`);
  process.exit(1);
}

const { setDefaultResultOrder } = await import('node:dns');
const { fileURLToPath } = await import('node:url');
const { spawn } = await import('node:child_process');
setDefaultResultOrder('ipv4first');

const { runCli } = await import('../src/cli.js');
const { createCodexSectionReader } = await import('../src/codex-status-child.js');

const code = await runCli(process.argv.slice(2), {
  cliPath: fileURLToPath(import.meta.url),
  // The only place that builds the real Codex section reader, with the real
  // environment and the real spawn. runCli never looks for a codex-rotator config
  // or starts a child process unless it is handed this function.
  readCodexSection: createCodexSectionReader({ env: process.env, spawnImpl: spawn }),
});
process.exitCode = code;
