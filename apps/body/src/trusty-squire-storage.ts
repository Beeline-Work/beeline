import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export function trustySquireStorePath(configRoot: string): string {
  return resolve(configRoot, 'trusty-squire');
}

export function trustySquireLegacyStorePaths(
  operatorHome = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = new Set([resolve(operatorHome, '.config')]);
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfig && isAbsolute(xdgConfig)) roots.add(resolve(xdgConfig));
  return [...roots].map((root) => resolve(root, 'trusty-squire'));
}
