import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { assertDrained, columnDrops, contractFiles, schemaProblems } from './rollout-schema.mjs';

const arg = flag => process.argv[process.argv.indexOf(flag) + 1];
for (const flag of ['--machines', '--version', '--sha', '--trees'])
  if (!process.argv.includes(flag) || !arg(flag)) throw new Error(`${flag} is required`);
await assertDrained(JSON.parse(readFileSync(arg('--machines'), 'utf8')), {
  version: arg('--version'), sourceSha: arg('--sha'),
});
const { current, previous } = JSON.parse(readFileSync(arg('--trees'), 'utf8'));
const problems = schemaProblems(current, previous);
if (problems.length) throw new Error(problems.join('\n'));
const files = contractFiles();
if (files.length) {
  const client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    const target = (await client.query(`SELECT current_database() AS database,to_regclass('public.messages') IS NOT NULL AS has_messages`)).rows[0];
    if (target?.database !== 'fly-db' || target.has_messages !== true) throw new Error('contract migration database target guard failed');
    for (const file of files) {
      const sql = readFileSync(file, 'utf8');
      if (current[file] !== sql) throw new Error(`${file}: contract differs from the compatibility-checked source`);
      const statements = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').split(';').map(s => s.trim()).filter(Boolean);
      if (!statements.length || statements.some(s => !/^ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+\w+$/i.test(s)))
        throw new Error(`${file}: contracts must contain only idempotent column drops`);
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout='1s'");
        await client.query("SET LOCAL statement_timeout='5s'");
        for (const statement of statements) await client.query(statement);
        await client.query('COMMIT');
        console.log(`Contract migration completed: ${columnDrops(sql).join(', ')}`);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally { await client.end(); }
}
console.log(`Drained fleet verified; contract migrations completed (${files.length})`);
