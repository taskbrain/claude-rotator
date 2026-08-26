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
// Claude Code requires a client credential when ANTHROPIC_BASE_URL points at a
// gateway. The local proxy replaces this non-secret placeholder before any
// upstream request, so account credentials remain owned by the rotator.
export const LOCAL_GATEWAY_AUTH_TOKEN = 'claude-rotator-local-gateway';
const LOOPBACK_PROXY_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

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
  const host = proxyListenHost(config);
  const port = config.proxy?.port || DEFAULT_PORT;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export function proxyListenHost(config) {
  const host = config.proxy?.host || '127.0.0.1';
  if (!LOOPBACK_PROXY_HOSTS.has(host)) {
    throw new Error(
      `proxy.host must be a loopback address (127.0.0.1, localhost, or ::1), received ${host}`,
    );
  }
  return host;
}

export function mergeClaudeSettings(
  settings,
  baseUrl,
  gatewayAuthToken = LOCAL_GATEWAY_AUTH_TOKEN,
) {
  const current = cloneJson(settings || {});
  const env = { ...(current.env || {}) };
  const previousBaseUrl = settingSnapshot(env, 'ANTHROPIC_BASE_URL');
  const previousAuthToken = settingSnapshot(env, 'ANTHROPIC_AUTH_TOKEN');
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = gatewayAuthToken;
  current.env = env;
  return { settings: current, previousBaseUrl, previousAuthToken };
}

export function restoreClaudeSettings(settings, installState, options = {}) {
  const current = cloneJson(settings || {});
  const env = { ...(current.env || {}) };
  const installedValue = installState.proxyBaseUrl;
  const currentValue = env.ANTHROPIC_BASE_URL;
  const installedAuthToken = installState.gatewayAuthToken;
  const currentAuthToken = env.ANTHROPIC_AUTH_TOKEN;

  if (!options.force && currentValue !== installedValue) {
    return {
      conflict: true,
      reason: `ANTHROPIC_BASE_URL is "${currentValue}", expected "${installedValue}"`,
      settings: current,
    };
  }
  if (
    !options.force
    && installedAuthToken != null
    && currentAuthToken !== installedAuthToken
  ) {
    return {
      conflict: true,
      reason: 'ANTHROPIC_AUTH_TOKEN was changed after claude-rotator was installed',
      settings: current,
    };
  }

  restoreSetting(env, 'ANTHROPIC_BASE_URL', installState.previousBaseUrl);
  if (installedAuthToken != null) {
    restoreSetting(env, 'ANTHROPIC_AUTH_TOKEN', installState.previousAuthToken);
  }

  if (Object.keys(env).length > 0) current.env = env;
  else delete current.env;

  return { conflict: false, settings: current };
}

export function areClaudeGatewaySettingsRestored(settings, installState) {
  const env = settings?.env || {};
  return settingMatchesSnapshot(env, 'ANTHROPIC_BASE_URL', installState.previousBaseUrl)
    && (
      installState.gatewayAuthToken == null
      || settingMatchesSnapshot(env, 'ANTHROPIC_AUTH_TOKEN', installState.previousAuthToken)
    );
}

function settingSnapshot(env, key) {
  return {
    existed: Object.prototype.hasOwnProperty.call(env, key),
    value: env[key],
  };
}

function restoreSetting(env, key, previous) {
  if (previous?.existed) env[key] = previous.value;
  else delete env[key];
}

function settingMatchesSnapshot(env, key, snapshot) {
  const exists = Object.prototype.hasOwnProperty.call(env, key);
  return snapshot?.existed
    ? exists && env[key] === snapshot.value
    : !exists;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
