// Run with node --import tsx. This is a strict audit gate, deliberately outside
// the ordinary regression suite: a nonzero exit preserves an OPEN finding.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { BackgroundWork } from '../apps/server/src/background-work.ts';
import { runMaintenance } from '../apps/server/src/background.ts';
import { NextDayCheckin } from '../apps/server/src/next-day-checkin.ts';
import { groupBPostgresDatabase } from '../apps/server/src/test-fixtures/test-support-router-group-b-postgres.ts';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
assert.ok(url, 'BEELINE_COMMAND_TEST_POSTGRES_URL must name isolated loopback PostgreSQL');
const source = readFileSync(new URL('../apps/server/src/index.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const recurring = [];
function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(tree) === 'work' && node.expression.name.text === 'add') {
    const [name, interval] = node.arguments;
    assert.ok(name && ts.isStringLiteral(name));
    recurring.push({ name: name.text, interval: interval.getText(tree),
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
  }
  ts.forEachChild(node, visit);
}
visit(tree);
const failures = [];
const inventory = JSON.parse(readFileSync(new URL('../data/network-ops-fixes/group-b-recurring-inventory.json', import.meta.url), 'utf8'));
assert.equal(inventory.entries.filter(entry => entry.id.startsWith('D1-')).length, 55);
assert.equal(inventory.entries.filter(entry => entry.id.startsWith('D2-')).length, 6);
assert.equal(new Set(inventory.entries.map(entry => entry.mechanism)).size, 61);
assert.equal(inventory.repairSuboperations.length, 18);
for (const entry of [...inventory.entries, ...inventory.repairSuboperations]) {
  assert.ok(existsSync(new URL(`../${entry.proof}`, import.meta.url)), `Missing proof ${entry.proof}`);
  if (entry.implementation) assert.ok(existsSync(new URL(`../${entry.implementation}`, import.meta.url)));
  if (entry.disposition === 'open') failures.push(`F22 ${entry.mechanism}: ${entry.boundary ?? entry.owner}`);
}
const evidence = { schema: 'router-group-b-open-proof.v1', postgres: true,
  inventory: { auditSha256: inventory.auditSha256, mechanisms: inventory.entries.length, repairSuboperations: inventory.repairSuboperations.length },
  recurring, observations: [] };
const fixture = await groupBPostgresDatabase(url);
try {
  // The actual production registration supplies admission and the actual
  // business implementation supplies SQL. Do not run free-agent/provider
  // lifecycle behavior, and do not synthesize a passing empty job callback.
  const implementations = {
    repair: db => runMaintenance(db),
    'next-day-checkin': db => new NextDayCheckin(db, 'http://127.0.0.1', async () => {
      throw new Error('An empty proof must never send email');
    }).runOnce(),
  };
  for (const [name, run] of Object.entries(implementations)) {
    const registration = recurring.find(item => item.name === name);
    if (!registration) continue;
    assert.equal(registration.interval, 'reconciliationMs');
    assert.match(source, /const reconciliationMs\s*=\s*60_000/);
    let elapsed = 0;
    const statements = [];
    const db = {
      query: (sql, values) => { statements.push(sql); return fixture.database.query(sql, values); },
      transaction: work => fixture.database.transaction(work),
    };
    const work = new BackgroundWork(() => elapsed, () => {});
    work.add(name, 60_000, async () => { await run(db); });
    await work.run(true);
    statements.length = 0;
    elapsed = 60_000;
    await work.run(false);
    evidence.observations.push({ name, elapsedMs: elapsed, statements: statements.length,
      sql: statements.map(sql => sql.replace(/\s+/g, ' ').trim()) });
    try { assert.equal(statements.length, 0, `${name}: settled idle observations must be zero`); }
    catch (error) { failures.push(error.message); }
  }
  for (const registration of recurring)
    failures.push(`F16/F17/F22: ${registration.name} still has an interval registration at apps/server/src/index.ts:${registration.line} (${registration.interval})`);
} finally { await fixture.close(); }
console.log(JSON.stringify({ ...evidence, failures }, null, 2));
if (failures.length) process.exitCode = 1;
