import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { judgeTree, readInvariants, relaxations, validateRules } from './architecture-invariants.mjs';
import { ownerApprovedRelaxation } from './check-architecture.mjs';
import { BOOTSTRAP_REASON, judgeStorage, storageRelaxations } from './architecture-storage.mjs';

const RULE = {
  id: 'work.command-creation', module: 'Work authority', invariant: 'Commands come from createAgentCommand.',
  pattern: 'INSERT\\s+INTO\\s+agent_commands\\b', flags: 'i', scope: ['src'], owners: ['src/agent-command.ts'],
  total: 1, fix: 'Call createAgentCommand.',
};

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'architecture-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

const BASE = {
  'src/agent-command.ts': 'db.query(`INSERT INTO agent_commands(id) VALUES($1)`);',
  'src/mcp.ts': 'db.query(`insert into\n  agent_commands(id) VALUES($1)`);',
  'src/mcp.test.ts': 'db.query(`INSERT INTO agent_commands(id) VALUES($1)`);',
};

test('owner files and tests are free; one existing exception fits the total', () => {
  assert.deepEqual(judgeTree(tree(BASE), { rules: [RULE] }), []);
});

test('a new site names the rule, every site and the one fix', () => {
  const [error] = judgeTree(tree({ ...BASE, 'src/new.ts': 'INSERT INTO agent_commands(id) VALUES(1)' }), { rules: [RULE] });
  assert.match(error, /\[work\.command-creation\]/);
  assert.match(error, /src\/mcp\.ts:1/);
  assert.match(error, /src\/new\.ts:1/);
  assert.match(error, /Fix: Call createAgentCommand\./);
});

test('moving a site between files keeps the total and passes', () => {
  const moved = { ...BASE, 'src/mcp.ts': '', 'src/other.ts': 'INSERT INTO agent_commands(id) VALUES(1)' };
  assert.deepEqual(judgeTree(tree(moved), { rules: [RULE] }), []);
});

test('a removed site asks for the lower total', () => {
  const [error] = judgeTree(tree({ ...BASE, 'src/mcp.ts': '' }), { rules: [RULE] });
  assert.match(error, /Lower "total" from 1 to 0/);
});

test('tightening is not a relaxation', () => {
  const root = tree(BASE);
  const base = { rules: [RULE] };
  assert.deepEqual(relaxations(root, base, { rules: [{ ...RULE, total: 0 }] }), []);
  assert.deepEqual(relaxations(root, base, { rules: [RULE, { ...RULE, id: 'new.rule' }] }), []);
  assert.deepEqual(relaxations(root, base, { rules: [{ ...RULE, fix: 'Reworded fix.' }] }), []);
  assert.deepEqual(relaxations(root, undefined, { rules: [] }), []);
});

test('raising a total, widening owners or removing a live rule is a relaxation', () => {
  const root = tree(BASE);
  const base = { rules: [RULE] };
  assert.deepEqual(relaxations(root, base, { rules: [{ ...RULE, total: 2 }] }), ['rule work.command-creation total raised from 1 to 2']);
  assert.deepEqual(relaxations(root, base, { rules: [{ ...RULE, owners: [...RULE.owners, 'src/mcp.ts'] }] }), ['rule work.command-creation owners changed']);
  assert.deepEqual(relaxations(root, base, { rules: [{ ...RULE, pattern: 'nothing' }] }), ['rule work.command-creation pattern changed']);
  assert.deepEqual(relaxations(root, base, { rules: [] }), ['rule work.command-creation removed']);
});

test('removing a rule whose pattern matches nothing is not a relaxation', () => {
  const root = tree({ 'src/agent-command.ts': '' });
  assert.deepEqual(relaxations(root, { rules: [RULE] }, { rules: [] }), []);
});

test('rules must be complete and valid', () => {
  const errors = validateRules({ rules: [{ ...RULE, fix: undefined }, { ...RULE, pattern: '(' }, RULE] });
  assert.ok(errors.some((error) => error.includes('needs "fix"')));
  assert.ok(errors.some((error) => error.includes('pattern is invalid')));
  assert.ok(errors.some((error) => error.includes('listed twice')));
});

test('only the owner\'s APPROVED review on the exact head counts', async () => {
  const head = 'a'.repeat(40);
  const pr = { repository: 'Beeline-Work/beeline', pullRequest: '7', head, token: 't' };
  const seen = [];
  const reviews = (list) => async (url, init) => { seen.push({ url: String(url), auth: init.headers.Authorization }); return { ok: true, json: async () => list }; };
  const review = (fields) => ({ id: 1, state: 'APPROVED', user: { login: 'lunchboxfortwo' }, commit_id: head, submitted_at: 'now', ...fields });
  assert.equal(await ownerApprovedRelaxation(pr, reviews([review({})])), true);
  assert.equal(seen[0].url, 'https://api.github.com/repos/Beeline-Work/beeline/pulls/7/reviews?per_page=100&page=1');
  assert.equal(seen[0].auth, 'Bearer t');
  assert.equal(await ownerApprovedRelaxation(pr, reviews([review({ commit_id: 'b'.repeat(40) })])), false, 'older head');
  assert.equal(await ownerApprovedRelaxation(pr, reviews([review({ user: { login: 'someone' } })])), false, 'not the owner');
  assert.equal(await ownerApprovedRelaxation(pr, reviews([review({ state: 'COMMENTED' }), review({ state: 'DISMISSED' })])), false, 'not approved');
  const before = seen.length;
  assert.equal(await ownerApprovedRelaxation({ ...pr, head: 'abc' }, reviews([review({})])), false, 'short head');
  assert.equal(await ownerApprovedRelaxation({ ...pr, pullRequest: '' }, reviews([review({})])), false, 'push, no PR');
  assert.equal(seen.length, before, 'no request without an exact PR and head');
  assert.equal(await ownerApprovedRelaxation(pr, async () => ({ ok: false })), false);
  assert.equal(await ownerApprovedRelaxation(pr, async () => { throw new Error('offline'); }), false);
});

test('this repository meets its own invariants', () => {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const invariants = readInvariants(root);
  assert.deepEqual(validateRules(invariants), []);
  assert.deepEqual(judgeTree(root, invariants), []);
  assert.deepEqual(judgeStorage(root, invariants.storage), []);
});

test('a distinct rule counts different names, not uses', () => {
  const rule = { ...RULE, id: 'settings.server-env', pattern: 'process\\.env\\.[A-Z_]+', flags: '', distinct: true, owners: [], total: 1 };
  const root = tree({ 'src/a.ts': 'process.env.PORT; process.env.PORT;', 'src/b.ts': 'process.env.PORT' });
  assert.deepEqual(judgeTree(root, { rules: [rule] }), []);
  const [error] = judgeTree(tree({ 'src/a.ts': 'process.env.PORT', 'src/b.ts': 'process.env.NEW_FLAG' }), { rules: [rule] });
  assert.match(error, /process\.env\.NEW_FLAG \(first at src\/b\.ts:1\)/);
});

const STORAGE = {
  scope: ['src'], bootstrapTotal: 0, unusedTotal: 0,
  tables: { notes: { module: 'Notes', reason: 'A note is what a person wrote.', columns: {
    id: 'The note key.', body: 'What the person wrote.', created_at: 'When it was written.' } } },
  jsonb: { meta: { tone: 'The tone the writer picked.' } },
};
const SCHEMA = 'CREATE TABLE IF NOT EXISTS notes (id text PRIMARY KEY, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());';

test('registered storage with a writer and a reader passes', () => {
  const root = tree({
    'src/schema.ts': `export const S = \`${SCHEMA}\`;`,
    'src/notes.ts': "db.query(`INSERT INTO notes(id,body) VALUES($1,$2)`); db.query(`SELECT id,body,created_at FROM notes WHERE meta->>'tone'='x'`);",
  });
  assert.deepEqual(judgeStorage(root, STORAGE), []);
});

test('a column only written, or only read, fails with the fix', () => {
  const root = tree({
    'src/schema.ts': `export const S = \`${SCHEMA}\`;`,
    'src/notes.ts': 'db.query(`INSERT INTO notes(id,body) VALUES($1,$2)`); db.query(`SELECT id FROM notes`);',
    'src/notes.test.ts': 'db.query(`SELECT body,created_at FROM notes`);',
  });
  const [error] = judgeStorage(root, STORAGE);
  assert.match(error, /notes\.body has no reader/);
  assert.match(error, /notes\.created_at has no reader/);
  assert.match(error, /Tests alone do not count/);
});

test('an unregistered jsonb key read and a bootstrap reason on a new entry fail', () => {
  const root = tree({
    'src/schema.ts': `export const S = \`${SCHEMA}\`;`,
    'src/notes.ts': "db.query(`INSERT INTO notes(id,body) VALUES($1,$2)`); db.query(`SELECT id,body,created_at FROM notes WHERE meta->>'mood'='x'`);",
  });
  const storage = { ...STORAGE, tables: { notes: { ...STORAGE.tables.notes, columns: { ...STORAGE.tables.notes.columns, id: BOOTSTRAP_REASON } } } };
  const errors = judgeStorage(root, storage);
  assert.ok(errors.some((error) => /jsonb key meta\.mood is read at src\/notes\.ts:1 but not registered/.test(error)));
  assert.ok(errors.some((error) => /1 new registry entr\(y\/ies\) use the bootstrap reason/.test(error)));
});

test('raising a storage total is a relaxation; adding entries is not', () => {
  const base = { rules: [], storage: STORAGE };
  assert.deepEqual(storageRelaxations(base, { rules: [], storage: { ...STORAGE, unusedTotal: 3 } }), ['storage unusedTotal raised from 0 to 3']);
  const added = { ...STORAGE, tables: { ...STORAGE.tables, more: { module: 'Notes', reason: 'Another fact.', columns: {} } } };
  assert.deepEqual(storageRelaxations(base, { rules: [], storage: added }), []);
});
