import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'claude-rotator';

export function expandHome(path, home = homedir()) {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

export function xdgConfigHome(env = process.env, home = homedir()) {
  return env.XDG_CONFIG_HOME || join(home, '.config');
}

export function xdgDataHome(env = process.env, home = homedir()) {
  return env.XDG_DATA_HOME || join(home, '.local', 'share');
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

export function backupDir(env = process.env, home = homedir()) {
  return join(appConfigDir(env, home), 'backups');
}

export function claudeSettingsPath(home = homedir()) {
  return join(home, '.claude', 'settings.json');
}

export function linuxAccountsDir(env = process.env, home = homedir()) {
  return join(appDataDir(env, home), 'accounts');
}
