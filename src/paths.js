import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const APP_NAME = 'claude-rotator';

export function expandHome(path, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

export function xdgConfigHome(env = process.env, home = homedir()) {
  if (env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)) return env.XDG_CONFIG_HOME;
  return join(home, '.config');
}

export function xdgDataHome(env = process.env, home = homedir()) {
  if (env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)) return env.XDG_DATA_HOME;
  return join(home, '.local', 'share');
}

export function appConfigDir(env = process.env, home = homedir()) {
  return join(xdgConfigHome(env, home), APP_NAME);
}

export function appDataDir(env = process.env, home = homedir()) {
  return join(xdgDataHome(env, home), APP_NAME);
}

export function defaultConfigPath(env = process.env, home = homedir()) {
  return join(appConfigDir(env, home), 'config.json');
}

export function installStatePath(env = process.env, home = homedir()) {
  return join(appConfigDir(env, home), 'install-state.json');
}

export function runtimeStatePath(env = process.env, home = homedir()) {
  return join(appConfigDir(env, home), 'runtime-state.json');
}

export function backupDir(env = process.env, home = homedir()) {
  return join(appConfigDir(env, home), 'backups');
}

export function claudeSettingsPath(home = homedir()) {
  return join(home, '.claude', 'settings.json');
}

export function linuxAccountsDir(env = process.env, home = homedir()) {
  return join(appDataDir(env, home), 'accounts');
}

export function macosServiceLockPath(env = process.env, home = homedir()) {
  return join(appConfigDir(env, home), 'macos-service.lock');
}

export function macosWatchdogMarkerPath(env = process.env, home = homedir()) {
  return join(appConfigDir(env, home), 'watchdog.json');
}

export function macosWatchdogHelperPath(env = process.env, home = homedir()) {
  return join(appDataDir(env, home), 'macos-watchdog.sh');
}

export function macosWatchdogPlistPath(home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', 'io.github.claude-rotator.watchdog.plist');
}
