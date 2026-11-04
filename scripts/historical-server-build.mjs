import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

/** Build the exact recorded server sources for an isolated rollout replay. */
export function historicalServerBuild(ref) {
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('historical build requires a full commit');
  const root = resolve('.beeline-proof/builds', ref);
  const cached = existsSync(resolve(root, '.built'));
  if (cached && existsSync(resolve(root, 'server/assets/mcp/muse.webp'))) return root;
  const packages = ['apps/server', 'apps/auth', 'packages/api-contract', 'packages/nostr', 'packages/buzz-client'];
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, ...packages], { encoding: 'utf8' })
    .trim().split('\n').filter(f => f.startsWith('apps/server/assets/') || (!cached &&
      (/\/src\//.test(f) && !/\.test\.ts$|\.d\.ts$|test-support|test-fixtures|\/fixtures\//.test(f) || /\/package.json$/.test(f))));
  const blobs = execFileSync('git', ['cat-file', '--batch'], {
    input: files.map(f => `${ref}:${f}\n`).join(''), maxBuffer: 64 * 1024 * 1024,
  });
  let offset = 0;
  for (const file of files) {
    const end = blobs.indexOf(10, offset);
    const size = Number(blobs.subarray(offset, end).toString().split(' ')[2]);
    if (!Number.isSafeInteger(size)) throw new Error(`missing historical source ${file}`);
    offset = end + 1;
    const source = blobs.subarray(offset, offset + size);
    offset += size + 1;
    const area = packages.find(p => file.startsWith(p + '/'));
    const name = area === 'apps/server' ? 'server' : area === 'apps/auth' ? 'auth' : area.split('/').at(-1);
    const relative = file.slice(area.length + 1);
    const target = resolve(root, name === 'server' ? 'server' : `node_modules/@beeline/${name}`,
      relative.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.endsWith('.ts') ? ts.transpileModule(source.toString(), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText : source);
  }
  writeFileSync(resolve(root, '.built'), ref);
  return root;
}
