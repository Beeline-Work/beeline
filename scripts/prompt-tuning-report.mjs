/** Compare saved subscription results; never calls a model or opens held-out inputs implicitly. */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { median } from './prompt-nightly.mjs';
import { summarize, frontier } from './prompt-subscription-replay.mjs';

export const MODELS = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-terra'];
export function tuningReport(runs, partition, expectedModels = MODELS) {
  if (!['tune', 'heldout'].includes(partition)) throw new Error('An explicit tune or heldout partition is required');
  if (runs.some(r => r.partition !== partition || r.smokeOnly)) throw new Error('Cannot combine smoke proofs or different partitions with a tuning round');
  if (new Set(runs.map(r => r.splitHash)).size !== 1) throw new Error('Results have different frozen splits');
  const byModel = new Map(), configs = new Map(), excluded = [];
  for (const run of runs) {
    if (run.status === 'model-stopped' && run.error) excluded.push({ model: run.model, error: run.error });
    const variants = byModel.get(run.model) ?? new Map();
    byModel.set(run.model, variants);
    for (const [name, entry] of Object.entries(run.variants)) {
      if (configs.has(name) && JSON.stringify(configs.get(name)) !== JSON.stringify(entry.config)) throw new Error(`Config changed under the same variant name: ${name}`);
      configs.set(name, entry.config);
      const target = variants.get(name) ?? { rows: new Map(), expected: run.expectedCases };
      variants.set(name, target);
      if (target.expected !== run.expectedCases) throw new Error('Mismatched case cohorts');
      for (const row of entry.rows) {
        if (target.rows.has(row.id) && JSON.stringify(target.rows.get(row.id)) !== JSON.stringify(row)) throw new Error(`Conflicting repeated sample: ${run.model}/${name}/${row.id}`);
        target.rows.set(row.id, row);
      }
    }
  }
  const models = expectedModels.filter(m => !excluded.some(e => e.model === m));
  const names = [...configs.keys()];
  if (!names.includes('full')) throw new Error('A full baseline is required');
  const paired = Object.fromEntries(models.map(model => {
    const baseline = byModel.get(model)?.get('full');
    const ids = baseline ? [...baseline.rows.keys()].filter(id => names.every(name => byModel.get(model)?.get(name)?.rows.get(id)?.status === 'behavior')) : [];
    return [model, ids];
  }));
  const variants = names.map(name => {
    const perModel = {}, inputs = [], owned = [], requests = [], regressions = [];
    let complete = models.length > 0;
    for (const model of models) {
      const entry = byModel.get(model)?.get(name);
      const rows = entry ? [...entry.rows.values()] : [];
      const scoredPairs = (paired[model] ?? []).map(id => entry.rows.get(id));
      const basePairs = (paired[model] ?? []).map(id => byModel.get(model).get('full').rows.get(id));
      const pairedPassRate = scoredPairs.length ? scoredPairs.filter(r => r.pass).length / scoredPairs.length : null;
      const baseRate = basePairs.length ? basePairs.filter(r => r.pass).length / basePairs.length : null;
      if (baseRate !== null && pairedPassRate < baseRate - 0.05 - 1e-12) regressions.push(model);
      complete &&= Boolean(entry && rows.length === entry.expected && rows.every(r => r.status === 'behavior' && r.telemetry?.status === 'complete' && r.telemetry.initialExposure === 'explicit-replay-definitions') &&
        scoredPairs.length && scoredPairs.every(r => Number.isFinite(r.inputTokens) && Number.isFinite(r.modelRequests)));
      inputs.push(...scoredPairs.map(r => r.inputTokens).filter(Number.isFinite));
      owned.push(...scoredPairs.flatMap(r => r.telemetry?.calls ?? []).map(c => c.beelineOwnedTokensPerCall).filter(Number.isFinite));
      requests.push(...scoredPairs.map(r => r.modelRequests).filter(Number.isFinite));
      perModel[model] = { ...summarize(rows), attempted: rows.length, expected: entry?.expected ?? null,
        pairedPassed: scoredPairs.filter(r => r.pass).length, pairedScored: scoredPairs.length, pairedPassRate };
    }
    const rates = Object.values(perModel).map(m => m.pairedPassRate);
    return { name, config: configs.get(name), complete, regressionModels: regressions, perModel,
      meanPassRate: rates.length && rates.every(r => r !== null) ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      worstModelPassRate: rates.length && rates.every(r => r !== null) ? Math.min(...rates) : null,
      medianInputTokens: median(inputs), medianBeelineOwnedTokensPerCall: median(owned), medianModelRequestsPerCase: median(requests) };
  });
  const edge = frontier(variants).map(v => v.name);
  const comparisons = Object.fromEntries(names.filter(name => name !== 'full').map(name => {
    const byCause = { 'never searched': [], 'wrong tool': [], 'called unloaded tool': [], other: [] };
    let extraCalls = 0, extraSearches = 0, extraModelRequests = 0, modelRequestPairs = 0, pairs = 0;
    const won = [], lost = [], tied = [], unscored = [];
    for (const model of models) {
      const baseline = byModel.get(model)?.get('full'), candidate = byModel.get(model)?.get(name);
      if (!candidate || !baseline) continue;
      const config = configs.get(name);
      for (const [id, after] of candidate.rows) {
        const before = baseline.rows.get(id);
        if (!before) continue;
        if (before.status === 'behavior' && after.status === 'behavior') {
          (before.pass === after.pass ? tied : after.pass ? won : lost).push(`${model}:${id}`);
          extraCalls += after.toolCalls - before.toolCalls;
          extraSearches += after.searchCalls - before.searchCalls;
          if (Number.isFinite(after.modelRequests) && Number.isFinite(before.modelRequests)) {
            extraModelRequests += after.modelRequests - before.modelRequests;
            modelRequestPairs++;
          }
          pairs++;
        } else unscored.push(`${model}:${id}`);
        if (before.pass !== true || after.pass === true) continue;
        const needed = before.transcript.calls.map(c => c.name).filter(n => !(config.core ?? []).includes(n));
        const loaded = new Set(after.searches.flatMap(s => s.names));
        const cause = /unloaded tool/i.test(after.reason ?? '') ? 'called unloaded tool'
          : after.status !== 'behavior' ? 'other'
          : needed.length && !after.searchCalls ? 'never searched'
          : needed.some(n => !loaded.has(n)) && after.searchCalls ? 'wrong tool' : 'other';
        byCause[cause].push({ model, id, status: after.status, reason: after.reason });
      }
    }
    return [name, { won, lost, tied, unscored, deferredOnlyFailures: byCause, pairedSamples: pairs,
      extraToolCallsPerSample: pairs ? extraCalls / pairs : null,
      extraSearchCallsPerSample: pairs ? extraSearches / pairs : null,
      extraModelRequestsPerSample: modelRequestPairs ? extraModelRequests / modelRequestPairs : null }];
  }));
  return { partition, models, excluded, missingModels: models.filter(m => !byModel.has(m)), pairedCaseIds: paired,
    variants, frontier: edge, comparisons, costUsd: 0,
    usageNote: 'Frontier uses structural Beeline-owned tokens per model call from rollouts, including retrieved definition objects retained in history. medianInputTokens remains the separate aggregate Codex total per case. Missing telemetry or ungraded cases prevent complete frontier eligibility. Codex may itself defer the replay catalog; inspect telemetry.initialExposure before interpreting the result as eager versus deferred.' };
}
export function stoppingDecision(history) {
  if (history.length >= 8) return { stop: true, reason: 'Eight rounds reached' };
  if (history.length < 3) return { stop: false, reason: 'Two consecutive round changes are not available' };
  const changes = history.slice(-3).slice(1).map((round, i) => ({
    meanPassRateGain: round.bestMeanPassRate - history.slice(-3)[i].bestMeanPassRate,
    medianTokensSaved: history.slice(-3)[i].smallestMedianInputTokens - round.smallestMedianInputTokens,
  }));
  return { stop: changes.every(c => c.meanPassRateGain < 0.03 - 1e-12 && c.medianTokensSaved < 500), changes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const paths = option('--inputs')?.split(',');
  if (!paths?.length) throw new Error('--inputs requires comma-separated result files');
  const report = tuningReport(paths.map(p => JSON.parse(readFileSync(p, 'utf8'))), option('--partition'));
  const json = JSON.stringify(report, null, 2) + '\n';
  if (option('--out')) writeFileSync(option('--out'), json); else process.stdout.write(json);
}
