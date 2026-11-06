import ts from 'typescript';
// Architecture invariants: each rule says a sink (a SQL write, a notify, a
// timer) lives only in the files that own it. Sites outside those files are
// counted against the rule's `total`, a one-way ratchet for today's
// exceptions. The rules live in `architecture/invariants.json`.
//
// Candidate rules must hold. Rule changes, including higher totals and widened
// owner sets, are reported for weekly review after merging.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const INVARIANTS_PATH = 'architecture/invariants.json';
const SOURCE_FILE = /\.(ts|tsx|mjs|js)$/;
const SKIP_FILE = /\.(test|spec)\.[^.]+$|\.d\.ts$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__tests__', 'test-fixtures']);
const RULE_KEYS = ['id', 'module', 'invariant', 'pattern', 'scope', 'owners', 'total', 'fix'];
/** Fields whose change moves what a rule catches; any change to them is a relaxation. */
const BOUNDARY_KEYS = ['pattern', 'flags', 'scope', 'owners', 'distinct', 'ownerFunctions', 'ownerSites', 'strict', 'filePattern', 'insertColumnValue'];

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

/** Split SQL expressions without treating nested calls, quoted values or
 * template interpolations as column separators. Unknown expressions fail closed.
 */
function sqlItems(source) {
  const items=[];let start=0,depth=0,index=0;
  while(index<source.length) {
    const char=source[index];
    if(source.startsWith('${',index)) {
      let braces=1;index+=2;
      while(index<source.length&&braces) {if(source[index]==='{')braces++;if(source[index]==='}')braces--;index++;}
      continue;
    }
    if(char==="'"||char==='"') {
      const quote=char;index++;
      while(index<source.length) {
        if(source[index++]===quote) {if(source[index]===quote)index++;else break;}
      }
      continue;
    }
    if(char==='(')depth++;
    if(char===')') {if(!depth)break;depth--;}
    if(!depth&&(char===';'||char==='`'||(!index||!/[\w]/.test(source[index-1]))&&/^(?:FROM|ON|RETURNING)\b/i.test(source.slice(index))))break;
    if(!depth&&char===',') {items.push(source.slice(start,index).trim());start=index+1;}
    index++;
  }
  items.push(source.slice(start,index).trim());items.end=index;return items;
}

/** Find another top-level SELECT arm before this INSERT's enclosing query ends. */
function unionSelectTail(source) {
  let depth=0,index=0;
  while(index<source.length) {
    const char=source[index];
    if(char==="'"||char==='"') {
      const quote=char;index++;
      while(index<source.length) {if(source[index++]===quote) {if(source[index]===quote)index++;else break;}}
      continue;
    }
    if(char==='(')depth++;
    if(char===')') {if(!depth)return;depth--;}
    if(!depth) {
      if(char===';'||char==='`')return;
      const next=/^UNION(?:\s+ALL)?\s+SELECT\s+/i.exec(source.slice(index));
      if(next)return source.slice(index+next[0].length);
    }
    index++;
  }
}

function hasLiteralInsertValue(source, match, contract) {
  const columns=sqlItems(match[0].slice(match[0].indexOf('(')+1));
  const ordinal=columns.findIndex(column=>column.replaceAll('"','').toLowerCase()===contract.column);
  if (ordinal<0) return false;
  let tail=source.slice(match.index+match[0].length);
  while (true) {
    const values=sqlItems(tail);
    if (values[ordinal]!==contract.value) return false;
    tail=tail.slice(values.end);
    if (/VALUES\s*\($/i.test(match[0])) {
      const next=/^\)\s*,\s*\(/.exec(tail);
      if (!next) return true;
      tail=tail.slice(next[0].length);
    } else {
      const next=unionSelectTail(tail);
      if (next===undefined) return true;
      tail=next;
    }
  }
}

/** Every match of a rule outside its owner files, as `file:line`. */
function findSites(root, rule) {
  const files = [];
  for (const scope of rule.scope) walk(root, scope, files);
  const owners = new Set(rule.owners);
  const sites = [];
  const named = new Map();
  for (const file of files.sort()) {
    if (rule.filePattern && !new RegExp(rule.filePattern).test(file)) continue;
    if (owners.has(file) && !rule.ownerFunctions) continue;
    const source = readFileSync(path.join(root, file), 'utf8');
    const pattern = new RegExp(rule.pattern, `g${rule.flags ?? ''}`);
    const parsed = owners.has(file) && rule.ownerFunctions ? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true) : undefined;
    for (const match of source.matchAll(pattern)) {
      if(rule.insertColumnValue&&hasLiteralInsertValue(source,match,rule.insertColumnValue))continue;
      const site = `${file}:${source.slice(0, match.index).split('\n').length}`;
      if (owners.has(file) && rule.ownerFunctions) {
        let enclosing;
        const visit = node => {
          if (node.pos > match.index || node.end <= match.index) return;
          if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
              (ts.isVariableDeclaration(node) && node.initializer &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) && node.name)
            enclosing = node.name.getText(parsed);
          else if (!enclosing && ts.isVariableDeclaration(node) && node.name)
            enclosing = node.name.getText(parsed);
          ts.forEachChild(node, visit);
        };
        visit(parsed);
        if ((rule.ownerFunctions[file] ?? []).includes(enclosing)) continue;
      }
      // A `distinct` rule counts different matches (say, setting names), not uses.
      if (!rule.distinct) sites.push(site);
      else if (!named.has(match[0])) named.set(match[0], `${match[0]} (first at ${site})`);
    }
  }
  return rule.distinct ? [...named.values()] : sites;
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
    if (rule.strict && rule.total !== 0) errors.push(`${INVARIANTS_PATH}: strict rule ${name} must have zero allowance`);
    if (!Number.isInteger(rule.total) || rule.total < 0)
      errors.push(`${INVARIANTS_PATH}: rule ${name} total must be a whole number`);
    try {
      new RegExp(rule.pattern, rule.flags ?? '');
      if (rule.filePattern) new RegExp(rule.filePattern);
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
    if (rule.ownerSites !== undefined) {
      const all = findSites(root, { ...rule, owners: [], ownerFunctions: undefined });
      if (all.length - sites.length !== rule.ownerSites)
        errors.push(`[${rule.id}] expected exactly ${rule.ownerSites} owned sink(s), found ${all.length - sites.length}. ${rule.fix}`);
    }
    if (sites.length > rule.total)
      errors.push([
        `[${rule.id}] ${rule.invariant}`,
        `  Found ${sites.length} site(s) outside ${rule.owners.join(', ') || 'any owner file'}; at most ${rule.total} are allowed:`,
        ...sites.map((site) => `    ${site}`),
        `  Fix: ${rule.fix}`,
        '  Moving an existing site between files is fine. Update the declared invariant for an intentional change; the owner reviews rule changes weekly.',
      ].join('\n'));
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

function tighterBoundary(key, before, after) {
  if (key === 'ownerSites') return Number.isInteger(after) && after < before;
  if (key === 'owners') return after.every(owner => before.includes(owner));
  if (key === 'ownerFunctions' && before && after)
    return Object.entries(after).every(([file, names]) => names.every(name => before[file]?.includes(name)));
  return false;
}

/** A capability may move only with its complete, unchanged function bodies.
 * Counts and every matching boundary remain frozen; there is no relocation list. */
function unchangedOwners(root, before, after, readBase) {
  if (!readBase || !Number.isInteger(before.ownerSites) || !before.ownerFunctions || !after.ownerFunctions ||
      before.owners.length !== after.owners.length || before.ownerSites !== after.ownerSites) return false;
  const bodies = (rule, read) => {
    const result = [];
    const printer = ts.createPrinter({ removeComments: true });
    for (const [file, names] of Object.entries(rule.ownerFunctions)) {
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      for (const name of names) {
        const matches = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body);
        if (matches.length !== 1) throw new Error('owner is not one named function');
        result.push(printer.printNode(ts.EmitHint.Unspecified, matches[0].body, source));
      }
    }
    return result.sort();
  };
  try { return JSON.stringify(bodies(before, readBase)) === JSON.stringify(bodies(after, file => readFileSync(path.join(root, file), 'utf8'))); }
  catch { return false; }
}

/** Strict capability owners cannot be weakened through a candidate-rule edit. */
export function strictRelaxations(root, base, head, readBase) {
  if (!base) return [];
  const current = new Map(head.rules.map(rule => [rule.id, rule]));
  const found = [];
  for (const was of base.rules.filter(rule => rule.strict)) {
    const rule = current.get(was.id);
    if (!rule) { found.push(`rule ${was.id} removed`); continue; }
    if (rule.total > was.total) found.push(`rule ${was.id} allowance increased`);
    const relocated = unchangedOwners(root, was, rule, readBase);
    for (const key of BOUNDARY_KEYS)
      if (!(relocated && ['owners','ownerFunctions'].includes(key)) &&
          JSON.stringify(rule[key] ?? null) !== JSON.stringify(was[key] ?? null) && !tighterBoundary(key, was[key], rule[key]))
        found.push(`rule ${was.id} ${key} changed`);
  }
  return found;
}
