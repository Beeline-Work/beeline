/** Offline audit of saved subscription samples. Never calls a model. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getEncoding } from 'js-tiktoken';
import { createStub } from './prompt-replay-stub.mjs';
import { nativePrompt } from './prompt-subscription-replay.mjs';
import { loadCases, loadSource, toolsFor } from './prompt-cases.ts';
import { median } from './prompt-nightly.mjs';
import { tuningReport } from './prompt-tuning-report.mjs';

const encoder = getEncoding('o200k_base');
const count = text => encoder.encode(text).length;
export function ownedAccounting(prompt, fixture) {
  const start = prompt.indexOf('## Turn\n');
  if (start < 0) throw new Error('Missing case conversation');
  const end = prompt.indexOf('\n````\n', start);
  if (end < 0) throw new Error('Missing case conversation end');
  const conversation = prompt.slice(start, end + 6);
  const owned = prompt.slice(0, start) + prompt.slice(end + 6);
  const indexStart = owned.indexOf('## Deferred tool index\n');
  const indexEnd = indexStart < 0 ? -1 : owned.indexOf('\n\n', indexStart);
  const index = indexStart < 0 ? '' : owned.slice(indexStart, indexEnd < 0 ? undefined : indexEnd);
  const system = index ? owned.replace(index, '') : owned;
  const stub = createStub(fixture);
  const tools = JSON.stringify(stub.listing());
  return { tokenizer: 'js-tiktoken@1.0.21/o200k_base',
    scope: 'Initial request; serialized MCP listing plus replay-owned instructions and skill index. Excludes case conversation and Codex envelope. Not provider billing serialization.',
    systemTokens: count(system), toolTokens: count(tools + index), conversationTokens: count(conversation),
    beelineOwnedTokensPerInitialCall: count(system) + count(tools + index),
    modelCalls: null, codexHarnessTokensPerCall: null };
}

export async function auditSaved(root, paths) {
  const source = await loadSource(root);
  const cases = new Map(loadCases().map(c => [c.id, c]));
  const gaps = [], examples = [], runs = [];
  for (const path of paths) {
    const run = JSON.parse(readFileSync(path, 'utf8'));
    for (const [name, entry] of Object.entries(run.variants)) {
      for (const row of entry.rows) {
        const directory = join(path.slice(0, path.lastIndexOf('/')), name, row.id);
        const fixturePath = join(directory, 'fixture.json');
        const fixture = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, 'utf8')) : {
          testCase: cases.get(row.id), tools: toolsFor(source, cases.get(row.id)), skills: {}, variant: entry.config };
        const promptPath = join(directory, 'prompt.txt');
        const prompt = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : nativePrompt(source, fixture.testCase, entry.config, fixture.tools, row.seed);
        row.promptAccounting = { ...ownedAccounting(prompt, fixture), source: existsSync(promptPath) ? 'saved prompt and fixture' : 'reconstructed from saved variant and current source' };
        if (row.status !== 'behavior') gaps.push({ model: run.model, variant: name, id: row.id, reason: row.reason,
          missingCalls: row.results?.filter(r => r.boundary === 'missing').map(r => r.call) ?? [], attemptedCalls: row.attemptedCalls });
        if (run.model === 'gpt-6-luna' && row.id === 'android-uses-leased-emulator' && ['full', 'r0-deferred'].includes(name)) {
          const eventsPath = join(directory, 'events.jsonl');
          const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
          examples.push({ variant: name, id: row.id, ...row.promptAccounting, codexAggregateInputTokens: row.inputTokens,
            turnCompletedEvents: events.filter(e => e.type === 'turn.completed'),
            eventTypes: [...new Set(events.map(e => e.type))], toolCalls: row.toolCalls, searchCalls: row.searchCalls });
        }
      }
      entry.initialPromptSummary = { medianBeelineOwnedTokensPerInitialCall: median(entry.rows.map(r => r.promptAccounting.beelineOwnedTokensPerInitialCall)),
        medianModelCallsPerCase: null, medianCodexAggregateInputTokensPerCase: entry.summary.medianInputTokens };
    }
    runs.push(run);
  }
  // Partial new variants must not shrink the comparison cohort for completed rounds.
  const roundReports = [];
  for (let round = 0; round <= 3; round++) {
    const selected = runs.filter(r => Number(/subscription-round-(\d+)/.exec(paths[runs.indexOf(r)])[1]) <= round);
    const names = [...new Set(selected.flatMap(r => Object.keys(r.variants)))];
    const completed = names.filter(name => ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-terra'].every(model =>
      selected.some(r => r.model === model && r.variants[name]?.rows.length === r.expectedCases)));
    const comparableRuns = selected.map(r => ({ ...r, variants: Object.fromEntries(Object.entries(r.variants).filter(([n]) => completed.includes(n))) }));
    const old = tuningReport(comparableRuns, 'tune');
    const points = old.variants.map(v => ({ name: v.name, meanPassRate: v.meanPassRate, perModel: v.perModel,
      regressionModels: v.regressionModels, complete: v.complete,
      initialOwnedTokens: median(selected.flatMap(r => r.variants[v.name]?.rows ?? []).map(r => r.promptAccounting.beelineOwnedTokensPerInitialCall)),
      oldCodexAggregateTokens: v.medianInputTokens }));
    const eligible = points.filter(v => v.complete && !v.regressionModels.length);
    const corrected = eligible.filter(v => !eligible.some(o => o.meanPassRate > v.meanPassRate && o.initialOwnedTokens < v.initialOwnedTokens)).map(v => v.name);
    roundReports.push({ round, pairedCaseCounts: Object.fromEntries(Object.entries(old.pairedCaseIds).map(([m, ids]) => [m, ids.length])),
      pendingVariants: names.filter(n => !completed.includes(n)), oldFrontier: old.frontier, initialOwnedFrontier: corrected, points,
      flips: { added: corrected.filter(n => !old.frontier.includes(n)), removed: old.frontier.filter(n => !corrected.includes(n)) } });
  }
  const old = tuningReport(runs.filter(r => !Object.hasOwn(r.variants, 'r3-full-shorter')), 'tune');
  const points = old.variants.map(v => {
    const values = runs.flatMap(r => r.variants[v.name]?.rows ?? []).map(r => r.promptAccounting.beelineOwnedTokensPerInitialCall);
    return { name: v.name, meanPassRate: v.meanPassRate, regressionModels: v.regressionModels,
      complete: v.complete, initialOwnedTokens: median(values), oldCodexAggregateTokens: v.medianInputTokens };
  });
  const eligible = points.filter(v => v.complete && !v.regressionModels.length);
  const initialFrontier = eligible.filter(v => !eligible.some(o => o.meanPassRate > v.meanPassRate && o.initialOwnedTokens < v.initialOwnedTokens)).map(v => v.name);
  return { status: 'provisional-missing-model-call-telemetry-and-unscored-cases', examples, roundReports,
    oldFrontier: old.frontier, initialOwnedFrontier: initialFrontier, points,
    flips: { added: initialFrontier.filter(n => !old.frontier.includes(n)), removed: old.frontier.filter(n => !initialFrontier.includes(n)) },
    unscoredCount: gaps.length, gaps,
    runs: runs.map(r => ({ model: r.model, variants: Object.fromEntries(Object.entries(r.variants).map(([n, v]) => [n, { ...v.summary, ...v.initialPromptSummary }])) })),
    limitation: 'Saved events contain aggregate turn usage only. Neither exact Codex envelope tokens nor model calls nor median expanded prompt tokens per call can be reconstructed. Existing unscored cases remain excluded, not silently counted as failures. No final frontier or stop decision is valid yet.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out, ...paths] = process.argv.slice(2);
  writeFileSync(out, JSON.stringify(await auditSaved(process.cwd(), paths), null, 2) + '\n');
}
