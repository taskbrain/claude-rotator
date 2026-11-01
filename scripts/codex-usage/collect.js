#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const HOUR = 3_600_000;
const THRESHOLD = 90;

function samplesOf(snapshot) {
  if (!Array.isArray(snapshot.accounts)) throw new Error('invalid status JSON');
  return snapshot.accounts.flatMap(account => [
    ...Object.entries(account.windows ?? {}),
    ...(account.otherWindows ?? []).map(window => ['other', window]),
  ].filter(([, value]) => value !== null).map(([window, value]) => ({
    label: account.label,
    window,
    usedPercent: value.usedPercent ?? null,
    resetAt: value.resetAt ?? null,
    windowMinutes: value.windowMinutes ?? null,
    observedAt: value.observedAt ?? null,
    fresh: value.fresh === true,
    state: account.state,
  })));
}

const windowKey = row => JSON.stringify([row.label, row.window, row.resetAt, row.windowMinutes]);
const sampleKey = row => JSON.stringify([windowKey(row), row.observedAt]);

async function readOrEmpty(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function forecastWindow(current, samples, now) {
  const result = {
    ...current,
    status: 'unknown',
    reason: null,
    sampleCount: 0,
    ratePercentPerHour: null,
    reachesAt: null,
  };
  const unknown = reason => ({ ...result, reason });
  if (!current.fresh) return unknown('stale');
  const reset = Date.parse(current.resetAt);
  if (!Number.isFinite(reset) || !Number.isInteger(current.windowMinutes) || current.windowMinutes <= 0) {
    return unknown('incomplete-window');
  }
  if (reset <= now) return unknown('expired-window');
  const observed = Date.parse(current.observedAt);
  if (!Number.isFinite(observed) || observed > now || !Number.isFinite(current.usedPercent)) {
    return unknown('invalid-observation');
  }

  // fresh は採取時点の値。履歴を現在の短い鮮度期限で捨てると、毎時の回帰ができない。
  const points = [...new Map(samples.filter(row => windowKey(row) === windowKey(current)
    && row.fresh && Number.isFinite(row.usedPercent)
    && Number.isFinite(Date.parse(row.observedAt)) && Date.parse(row.observedAt) <= observed)
    .map(row => [Date.parse(row.observedAt), row])).values()]
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  result.sampleCount = points.length;
  if (points.length < 3) return unknown('insufficient-points');

  const origin = Date.parse(points[0].observedAt);
  const x = points.map(row => (Date.parse(row.observedAt) - origin) / HOUR);
  const meanX = x.reduce((sum, value) => sum + value, 0) / points.length;
  const meanY = points.reduce((sum, row) => sum + row.usedPercent, 0) / points.length;
  const rate = points.reduce((sum, row, i) => sum + (x[i] - meanX) * (row.usedPercent - meanY), 0)
    / x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  result.ratePercentPerHour = rate;
  if (current.usedPercent >= THRESHOLD) {
    return { ...result, status: 'reaches-90', reason: 'already-at-90', reachesAt: current.observedAt };
  }
  if (rate <= 0) return { ...result, status: 'not-reaching', reason: 'non-positive-rate' };
  const crossing = origin + (meanX + (THRESHOLD - meanY) / rate) * HOUR;
  if (!Number.isFinite(crossing) || crossing >= reset) {
    return { ...result, status: 'not-reaching', reason: 'at-or-after-reset' };
  }
  return { ...result, status: 'reaches-90', reason: 'projected', reachesAt: new Date(crossing).toISOString() };
}

const STATUS_TEXT = { 'reaches-90': '90%に届く', 'not-reaching': '届かない', unknown: '判定不能' };
const REASON_TEXT = {
  stale: '最新の値が fresh ではない',
  'incomplete-window': '窓を特定できない',
  'expired-window': 'リセット時刻を過ぎている',
  'invalid-observation': '観測時刻または使用率が不明',
  'insufficient-points': '異なる時刻の fresh な点が3つ未満',
  'non-positive-rate': 'ペースが0以下',
  'at-or-after-reset': '90%到達はリセット時刻以降',
  'already-at-90': '観測時点で90%以上',
  projected: '最小二乗法による見込み',
};

function markdown(report) {
  const lines = [`# Codex 使用量の見込み (${report.date} JST)`, '',
    '表示専用です。振り分けの判断には使いません。', '', `生成: ${report.generatedAt}`, ''];
  const safe = value => String(value).replace(/[\r\n`]/g, ' ');
  for (const account of report.accounts) {
    lines.push(`## ${safe(account.label)}`, '', `状態: ${safe(account.state)}`, '');
    if (!account.windows.length) lines.push('判定不能: 窓の値がない', '');
    for (const window of account.windows) {
      lines.push(`- ${safe(window.window)} (${window.windowMinutes ?? '?'}分): ${STATUS_TEXT[window.status]}`
        + ` — ${REASON_TEXT[window.reason]}。点: ${window.sampleCount}。`
        + ` ペース: ${window.ratePercentPerHour === null ? '不明' : window.ratePercentPerHour.toFixed(3) + '%/時'}。`
        + ` 90%到達: ${window.reachesAt ?? '—'}。リセット: ${window.resetAt ?? '不明'}。`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function publishForecast(outputDir, date, snapshot, current, samples, now) {
  const stem = join(outputDir, `codex-usage-forecast-${date}`);
  const lock = `${stem}.lock`;
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  try {
    let json = await readOrEmpty(`${stem}.json`);
    if (!json) {
      const report = {
        schemaVersion: 1,
        date,
        timeZone: 'Asia/Tokyo',
        generatedAt: new Date(now).toISOString(),
        thresholdPercent: THRESHOLD,
        accounts: snapshot.accounts.map(account => ({
          label: account.label,
          state: account.state,
          windows: current.filter(row => row.label === account.label)
            .map(row => forecastWindow(row, samples, now)),
        })),
      };
      json = JSON.stringify(report, null, 2) + '\n';
      await writeFile(join(lock, 'forecast.json'), json);
      await rename(join(lock, 'forecast.json'), `${stem}.json`);
    }
    // 日付の JSON が完了の根拠。派生ファイルだけ欠けても次回に作り直せる。
    await writeFile(join(lock, 'forecast.md'), markdown(JSON.parse(json)));
    await rename(join(lock, 'forecast.md'), `${stem}.md`);
    await writeFile(join(lock, 'latest.json'), json);
    await rename(join(lock, 'latest.json'), join(outputDir, 'latest.json'));
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function collectUsage({ env = process.env, now = Date.now() } = {}) {
  const rotator = env.CODEX_USAGE_ROTATOR || join(env.HOME, '.local/bin/codex-rotator');
  let stdout;
  try {
    ({ stdout } = await execute(rotator, ['status', '--json'], { env }));
  } catch {
    throw new Error('rotator status failed');
  }
  let snapshot, current;
  try {
    snapshot = JSON.parse(stdout);
    current = samplesOf(snapshot);
  } catch {
    throw new Error('invalid status JSON');
  }

  const outputDir = env.CODEX_USAGE_DIR || join(env.HOME, '.claude/work/routing');
  const samplePath = join(outputDir, 'codex-usage-samples.jsonl');
  const samples = (await readOrEmpty(samplePath)).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const seen = new Set(samples.map(sampleKey));
  const additions = current.filter(row => {
    const key = sampleKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await mkdir(outputDir, { recursive: true });
  if (additions.length) await appendFile(samplePath, additions.map(row => JSON.stringify(row) + '\n').join(''));

  const jst = new Date(now + 9 * HOUR).toISOString();
  const hour = Number(jst.slice(11, 13));
  if (hour >= 8 && hour < 21) {
    await publishForecast(outputDir, jst.slice(0, 10), snapshot, current, [...samples, ...additions], now);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  collectUsage().catch(error => {
    // 子の stderr や例外の内容は、そのままログへ転記しない。
    const message = ['rotator status failed', 'invalid status JSON'].includes(error.message)
      ? error.message : 'collection failed';
    process.stderr.write(`codex-usage: ${message}\n`);
    process.exitCode = 1;
  });
}
