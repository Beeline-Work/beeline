/** Sample the existing nightly replay harness with cold versus retained fixed context. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadSource, loadCases } from './prompt-cases.ts';
import { budget, replayInterleaved, fileTransport, DEFAULT_MODELS } from './prompt-nightly.mjs';
import { CodexPromptDelivery } from '../apps/body/src/codex-prompt-delivery.ts';

const out = resolve(process.argv[2] ?? '.scratch/fixed-context-replay');
mkdirSync(out, { recursive: true });
const source = await loadSource(process.cwd());
const cached = new Set(['turn.session', 'turn.members', 'turn.memory', 'turn.corners', 'turn.workspace-core',
  'turn.objective', 'turn.rename', 'turn.brief', 'turn.checkout', 'turn.capabilities']);
const candidate = { ...source, assembly: { ...source.assembly, assembleTurnPrompt(context) {
  const delivery = new CodexPromptDelivery();
  const first = source.assembly.assembleTurnPrompt({ ...context, delivery });
  delivery.complete(true);
  const warm = source.assembly.assembleTurnPrompt({ ...context, delivery });
  const retained = source.assembly.TURN_SECTIONS
    .filter(section => cached.has(section.id) && section.surfaces.includes(context.surface))
    .map(section => section.render(context)).filter(Boolean).join('\n\n');
  return { text: `Previously delivered context, retained in this conversation:\n${retained}\n\nCurrent turn:\n${warm.text}`,
    report: first.report };
} } };
const cases = loadCases().filter(testCase => ['members-exact-handle', 'memory-answers-from-note'].includes(testCase.id));
if (cases.length !== 2) throw Error('Saved replay sample is missing');
const ledger = budget(1_000_000, 2);
const partial = [];
try {
  const rows = await replayInterleaved({ cold: source, warm: candidate }, cases, {
    models: DEFAULT_MODELS, ledger, request: fileTransport(join(out, 'exchange')),
    onCase(model, arm, row) { partial.push({ model, arm, row }); writeFileSync(join(out, 'partial.json'), JSON.stringify(partial, null, 2)); },
  });
  const regressed = DEFAULT_MODELS.some(model => rows[model].cold.some((row, index) =>
    row.samples.some((sample, i) => sample.pass === true && rows[model].warm[index].samples[i].pass !== true)));
  const complete = DEFAULT_MODELS.every(model => ['cold', 'warm'].every(arm => rows[model][arm].every(row => row.scored === 3)));
  const result = { status: complete ? 'complete' : 'incomplete', regressed, models: DEFAULT_MODELS,
    cases: cases.map(testCase => testCase.id), tokens: ledger.tokens, cost: ledger.cost, rows,
    limitation: 'Sampled retained context simulation; adapter restart and compaction are verified separately by ACP wire tests.' };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, rows: undefined }));
  if (!complete || regressed) process.exitCode = 1;
} catch (error) {
  writeFileSync(join(out, 'result.json'), JSON.stringify({ status: 'failed', reason: error.message, tokens: ledger.tokens, cost: ledger.cost, partial }, null, 2));
  throw error;
}
