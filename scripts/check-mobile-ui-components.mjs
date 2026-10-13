import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { judgeUiRegistry, REGISTRY_PATH, registryAtRef, scanUiTree } from './mobile-ui-policy.mjs';

const args = process.argv.slice(2);
const baseFlag = args.indexOf('--base');
const base = baseFlag === -1 ? undefined : args[baseFlag + 1];
if (baseFlag !== -1 && (!base || base.startsWith('-')))
  throw new Error('--base requires a git ref');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
try {
  const scans = scanUiTree(root);
  const registry = JSON.parse(readFileSync(path.join(root, REGISTRY_PATH), 'utf8'));
  const errors = judgeUiRegistry(scans, registry, base ? registryAtRef(root, base) : undefined);
  for (const error of errors)
    console.error(
      `apps/mobile/sources/${error.file}:${error.line} [${error.rule}] ${error.message}`,
    );
  if (errors.length) {
    console.error(
      `UI component policy failed: ${errors.length} violation(s). Reuse the shared components; new shared components require a visible registry entry. Legacy controls cannot grow or be replaced with new hand-rolled controls.`,
    );
    process.exitCode = 1;
  } else
    console.log(
      `UI component policy passed (${scans.length} source modules; ${Object.keys(registry.components).length} registered shared files).`,
    );
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
