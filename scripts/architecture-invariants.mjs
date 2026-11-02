// Architecture invariants: each rule says a sink (a SQL write, a notify, a
// timer) lives only in the files that own it. Sites outside those files are
// counted against the rule's `total`, a one-way ratchet for today's
// exceptions. The rules live in `architecture/invariants.json`.
//
// Tightening a rule (a lower total, a new rule) needs no review. Relaxing one
// (a higher total, a removed rule, a changed pattern/scope/owners) needs the
// owner's yes on the exact PR head; `check-architecture.mjs` reads that record.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const INVARIANTS_PATH = 'architecture/invariants.json';
const SOURCE_FILE = /\.(ts|tsx|mjs|js)$/;
const SKIP_FILE = /\.(test|spec)\.[^.]+$|\.d\.ts$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__tests__', 'test-fixtures']);
const RULE_KEYS = ['id', 'module', 'invariant', 'pattern', 'scope', 'owners', 'total', 'fix'];
/** Fields whose change moves what a rule catches; any change to them is a relaxation. */
const BOUNDARY_KEYS = ['pattern', 'flags', 'scope', 'owners'];

export function readInvariants(root) {
  return JSON.parse(readFileSync(path.join(root, INVARIANTS_PATH), 'utf8'));
}

export function invariantsAtRef(root, ref) {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${INVARIANTS_PATH}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return undefined; // the file did not exist at base: this is the change that adds it
  }
}

function walk(root, relative, out) {
  let entries;
  try {
    entries = readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, child, out);
    } else if (SOURCE_FILE.test(entry.name) && !SKIP_FILE.test(entry.name)) out.push(child);
  }
}

/** Every match of a rule outside its owner files, as `file:line`. */
function findSites(root, rule) {
  const files = [];
  for (const scope of rule.scope) walk(root, scope, files);
  const owners = new Set(rule.owners);
  const sites = [];
  for (const file of files.sort()) {
    if (owners.has(file)) continue;
    const source = readFileSync(path.join(root, file), 'utf8');
    const pattern = new RegExp(rule.pattern, `g${rule.flags ?? ''}`);
    for (const match of source.matchAll(pattern))
      sites.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
  }
  return sites;
}

export function validateRules(invariants) {
  const errors = [];
  const ids = new Set();
  for (const rule of invariants.rules ?? []) {
    const name = rule.id ?? '(no id)';
    for (const key of RULE_KEYS)
      if (rule[key] === undefined) errors.push(`${INVARIANTS_PATH}: rule ${name} needs "${key}"`);
    if (ids.has(rule.id)) errors.push(`${INVARIANTS_PATH}: rule ${name} is listed twice`);
    ids.add(rule.id);
    if (!Number.isInteger(rule.total) || rule.total < 0)
      errors.push(`${INVARIANTS_PATH}: rule ${name} total must be a whole number`);
    try {
      new RegExp(rule.pattern, rule.flags ?? '');
    } catch (error) {
      errors.push(`${INVARIANTS_PATH}: rule ${name} pattern is invalid: ${error.message}`);
    }
  }
  return errors;
}

/** Rule violations in the tree, each with the one way to comply. */
export function judgeTree(root, invariants) {
  const errors = [];
  for (const rule of invariants.rules) {
    const sites = findSites(root, rule);
    if (sites.length > rule.total)
      errors.push([
        `[${rule.id}] ${rule.invariant}`,
        `  Found ${sites.length} site(s) outside ${rule.owners.join(', ') || 'any owner file'}; at most ${rule.total} are allowed:`,
        ...sites.map((site) => `    ${site}`),
        `  Fix: ${rule.fix}`,
        '  Moving an existing site between files is fine. Raising the total needs the owner\'s yes on this PR head.',
      ].join('\n'));
    else if (sites.length < rule.total)
      errors.push(`[${rule.id}] only ${sites.length} site(s) remain outside the owner files. Lower "total" from ${rule.total} to ${sites.length} in ${INVARIANTS_PATH}; tightening needs no review.`);
  }
  return errors;
}

/** How the PR's rules are weaker than the base rules. Empty means none. */
export function relaxations(root, base, head) {
  if (!base) return [];
  const found = [];
  const current = new Map(head.rules.map((rule) => [rule.id, rule]));
  for (const was of base.rules) {
    const rule = current.get(was.id);
    if (!rule) {
      // A rule whose pattern no longer matches anything in its scope is dead.
      if (findSites(root, { ...was, owners: [] }).length) found.push(`rule ${was.id} removed`);
      continue;
    }
    if (rule.total > was.total) found.push(`rule ${was.id} total raised from ${was.total} to ${rule.total}`);
    for (const key of BOUNDARY_KEYS)
      if (JSON.stringify(rule[key] ?? null) !== JSON.stringify(was[key] ?? null))
        found.push(`rule ${was.id} ${key} changed`);
  }
  return found;
}
