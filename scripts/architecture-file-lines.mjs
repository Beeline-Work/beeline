import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const sourceFile = /\.(?:ts|tsx|js|mjs)$/;
export const fileLineCount = source => source === '' ? 0 : source.split('\n').length - Number(source.endsWith('\n'));

export function validateFileLines(rule) {
  const errors = [];
  if (rule.limit !== 1000) errors.push('code.file-lines: limit must be 1000');
  if (JSON.stringify(rule.scope) !== JSON.stringify(['apps', 'packages', 'scripts', 'tools']))
    errors.push('code.file-lines: scope must cover apps, packages, scripts and tools');
  if (!Array.isArray(rule.generated) || new Set(rule.generated).size !== rule.generated.length ||
      rule.generated.some(file => typeof file !== 'string' || !sourceFile.test(file) || /[*?]/.test(file)))
    errors.push('code.file-lines: needs unique exact generated paths');
  return errors;
}

/** Use the index, including staged additions; test files have the same limit. */
export function judgeFileLines(root, rule) {
  const errors = [];
  const generated = new Set(rule.generated);
  const files = execFileSync('git', ['ls-files', '-z', '--', ...rule.scope], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(file => sourceFile.test(file) && !generated.has(file));
  for (const file of files) {
    let source;
    try { source = readFileSync(path.join(root, file), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const lines = fileLineCount(source);
    if (lines > rule.limit)
      errors.push(`[${rule.id}] ${file}: ${lines} lines exceeds ${rule.limit}. ${rule.fix}`);
  }
  return errors;
}

/** A later PR cannot relax the cap, its scope or generated exclusions. */
export function fileLineRelaxations(root, base, head, ref) {
  const was = base?.rules.find(rule => rule.kind === 'file-lines');
  if (!was) return [];
  const rule = head.rules.find(rule => rule.id === was.id);
  if (!rule) return ['file line rule removed'];
  const errors = [];
  for (const key of ['kind', 'scope', 'limit', 'generated'])
    if (JSON.stringify(was[key]) !== JSON.stringify(rule[key])) errors.push(`file line rule ${key} changed`);
  return errors;
}
