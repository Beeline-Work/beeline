import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { assertDrained, columnDrops, schemaProblems } from './rollout-schema.mjs';

test('rollout-0707 rejects a drop while the preceding build reads owner_agent_id', () => {
  const previous = { 'apps/server/src/corner-worker.ts': 'const query = `SELECT fact.owner_agent_id FROM corner_facts fact`;' };
  const current = { 'apps/server/contracts/owner.sql': 'ALTER TABLE corner_facts DROP COLUMN IF EXISTS owner_agent_id;' };
  assert.match(schemaProblems(current, previous).join('\n'), /previous release still reads or writes/);
  assert.deepEqual(schemaProblems(current, {}), []);
  assert.match(schemaProblems({ 'apps/server/src/database.ts': Object.values(current)[0] }, {}).join('\n'), /old Machines must drain/);
});

test('SERVER-27 catches previous writes, ignores schema declarations, and recognizes batched drops', () => {
  const drop = 'ALTER TABLE github_star_prompts DROP COLUMN IF EXISTS reached_milestone, DROP COLUMN checked_milestone;';
  assert.deepEqual(columnDrops(drop), ['github_star_prompts.reached_milestone', 'github_star_prompts.checked_milestone']);
  assert.deepEqual(columnDrops('ALTER TABLE public."github_star_prompts" DROP COLUMN "reached_milestone";'), ['github_star_prompts.reached_milestone']);
  const previous = { 'apps/server/src/github-star-prompt.ts': 'export const GITHUB_STAR_PROMPT_SCHEMA = `CREATE TABLE github_star_prompts(reached_milestone int);`;\nconst write = `INSERT INTO github_star_prompts(reached_milestone) VALUES(3)`;' };
  assert.match(schemaProblems({ 'apps/server/contracts/star.sql': drop }, previous).join('\n'), /previous release still reads or writes/);
  assert.deepEqual(schemaProblems({ 'apps/server/contracts/star.sql': drop }, { 'apps/server/src/schema.ts': 'const SCHEMA = `CREATE TABLE github_star_prompts(reached_milestone int);`;' }), []);
});

test('contract migrations cannot run before the peer drains or after a failed canary', () => {
  const machine = image => ({ state: 'started', config: { image } });
  assert.throws(() => assertDrained([machine('new'), machine('old')], 'new'), /old or unready/);
  assert.throws(() => assertDrained([], 'new'), /old or unready/);
  assert.throws(() => assertDrained([{ state: 'stopped', config: { image: 'new' } }], 'new'), /old or unready/);
  assert.doesNotThrow(() => assertDrained([machine('new'), machine('new@sha256:abc')], 'new'));
  const action = parse(readFileSync(new URL('../.github/actions/server-leg/action.yml', import.meta.url), 'utf8'));
  const steps = action.runs.steps;
  const guard = steps.findIndex(s => s.name.startsWith('Guard schema overlap'));
  const migrate = steps.findIndex(s => s.id === 'migrate');
  const canary = steps.findIndex(s => s.name.startsWith('Canary one Machine'));
  const contract = steps.findIndex(s => s.name.startsWith('Run column contracts'));
  assert.ok(guard < migrate && migrate < canary && canary < contract);
  assert.match(steps[contract].run, /flyctl machine list/);
  assert.match(steps[contract].run, /run-contract-migrations\.mjs/);
  assert.equal(steps[guard].env.PUBLISHED_SERVER_IMAGE, '${{ inputs.previous_server_image_ref }}');
  assert.equal(steps[guard].env.ROLLBACK_SERVER_IMAGE, '${{ inputs.rollback_server_image_ref }}');
  const release = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const leg = release.jobs.server.steps.find(step => step.uses === './.github/actions/server-leg');
  assert.equal(leg.with.previous_server_image_ref, '${{ needs.initialize.outputs.previous_server_image_ref }}');
  assert.equal(leg.with.rollback_server_image_ref, '${{ needs.initialize.outputs.rollback_server_image_ref }}');
});

test('a derived output alias or another table column does not prohibit a legitimate contract', () => {
  const current = { 'apps/server/contracts/star.sql': 'ALTER TABLE github_star_prompts DROP COLUMN IF EXISTS reached_milestone;' };
  const previous = { 'apps/server/src/github-star-prompt.ts': 'const read = `SELECT reached.milestone reached_milestone FROM github_star_prompts prompt JOIN other reached ON true`; const other = `SELECT reached_milestone FROM other`;' };
  assert.deepEqual(schemaProblems(current, previous), []);
  assert.match(schemaProblems(current, { 'apps/server/src/star.ts': 'const read = `SELECT prompt.* FROM github_star_prompts prompt`;' }).join('\n'), /previous release still reads/);
  assert.match(schemaProblems(current, { 'apps/server/src/star.ts': 'const read = `SELECT prompt.reached_milestone FROM public.github_star_prompts prompt`;' }).join('\n'), /previous release still reads/);
});
