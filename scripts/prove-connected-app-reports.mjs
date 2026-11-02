// Exercise the connected-app HTTP paths against built server modules.
// The isolated test database and local identity provider stand in for production.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = new URL('../apps/server/src/rooms-mcp.test.ts', import.meta.url);
const proof = new URL(`../apps/server/src/connected-app-built-proof-${process.pid}.test.ts`, import.meta.url);
let written = false;
try {
  const text = (await readFile(source, 'utf8')).replace(
    /from '(\.\/[^']+)\.js'/g,
    (match, name) => name === './test-support' ? match : `from '../dist/${name.slice(2)}.js'`,
  );
  await writeFile(proof, text, { flag: 'wx' });
  written = true;
  const result = spawnSync('npx', ['vitest', 'run', fileURLToPath(proof), '-t', 'R1:|R2:',
    '--maxWorkers=1', '--minWorkers=1', '--silent', '--no-cache'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (!process.exitCode) console.log('R1/R2 demonstrated: built MCP HTTP report reaches commander, objective completes, working clears, and tag receipts name each live route.');
} finally {
  if (written) await rm(proof, { force: true });
}
