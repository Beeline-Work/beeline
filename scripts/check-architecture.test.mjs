import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { judgeTree, readInvariants, relaxations, validateRules } from './architecture-invariants.mjs';
import { ownerApprovedRelaxation } from './check-architecture.mjs';

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

test('the owner record is read for the exact head only', async () => {
  const head = 'a'.repeat(40);
  const seen = [];
  const approve = async (url) => { seen.push(String(url)); return { ok: true, json: async () => ({ approved: true }) }; };
  assert.equal(await ownerApprovedRelaxation({ repository: 'Beeline-Work/beeline', pullRequest: '7', head }, approve), true);
  assert.match(seen[0], /\/v1\/public\/architecture-approvals\?repository=Beeline-Work%2Fbeeline&pullRequest=7&head=a{40}$/);
  assert.equal(await ownerApprovedRelaxation({ repository: 'Beeline-Work/beeline', pullRequest: '7', head: 'abc' }, approve), false);
  assert.equal(seen.length, 1);
  const refuse = async () => ({ ok: true, json: async () => ({ approved: false }) });
  assert.equal(await ownerApprovedRelaxation({ repository: 'r/r', pullRequest: '7', head }, refuse), false);
  const offline = async () => { throw new Error('offline'); };
  assert.equal(await ownerApprovedRelaxation({ repository: 'r/r', pullRequest: '7', head }, offline), false);
});

test('this repository meets its own invariants', () => {
  const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const invariants = readInvariants(root);
  assert.deepEqual(validateRules(invariants), []);
  assert.deepEqual(judgeTree(root, invariants), []);
});
