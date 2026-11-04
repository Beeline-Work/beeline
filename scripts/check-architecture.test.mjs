import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { judgeTree, readInvariants, relaxations, validateRules } from './architecture-invariants.mjs';
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
  assert.deepEqual(relaxations(root, base, { rules: [{ ...RULE, owners: [] }] }), []);
  assert.deepEqual(relaxations(root, base, { rules: [{ ...RULE, scope: ['src', 'new-src'] }] }), []);
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

const RUNNER = fileURLToPath(new URL('./check-architecture.mjs', import.meta.url));

function guardFixture() {
  const root = tree({ ...BASE, 'architecture/invariants.json': JSON.stringify({ rules: [RULE] }) });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Architecture test', '-c', 'user.email=architecture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'base');
  const run = () => spawnSync(process.execPath, [RUNNER, '--root', root, '--base', 'HEAD'], { encoding: 'utf8' });
  return { root, run, git };
}

test('a planted backdoor cannot be legalized by raising the candidate budget', () => {
  const { root, run } = guardFixture();
  writeFileSync(path.join(root, 'architecture/invariants.json'), JSON.stringify({ rules: [{ ...RULE, total: 2 }] }));
  writeFileSync(path.join(root, 'src/new.ts'), 'INSERT INTO agent_commands(id) VALUES(1)');
  const result = run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Architecture relaxation forbidden: rule work\.command-creation total raised from 1 to 2/);
});

test('owner, scope and pattern backdoors fail even when the candidate passes', () => {
  for (const change of [
    { owners: [...RULE.owners, 'src/mcp.ts'], total: 0 },
    { scope: [], total: 0 },
    { pattern: 'no_longer_catches_the_write', total: 0 },
  ]) {
    const { root, run } = guardFixture();
    writeFileSync(path.join(root, 'architecture/invariants.json'), JSON.stringify({ rules: [{ ...RULE, ...change }] }));
    const result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Architecture relaxation forbidden/);
  }
});

test('a missing trusted base cannot silently disable relaxation checking', () => {
  const { root } = guardFixture();
  const result = spawnSync(process.execPath, [RUNNER, '--root', root, '--base', 'missing-base'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
});

test('normal tightening passes the CLI check against base', () => {
  const { root, run } = guardFixture();
  writeFileSync(path.join(root, 'architecture/invariants.json'), JSON.stringify({ rules: [{ ...RULE, total: 0 }] }));
  writeFileSync(path.join(root, 'src/mcp.ts'), '');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Architecture check passed/);
});

test('candidate guard changes are reported separately from invariant relaxation', () => {
  const { root, run, git } = guardFixture();
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts/check-architecture.mjs'), '// base guard');
  git('add', '.');
  git('-c', 'user.name=Architecture test', '-c', 'user.email=architecture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'guard');
  writeFileSync(path.join(root, 'scripts/check-architecture.mjs'), '// changed guard');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Candidate architecture guard changed: scripts\/check-architecture\.mjs/);
});

test('this repository meets its own invariants', () => {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const invariants = readInvariants(root);
  assert.deepEqual(validateRules(invariants), []);
  assert.deepEqual(judgeTree(root, invariants), []);
  assert.deepEqual(judgeStorage(root, invariants.storage), []);
});

test('locked capability paths have zero budget and reject planted second owners', () => {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const { rules } = readInvariants(root);
  for (const [id, file, text] of [
    ['paths.phone-connection-owner', 'apps/mobile/sources/buzz/backdoor.ts', 'createTestLiveConnection({});'],
    ['paths.server-phone-socket-owner', 'apps/server/src/backdoor.ts', 'phoneSocketView(raw);'],
    ['paths.phone-server-read-owner', 'apps/mobile/sources/buzz/backdoor.ts', 'readServerSurface({}, "readChats", {});'],
  ]) {
    const rule = rules.find(rule => rule.id === id);
    assert.equal(rule.total, 0);
    assert.ok(judgeTree(tree({ [file]: text }), { rules: [rule] }).some(error => error.includes(id)));
  }
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

// The schema still exists during the switch-now / drop-next-release interval.
test('scheduled column drops exclude only those columns from unusedTotal', () => {
  const root = tree({
    'src/schema.ts': SCHEMA,
    'src/notes.ts': 'INSERT INTO notes(id) VALUES(1); SELECT id,created_at FROM notes;',
  });
  const storage = structuredClone(STORAGE);
  storage.tables.notes.columns.body = { reason: STORAGE.tables.notes.columns.body, drop: 'release 1.2.3' };
  assert.deepEqual(judgeStorage(root, storage), []);
  assert.deepEqual(storageRelaxations({ storage: STORAGE }, { storage }), []);
  delete storage.tables.notes.columns.body.drop;
  assert.match(judgeStorage(root, storage).join('\n'), /notes\.body has no writer/);
});

test('scheduled table drops exclude every column, retaining bootstrap accounting', () => {
  const root = tree({ 'src/schema.ts': SCHEMA });
  const storage = structuredClone(STORAGE);
  storage.tables.notes.drop = 'release 1.2.3';
  storage.tables.notes.columns.body = { reason: BOOTSTRAP_REASON, drop: 'release 1.2.3' };
  storage.bootstrapTotal = 1;
  assert.deepEqual(judgeStorage(root, storage), []);
  assert.deepEqual(storageRelaxations({ storage: { ...STORAGE, bootstrapTotal: 1 } }, { storage }), []);
  storage.bootstrapTotal = 0;
  assert.match(judgeStorage(root, storage).join('\n'), /new registry entr/);
});

test('drop metadata requires a non-empty reference and the original reason', () => {
  const root = tree({ 'src/schema.ts': SCHEMA });
  for (const drop of ['', '   ', true, 123]) {
    const storage = structuredClone(STORAGE);
    storage.tables.notes.drop = drop;
    storage.tables.notes.columns.body = { reason: STORAGE.tables.notes.columns.body, drop };
    const errors = judgeStorage(root, storage).join('\n');
    assert.match(errors, /table notes needs a non-empty "drop"/);
    assert.match(errors, /column notes\.body needs a non-empty "drop"/);
    assert.match(errors, /notes\.body has no writer/);
  }
  const storage = structuredClone(STORAGE);
  storage.tables.notes.drop = 'release 1.2.3';
  storage.tables.notes.columns.body = { drop: 'release 1.2.3' };
  assert.match(judgeStorage(root, storage).join('\n'), /column notes\.body needs a one-line reason/);
});

test('scheduling an already unused column for deletion requires lowering unusedTotal', () => {
  const root = tree({
    'src/schema.ts': SCHEMA,
    'src/notes.ts': 'INSERT INTO notes(id) VALUES(1); SELECT id,created_at FROM notes;',
  });
  const storage = structuredClone(STORAGE);
  storage.unusedTotal = 1;
  assert.deepEqual(judgeStorage(root, storage), []);
  storage.tables.notes.columns.body = { reason: STORAGE.tables.notes.columns.body, drop: 'release 1.2.3' };
  assert.match(judgeStorage(root, storage).join('\n'), /Lower "unusedTotal" from 1 to 0/);
  storage.unusedTotal = 0;
  assert.deepEqual(judgeStorage(root, storage), []);
  assert.deepEqual(storageRelaxations({ storage: { ...STORAGE, unusedTotal: 1 } }, { storage }), []);
});
