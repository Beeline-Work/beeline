// Storage registry checks (`storage` in architecture/invariants.json).
//
// Every table, column and jsonb key the server stores is registered with its
// owner module and a one-line reason it cannot be derived. The exact schema is
// compared with the registry by apps/server/src/storage-registry.test.ts, which
// runs the real migrations. This file checks what source text can show:
//   - every registered column has a writer and a reader in non-test code;
//   - every jsonb key read in SQL (`col->>'key'`, `col->'key'`, `col ? 'key'`)
//     is registered under that column;
//   - new entries carry a real reason, not the bootstrap text.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const BOOTSTRAP_REASON = 'existing before the registry; weekly audit reviews';
const scheduledDrop = (entry) => typeof entry?.drop === 'string' && entry.drop.trim().length > 0;
const SOURCE_FILE = /\.(ts|mjs|js)$/;
const SKIP_FILE = /\.(test|spec)\.[^.]+$|\.d\.ts$|test-support\.ts$|-fixture\.ts$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__tests__', 'test-fixtures']);

function sources(root, scope) {
  const files = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(child);
      } else if (SOURCE_FILE.test(entry.name) && !SKIP_FILE.test(entry.name)) files.push(child);
    }
  };
  for (const start of scope) walk(start);
  return files.sort().map((file) => ({ file, text: readFileSync(path.join(root, file), 'utf8') }));
}

const word = (name) => new RegExp(`(?<![\\w.$])${name}(?!\\w)`, 'g');
const countWord = (text, name) => (text.match(word(name)) ?? []).length;

/** The body of a parenthesised list starting at `open`. */
function parenthesised(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && --depth === 0) return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
}

/** Column definitions per table, and the text with every DDL statement removed. */
function splitDdl(text) {
  const definitions = [];
  let rest = text.replace(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi, (match, table, offset) => {
    definitions.push({ table, body: parenthesised(text, offset + match.length - 1) });
    return match;
  });
  for (const { body } of definitions) rest = rest.replace(body, '');
  rest = rest.replace(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(\w+)([^;`]*)/gi, (match, table, body) => {
    definitions.push({ table, body: body.replace(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi, ',') });
    return '';
  });
  rest = rest.replace(/CREATE\s+(?:UNIQUE\s+)?INDEX[^;`]*/gi, '');
  return { definitions, rest };
}

/** Writer and reader evidence for every registered column. */
function columnEvidence(root, storage) {
  const tables = storage.tables ?? {};
  const evidence = new Map();
  const at = (table, column) => {
    const key = `${table}.${column}`;
    if (!evidence.has(key)) evidence.set(key, { writes: 0, defaults: 0, mentions: 0 });
    return evidence.get(key);
  };
  for (const { text } of sources(root, storage.scope)) {
    const { definitions, rest } = splitDdl(text);
    for (const { table, body } of definitions) {
      if (!tables[table]) continue;
      for (const column of Object.keys(tables[table].columns)) {
        const definition = body.match(new RegExp(`(?:^|[,(\\s])${column}\\s+([^,]*)`, 'i'));
        if (definition && /\b(DEFAULT|GENERATED|BIGSERIAL|SERIAL)\b/i.test(definition[1])) at(table, column).defaults += 1;
      }
    }
    for (const match of rest.matchAll(/INSERT\s+INTO\s+(\w+)(?:\s+AS\s+\w+)?\s*\(/gi)) {
      const table = tables[match[1]];
      if (!table) continue;
      const list = parenthesised(rest, match.index + match[0].length - 1);
      for (const column of Object.keys(table.columns))
        if (countWord(list, column)) at(match[1], column).writes += 1;
    }
    for (const match of rest.matchAll(/UPDATE\s+(\w+)(?:\s+(?!SET\b)\w+)?\s+SET\b([\s\S]*?)(?=\bWHERE\b|\bFROM\b|\bRETURNING\b|`|$)/gi)) {
      const table = tables[match[1]];
      if (!table) continue;
      for (const column of Object.keys(table.columns))
        if (new RegExp(`(?<![\\w.])${column}\\s*=`).test(match[2])) at(match[1], column).writes += 1;
    }
    const tokens = new Map();
    for (const token of rest.match(/[A-Za-z_]\w*/g) ?? []) tokens.set(token, (tokens.get(token) ?? 0) + 1);
    for (const [name, table] of Object.entries(tables))
      for (const column of Object.keys(table.columns)) {
        const mentions = tokens.get(column);
        if (mentions) at(name, column).mentions += mentions;
      }
  }
  return evidence;
}

/** Registered columns with no writer, or with no mention beyond their writes. */
function unusedColumns(root, storage) {
  const evidence = columnEvidence(root, storage);
  const unused = [];
  for (const [table, entry] of Object.entries(storage.tables ?? {}))
    for (const [column, definition] of Object.entries(entry.columns)) {
      if (scheduledDrop(entry) || scheduledDrop(definition)) continue;
      const seen = evidence.get(`${table}.${column}`) ?? { writes: 0, defaults: 0, mentions: 0 };
      // A column default is a writer; its DDL is not a mention.
      if (!seen.writes && !seen.defaults) unused.push(`${table}.${column} has no writer`);
      else if (seen.mentions <= seen.writes) unused.push(`${table}.${column} has no reader`);
    }
  return unused;
}

/** Every jsonb key read in SQL, keyed `column.key`, with its sites. */
function jsonbKeyReads(root, storage) {
  const columns = new Set(Object.keys(storage.jsonb ?? {}));
  const reads = new Map();
  for (const { file, text } of sources(root, storage.scope))
    for (const match of text.matchAll(/(?<![\w.])(\w+)\s*(?:->>|->|\?)\s*'([A-Za-z_][\w-]*)'/g)) {
      if (!columns.has(match[1])) continue;
      const key = `${match[1]}.${match[2]}`;
      if (!reads.has(key)) reads.set(key, []);
      reads.get(key).push(`${file}:${text.slice(0, match.index).split('\n').length}`);
    }
  return reads;
}

/** Problems with the registry against the tree, each with its fix. */
export function judgeStorage(root, storage) {
  if (!storage) return [];
  const errors = [];
  let bootstrap = 0;
  const entries = [];
  for (const [table, entry] of Object.entries(storage.tables ?? {})) {
    entries.push([`table ${table}`, entry]);
    if (typeof entry.module !== 'string' || !entry.module) errors.push(`[storage] table ${table} needs an owner "module"`);
    for (const [column, reason] of Object.entries(entry.columns ?? {})) entries.push([`column ${table}.${column}`, reason]);
  }
  for (const [column, keys] of Object.entries(storage.jsonb ?? {}))
    for (const [key, reason] of Object.entries(keys)) entries.push([`jsonb key ${column}.${key}`, reason]);
  for (const [name, entry] of entries) {
    const reason = typeof entry === 'string' ? entry : entry?.reason;
    if (entry && typeof entry === 'object' && 'drop' in entry && !scheduledDrop(entry))
      errors.push(`[storage] ${name} needs a non-empty "drop" reference to the PR or release that will delete it.`);
    if (reason === BOOTSTRAP_REASON) bootstrap += 1;
    else if (typeof reason !== 'string' || reason.trim().length < 10)
      errors.push(`[storage] ${name} needs a one-line reason it cannot be derived from other stored facts.`);
  }
  if (bootstrap > storage.bootstrapTotal)
    errors.push(`[storage] ${bootstrap - storage.bootstrapTotal} new registry entr(y/ies) use the bootstrap reason. Give each new table, column or jsonb key its own one-line reason it cannot be derived, or derive it instead of storing it.`);
  else if (bootstrap < storage.bootstrapTotal)
    errors.push(`[storage] Lower "bootstrapTotal" from ${storage.bootstrapTotal} to ${bootstrap} in architecture/invariants.json; tightening needs no review.`);
  for (const [key, sites] of jsonbKeyReads(root, storage)) {
    const [column, name] = key.split('.');
    if (!(name in storage.jsonb[column]))
      errors.push(`[storage] jsonb key ${key} is read at ${sites.join(', ')} but not registered. Add "${name}" under storage.jsonb.${column} with a one-line reason it cannot be derived, or derive it instead of storing it.`);
  }
  const unused = unusedColumns(root, storage);
  if (unused.length > storage.unusedTotal)
    errors.push([
      `[storage] ${unused.length} registered column(s) lack a writer or a reader in non-test code; at most ${storage.unusedTotal} are allowed:`,
      ...unused.map((item) => `    ${item}`),
      '  Fix: write and read the new column in server code, or do not store it (derive it). Tests alone do not count.',
    ].join('\n'));
  else if (unused.length < storage.unusedTotal)
    errors.push(`[storage] Lower "unusedTotal" from ${storage.unusedTotal} to ${unused.length} in architecture/invariants.json; tightening needs no review.`);
  return errors;
}

/** Ways the PR's storage rules are weaker than base. Adding entries is never one. */
export function storageRelaxations(base, head) {
  if (!base?.storage) return [];
  const found = [];
  if (!head.storage) return ['storage registry removed'];
  for (const key of ['bootstrapTotal', 'unusedTotal'])
    if (head.storage[key] > base.storage[key]) found.push(`storage ${key} raised from ${base.storage[key]} to ${head.storage[key]}`);
  if (JSON.stringify(head.storage.scope) !== JSON.stringify(base.storage.scope)) found.push('storage scope changed');
  return found;
}
