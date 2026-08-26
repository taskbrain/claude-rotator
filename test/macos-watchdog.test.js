import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  renderMacosWatchdogLaunchAgentPlist,
  renderMacosWatchdogScript,
  shellQuote,
} from '../src/macos-watchdog.js';
import { fileSha256, writeJsonFile } from '../src/json-file.js';

const execFileAsync = promisify(execFile);

describe('macOS WatchDock helper', () => {
  it('does nothing when the desired-generation marker is absent or stale', async () => {
    const fixture = await createFixture();
    try {
      await fixture.run();
      assert.equal(await fixture.calls(), '');

      await writeJsonFile(fixture.markerPath, {
        version: 1,
        installStateSha256: '0'.repeat(64),
      });
      await fixture.run();
      assert.equal(await fixture.calls(), '');
    } finally {
      await fixture.cleanup();
    }
  });

  it('bootstraps a missing main job once and verifies registration', async () => {
    const fixture = await createFixture();
    try {
      await writeJsonFile(fixture.markerPath, {
        version: 1,
        installStateSha256: await fileSha256(fixture.installStatePath),
      });

      const result = await fixture.run();

      assert.equal(await fixture.calls(), [
        'print gui/501/io.github.claude-rotator',
        `bootstrap gui/501 ${fixture.mainPlistPath}`,
        'print gui/501/io.github.claude-rotator',
      ].join('\n') + '\n', result.stderr);
    } finally {
      await fixture.cleanup();
    }
  });

  it('renders a syntax-valid helper and a lockf-backed periodic LaunchAgent', async () => {
    const helper = renderMacosWatchdogScript({
      markerPath: '/tmp/watchdog.json',
      installStatePath: '/tmp/install-state.json',
      mainPlistPath: '/tmp/main.plist',
      domain: 'gui/501',
    });
    const plist = renderMacosWatchdogLaunchAgentPlist({
      lockPath: '/tmp/service.lock',
      helperPath: '/tmp/watchdog.sh',
    });

    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-watchdog-syntax-'));
    const helperPath = join(dir, 'watchdog.sh');
    try {
      await writeFile(helperPath, helper, { mode: 0o700 });
      await execFileAsync('/bin/sh', ['-n', helperPath]);
      assert.match(plist, /<string>\/usr\/bin\/lockf<\/string>/);
      assert.match(plist, /<string>-t<\/string>[\s\S]*<string>0<\/string>[\s\S]*<string>-k<\/string>/);
      assert.match(plist, /<key>StartInterval<\/key>\s*<integer>15<\/integer>/);
      assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('renders a syntax-valid helper when paths contain a single quote', async () => {
    const helper = renderMacosWatchdogScript({
      markerPath: "/tmp/o'brien/watchdog.json",
      installStatePath: '/tmp/install-state.json',
      mainPlistPath: '/tmp/main.plist',
      domain: 'gui/501',
    });

    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-watchdog-quote-'));
    const helperPath = join(dir, 'watchdog.sh');
    try {
      await writeFile(helperPath, helper, { mode: 0o700 });
      await execFileAsync('/bin/sh', ['-n', helperPath]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a single-quote payload as a literal value, not a command substitution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-watchdog-injection-'));
    const canaryPath = join(dir, `should-not-exist-${process.pid}`);
    const payloadMarkerPath = `${dir}/x'$(touch ${canaryPath})'y`;
    const helper = renderMacosWatchdogScript({
      markerPath: payloadMarkerPath,
      installStatePath: '/tmp/install-state.json',
      mainPlistPath: '/tmp/main.plist',
      domain: 'gui/501',
    });

    const helperPath = join(dir, 'watchdog.sh');
    try {
      await writeFile(helperPath, helper, { mode: 0o700 });
      await execFileAsync('/bin/sh', [helperPath]);
      await assert.rejects(readFile(canaryPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-watchdog-'));
  const markerPath = join(dir, 'watchdog.json');
  const installStatePath = join(dir, 'install-state.json');
  const mainPlistPath = join(dir, 'main.json');
  const helperPath = join(dir, 'watchdog.sh');
  const launchctlPath = join(dir, 'launchctl');
  const plutilPath = join(dir, 'plutil');
  const shasumPath = join(dir, 'shasum');
  const callsPath = join(dir, 'calls');
  const registeredPath = join(dir, 'registered');

  await writeJsonFile(installStatePath, { installedAt: '2026-08-23T00:00:00.000Z' });
  await writeJsonFile(mainPlistPath, { Label: 'io.github.claude-rotator' });
  await writeExecutable(plutilPath, `#!/bin/sh
node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(value[process.argv[2]]))' "$6" "$2"
`);
  await writeExecutable(shasumPath, `#!/bin/sh
node -e 'const fs=require("fs"),crypto=require("crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex")+"  "+process.argv[1]+"\\n")' "$3"
`);
  await writeExecutable(launchctlPath, `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(callsPath)}
if [ "$1" = print ]; then
  [ -f ${shellQuote(registeredPath)} ] && exit 0
  exit 113
fi
if [ "$1" = bootstrap ]; then
  : > ${shellQuote(registeredPath)}
  exit 0
fi
exit 2
`);
  await writeFile(helperPath, renderMacosWatchdogScript({
    markerPath,
    installStatePath,
    mainPlistPath,
    domain: 'gui/501',
    launchctlPath,
    plutilPath,
    shasumPath,
  }), { mode: 0o700 });

  return {
    markerPath,
    installStatePath,
    mainPlistPath,
    run: () => execFileAsync('/bin/sh', [helperPath]),
    calls: async () => readFile(callsPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function writeExecutable(path, body) {
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
}
