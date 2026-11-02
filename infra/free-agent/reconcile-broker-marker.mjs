import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Fly image changes can replace directory inodes while retaining the marker.
// Run before the user manager starts any unit; keep the account binding intact.
export function reconcileBrokerMarker(home) {
  const path = join(home, '.trusty-squire', '.trusty-squire-broker-unit.json');
  if (!existsSync(path)) return;
  const marker = JSON.parse(readFileSync(path, 'utf8'));
  mkdirSync(join(home, '.trusty-squire', 'chrome-profile'), { recursive: true, mode: 0o700 });
  const profile = realpathSync(join(home, '.trusty-squire', 'chrome-profile'));
  if (marker.version !== 1 || marker.profile?.name !== basename(profile) ||
      marker.socket !== join(home, '.trusty-squire', 'broker.sock'))
    throw new Error('Unexpected hosted broker marker');
  const { dev, ino } = statSync(dirname(profile));
  if (marker.profile.dev === dev && marker.profile.ino === ino) return;
  marker.profile = { dev, ino, name: basename(profile) };
  writeFileSync(`${path}.tmp`, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  reconcileBrokerMarker(process.env.HOME);
