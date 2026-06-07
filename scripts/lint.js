#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['src', 'bin', 'scripts', 'test'];
const files = [];

for (const root of roots) {
  await collectJs(root, files);
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

const forbiddenLogPattern = /console\.(log|error|warn)\([^)]*(accessToken|refreshToken|authorization|apiKey|secret)/i;
for (const file of files.filter(file => file.startsWith('src/') || file.startsWith('bin/'))) {
  const body = await readFile(file, 'utf8');
  if (forbiddenLogPattern.test(body)) {
    process.stderr.write(`Forbidden secret logging pattern in ${file}\n`);
    process.exit(1);
  }
}

async function collectJs(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectJs(path, out);
    else if (entry.isFile() && path.endsWith('.js')) out.push(path);
  }
}
