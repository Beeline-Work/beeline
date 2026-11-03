import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractRoot = 'apps/server/contracts/';
// Already-applied, unrelated migrations are outside this repair's scope. The
// two incident columns are deliberately absent and may never be grandfathered.
const legacyDrops = JSON.parse(readFileSync(new URL('./rollout-schema-baseline.json', import.meta.url), 'utf8'));
const serverFile = file => file.startsWith('apps/server/src/') && file.endsWith('.ts') && !/\.test\.ts$|test-support|\/fixtures\/|\/test-fixtures\//.test(file);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

export function columnDrops(source) {
  const clean = source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const drops = [];
  for (const table of clean.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?\w+"?\.)?("?\w+"?)([^;`]*)(?:;|`)/gi))
    for (const column of table[2].matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?("?\w+"?)/gi))
      drops.push(`${table[1].replaceAll('"', '').toLowerCase()}.${column[1].replaceAll('"', '').toLowerCase()}`);
  return [...new Set(drops)];
}

/** Schema declarations are not runtime readers; generated SQL helpers are. */
export function runtimeSql(source) {
  // Multiline schema literals end on their own line. Unknown declaration
  // shapes remain in the scan, so ambiguity blocks a drop rather than allowing it.
  return source
    .replace(/\b(?:export\s+)?const\s+\w*SCHEMA\w*\s*=\s*`[\s\S]*?^`;/gm, '')
    .replace(/\b(?:export\s+)?const\s+\w*SCHEMA\w*\s*=\s*`[^`]*`;/g, '')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
}

function readsColumn(source, table, column) {
  const hasTable = new RegExp(`\\b${table}\\b`, 'i');
  for (const fragment of source.split('`')) {
    const query = fragment.replace(/'(?:''|[^'])*'/g, "''");
    if (!hasTable.test(query)) continue;
    const aliases = [...query.matchAll(new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(?:"?\\w+"?\\.)?"?${table}"?\\s+(?:AS\\s+)?(\\w+)`, 'gi'))]
      .map(m => m[1]).filter(alias => !/^(WHERE|SET|ON|LEFT|RIGHT|INNER|JOIN|ORDER|GROUP|LIMIT|RETURNING)$/i.test(alias));
    if (/(?:SELECT|,)\s*\*\s*(?:,|FROM)/i.test(query) ||
        [table, ...aliases].some(alias => new RegExp(`\\b${alias}\\.\\*`).test(query))) return true;
    if ([table, ...aliases].some(alias => new RegExp(`\\b${alias}\\.${column}\\b`, 'i').test(query))) return true;
    // Unqualified SQL columns and INSERT column lists are conservatively reads.
    const withoutAliases = query.replace(new RegExp(`(?:\\b(?:AS|END)\\s+|\\w+\\.\\w+\\s+|\\$\\{[^}]*\\}\\s+)${column}\\b`, 'gi'), '');
    if (new RegExp(`(?<![\\w.$])${column}(?!\\w)`, 'i').test(withoutAliases)) return true;
  }
  // SQL expression builders take an alias argument and interpolate it later.
  return hasTable.test(source) && new RegExp(`\\$\\{[^}]*[Aa]lias[^}]*\\}\\.${column}\\b`).test(source);
}

export function schemaProblems(current, previous) {
  const priorDrops = new Set(Object.values(previous).flatMap(columnDrops));
  const runtimeTrees = [['previous release', previous], ['candidate', current]].map(([revision, tree]) =>
    [revision, Object.entries(tree).filter(([name]) => serverFile(name)).map(([name, text]) => [name, runtimeSql(text)])]);
  const problems = [];
  for (const [file, source] of Object.entries(current)) {
    for (const drop of columnDrops(source)) {
      if (!file.startsWith(contractRoot) && !['corner_facts.owner_agent_id', 'github_star_prompts.reached_milestone'].includes(drop) &&
          (priorDrops.has(drop) || legacyDrops.includes(drop))) continue;
      const [table, column] = drop.split('.');
      for (const [revision, tree] of runtimeTrees) {
        const readers = tree.filter(([, sql]) => {
          return readsColumn(sql, table, column);
        }).map(([name]) => name);
        if (readers.length) problems.push(`${drop}: ${revision} still reads or writes it (${readers.join(', ')})`);
      }
      if (!file.startsWith(contractRoot)) problems.push(`${drop}: move the drop to ${contractRoot}; old Machines must drain first`);
    }
  }
  return [...new Set(problems)];
}

export function sourceTrees(previousRef) {
  if (!/^[A-Za-z0-9_./-]+$/.test(previousRef)) throw new Error('invalid previous release ref');
  const files = git('ls-files', 'apps/server/src', contractRoot).trim().split('\n').filter(Boolean);
  const previousFiles = git('ls-tree', '-r', '--name-only', previousRef, 'apps/server/src', contractRoot).trim().split('\n').filter(Boolean);
  const selected = previousFiles.filter(serverFile);
  const blobs = execFileSync('git', ['cat-file', '--batch'], {
    input: selected.map(f => `${previousRef}:${f}\n`).join(''), maxBuffer: 64 * 1024 * 1024,
  });
  let offset = 0;
  const previous = Object.fromEntries(selected.map(file => {
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString();
    const size = Number(header.split(' ')[2]);
    if (!Number.isSafeInteger(size)) throw new Error(`Cannot read previous source ${file}`);
    offset = end + 1;
    const text = blobs.subarray(offset, offset + size).toString();
    offset += size + 1;
    return [file, text];
  }));
  return {
    current: Object.fromEntries(files.filter(f => serverFile(f) || f.startsWith(contractRoot)).map(f => [f, readFileSync(f, 'utf8')])),
    previous,
  };
}

export function contractFiles() {
  try { return readdirSync(contractRoot).filter(f => f.endsWith('.sql')).sort().map(f => contractRoot + f); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function assertDrained(machines, image) {
  const tag = value => String(value ?? '').replace(/@sha256:[a-f0-9]+$/, '');
  if (!machines.length || machines.some(m => m.state !== 'started' || tag(m.config?.image ?? m.imageRef) !== tag(image)))
    throw new Error('contract migration refused: old or unready Machines remain');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const previous = process.argv[process.argv.indexOf('--previous') + 1];
  if (!process.argv.includes('--previous') || !previous) throw new Error('--previous is required');
  const trees = sourceTrees(previous);
  const problems = schemaProblems(trees.current, trees.previous);
  if (problems.length) throw new Error(problems.join('\n'));
  console.log('Rollout schema compatibility passed');
}
