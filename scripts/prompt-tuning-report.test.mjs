import assert from 'node:assert/strict';
import test from 'node:test';
import { tuningReport, stoppingDecision, MODELS } from './prompt-tuning-report.mjs';
const row = (id, pass, inputTokens = 100, status = 'behavior') => ({ id, pass, status, inputTokens,
  modelRequests: 1, telemetry: { status: 'complete', initialExposure: 'explicit-replay-definitions', modelRequests: 1, sumProviderInputTokens: inputTokens, calls: [{ inputTokens, beelineOwnedTokensPerCall: inputTokens, codexInstructionTokens: 5, codexToolTokens: 3, codexAddedTokensPerCall: 8 }] },
  toolCalls: 1, searchCalls: 0, searches: [], transcript: { calls: [{ name: 'read', args: {} }], text: '' } });
const config = name => ({ name, mode: name === 'full' ? 'full' : 'deferred', core: ['read'] });
const run = (model, full, deferred) => ({ model, partition: 'tune', splitHash: 'fixed', expectedCases: full.length,
  status: 'complete', variants: { full: { config: config('full'), rows: full }, deferred: { config: config('deferred'),
    rows: deferred.map(r => ({ ...r, telemetry: r.telemetry ? { ...r.telemetry, initialExposure: 'purpose-index-only' } : r.telemetry })) } } });

test('frontier compares the same scored pairs while preserving raw exclusions', () => {
  const runs = MODELS.map(model => run(model, [row('a', true), row('b', false)], [row('a', true, 80), row('b', null, 60, 'incomplete')]));
  const report = tuningReport(runs, 'tune');
  assert.deepEqual(report.pairedCaseIds[MODELS[0]], ['a']);
  assert.equal(report.variants[0].perModel[MODELS[0]].passRate, .5);
  assert.equal(report.variants[1].perModel[MODELS[0]].passRate, 1);
  assert.equal(report.variants[1].perModel[MODELS[0]].unscored, 1);
  assert.equal(report.variants[0].meanPassRate, 1);
  assert.equal(report.variants[1].meanPassRate, 1);
  assert.equal(report.comparisons.deferred.unscored.length, 3);
});

test('a per-model regression above five points disqualifies a cheaper variant', () => {
  const runs = MODELS.map((model, i) => run(model, [row('a', true)], [row('a', i !== 0, 20)]));
  const report = tuningReport(runs, 'tune');
  assert.deepEqual(report.variants[1].regressionModels, [MODELS[0]]);
  assert.deepEqual(report.frontier, ['full']);
});

test('frontier uses Beeline tokens rather than aggregate Codex usage, and legacy telemetry gaps prevent eligibility', () => {
  const runs = MODELS.map(model => {
    const before = row('a', true, 10);
    before.telemetry.calls[0].beelineOwnedTokensPerCall = 100;
    const after = row('a', true, 1000);
    after.telemetry.calls[0].beelineOwnedTokensPerCall = 20;
    return run(model, [before], [after]);
  });
  const report = tuningReport(runs, 'tune');
  assert.equal(report.variants[0].medianBeelineOwnedTokensPerCall, 100);
  assert.equal(report.variants[1].medianBeelineOwnedTokensPerCall, 20);
  assert.ok(report.frontier.includes('deferred'));
  for (const r of runs) r.variants.deferred.rows[0].telemetry.initialExposure = 'explicit-replay-definitions';
  assert.equal(tuningReport(runs, 'tune').variants[1].complete, false);
  assert.equal(tuningReport(runs, 'tune').frontier.includes('deferred'), false);
  for (const r of runs) for (const v of Object.values(r.variants)) delete v.rows[0].telemetry;
  assert.deepEqual(tuningReport(runs, 'tune').frontier, []);
});

test('missing models prevent a complete frontier and explicit model limits are preserved', () => {
  const one = run(MODELS[0], [row('a', true)], [row('a', true)]);
  const report = tuningReport([one], 'tune');
  assert.equal(report.missingModels.length, 2);
  assert.equal(report.frontier.length, 0);
  const stopped = { ...run(MODELS[2], [], []), status: 'model-stopped', error: 'Exact subscription usage limit message' };
  const available = tuningReport([one, run(MODELS[1], [row('a', true)], [row('a', true)]), stopped], 'tune');
  assert.deepEqual(available.models, MODELS.slice(0, 2));
  assert.equal(available.excluded[0].error, stopped.error);
});

test('partition mixing, smoke proofs, changed configs and repeated conflicting samples are rejected', () => {
  const r = run(MODELS[0], [row('a', true)], [row('a', true)]);
  assert.throws(() => tuningReport([r], 'heldout'), /different partitions/);
  assert.throws(() => tuningReport([{ ...r, smokeOnly: true }], 'tune'), /smoke proofs/);
  const changed = structuredClone(r); changed.variants.deferred.config.core = [];
  assert.throws(() => tuningReport([r, changed], 'tune'), /Config changed/);
  const repeated = structuredClone(r); repeated.variants.full.rows[0].pass = false;
  assert.throws(() => tuningReport([r, repeated], 'tune'), /Conflicting repeated sample/);
});

test('two flat rounds stop; a sufficient accuracy or token improvement keeps tuning', () => {
  const point = (accuracy, tokens) => ({ bestMeanPassRate: accuracy, smallestMedianInputTokens: tokens });
  assert.equal(stoppingDecision([point(.5, 10000), point(.52, 9800)]).stop, false);
  assert.equal(stoppingDecision([point(.5, 10000), point(.52, 9800), point(.53, 9600)]).stop, true);
  assert.equal(stoppingDecision([point(.5, 10000), point(.54, 9800), point(.55, 9600)]).stop, false);
  assert.equal(stoppingDecision([point(.5, 10000), point(.51, 9500), point(.52, 9400)]).stop, false);
  assert.equal(stoppingDecision(Array.from({length: 8}, () => point(.5, 10000))).stop, true);
});

test('legacy per-response accounting cannot complete or enter the frontier even with complete status and correct exposure', () => {
  const runs = MODELS.map(model => run(model, [row('a', true)], [row('a', true, 80)]));
  for (const modelRun of runs) for (const entry of Object.values(modelRun.variants)) {
    for (const call of entry.rows[0].telemetry.calls) {
      delete call.codexInstructionTokens; delete call.codexToolTokens; delete call.codexAddedTokensPerCall;
    }
  }
  const legacy = tuningReport(runs, 'tune');
  assert.deepEqual(legacy.frontier, []);
  assert.ok(legacy.variants.every(v => !v.complete));
  assert.ok(legacy.variants.every(v => Object.values(v.perModel).every(m => m.missingTelemetry === 1 && m.medianCodexAddedTokensPerCall === null)));
  for (const modelRun of runs) for (const entry of Object.values(modelRun.variants))
    Object.assign(entry.rows[0].telemetry.calls[0], { codexInstructionTokens: 5, codexToolTokens: 3, codexAddedTokensPerCall: 8 });
  assert.ok(tuningReport(runs, 'tune').variants.every(v => v.complete));
});
