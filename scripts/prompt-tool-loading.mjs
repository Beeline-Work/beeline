/** Opt-in replay experiment; never executes a model's proposed tools. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, loadCases, loadSource } from './prompt-cases.ts';
import { budget, needsSquire, replaySuite, scoreRows, median } from './prompt-nightly.mjs';

// Positive expected calls and recorded transcript calls; generic scenario fallbacks are not usage.
export const CORE_TOOLS = ['Bash', 'open_corner', 'report', 'read', 'order', 'app_tool'];
export const FIND_TOOLS = { name: 'find_tools', description: 'Load full tool definitions by exact names or a plain-language query. Wait for results before calling loaded tools.',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false } };
const definition = t => ({ name: t.name, description: t.description, input_schema: t.inputSchema });
const words = text => text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
export function deniesAvailableTool(text, tools) {
  return text.split(/[.!?\n]/).some(sentence => {
    if (/\b(?:permission|approval|authorized|hold|policy|forbidden)\b/i.test(sentence)) return false;
    const tokens = words(sentence);
    const denial = /(?:\btool\b.{0,40}(?:unavailable|not available)|(?:do not have|don't have|cannot access|can't access|lack).{0,60}\btools?\b|(?:no|without) (?:available |callable )?(?:[a-z_]+ )?tools?\b)/i.test(sentence);
    return denial && /\btools?\b/i.test(sentence) &&
      (tools.some(t => tokens.includes(t.name.toLowerCase())) || /(?:no|without|lack of) (?:available |callable )?tools\b/i.test(sentence));
  });
}
export function findTools(tools, query) {
  const terms = words(query).filter(w => !['a', 'an', 'the', 'to', 'for', 'tool', 'tools', 'i', 'need', 'and', 'with'].includes(w));
  const exact = tools.filter(t => terms.includes(t.name.toLowerCase()));
  if (exact.length) return exact.map(definition);
  const ranked = tools.map(t => ({ t, score: terms.filter(w => words(`${t.name.replaceAll('_', ' ')} ${t.description}`).includes(w)).length }))
    .filter(t => t.score).sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  return ranked.slice(0, 5).map(({ t }) => definition(t));
}
export function deferredPrompt(prompt, tools) {
  const core = tools.filter(t => CORE_TOOLS.includes(t.name));
  const all = JSON.stringify(tools.map(definition));
  if (!prompt.includes(all)) throw new Error('Replay prompt tool block not found');
  const index = tools.filter(t => !CORE_TOOLS.includes(t.name)).map(t => `${t.name}: ${t.description.split(/\s+/).slice(0, 14).join(' ')}`);
  return { core: core.map(t => t.name), prompt: prompt.replace(all, JSON.stringify([...core, FIND_TOOLS].map(definition))) +
    `\n## Deferred tool index\nEvery tool below is available through find_tools. Search by name or purpose to load its full definition; wait for the result before calling it. Loaded definitions remain callable for this sample.\n${index.join('\n')}\n` };
}
export function coreEvidence(cases) {
  const counts = {};
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.call === 'string') counts[value.call] = (counts[value.call] ?? 0) + 1;
    for (const [key, child] of Object.entries(value)) if (!['not', 'noCall', 'atMostOnce'].includes(key)) walk(child);
  };
  cases.forEach(c => {
    walk(c.pass);
    for (const line of [...c.messages ?? [], ...c.scenario?.history ?? []]) {
      for (const match of JSON.stringify(line).matchAll(/Tool result[^a-z_]+([a-zA-Z_]+)\(/g)) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
    }
  });
  return counts;
}
const p90 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1] : null;
export function comparisonSummary(baseline, deferred, eligible) {
  const arm = rows => {
    // Input tokens per API turn, including all search continuations.
    const requestInputs = rows.flatMap(r => r.samples.flatMap(s => s.requests.map(q => q.usage?.prompt_tokens).filter(Number.isFinite)));
    const inputs = rows.flatMap(r => r.samples.filter(s => s.requests.length && s.requests.every(q => Number.isFinite(q.usage?.prompt_tokens)))
      .map(s => s.requests.reduce((n, q) => n + q.usage.prompt_tokens, 0)));
    const samples = rows.flatMap(r => r.samples);
    return { ...scoreRows(rows, eligible), inputAccountingSamples: inputs.length, medianInputTokens: median(inputs), p90InputTokens: p90(inputs),
      medianInputTokensPerRequest: median(requestInputs), p90InputTokensPerRequest: p90(requestInputs),
      callsPerSample: samples.length ? samples.reduce((n, s) => n + s.requests.length, 0) / samples.length : null };
  };
  const won = [], lost = [], tied = [], unpaired = [];
  const failures = { 'never searched': [], 'searched but wrong tool': [], 'called an unloaded tool': [], other: [] };
  for (const row of deferred) {
    const before = baseline.find(b => b.id === row.id);
    if (typeof row.pass !== 'boolean' || typeof before?.pass !== 'boolean') unpaired.push(row.id);
    else (row.pass === before.pass ? tied : row.pass ? won : lost).push(row.id);
    row.samples.forEach((s, i) => {
      if (!before?.samples[i]?.pass || s.pass === true) return;
      const searches = s.attemptedCalls.filter(c => c.name === 'find_tools');
      const cause = s.terminal === 'unloaded-tool' ? 'called an unloaded tool' : s.status !== 'behavior' ? 'other' : !searches.length ? 'never searched'
        : before.samples[i].transcript.calls.some(c => !CORE_TOOLS.includes(c.name) && !s.rounds.some(r => r.results?.some(v => v.call?.name === 'find_tools' && Array.isArray(v.result) && v.result.some(t => t.name === c.name)))) ? 'searched but wrong tool' : 'other';
      failures[cause].push(`${row.id}@${s.seed}`);
    });
  }
  const full = arm(baseline), lazy = arm(deferred);
  return { baseline: full, deferred: lazy, won, lost, tied, unpaired, deferredOnlyFailures: failures,
    extraCallsPerSample: lazy.callsPerSample - full.callsPerSample };
}
export async function runToolComparison({ out, request, tokenCap, costCap, models, root = process.cwd() }) {
  mkdirSync(out, { recursive: true });
  const all = loadCases(), cases = all.filter(c => !needsSquire(c)), source = await loadSource(root);
  const problems = check(source, all);
  if (problems.length) throw new Error(problems.join('\n'));
  const ledger = budget(tokenCap, costCap);
  const result = { status: 'running', startedAt: new Date().toISOString(), mode: 'deferred',
    seeds: [1000, 1001, 1002], tokenCap, costCap, eligibleCount: cases.length,
    core: CORE_TOOLS, coreEvidence: coreEvidence(all), models: {},
    skipped: all.filter(needsSquire).map(c => c.id), tokens: 0, cost: 0 };
  const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify({ ...result, tokens: ledger.tokens, cost: ledger.cost }, null, 2) + '\n');
  save();
  try {
    // Case-major pairing gives partial runs useful pairs before a cap is reached.
    for (const model of models) result.models[model] = { baseline: [], deferred: [] };
    for (const testCase of cases) {
      for (const model of models) {
        const entry = result.models[model];
        if (entry.unavailable) continue;
        for (const toolMode of ['full', 'deferred']) {
          const name = toolMode === 'full' ? 'baseline' : 'deferred';
          entry[name].push(...await replaySuite(source, [testCase], { model, request, ledger, toolMode }));
          entry.summary = comparisonSummary(entry.baseline, entry.deferred, cases.length);
          save();
        }
        if ([...entry.baseline.at(-1).samples, ...entry.deferred.at(-1).samples].some(s => s.terminal === 'budget')) throw new Error('Replay budget exhausted');
        // An unavailable model should not consume a whole cohort of failed requests.
        if (entry.baseline.length === 1 && [...entry.baseline.at(-1).samples, ...entry.deferred.at(-1).samples].every(s => s.terminal === 'transport')) {
          entry.unavailable = 'Both arms returned only transport failures; no model substituted';
          save();
        }
      }
    }
    result.status = Object.values(result.models).some(m => m.unavailable || ['baseline', 'deferred'].some(a => m[a].some(r => r.samples.some(s => s.status !== 'behavior')))) ? 'incomplete' : 'complete';
  } catch (error) { result.status = 'failed'; result.error = error.message; }
  result.tokens = ledger.tokens; result.cost = ledger.cost;
  save();
  writeFileSync(join(out, 'summary.txt'), JSON.stringify({ status: result.status, error: result.error, tokens: result.tokens, cost: result.cost,
    models: Object.fromEntries(Object.entries(result.models).map(([id, m]) => [id, { unavailable: m.unavailable, ...m.summary }])) }, null, 2) + '\n');
  return result;
}
