import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

// Record only a boolean, never the path or contents a test reads. This catches
// source-reading helpers while leaving ordinary image/data reads prunable.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = process.env.BEELINE_FUNCTION_COVERAGE_DIR;
if (!directory) throw new Error('BEELINE_FUNCTION_COVERAGE_DIR is required');
fs.mkdirSync(directory, { recursive: true });
const marker = resolve(directory, `.source-read-${process.pid}`);
fs.rmSync(marker, { force: true });
const originals = [];
function observe(value) {
  const filename = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
  if (typeof filename !== 'string') return;
  const file = relative(root, resolve(filename));
  if (!file.startsWith('../') && !file.includes('node_modules/') && /\.(?:[cm]?[jt]sx?|md|jsonc?|ya?ml|sql|sh|css|html|txt)$/.test(file)) fs.writeFileSync(marker, '');
}
for (const [object, names, processWork] of [
  [fs, ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream'], false],
  [fs.promises, ['readFile', 'open'], false],
  [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], true],
]) {
  for (const name of names) {
    const original = object[name];
    originals.push([object, name, original]);
    object[name] = function (...args) {
      if (processWork) fs.writeFileSync(marker, '');
      else observe(args[0]);
      return original.apply(this, args);
    };
  }
}
syncBuiltinESMExports();
afterAll(() => {
  for (const [object, name, original] of originals) object[name] = original;
  syncBuiltinESMExports();
});
