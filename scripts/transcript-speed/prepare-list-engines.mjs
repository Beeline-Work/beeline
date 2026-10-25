/** Install the experiment-only LegendList alias without editing either lockfile. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = path.join(root, 'scripts/latency-rig/.local/list-engines');
const destination = path.join(root, 'apps/mobile/node_modules/@legendapp/list-benchmark');
const version = '3.6.0';
const expectedSha256 = 'dfc348d8ae9779baa5b58db3c720ea526e7807f55a575a97b5c4a56ebb35c35c';
mkdirSync(scratch, { recursive: true });
if (existsSync(path.join(destination, 'package.json'))) {
  if (JSON.parse(readFileSync(path.join(destination, 'package.json'), 'utf8')).version !== version)
    throw new Error('Existing benchmark alias has a different version');
  console.log(`LegendList benchmark alias already installed (${version})`);
} else {
  execFileSync('npm', ['pack', `@legendapp/list@${version}`, '--ignore-scripts', '--pack-destination', scratch], { stdio: 'pipe' });
  const archive = path.join(scratch, `legendapp-list-${version}.tgz`);
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== expectedSha256)
    throw new Error('LegendList archive differs from the pinned benchmark package');
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', destination, '--strip-components=1']);
  console.log(`Installed experiment-only LegendList (${version}); manifests and lockfiles unchanged`);
}
