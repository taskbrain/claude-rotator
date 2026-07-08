import { defaultConfigPath } from './paths.js';
import { readJsonFile, writeJsonFile } from './json-file.js';

export const DEFAULT_PORT = 37891;
export const DEFAULT_THRESHOLD = 1;
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
export const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_UPSTREAM_CONNECT_RETRIES = 3;
export const DEFAULT_UPSTREAM_CONNECT_RETRY_DELAY_MS = 250;
export const DEFAULT_WEEKLY_RESET_PRIORITY_WINDOW_MS = 36 * 60 * 60 * 1000;
export const DEFAULT_USAGE_POLL_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_USAGE_REFRESH_CONCURRENCY = 1;
export const DEFAULT_USAGE_REFRESH_REQUEST_SPACING_MS = 1500;

export function createDefaultConfig() {
  return {
    proxy: {
      host: '127.0.0.1',
      port: DEFAULT_PORT,
      upstreamIdleTimeoutMs: DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
      upstreamConnectTimeoutMs: DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS,
      upstreamConnectRetries: DEFAULT_UPSTREAM_CONNECT_RETRIES,
      upstreamConnectRetryDelayMs: DEFAULT_UPSTREAM_CONNECT_RETRY_DELAY_MS,
    },
    upstream: 'https://api.anthropic.com',
    switchThreshold: DEFAULT_THRESHOLD,
    rotationPolicy: {
      mode: 'use-expiring-weekly',
      weeklyResetPriorityWindowMs: DEFAULT_WEEKLY_RESET_PRIORITY_WINDOW_MS,
    },
    usagePolling: {
      enabled: true,
      intervalMs: DEFAULT_USAGE_POLL_INTERVAL_MS,
      concurrency: DEFAULT_USAGE_REFRESH_CONCURRENCY,
      requestSpacingMs: DEFAULT_USAGE_REFRESH_REQUEST_SPACING_MS,
    },
    accounts: [],
  };
}

export function getConfigPath(env = process.env) {
  return env.CLAUDE_ROTATOR_CONFIG || defaultConfigPath(env);
}

export async function loadConfig(path = getConfigPath()) {
  return readJsonFile(path, null);
}

export async function loadOrCreateConfig(path = getConfigPath()) {
  const existing = await loadConfig(path);
  if (existing) return existing;
  const config = createDefaultConfig();
  await saveConfig(config, path);
  return config;
}

export async function saveConfig(config, path = getConfigPath()) {
  await writeJsonFile(path, config);
}

export function proxyBaseUrl(config) {
  const host = config.proxy?.host || '127.0.0.1';
  const port = config.proxy?.port || DEFAULT_PORT;
  return `http://${host}:${port}`;
}

export function mergeClaudeSettings(settings, baseUrl) {
  const current = cloneJson(settings || {});
  const env = { ...(current.env || {}) };
  const existed = Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_BASE_URL');
  const previousBaseUrl = { existed, value: env.ANTHROPIC_BASE_URL };
  env.ANTHROPIC_BASE_URL = baseUrl;
  current.env = env;
  return { settings: current, previousBaseUrl };
}

export function restoreClaudeSettings(settings, installState, options = {}) {
  const current = cloneJson(settings || {});
  const env = { ...(current.env || {}) };
  const installedValue = installState.proxyBaseUrl;
  const currentValue = env.ANTHROPIC_BASE_URL;

  if (!options.force && currentValue !== installedValue) {
    return {
      conflict: true,
      reason: `ANTHROPIC_BASE_URL is "${currentValue}", expected "${installedValue}"`,
      settings: current,
    };
  }

  if (installState.previousBaseUrl?.existed) {
    env.ANTHROPIC_BASE_URL = installState.previousBaseUrl.value;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }

  if (Object.keys(env).length > 0) current.env = env;
  else delete current.env;

  return { conflict: false, settings: current };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
